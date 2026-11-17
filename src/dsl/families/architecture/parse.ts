import type { DslDiagnostic, DslDirection, DslEdge } from '../../ast';
import { tokenDiagnostic } from '../../diagnostics';
import { joinTokens, type DslSegment } from '../../segments';
import { slugifyDslId } from '../../text';
import { attributeSlot, DIRECTIONS } from '../../vocabulary';
import type { DslToken } from '../../tokenize';
import {
  ELEMENT_KINDS,
  FLOW_STEP_KINDS,
  VIEW_KINDS,
  type ArchElement,
  type ArchFlow,
  type ArchView,
  type FlowStep,
  type FlowStepKind,
  type ViewKind,
  type ViewRule,
  type ViewRuleWhere,
} from '../../model/types';
import { parseEdge } from '../graph/parse';
import {
  FLOW_KEYWORDS,
  TYPED_ELEMENT_KEYS,
  TYPED_RELATION_KEYS,
  blockLines,
  blockTree,
  canonicalAttributesWithTags,
  extractTags,
  isArchitectureWorkspace,
  joinTagValue,
  readDeclaration,
  splitAttributes,
  type ArchitectureWorkspace,
  type Block,
  type Declaration,
  type RelationDraft,
} from './parseHelpers';
import { resolveWorkspaceDraft } from './parseResolve';

/**
 * The C4 block parser (grammar §9): `model`, `deployment`, `views` and `flow`
 * blocks with real semantics. Plain graph lines are still handled by the graph
 * engine — `parseArchitectureWorkspace` returns null when no C4 block appears.
 *
 * Two passes: declarations land first (element paths, views, flows), then every
 * reference resolves against the finished tree, so relations may precede their
 * targets (and Structurizr's scoped `-> B` works).
 */

export function parseArchitectureWorkspace(
  segments: readonly DslSegment[],
  diagnostics: DslDiagnostic[],
): ArchitectureWorkspace | null {
  const roots = blockTree(segments);
  if (!isArchitectureWorkspace(segments)) return null;

  const elements: ArchElement[] = [];
  const views: ArchView[] = [];
  const flowDrafts: Array<{ flow: ArchFlow; refs: Map<FlowStep, { from: string; to: string }> }> = [];
  const reserved: string[] = [];
  const usedIds = new Set<string>();
  const pendingRelations: RelationDraft[] = [];
  const pendingInstances: Array<{ element: ArchElement; ref: string; line: number }> = [];
  let stepCounter = 0;
  let modelName: string | undefined;

  const uniquePath = (parent: string | null, localId: string): string => {
    const base = parent ? `${parent}.${localId}` : localId;
    let candidate = base;
    let suffix = 2;
    while (usedIds.has(candidate)) candidate = `${base}-${suffix++}`;
    usedIds.add(candidate);
    return candidate;
  };

  const declare = (declaration: Declaration, parent: string | null, extra: Partial<ArchElement> = {}): ArchElement => {
    const typed = splitAttributes(declaration.attrs, TYPED_ELEMENT_KEYS);
    // A bare colour (`[#08427b]`, `[blue]`) is the canonical spelling of `color:`: the text writes it back that way.
    const bareColor = typed.attrs.find((entry) => !entry.key && attributeSlot(entry) === 'color');
    if (bareColor && typed.values.has('color')) {
      diagnostics.push(tokenDiagnostic('W130', 'warning', declaration.first, 'Two color attributes; `color:` wins'));
    } else if (bareColor) typed.values.set('color', bareColor.value);
    const kept = typed.attrs.filter((entry) => entry !== bareColor);
    if (kept.some((entry) => entry.key === 'iconpos')) {
      diagnostics.push(tokenDiagnostic('W131', 'warning', declaration.first, 'iconpos applies to icon cards, not model elements; kept, no effect'));
    }
    // `store` implies `cylinder` (§14.17 says it is emitted) so v1 renderers agree.
    const attrs = declaration.kind === 'store' && !kept.some((entry) => entry.value === 'cylinder')
      ? [{ value: 'cylinder' } as const, ...kept]
      : kept;
    const element: ArchElement = {
      id: uniquePath(parent, declaration.localId),
      kind: declaration.kind,
      name: declaration.name,
      parent,
      tags: declaration.tags,
      ...(typed.values.has('tech') ? { tech: typed.values.get('tech')! } : {}),
      ...(typed.values.has('desc') ? { desc: typed.values.get('desc')! } : {}),
      ...(typed.values.has('doc') ? { doc: typed.values.get('doc')! } : {}),
      links: declaration.attrs.filter((entry) => entry.key === 'link').map((entry) => entry.value),
      ...(typed.values.has('icon') ? { icon: typed.values.get('icon')! } : {}),
      ...(typed.values.has('color') ? { color: typed.values.get('color')! } : {}),
      ...(attrs.length ? { attrs } : {}),
      line: declaration.line,
      ...extra,
    };
    elements.push(element);
    return element;
  };

  const declareRelation = (scope: string | null, edge: DslEdge, env?: string): void => {
    const { attributes, tags } = canonicalAttributesWithTags(edge.attributes, []);
    const typed = splitAttributes(attributes, TYPED_RELATION_KEYS);
    const draft: RelationDraft = {
      scope, line: edge.line, tags, ...(env ? {env} : {}),
      from: edge.from.id ?? edge.from.label,
      to: edge.to.id ?? edge.to.label,
      ...(edge.label ?? typed.values.get('label') ? { label: edge.label ?? typed.values.get('label')! } : {}),
      ...(typed.values.has('tech') ? { tech: typed.values.get('tech')! } : {}),
      ...(typed.values.has('link') ? { link: typed.values.get('link')! } : {}),
      ...(typed.attrs.length ? { attrs: typed.attrs } : {}),
    };
    pendingRelations.push(draft);
  };

  // ---- model --------------------------------------------------------------

  const walkModel = (blocks: readonly Block[], scope: string | null, env?: string): void => {
    for (const block of blocks) {
      const declaration = readDeclaration(block.tokens, diagnostics);
      if (declaration) {
        const element = declare(declaration, scope, env ? { env } : {});
        if (declaration.kind === 'instance') {
          const reference = joinTokens(extractTags(block.tokens).tokens.slice(1));
          if (reference) pendingInstances.push({ element, ref: reference, line: declaration.line });
        }
        walkModel(block.children, element.id, env);
        continue;
      }
      const edges = parseEdge(block.tokens, diagnostics);
      if (edges) {
        for (const edge of edges) declareRelation(scope, edge, env);
        continue;
      }
      const line = blockLines(block).join('\n');
      if (line) {
        diagnostics.push(tokenDiagnostic('W101', 'warning', block.tokens[0], 'Line could not be read as an element or relation; kept verbatim', 'Try `container Name [tech: …]` or `A -> B : label`'));
        reserved.push(line);
      }
    }
  };

  // ---- deployment ---------------------------------------------------------

  const walkDeployment = (block: Block, env: string, parentId: string | null): void => {
    const declaration = readDeclaration(block.tokens, diagnostics);
    if (!declaration) {
      const edges = parseEdge(block.tokens, diagnostics);
      if (edges) {
        for (const edge of edges) declareRelation(parentId, edge, env);
        return;
      }
      diagnostics.push(tokenDiagnostic('W101', 'warning', block.tokens[0], 'Deployment node needs a name; kept verbatim'));
      const line = blockLines(block).join('\n');
      if (line) reserved.push(line);
      return;
    }
    const element = declare(declaration, parentId, { env });
    walkModel(block.children, element.id, env);
  };

  // ---- views --------------------------------------------------------------

  const attributeDirection = (token: DslToken): DslDirection | undefined =>
    token.kind === 'word' ? DIRECTIONS[token.value.toLowerCase()] : undefined;

  const parseRule = (block: Block): ViewRule | null => {
    const tokens = block.tokens;
    const op = tokens[0]?.value;
    if (op !== 'include' && op !== 'exclude') {
      diagnostics.push(tokenDiagnostic('W160', 'warning', tokens[0], 'Unsupported view statement; kept verbatim'));
      return { op: 'include', subject: '', raw: joinTokens(tokens), line: tokens[0]?.line ?? 1 };
    }
    const raw = joinTokens(tokens);
    const arrowAt = tokens.findIndex((token, index) => index > 0 && token.kind === 'arrow');
    const whereAt = tokens.findIndex((token, index) => index > 0 && token.value.toLowerCase() === 'where');
    const end = whereAt < 0 ? tokens.length : whereAt;
    const subject = joinTokens(tokens.slice(1, arrowAt < 0 ? end : arrowAt));
    let arrow: ViewRule['arrow'];
    if (arrowAt >= 0) {
      const left = joinTokens(tokens.slice(1, arrowAt));
      const right = joinTokens(tokens.slice(arrowAt + 1, end));
      arrow = { ...(left ? { from: left } : {}), ...(right ? { to: right } : {}) };
      if (!left && !right) return null;
    }
    let where: ViewRule['where'];
    if (whereAt >= 0) {
      const clause = tokens.slice(whereAt + 1);
      const parseWhere = (tokens: readonly DslToken[]): ViewRuleWhere | undefined => {
        // AND binds more tightly than OR. Quoted words are values, never operators.
        for (const [operator, field] of [['or', 'any'], ['and', 'all']] as const) {
          const at = tokens.findIndex((token, index) => index > 2 && tokens[index - 1]?.value !== '@' && tokens[index - 1]?.value !== 'not' && token.kind === 'word' && token.value.toLowerCase() === operator);
          if (at < 0) continue;
          const left = parseWhere(tokens.slice(0, at));
          const right = parseWhere(tokens.slice(at + 1));
          return left && right ? { [field]: [left, right] } : undefined;
        }
        if (tokens[1]?.value.toLowerCase() !== 'is') return undefined;
        const key = tokens[0]?.value.toLowerCase();
        const negated = tokens[2]?.value.toLowerCase() === 'not';
        const values = tokens.slice(negated ? 3 : 2);
        if (!values.length) return undefined;
        if (key === 'kind') {
          const value = joinTokens(values).toLowerCase();
          if (!(ELEMENT_KINDS as readonly string[]).includes(value)) return undefined;
          return negated ? { kindNot: value } : { kind: value };
        }
        if (key === 'tag') return negated ? { tagNot: joinTagValue(values) } : { tag: joinTagValue(values) };
        return undefined;
      };
      where = parseWhere(clause);
      if (!where) {
        diagnostics.push(tokenDiagnostic('W160', 'warning', clause[0], 'Unsupported `where` clause; skipped and kept verbatim'));
        return { op, subject, raw, line: tokens[0]?.line ?? 1 };
      }

    }
    if (!subject && !arrow) return null;
    return { op, subject: arrow ? subject : subject || '*', ...(arrow ? { arrow } : {}), ...(where ? { where } : {}), line: tokens[0]?.line ?? 1 };
  };

  const parseView = (block: Block): ArchView | undefined => {
    const tokens = block.tokens;
    const kind = tokens[1]?.value as ViewKind | undefined;
    if (!kind || !(VIEW_KINDS as readonly string[]).includes(kind)) {
      diagnostics.push(tokenDiagnostic('W160', 'warning', tokens[1] ?? tokens[0], 'Unknown view kind; kept verbatim'));
      reserved.push(blockLines(block).join('\n'));
      return undefined;
    }
    let of: string | undefined;
    let env: string | undefined;
    let direction: DslDirection | undefined;
    // A bracketed `[right]` is a direction hint; bare trailing words work too.
    const bracketed = new Set<number>();
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index]?.value !== '[') continue;
      const close = tokens.findIndex((token, at) => at > index && token.value === ']');
      if (close < 0) continue;
      const candidate = tokens.slice(index + 1, close).map(attributeDirection).find(Boolean);
      if (candidate) {
        direction = candidate;
        for (let at = index; at <= close; at += 1) bracketed.add(at);
      }
    }
    const rest = tokens.slice(2).filter((token, index) => {
      if (bracketed.has(index + 2)) return false;
      const candidate = attributeDirection(token);
      if (candidate && tokens[index + 3]?.value !== ']') {
        direction = candidate;
        return false;
      }
      return true;
    });
    // Quoted names are string tokens but still name the scope (`of "Docs Site"`).
    const words = rest;
    const strings = rest.filter((token) => token.kind === 'string');
    const ofAt = words.findIndex((token) => token.value.toLowerCase() === 'of');
    const inAt = words.findIndex((token) => token.value.toLowerCase() === 'in');
    // `of Shop.Web` is one token; `of API Gateway` is a display name, so a
    // multi-word reference joins with spaces and resolves by name.
    if (ofAt >= 0) of = words.slice(ofAt + 1, inAt > ofAt ? inAt : words.length).map((token) => token.value).join(' ');
    if (inAt >= 0) env = words.slice(inAt + 1).map((token) => token.value).join(' ');
    const name = kind === 'custom'
      ? strings[0]?.value ?? of ?? 'Custom view'
      : of ? `${kind} of ${of}` : kind === 'deployment' && env ? `deployment in ${env}` : kind === 'landscape' ? 'Landscape' : kind;
    const rules = block.children.map(parseRule).filter((rule): rule is ViewRule => rule !== null);
    const id = kind === 'custom'
      ? `view:custom:${slugifyDslId(name)}`
      : kind === 'deployment'
        ? `view:deployment:${slugifyDslId(of ?? '')}:${slugifyDslId(env ?? '')}`
        : kind === 'landscape'
          ? 'view:landscape'
          : `view:${kind}:${slugifyDslId(of ?? '')}`;
    return {
      id, kind, name, rules,
      ...(of ? { of } : {}),
      ...(env ? { env } : {}),
      ...(direction ? { direction } : {}),
      line: tokens[0]!.line,
    };
  };

  // ---- flows --------------------------------------------------------------

  const walkFlow = (block: Block): void => {
    const flowName = joinTokens(block.tokens.slice(1)) || `Flow ${flowDrafts.length + 1}`;
    const flowId = `flow:${slugifyDslId(flowName)}`;
    const refs = new Map<FlowStep, { from: string; to: string }>();
    const steps = parseFlowBlocks(block.children, flowId, null, refs);
    flowDrafts.push({ flow: { id: flowId, name: flowName, steps, line: block.tokens[0]!.line }, refs });
  };

  const parseFlowBlocks = (
    blocks: readonly Block[], flowId: string, scope: string | null, refs: Map<FlowStep, { from: string; to: string }>,
  ): FlowStep[] => {
    const steps: FlowStep[] = [];
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!;
      const first = block.tokens[0]?.value.toLowerCase() ?? '';
      if (first === 'else' || first === 'and') continue;
      const { tokens: cleaned, tags } = extractTags(block.tokens);
      const keyword = FLOW_KEYWORDS[first] ?? first;
      const kinds = FLOW_STEP_KINDS as readonly string[];
      stepCounter += 1;
      const id = `${flowId}.s${stepCounter}`;
      if ((keyword === 'alternate' || keyword === 'parallel') && block.segment.opens) {
        const label = joinTokens(cleaned.slice(1));
        const branches: Array<{ label?: string; steps: FlowStep[] }> = [];
        const firstBranch = keyword === 'alternate' ? (label ? { label } : {}) : {};
        branches.push({ ...firstBranch, steps: parseFlowBlocks(block.children, flowId, scope, refs) });
        // `else { … }` / `and { … }` are siblings of the opener.
        while (blocks[index + 1] && ['else', 'and'].includes(blocks[index + 1]!.tokens[0]?.value.toLowerCase() ?? '')) {
          index += 1;
          const sibling = blocks[index]!;
          const siblingLabel = joinTokens(sibling.tokens.slice(1));
          branches.push({ ...(siblingLabel ? { label: siblingLabel } : {}), steps: parseFlowBlocks(sibling.children, flowId, scope, refs) });
        }
        steps.push({ id, kind: keyword as FlowStepKind, tags, ...(label ? { label } : {}), branches, line: block.tokens[0]!.line });
        continue;
      }
      if (keyword === 'goto') {
        const target = joinTokens(cleaned.slice(1));
        if (target) steps.push({ id, kind: 'goto', tags, goto: target, line: block.tokens[0]!.line });
        continue;
      }
      if (keyword === 'message' || keyword === 'step') {
        const edges = parseEdge(cleaned.slice(1), diagnostics);
        if (edges && edges.length > 0) {
          const edge = edges[0]!;
          const step: FlowStep = {
            id, kind: 'message', tags,
            from: edge.from.id ?? edge.from.label, to: edge.to.id ?? edge.to.label,
            ...(edge.label ? { label: edge.label } : {}),
            line: edge.line,
          };
          refs.set(step, { from: step.from!, to: step.to! });
          steps.push(step);
          continue;
        }
        diagnostics.push(tokenDiagnostic('W101', 'warning', block.tokens[0], 'Flow step needs `A -> B` or a label; kept verbatim'));
        continue;
      }
      if (kinds.includes(keyword)) {
        const text = joinTokens(cleaned.slice(1));
        steps.push({
          id, kind: keyword as FlowStepKind, tags,
          ...(text ? { label: text } : {}),
          line: block.tokens[0]!.line,
        });
        continue;
      }
      diagnostics.push(tokenDiagnostic('W160', 'warning', block.tokens[0], 'Unsupported flow statement; kept verbatim'));
      reserved.push(joinTokens(block.tokens));
    }
    return steps;
  };

  // ---- assemble -----------------------------------------------------------

  const walkRoot = (block: Block): void => {
    const first = block.tokens[0]?.value;
    if (first === 'workspace') {
      const label = block.tokens.find((token) => token.kind === 'string');
      if (label && !modelName) modelName = label.value;
      for (const child of block.children) walkRoot(child);
      return;
    }
    if (first === 'model') {
      const label = block.tokens.find((token) => token.kind === 'string');
      if (label && !modelName) modelName = label.value;
      walkModel(block.children, null);
      return;
    }
    if (first === 'deployment') {
      const envName = joinTokens(block.tokens.slice(1)) || 'Production';
      for (const child of block.children) walkDeployment(child, envName, null);
      return;
    }
    if (first === 'views') {
      for (const child of block.children) {
        if (child.tokens[0]?.value === 'view') {
          const view = parseView(child);
          if (view) views.push(view);
        } else {
          diagnostics.push(tokenDiagnostic('W160', 'warning', child.tokens[0], 'Only `view …` lines belong in `views`; kept verbatim'));
          reserved.push(blockLines(child).join('\n'));
        }
      }
      return;
    }
    if (first === 'view') {
      const view = parseView(block);
      if (view) views.push(view);
      return;
    }
    if (first === 'flow') {
      walkFlow(block);
      return;
    }
    if (first?.startsWith('!')) return;
    const declaration = readDeclaration(block.tokens, diagnostics);
    if (declaration) {
      walkModel([block], null);
      return;
    }
    const edges = parseEdge(block.tokens, diagnostics);
    if (edges) {
      for (const edge of edges) declareRelation(null, edge);
      return;
    }
    const line = blockLines(block).join('\n');
    if (line) reserved.push(line);
  };
  for (const root of roots) walkRoot(root);

  return resolveWorkspaceDraft(
    { elements, views, flowDrafts, pendingRelations, pendingInstances, reserved, modelName },
    diagnostics,
  );
}
