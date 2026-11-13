import { DSL_FAMILIES } from './ast';
import { tokenize } from './tokenize';

/** IDE-style roles for one source line; the editor colours each one. */
export type HighlightKind =
  | 'keyword' | 'name' | 'id' | 'key' | 'value' | 'number' | 'color' | 'label'
  | 'string' | 'comment' | 'arrow' | 'bracket' | 'brace' | 'punctuation' | 'meta';

export interface HighlightSpan {
  readonly kind: HighlightKind;
  /** 0-based, end exclusive, within the line. */
  readonly from: number;
  readonly to: number;
}

// grammar.md §2.5, plus the common heads of pasted Mermaid, Structurizr and D2.
const KEYWORDS = new Set([
  'flowchart', 'architecture', 'sequence', 'state', 'erd', 'class', 'mindmap', 'gitgraph', 'bpmn', 'org', 'gantt',
  'wireframe', 'chart', 'sankey', 'journey', 'timeline',
  'title', 'direction', 'appearance', 'icons', 'autonumber', 'legend', 'align', 'animate', 'step', 'hold',
  'group', 'note', 'participant', 'activate', 'deactivate', 'loop', 'alt', 'else', 'opt', 'par', 'and', 'break',
  'fork', 'join', 'choice', 'commit', 'branch', 'checkout', 'switch', 'merge', 'cherry-pick', 'central',
  'model', 'views', 'view', 'person', 'system', 'container', 'component', 'store', 'queue', 'external', 'deployment',
  'node', 'instance', 'flow', 'goto', 'include', 'exclude', 'extends', 'rank', 'pin',
  'graph', 'subgraph', 'end', 'classDef', 'style', 'linkStyle', 'click', 'sequenceDiagram', 'stateDiagram',
  'stateDiagram-v2', 'classDiagram', 'erDiagram', 'actor', 'workspace', 'softwareSystem', 'systemContext',
  'autoLayout', 'styles', 'element', 'relationship', 'vars',
]);
// The word after a family head is its direction (`flowchart right`, `graph TD`).
const HEADS = new Set([...DSL_FAMILIES, 'graph']);
const NUMBER = /^-?\d+(?:\.\d+)?(?:px|%)?$/;
const HEX = /^#[0-9a-f]{3,8}$/i;

/** Classifies a line by position: keywords open a statement, `[…]` holds keys and values, `:` starts a label. */
export function highlightLine(text: string): HighlightSpan[] {
  if (text.trimStart().startsWith('%%')) return text.trim() ? [{ kind: 'meta', from: text.length - text.trimStart().length, to: text.length }] : [];
  const tokens = tokenize(text).tokens;
  const spans: HighlightSpan[] = [];
  let statementStart = true;
  let inBracket = false;
  let label = false;
  let afterKey = false;
  tokens.forEach((token, index) => {
    const from = token.col - 1;
    const to = token.endCol - 1;
    const next = tokens[index + 1];
    const push = (kind: HighlightKind) => spans.push({ kind, from, to });
    if (token.kind === 'comment' || token.kind === 'string' || token.kind === 'arrow') {
      push(token.kind);
      if (token.kind === 'arrow') label = false;
      statementStart = false;
      return;
    }
    if (token.kind === 'punctuation') {
      const char = token.value;
      push(char === '[' || char === ']' ? 'bracket' : char === '{' || char === '}' ? 'brace' : 'punctuation');
      if (char === '[') { inBracket = true; afterKey = false; }
      else if (char === ']') inBracket = false;
      else if (char === ',') afterKey = false;
      else if (char === ':') { if (inBracket) afterKey = true; else if (!statementStart) label = true; }
      statementStart = char === ';' || char === '{';
      if (statementStart) label = false;
      return;
    }
    const value = token.value;
    const nextChar = next?.kind === 'punctuation' ? next.value : '';
    if (inBracket) {
      if (nextChar === ':' && !afterKey) push('key');
      else push(HEX.test(value) ? 'color' : NUMBER.test(value) ? 'number' : 'value');
    } else if (statementStart && value === '-' && next?.kind === 'word') {
      push('punctuation');
      return;
    } else if (statementStart && KEYWORDS.has(value)) {
      push('keyword');
    } else if (label) {
      push(HEX.test(value) ? 'color' : NUMBER.test(value) ? 'number' : 'label');
    } else if (nextChar === '=') {
      push('id');
    } else if (index === 1 && HEADS.has(tokens[0]!.value)) {
      push('value');
    } else {
      push(HEX.test(value) ? 'color' : NUMBER.test(value) ? 'number' : 'name');
    }
    statementStart = false;
  });
  return spans;
}
