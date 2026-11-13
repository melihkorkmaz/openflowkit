import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { tokenize } from '../../../dsl/tokenize';
import { searchIcons } from '../../../services/shapeLibrary/iconSearch';
import { loadProviderShapePreview } from '../../../services/shapeLibrary/providerCatalog';
import type { IconChoice } from '../../domain/nodes/iconNode';

/** Only the current icon attribute is replaced; adjacent attributes and quoted labels stay intact. */
export function iconValueAt(line: string, column: number): { from: number; to: number; query: string } | null {
  const { tokens } = tokenize(line.slice(0, column));
  if (tokens.some((token) => token.kind === 'comment')) return null;
  const bracket = tokens.findLastIndex((token) => token.kind === 'punctuation' && (token.value === '[' || token.value === ']'));
  if (bracket < 0 || tokens[bracket]!.value !== '[') return null;
  const field = tokens.slice(bracket + 1);
  const comma = field.findLastIndex((token) => token.kind === 'punctuation' && token.value === ',');
  const attribute = field.slice(comma + 1);
  if (attribute[0]?.kind !== 'word' || attribute[0].value !== 'icon' || attribute[1]?.value !== ':') return null;
  const start = attribute[1].endCol - 1;
  const before = line.slice(start, column);
  if (!/^[\w/ -]*$/.test(before)) return null;
  const from = start + (before.match(/^\s*/)?.[0].length ?? 0);
  const tail = line.slice(column).match(/^[\w/ -]*/)?.[0].trimEnd() ?? '';
  return { from, to: column + tail.length, query: line.slice(from, column).trim() };
}

interface IconCompletion extends Completion { readonly icon: IconChoice }

export function completeSourceIcon(context: CompletionContext): CompletionResult | null {
  const line = context.state.doc.lineAt(context.pos);
  const value = iconValueAt(line.text, context.pos - line.from);
  if (!value) return null;
  return {
    from: line.from + value.from, to: line.from + value.to, filter: false,
    options: searchIcons(value.query.replaceAll('/', ' '), 'all', 60).icons.map((icon): IconCompletion => ({
      label: `${icon.provider}/${icon.shapeId}`, detail: icon.label, icon,
    })),
  };
}

export const sourceIconCompletion = autocompletion({
  override: [completeSourceIcon], defaultKeymap: false, icons: false, maxRenderedOptions: 30, interactionDelay: 0,
  tooltipClass: () => 'ofk-source-icons',
  addToOptions: [{ position: 20, render: (completion) => {
    const { icon } = completion as IconCompletion;
    const image = document.createElement('img');
    image.className = 'ofk-source-icon-preview';
    image.alt = '';
    void loadProviderShapePreview(icon.packId, icon.shapeId).then((preview) => {
      if (preview) image.src = preview.previewUrl;
    }).catch(() => { /* Names remain selectable if a preview cannot load. */ });
    return image;
  } }],
});
