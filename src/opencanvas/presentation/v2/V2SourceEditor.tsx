import { acceptCompletion, closeBrackets, closeBracketsKeymap, closeCompletion, completionStatus, moveCompletionSelection, startCompletion } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentLess, indentMore } from '@codemirror/commands';
import { Annotation, Compartment, EditorSelection, EditorState, Prec, RangeSetBuilder, StateEffect, StateField, type Extension } from '@codemirror/state';
import {
  Decoration, type DecorationSet, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers,
  placeholder as placeholderText, tooltips, ViewPlugin, type ViewUpdate,
} from '@codemirror/view';
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import type { DslDiagnostic } from '../../../dsl/ast';
import { highlightLine } from '../../../dsl/highlight';
import { iconValueAt, sourceIconCompletion } from './sourceIconCompletion';

export interface V2SourceEditorHandle {
  focus(): void;
  /** Types `text` over the selection as one undoable edit. */
  insert(text: string): void;
  /** Selects a 1-based line/column range (a diagnostic's) and scrolls it into view. */
  selectRange(line: number, col: number, endCol: number): void;
}

/** A key the panel handles before the editor does; true means handled (the editor then ignores it). */
export type SourceKeyHandler = (event: KeyboardEvent) => boolean;

interface Props {
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** Called after the author types `[`, so the panel can offer attributes. */
  readonly onOpenBracket: () => void;
  readonly onKey: SourceKeyHandler;
  readonly diagnostics: readonly DslDiagnostic[];
  readonly autoFocus: boolean;
  readonly selectAll: boolean;
  readonly placeholder: string;
  readonly contentAttributes: Record<string, string>;
}

const external = Annotation.define<boolean>();
const setDiagnostics = StateEffect.define<readonly DslDiagnostic[]>();

/** Tokens are per line, so only the lines on screen are tokenized: a 10k-line source costs what a screenful does. */
function tokenDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to;) {
      const line = view.state.doc.lineAt(position);
      for (const span of highlightLine(line.text)) {
        builder.add(line.from + span.from, line.from + span.to, Decoration.mark({ attributes: { 'data-token': span.kind } }));
      }
      position = line.to + 1;
    }
  }
  return builder.finish();
}

const highlighter = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(view: EditorView) { this.decorations = tokenDecorations(view); }
  update(update: ViewUpdate) { if (update.docChanged || update.viewportChanged) this.decorations = tokenDecorations(update.view); }
}, { decorations: (plugin) => plugin.decorations });

/** Error and warning lines get a tone on the line and its gutter number. */
const diagnosticLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lines, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setDiagnostics)) continue;
      const doc = transaction.state.doc;
      const byLine = new Map<number, string>();
      for (const item of effect.value) {
        if (item.severity === 'info' || item.line < 1 || item.line > doc.lines) continue;
        if (byLine.get(item.line) !== 'error') byLine.set(item.line, item.severity);
      }
      return Decoration.set([...byLine].sort(([a], [b]) => a - b)
        .map(([line, tone]) => Decoration.line({ attributes: { 'data-tone': tone } }).range(doc.line(line).from)));
    }
    return transaction.docChanged ? lines.map(transaction.changes) : lines;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Spaces up to the next two-column stop at every caret: Tab types indentation, never a tab character. */
function indentToTabStop(view: EditorView): boolean {
  view.dispatch(view.state.changeByRange((range) => {
    const column = range.head - view.state.doc.lineAt(range.head).from;
    const spaces = ' '.repeat(2 - (column % 2));
    return { changes: { from: range.head, insert: spaces }, range: EditorSelection.cursor(range.head + spaces.length) };
  }), { userEvent: 'input.indent', scrollIntoView: true });
  return true;
}

const normalize = (text: string) => text.replace(/\r\n?/g, '\n');

/** The diagram source on CodeMirror 6, always dark: line numbers, IDE-style token colours, history, bracket closing and indent keys. */
export const V2SourceEditor = forwardRef<V2SourceEditorHandle, Props>(function V2SourceEditor(props, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latest = useRef(props);
  // CodeMirror's handlers are built once; they read the newest props through this ref.
  useLayoutEffect(() => { latest.current = props; });
  const attributes = useRef(new Compartment());

  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    insert: (text) => {
      const view = viewRef.current;
      if (!view) return;
      view.focus();
      view.dispatch(view.state.replaceSelection(text), { userEvent: 'input.complete', scrollIntoView: true });
    },
    selectRange: (line, col, endCol) => {
      const view = viewRef.current;
      if (!view) return;
      const doc = view.state.doc;
      const target = doc.line(Math.min(Math.max(1, line), doc.lines));
      const from = Math.min(target.to, target.from + Math.max(0, col - 1));
      const to = Math.min(target.to, from + Math.max(1, endCol - col));
      view.focus();
      view.dispatch({ selection: EditorSelection.single(from, to), scrollIntoView: true });
    },
  }), []);

  useLayoutEffect(() => {
    const extensions: Extension[] = [
      lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), closeBrackets(),
      EditorState.tabSize.of(2), EditorView.lineWrapping, placeholderText(latest.current.placeholder), highlighter, diagnosticLines,
      attributes.current.of(EditorView.contentAttributes.of(latest.current.contentAttributes)),
      // The panel's keys first (suggestions, Escape, Ctrl+Space); the input method owns every key while it composes.
      Prec.highest(EditorView.domEventHandlers({
        keydown: (event, view) => {
          // Claimed but not prevented: neither the keymap nor the panel sees it, the input method does.
          if (event.isComposing || view.composing || event.keyCode === 229) return true;
          const line = view.state.doc.lineAt(view.state.selection.main.head);
          const inIcon = iconValueAt(line.text, view.state.selection.main.head - line.from);
          let handled = false;
          if ((event.ctrlKey || event.metaKey) && event.key === ' ' && inIcon) handled = startCompletion(view);
          else if (completionStatus(view.state)) {
            if (event.key === 'Escape') handled = closeCompletion(view);
            else if (event.key === 'ArrowDown') handled = moveCompletionSelection(true)(view);
            else if (event.key === 'ArrowUp') handled = moveCompletionSelection(false)(view);
            else if (event.key === 'Enter' || event.key === 'Tab') handled = acceptCompletion(view);
          }
          if (handled) { event.preventDefault(); return true; }
          if (!latest.current.onKey(event)) return false;
          event.preventDefault();
          return true;
        },
      })),
      tooltips({ parent: document.body }), sourceIconCompletion,
      keymap.of([
        // An empty caret indents by a tab stop at the caret; a selection indents its lines. Shift+Tab outdents.
        { key: 'Tab', run: (view) => view.state.selection.ranges.every((range) => range.empty) ? indentToTabStop(view) : indentMore(view), shift: indentLess },
        ...closeBracketsKeymap, ...historyKeymap,
        // ⌘↵ is the panel's Generate, never a blank line.
        ...defaultKeymap.filter((binding) => binding.key !== 'Mod-Enter' && binding.key !== 'Escape'),
      ]),
      EditorState.languageData.of(() => [{ closeBrackets: { brackets: ['[', '{', '(', '"'] } }]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged || update.transactions.some((transaction) => transaction.annotation(external))) return;
        const value = update.state.doc.toString();
        latest.current.onChange(value);
        const head = update.state.selection.main.head;
        if (update.transactions.some((transaction) => transaction.isUserEvent('input.type')) && value[head - 1] === '[') latest.current.onOpenBracket();
      }),
    ];
    const view = new EditorView({ parent: hostRef.current!, state: EditorState.create({ doc: normalize(latest.current.value), extensions }) });
    viewRef.current = view;
    // Opened on request the source is focused: a sample is selected so ⌘V replaces it, a diagram's own source gets
    // the caret at its end so a stray keystroke never wipes it (U1-02).
    if (latest.current.autoFocus) {
      view.dispatch({ selection: latest.current.selectAll ? EditorSelection.single(0, view.state.doc.length) : EditorSelection.cursor(view.state.doc.length) });
      view.focus();
    }
    return () => { view.destroy(); viewRef.current = null; };
  }, []);

  // A value from outside (Convert, Format, an agent) replaces the text as one undoable step and is not echoed back.
  useEffect(() => {
    const view = viewRef.current;
    const next = normalize(props.value);
    if (!view || view.state.doc.toString() === next) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next }, annotations: external.of(true) });
  }, [props.value]);

  useEffect(() => { viewRef.current?.dispatch({ effects: setDiagnostics.of(props.diagnostics) }); }, [props.diagnostics, props.value]);

  const attributeKey = JSON.stringify(props.contentAttributes);
  useEffect(() => {
    viewRef.current?.dispatch({ effects: attributes.current.reconfigure(EditorView.contentAttributes.of(latest.current.contentAttributes)) });
  }, [attributeKey]);

  return <div ref={hostRef} className="ofk-v2-code-editor" />;
});
