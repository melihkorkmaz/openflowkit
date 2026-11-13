import { IconIndentIncrease, IconPlayerPlay, IconTransform } from '@tabler/icons-react';
import { useMemo, useRef, useState } from 'react';
import type { DslDiagnostic } from '../../../dsl/ast';
import { DSL_FAMILIES } from '../../../dsl/ast';
import { formatSource } from '../../../dsl/formatSource';
import { COLOR_WORDS, EDGE_FLAG_WORDS, FILL_WORDS, SHAPE_WORDS } from '../../../dsl/vocabulary';
import { DIAGRAM_PALETTES, type DiagramPaletteName } from '../../domain/nodes/nodePalette';
import { Button, Icon, Panel, Segmented } from '../design-system';
import { platformKeys } from './v2Shortcuts';
import { V2SourceEditor, type V2SourceEditorHandle } from './V2SourceEditor';

export function V2CodePanel({
  code, diagnostics, generating, canvasEdited, palette, onPaletteChange, onCodeChange, onGenerate, onClose, convertFrom, autoFocus = true, selectAll = false,
}: {
  code: string;
  diagnostics: readonly DslDiagnostic[];
  generating: boolean;
  canvasEdited: boolean;
  /** Palette applied when the code compiles; the DSL's own `appearance:` wins. */
  palette: DiagramPaletteName;
  onPaletteChange: (palette: DiagramPaletteName) => void;
  onCodeChange: (code: string) => void;
  onGenerate: () => void;
  onClose: () => void;
  /** Present when the draft is foreign syntax (Mermaid, Structurizr); converts it to DSL in place. */
  convertFrom?: { readonly label: string; readonly convert: () => void } | undefined;
  /** False when a template opened it beside its diagram: focus stays on the canvas. */
  autoFocus?: boolean;
  /** The new-diagram sample opens selected, so ⌘V replaces it; a diagram's own source opens with the caret at the end. */
  selectAll?: boolean;
}) {
  // ponytail: an empty editor shows the placeholder, not "document is empty".
  // Foreign syntax (Mermaid, Structurizr, D2) arrives without OpenFlowKit's parse diagnostics (the workspace drops
  // them); what is left is the conversion's own report, which must show — a failed Convert would look dead otherwise.
  const errors = code.trim() ? diagnostics.filter((item) => item.severity !== 'info') : [];
  const editorRef = useRef<V2SourceEditorHandle>(null);
  const [suggestions, setSuggestions] = useState<readonly string[]>([]);
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [formatting, setFormatting] = useState(false);
  const [formatError, setFormatError] = useState<string | null>(null);
  const names = useMemo(() => Array.from(new Set(code.split('\n').map((line) => line.split(/\s*(?:-->|->|<->|=|\[)/)[0]?.trim()).filter((name): name is string => !!name && !name.startsWith('//')))), [code]);
  const openSuggestions = (kind: 'attrs' | 'all') => {
    const attrs = [
      ...Object.keys(SHAPE_WORDS), ...Object.keys(COLOR_WORDS),
      ...FILL_WORDS, ...EDGE_FLAG_WORDS, 'shadow',
      'label:', 'tech:', 'icon:', 'from:', 'to:', 'head:', 'pin:', 'rank:', 'width:', 'height:',
    ];
    setSuggestions(kind === 'attrs' ? attrs : [...DSL_FAMILIES, ...names]);
    setSuggestionIndex(0);
  };
  const chooseSuggestion = (value: string) => {
    editorRef.current?.insert(value);
    setSuggestions([]);
  };
  // Foreign syntax converts first; a source with skipped lines stays as written, with the reason beside it.
  const formatCode = () => {
    if (formatting) return;
    if (convertFrom) { setFormatError(`Convert the ${convertFrom.label} first, then format.`); return; }
    setFormatting(true);
    void formatSource(code).then((result) => {
      setFormatting(false);
      if (result.ok === false) { setFormatError(result.reason); return; }
      setFormatError(null);
      if (result.text !== code) onCodeChange(result.text);
    });
  };
  const isFormatKey = (event: { shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean; code: string }) =>
    event.shiftKey && event.altKey && !event.metaKey && !event.ctrlKey && event.code === 'KeyF';
  const handleSourceKey = (event: KeyboardEvent): boolean => {
    if (suggestions.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      setSuggestionIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
      return true;
    }
    if (suggestions.length && (event.key === 'Enter' || event.key === 'Tab')) { chooseSuggestion(suggestions[suggestionIndex]!); return true; }
    if (suggestions.length && event.key === 'Escape') { setSuggestions([]); return true; }
    if ((event.ctrlKey || event.metaKey) && event.key === ' ') { openSuggestions('all'); return true; }
    if (isFormatKey(event)) { formatCode(); return true; }
    // Esc leaves the source for Close (WCAG 2.1.2), so a second Esc closes the panel.
    if (event.key === 'Escape') {
      (event.target as HTMLElement).closest('.ofk-panel')?.querySelector<HTMLElement>('.ofk-panel-header button')?.focus();
      return true;
    }
    return false;
  };
  return (
    <Panel title="Diagram as code" onClose={onClose} autoFocus={autoFocus} className="ofk-v2-workspace-panel ofk-v2-code-panel"
      onKeyDown={(event) => {
        // ⌘↵, ⌘⇧M and ⇧⌥F work from anywhere in the panel, not only inside the source.
        // A key the source already handled (⌘↵ accepting a suggestion) is not a second command.
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (isFormatKey(event)) { event.preventDefault(); formatCode(); return; }
        if (!(event.metaKey || event.ctrlKey)) return;
        if (event.shiftKey && event.key.toLowerCase() === 'm' && convertFrom) { event.preventDefault(); convertFrom.convert(); }
        else if (event.key === 'Enter') { event.preventDefault(); if (!generating && code.trim()) onGenerate(); }
      }}>
      <div className="ofk-v2-panel-stack">
        <div className="ofk-code-caption"><span>Source</span><span>Paste OpenFlowKit, Mermaid, Structurizr or D2</span>
          <Button onClick={formatCode} busy={formatting} disabled={formatting || !code.trim()} title={`Format source (${platformKeys('⇧⌥F')})`}>
            <Icon icon={IconIndentIncrease} /> Format <kbd>{platformKeys('⇧⌥F')}</kbd>
          </Button>
        </div>
        {formatError ? <p className="ofk-v2-code-warning" role="status">{formatError}</p> : null}
        {canvasEdited ? <p className="ofk-v2-code-warning" role="status">Canvas edited — regenerate will overwrite those changes.</p> : null}
        {convertFrom ? (
          <div className="ofk-v2-code-mermaid" role="status">
            <Icon icon={IconTransform} />
            <span>{convertFrom.label} detected. Generate converts it.</span>
            <Button onClick={convertFrom.convert}>Convert <kbd>{platformKeys('⌘⇧M')}</kbd></Button>
          </div>
        ) : null}
        <div className="ofk-v2-code-editor-wrap">
          <V2SourceEditor ref={editorRef} value={code} onChange={(value) => { setFormatError(null); onCodeChange(value); }}
            onOpenBracket={() => openSuggestions('attrs')} onKey={handleSourceKey} diagnostics={errors}
            autoFocus={autoFocus} selectAll={selectAll} placeholder={'flowchart\nStart -> Build -> Ship\nBuild [diamond]'}
            contentAttributes={{
              id: 'v2-code', 'aria-label': 'Diagram source', 'aria-autocomplete': 'list',
              'aria-describedby': errors.length ? 'v2-code-keys v2-code-diagnostics' : 'v2-code-keys',
              ...(errors.some((item) => item.severity === 'error') ? { 'aria-invalid': 'true' } : {}),
              ...(suggestions.length ? { 'aria-controls': 'v2-code-suggestions' } : {}),
            }} />
          <span id="v2-code-keys" className="ofk-visually-hidden">Tab indents, Shift+Tab outdents. Esc leaves the editor.</span>
          {suggestions.length ? <div id="v2-code-suggestions" role="listbox" className="ofk-v2-code-suggestions">
            {suggestions.slice(0, 12).map((suggestion, index) => <button type="button" role="option" aria-selected={index === suggestionIndex} key={suggestion} onPointerDown={(event) => event.preventDefault()} onClick={() => chooseSuggestion(suggestion)}>{suggestion}</button>)}
          </div> : null}
        </div>
        <div id="v2-code-diagnostics" className="ofk-v2-code-diagnostics" aria-live="polite" hidden={errors.length === 0}>
          {errors.slice(0, 8).map((item, index) => (
            <button type="button" key={`${item.line}:${item.col}:${item.code}:${index}`} data-tone={item.severity} onClick={() => {
              editorRef.current?.selectRange(item.line, item.col, item.endCol);
            }}><span>{item.code}</span><strong>Line {item.line}</strong>{item.message}</button>
          ))}
        </div>
        <footer className="ofk-v2-panel-footer ofk-v2-code-footer">
          <span className="ofk-code-palette-label">Diagram palette, applied on Generate</span>
          <Segmented<DiagramPaletteName> label="Diagram palette" value={palette}
            onChange={onPaletteChange}
            options={DIAGRAM_PALETTES.map(({ id, label, hint }) => ({ value: id, label, title: hint }))} />
          <Button variant="primary" onClick={onGenerate} busy={generating} disabled={generating || !code.trim()}>
            <Icon icon={IconPlayerPlay} /> {generating ? 'Generating…' : 'Generate diagram'} <kbd>{platformKeys('⌘↵')}</kbd>
          </Button>
          {errors.length ? <p>{convertFrom ? 'Fix the marked lines to convert.' : 'Bad lines are skipped; the rest still renders.'}</p> : null}
        </footer>
      </div>
    </Panel>
  );
}
