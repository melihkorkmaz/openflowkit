import type { DslAttribute, DslDiagnostic } from '../../ast';
import { tokenDiagnostic } from '../../diagnostics';
import { canonicalizeAttributes, readAttributes } from '../../attributes';
import type { CanonicalAttribute } from '../../sceneMeta';
import { joinTokens, type DslSegment } from '../../segments';
import { slugifyDslId } from '../../text';
import type { DslToken } from '../../tokenize';
import {
  ELEMENT_KINDS,
  type ArchModel,
  type ElementKind,
  type FlowStepKind,
} from '../../model/types';

export interface Block {
  readonly tokens: readonly DslToken[];
  readonly children: Block[];
  readonly segment: DslSegment;
}

/** Unknown blocks round-trip whole, braces and children included. */
export function blockLines(block: Block, indent = ''): string[] {
  const head = joinTokens(block.tokens);
  if (block.children.length === 0) return [`${indent}${head}`];
  return [
    `${indent}${head} {`,
    ...block.children.flatMap((child) => blockLines(child, `${indent}  `)),
    `${indent}}`,
  ];
}

export function blockTree(segments: readonly DslSegment[]): Block[] {
  const roots: Block[] = [];
  const stack: Block[][] = [roots];
  for (const segment of segments) {
    if (segment.tokens[0]?.kind === 'comment') continue;
    if (segment.closes) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (segment.tokens.length === 0) continue;
    const block: Block = { tokens: segment.tokens, children: [], segment };
    stack.at(-1)!.push(block);
    if (segment.opens) stack.push(block.children);
  }
  return roots;
}

/** Tags read back from a `where` clause: `@ core` → `@core`, bare `core` → `@core`. */
export function joinTagValue(tokens: readonly DslToken[]): string {
  const text = joinTokens(tokens).replace(/@\s+/g, '@');
  return text.startsWith('@') ? text : `@${text}`;
}

/** `@core` is two tokens (`@` + word); fold them into tags and hand back the rest. */
export function extractTags(tokens: readonly DslToken[]): { tokens: DslToken[]; tags: string[] } {
  const out: DslToken[] = [];
  const tags: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.value === '@' && tokens[index + 1]?.kind === 'word') {
      tags.push(tokens[index + 1]!.value);
      index += 1;
      continue;
    }
    out.push(token);
  }
  return { tokens: out, tags };
}

/**
 * Canonical attribute list with model semantics: a `tags:` value may carry a
 * comma-separated list, so bare entries after it are tags, not attributes.
 */
export function canonicalAttributesWithTags(
  attributes: readonly DslAttribute[],
  sugar: readonly string[] = [],
): { attributes: CanonicalAttribute[]; tags: string[] } {
  const tags = new Set(sugar.map((tag) => tag.toLowerCase()));
  const kept: DslAttribute[] = [];
  let inTags = false;
  const addTags = (value: string) => {
    for (const part of value.split(',').map((entry) => entry.trim()).filter(Boolean)) tags.add(part.toLowerCase());
  };
  for (const attribute of attributes) {
    if (attribute.key) {
      inTags = attribute.key.toLowerCase() === 'tags';
      if (inTags) addTags(attribute.value);
      else kept.push(attribute);
      continue;
    }
    if (inTags) addTags(attribute.value);
    else kept.push(attribute);
  }
  return { attributes: canonicalizeAttributes(kept, []), tags: [...tags] };
}

/** Attributes with a typed home on `ArchElement`; the rest stay in `attrs`. */
export const TYPED_ELEMENT_KEYS = new Set(['tech', 'desc', 'doc', 'link', 'icon', 'color']);
export const TYPED_RELATION_KEYS = new Set(['label', 'tech', 'link']);

export function splitAttributes(
  attributes: readonly CanonicalAttribute[],
  typed: ReadonlySet<string>,
): { values: Map<string, string>; attrs: CanonicalAttribute[] } {
  const values = new Map<string, string>();
  const attrs: CanonicalAttribute[] = [];
  for (const attribute of attributes) {
    const key = attribute.key?.toLowerCase();
    if (key && typed.has(key)) {
      if (!values.has(key)) values.set(key, attribute.value);
      continue;
    }
    attrs.push(attribute);
  }
  return { values, attrs };
}

export interface RelationDraft {
  readonly env?: string;
  readonly scope: string | null;
  readonly line: number;
  readonly from: string;
  readonly to: string;
  readonly label?: string;
  readonly tech?: string;
  readonly link?: string;
  readonly tags: readonly string[];
  readonly attrs?: readonly CanonicalAttribute[];
}

export interface Declaration {
  readonly localId: string;
  readonly name: string;
  readonly kind: ElementKind;
  readonly tags: string[];
  readonly attrs: readonly CanonicalAttribute[];
  readonly line: number;
  readonly first: DslToken;
}

/** `<kind> Name [attrs]` or `id = <kind> Name [attrs]`; null when the line is not a declaration. */
export function readDeclaration(tokens: readonly DslToken[], diagnostics: DslDiagnostic[]): Declaration | null {
  const { tokens: cleaned, tags: sugar } = extractTags(tokens);
  if (cleaned.length === 0) return null;
  const open = cleaned.findIndex((token) => token.value === '[');
  const head = open >= 0 ? cleaned.slice(0, open) : cleaned;
  let explicitId: string | undefined;
  let rest = head;
  if (head[1]?.value === '=') {
    explicitId = head[0]!.value;
    rest = head.slice(2);
  }
  const kind = rest[0]?.value;
  if (!kind || !(ELEMENT_KINDS as readonly string[]).includes(kind)) return null;
  const name = joinTokens(rest.slice(1));
  if (!name) return null;
  const parsed = readAttributes(cleaned, diagnostics);
  const { attributes, tags } = canonicalAttributesWithTags(parsed.attributes, sugar);
  const wanted = explicitId ?? slugifyDslId(name);
  const localId = /^[A-Za-z_][A-Za-z0-9_-]*$/.test(wanted) ? wanted : slugifyDslId(wanted);
  if (explicitId && localId !== explicitId) {
    diagnostics.push(tokenDiagnostic('W120', 'warning', cleaned[0], `Invalid explicit id ${explicitId}; slugified as ${localId}`));
  }
  return { localId, name, kind: kind as ElementKind, tags, attrs: attributes, line: cleaned[0]!.line, first: cleaned[0]! };
}

/** IcePanel's step vocabulary in DSL spelling; `alt`/`par` are the short forms. */
export const FLOW_KEYWORDS: Readonly<Record<string, FlowStepKind | 'step'>> = {
  step: 'step', alt: 'alternate', par: 'parallel', note: 'info',
};

export interface ArchitectureWorkspace {
  readonly model: ArchModel;
  /** Lines the parser could not honour, kept for the serializer's `reserved` tail. */
  readonly reserved: readonly string[];
}

/** True when the text uses at least one C4 construct. */
export function isArchitectureWorkspace(segments: readonly DslSegment[]): boolean {
  return blockTree(segments).some((root) => {
    const first = root.tokens[0]?.value;
    if (first === 'model' || first === 'views' || first === 'deployment' || first === 'workspace') return true;
    return first === 'flow' && root.tokens.length > 1;
  });
}

