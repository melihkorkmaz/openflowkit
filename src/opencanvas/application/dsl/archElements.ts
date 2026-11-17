import { projectRelations, selectViewElements } from '../../../dsl/model/predicates';
import { elementNode, relationConnector } from '../../../dsl/families/architecture/scene';
import {
  archFrameOf,
  archModelOfPage,
  archViewIdOfPage,
  createArchIndex,
  elementAncestors,
  elementDescendantIds,
  flattenFlowSteps,
  placedElementId,
} from '../../../dsl/model/model';
import type { ElementKind, ArchElement, ArchModel, ArchView, FlowStep } from '../../../dsl/model/types';
import { nodePaletteName, paletteResolver } from '../../domain/nodes/nodePalette';
import type { DocumentCommand } from '../../domain/commands/types';
import type { SceneDocumentV1, SceneNode, ScenePage } from '../../domain/document/types';
import { buildDeleteSelectionCommand } from '../../domain/commands/sceneEdits';
import { slugifyDslId } from '../../../dsl/text';
import type { IconResolver } from './iconCommands';
import {
  type ArchElementPatch,
  type ModelPage,
  batch,
  isModelPlacement,
  isRecord,
  modelPages,
  pageWithModel,
  setPage,
} from './archPages';

/* --------------------------------------------------------------- elements */

export function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mergeElement(element: ArchElement, patch: ArchElementPatch): ArchElement | null {
  const name = patch.name?.trim() || element.name;
  if (!name.trim()) return null;
  const { tech: _tech, desc: _desc, doc: _doc, color: _color, icon: _icon, ...rest } = element;
  const tech = optional(patch.tech ?? element.tech);
  const desc = optional(patch.desc ?? element.desc);
  const doc = optional(patch.doc ?? element.doc);
  const color = optional(patch.color ?? element.color);
  const icon = optional(patch.icon ?? element.icon);
  const tags = (patch.tags ?? element.tags).map((tag) => tag.trim().toLowerCase()).filter(Boolean);
  const links = (patch.links ?? element.links).map((link) => link.trim()).filter(Boolean);
  const merged: ArchElement = {
    ...rest, name, tags, links,
    ...(tech ? { tech } : {}),
    ...(desc ? { desc } : {}),
    ...(doc ? { doc } : {}),
    ...(color ? { color } : {}),
    ...(icon ? { icon } : {}),
  };
  const unchanged = (['name', 'tech', 'desc', 'doc', 'color', 'icon'] as const).every((key) => merged[key] === element[key])
    && JSON.stringify(merged.tags) === JSON.stringify(element.tags)
    && JSON.stringify(merged.links) === JSON.stringify(element.links);
  return unchanged ? null : merged;
}

/** Rename or edit one element; every page that places it follows, ids stay stable. */
export function buildArchElementEditCommand(
  document: SceneDocumentV1,
  elementId: string,
  patch: ArchElementPatch,
  resolveIcon?: IconResolver,
): DocumentCommand | null {
  const pages = modelPages(document, elementId);
  const source = pages[0];
  if (!source) return null;
  const element = source.model.elements.find((candidate) => candidate.id === elementId);
  if (!element) return null;
  const merged = mergeElement(element, patch);
  if (!merged) return null;
  const next: ArchModel = {
    ...source.model,
    elements: source.model.elements.map((candidate) => candidate.id === elementId ? merged : candidate),
  };
  const label = patch.name !== undefined && merged.name !== element.name ? 'Rename element' : 'Edit element';
  const commands = pages.map(({ page }) => setPage(page, pageWithModel(page, next, resolveIcon), `model-edit:${elementId}`, label));
  return commands.length === 1 ? commands[0]! : batch('model-edit', label, commands);
}

/** The kind a new element takes under `parentKind` (null = top level); null when that parent cannot hold children. */
export function defaultChildKind(parentKind: ElementKind | null): ElementKind | null {
  if (parentKind === null) return 'system';
  if (parentKind === 'system') return 'container';
  if (parentKind === 'container') return 'component';
  return null;
}

interface ArchElementAdd {
  readonly parentId: string | null;
  readonly kind: ElementKind;
  readonly name: string;
}

/** The view a page draws, the implicit landscape included. */
function pageView(model: ArchModel, page: ScenePage): ArchView | null {
  const viewId = archViewIdOfPage(page);
  if (!viewId) return null;
  return model.views.find((view) => view.id === viewId)
    ?? (viewId === 'view:landscape' ? { id: viewId, kind: 'landscape', name: 'Landscape', rules: [] } : null);
}

const PLACE_GAP = 40;
const PLACE_PADDING = { top: 72, right: 28, bottom: 52, left: 28 };

/**
 * Draws one element on a view page without touching its layout: inside the element's nearest boundary on the page
 * (else the view frame), below what is already there, with connectors to the elements already drawn. Every node on
 * the page keeps its transform; only the boundaries it lands in grow to hold it. An element whose parent is drawn as
 * a plain card is left off (drawing it would turn that card into a boundary: a Generate does that).
 */
function placeElement(page: ScenePage, model: ArchModel, elementId: string, resolveIcon?: IconResolver): ScenePage {
  const frame = archFrameOf(page);
  const index = createArchIndex(model);
  const element = index.byId.get(elementId);
  const byElement = new Map(page.nodes.flatMap((node) => {
    const id = placedElementId(node);
    return id ? [[id, node] as const] : [];
  }));
  if (!frame || !element || byElement.has(elementId)) return page;
  let parent: SceneNode = frame;
  for (const ancestor of elementAncestors(index, elementId)) {
    const drawn = byElement.get(ancestor);
    if (!drawn) continue;
    if (drawn.kind !== 'frame') return page;
    parent = drawn;
    break;
  }
  const siblings = page.nodes.filter((node) => node.parentId === parent.id);
  const x = siblings.length ? Math.min(...siblings.map((node) => node.transform.translation.x)) : PLACE_PADDING.left;
  const y = siblings.length ? Math.max(...siblings.map((node) => node.transform.translation.y + node.size.height)) + PLACE_GAP : PLACE_PADDING.top;
  const swatch = paletteResolver(nodePaletteName(frame));
  const zIndex = Math.max(0, ...page.nodes.map((node) => node.zIndex)) + 1;
  const drawn = elementNode(element, parent.id, zIndex, { origin: { x, y }, swatch, ...(resolveIcon ? { resolveIcon } : {}) });
  // Grow each container up the chain just enough to hold what is inside it; positions never move.
  const sizes = new Map<string, SceneNode['size']>();
  const byId = new Map(page.nodes.map((node) => [node.id, node]));
  let child: Pick<SceneNode, 'transform' | 'size'> = drawn;
  for (let host: SceneNode | undefined = parent; host; host = host.parentId ? byId.get(host.parentId) : undefined) {
    const size = sizes.get(host.id) ?? host.size;
    const width = Math.max(size.width, child.transform.translation.x + child.size.width + PLACE_PADDING.right);
    const height = Math.max(size.height, child.transform.translation.y + child.size.height + PLACE_PADDING.bottom);
    if (width === size.width && height === size.height) break;
    sizes.set(host.id, { width, height });
    child = { transform: host.transform, size: { width, height } };
  }
  const nodeOf = (id: string) => (id === elementId ? drawn : byElement.get(id))?.id ?? id;
  const shown = new Set([...byElement.keys(), elementId]);
  const drawnConnectors = new Set(page.connectors.map((connector) => connector.id));
  const connectors = projectRelations(index, shown)
    .filter((projection) => projection.from === elementId || projection.to === elementId)
    .map((projection) => {
      const connector = relationConnector(projection.relation, projection.from, projection.to, projection.implied);
      return { ...connector, source: { ...connector.source, nodeId: nodeOf(projection.from) }, target: { ...connector.target, nodeId: nodeOf(projection.to) } };
    })
    .filter((connector) => !drawnConnectors.has(connector.id));
  return {
    ...page,
    nodes: [...page.nodes.map((node) => sizes.has(node.id) ? { ...node, size: sizes.get(node.id)! } : node), drawn],
    connectors: [...page.connectors, ...connectors],
  };
}

/**
 * Every page of the model takes `next`; `elementId` is drawn, in place, on each view that now selects it
 * and does not draw it yet. One batch: one undo step.
 */
function modelChangeCommand(
  pages: readonly ModelPage[], next: ArchModel, elementId: string, id: string, label: string, resolveIcon?: IconResolver,
): DocumentCommand {
  const index = createArchIndex(next);
  const commands = pages.map(({ page }) => {
    const view = pageView(next, page);
    const updated = pageWithModel(page, next);
    const shows = view !== null && selectViewElements(index, view).shown.has(elementId);
    return setPage(page, shows ? placeElement(updated, next, elementId, resolveIcon) : updated, id, label);
  });
  return commands.length === 1 ? commands[0]! : batch(id, label, commands);
}

/**
 * Add an element to the model of `pageId`; every page sharing that model follows, so Map and the code text show it,
 * and each view whose rules include it draws it without moving anything else. Returns the new id with the command.
 */
/** `slug` under `parentId`, suffixed -2, -3… until no element has it. */
function freeId(model: ArchModel, parentId: string | null | undefined, slug: string): string {
  const taken = new Set(model.elements.map((element) => element.id));
  const base = `${parentId ? `${parentId}.` : ''}${slug}`;
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  return id;
}

export function buildArchElementAddCommand(
  document: SceneDocumentV1, pageId: string, add: ArchElementAdd, resolveIcon?: IconResolver,
): { command: DocumentCommand; id: string } | null {
  const name = add.name.trim();
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const model = page ? archModelOfPage(page) : null;
  if (!page || !model || !name) return null;
  // ponytail: pages share a model by element overlap, so an empty model is only this page's — match by a model id if empties ever span views.
  const pages = model.elements.length ? modelPages(document, model.elements[0]!.id) : [{ page, model, viewId: archViewIdOfPage(page) }];
  const parent = add.parentId ? model.elements.find((element) => element.id === add.parentId) : null;
  if (add.parentId && (!parent || defaultChildKind(parent.kind) === null)) return null;
  const id = freeId(model, parent?.id, slugifyDslId(name));
  const element: ArchElement = { id, kind: add.kind, name, parent: parent?.id ?? null, tags: [], links: [] };
  const next: ArchModel = { ...model, elements: [...model.elements, element] };
  return { command: modelChangeCommand(pages, next, id, `model-add:${id}`, 'Add element', resolveIcon), id };
}

/** Includes an element in the view `pageId` draws (a view with no rules keeps its implicit `include *`), drawn in place. */
export function buildArchAddToViewCommand(document: SceneDocumentV1, pageId: string, elementId: string, resolveIcon?: IconResolver): DocumentCommand | null {
  const page = document.pages.find((candidate) => candidate.id === pageId);
  const model = page ? archModelOfPage(page) : null;
  const view = model && page ? model.views.find((candidate) => candidate.id === archViewIdOfPage(page)) : undefined;
  if (!model || !view || !model.elements.some((element) => element.id === elementId)) return null;
  const rules = [...(view.rules.length ? view.rules : [{ op: 'include', subject: '*' } as const]), { op: 'include', subject: elementId } as const];
  const next: ArchModel = { ...model, views: model.views.map((candidate) => candidate === view ? { ...view, rules } : candidate) };
  return modelChangeCommand(modelPages(document, elementId), next, elementId, `model-view-add:${elementId}`, 'Add to view', resolveIcon);
}

/**
 * A rename of an element still on the id "Add" gave it (`new-container`, `new-system-2`) moves the id to the new
 * name's slug while no relation, child, view scope or flow uses it; view rules that name it follow. Once referenced,
 * ids stay stable. Every page keeps its layout: the drawn node takes the new id in place. Null keeps the id.
 */
export function buildArchRenameReslugCommand(
  document: SceneDocumentV1, elementId: string, patch: ArchElementPatch, resolveIcon?: IconResolver,
): { command: DocumentCommand; id: string } | null {
  const pages = modelPages(document, elementId);
  const model = pages[0]?.model;
  const element = model?.elements.find((candidate) => candidate.id === elementId);
  const merged = element && patch.name !== undefined ? mergeElement(element, patch) : null;
  if (!model || !element || !merged || merged.name === element.name) return null;
  const local = element.parent ? element.id.slice(element.parent.length + 1) : element.id;
  if (!new RegExp(`^new-${element.kind}(?:-\\d+)?$`).test(local)) return null;
  const referenced = model.elements.some((other) => other.parent === elementId || other.instanceOf === elementId)
    || model.relations.some((relation) => relation.from === elementId || relation.to === elementId)
    || model.views.some((view) => view.of === elementId)
    || model.flows.some((flow) => flattenFlowSteps(flow).some(({ step }) => step.from === elementId || step.to === elementId));
  const slug = slugifyDslId(merged.name);
  if (referenced || !slug || slug === local) return null;
  const id = freeId(model, element.parent, slug);
  const follow = (value: string | undefined) => value === elementId ? id : value;
  const next: ArchModel = {
    ...model,
    elements: model.elements.map((candidate) => candidate.id === elementId ? { ...merged, id } : candidate),
    views: model.views.map((view) => ({ ...view, rules: view.rules.map((rule) => ({
      ...rule, subject: follow(rule.subject)!,
      ...(rule.arrow ? { arrow: { ...(rule.arrow.from ? { from: follow(rule.arrow.from)! } : {}), ...(rule.arrow.to ? { to: follow(rule.arrow.to)! } : {}) } } : {}),
    })) })),
  };
  const relabel = (node: SceneNode): SceneNode => {
    if (placedElementId(node) !== elementId) return node;
    const dsl = isRecord(node.metadata.dsl) && node.metadata.dsl.id === elementId ? { ...node.metadata.dsl, id } : node.metadata.dsl;
    return {
      ...node, id: node.id === elementId ? id : node.id,
      metadata: { ...node.metadata, model: { ...(isRecord(node.metadata.model) ? node.metadata.model : {}), elementId: id }, ...(dsl ? { dsl } : {}) },
    };
  };
  const commands = pages.map(({ page }) => {
    const nodeIds = new Map(page.nodes.flatMap((node) => placedElementId(node) === elementId ? [[node.id, relabel(node).id] as const] : []));
    const end = <T extends { nodeId: string | null }>(point: T): T => point.nodeId && nodeIds.has(point.nodeId) ? { ...point, nodeId: nodeIds.get(point.nodeId)! } : point;
    const moved: ScenePage = {
      ...page,
      nodes: page.nodes.map(relabel),
      connectors: page.connectors.map((connector) => ({ ...connector, source: end(connector.source), target: end(connector.target) })),
    };
    return setPage(page, pageWithModel(moved, next, resolveIcon), `model-edit:${elementId}`, 'Rename element');
  });
  return { command: commands.length === 1 ? commands[0]! : batch('model-edit', 'Rename element', commands), id };
}

/** `icon: none` on several elements at once; every view that places them follows. */
export function buildArchRemoveIconsCommand(document: SceneDocumentV1, elementIds: readonly string[]): DocumentCommand | null {
  const pages = modelPages(document, elementIds[0] ?? '');
  const source = pages[0];
  const ids = new Set(elementIds);
  if (!source || !source.model.elements.some((element) => ids.has(element.id))) return null;
  const next: ArchModel = {
    ...source.model,
    elements: source.model.elements.map((element) => ids.has(element.id) ? { ...element, icon: 'none' } : element),
  };
  const commands = pages.map(({ page }) => setPage(page, pageWithModel(page, next), 'model-remove-icons', 'Remove icon'));
  return commands.length === 1 ? commands[0]! : batch('model-remove-icons', 'Remove icon', commands);
}

/** Picks `icon` (`aws/compute-lambda`) for these elements, on every view of their model, as one undo step. */
export function buildArchSetIconCommand(document: SceneDocumentV1, elementIds: readonly string[], icon: string, resolveIcon: IconResolver): DocumentCommand | null {
  const pages = modelPages(document, elementIds[0] ?? '');
  const source = pages[0];
  const ids = new Set(elementIds);
  if (!source || !source.model.elements.some((element) => ids.has(element.id))) return null;
  const next: ArchModel = {
    ...source.model,
    elements: source.model.elements.map((element) => ids.has(element.id) ? { ...element, icon } : element),
  };
  const commands = pages.map(({ page }) => setPage(page, pageWithModel(page, next, resolveIcon), 'model-set-icon', 'Change icon'));
  return commands.length === 1 ? commands[0]! : batch('model-set-icon', 'Change icon', commands);
}

/**
 * `icons: off` for a whole workspace: the model records it (so regenerated
 * text keeps it) and every inferred icon on every view comes off in place.
 */
export function buildArchIconsOffCommand(document: SceneDocumentV1, elementId: string): DocumentCommand | null {
  const pages = modelPages(document, elementId);
  const source = pages[0];
  if (!source || source.model.icons === 'off') return null;
  const next: ArchModel = { ...source.model, icons: 'off' };
  const commands = pages.map(({ page }) => setPage(page, pageWithModel(page, next), 'model-icons-off', 'Turn off icons from labels'));
  return commands.length === 1 ? commands[0]! : batch('model-icons-off', 'Turn off icons from labels', commands);
}

/**
 * Remove an element (and its children) from the model and from every view.
 * Views *of* a removed element go too, page included; the document always
 * keeps at least one page.
 */
export function buildArchElementRemoveCommand(
  document: SceneDocumentV1,
  elementId: string,
): DocumentCommand | null {
  const pages = modelPages(document, elementId);
  const source = pages[0];
  if (!source) return null;
  const index = createArchIndex(source.model);
  if (!index.byId.has(elementId)) return null;
  const removed = new Set([elementId, ...elementDescendantIds(index, elementId)]);
  const orphanViews = new Set(source.model.views.filter((view) => view.of && removed.has(view.of)).map((view) => view.id));
  const next: ArchModel = {
    ...source.model,
    elements: source.model.elements.filter((element) => !removed.has(element.id)),
    relations: source.model.relations.filter((relation) => !removed.has(relation.from) && !removed.has(relation.to)),
    views: source.model.views.filter((view) => !orphanViews.has(view.id)),
    flows: source.model.flows.map((flow) => ({ ...flow, steps: stripSteps(flow.steps, removed) })),
  };
  const commands: DocumentCommand[] = [];
  const removals: DocumentCommand[] = [];
  // The model lives on view frames, so one model page always survives.
  // ponytail: follows from model-per-frame storage — goes away once the model
  // has a document-level slot.
  let remaining = pages.length;
  for (const { page, viewId } of pages) {
    if (viewId && orphanViews.has(viewId) && remaining > 1) {
      remaining -= 1;
      removals.push({ kind: 'remove-page', id: `model-remove-view:${viewId}`, label: 'Remove view', index: document.pages.indexOf(page), page });
      continue;
    }
    const placed = page.nodes.filter((node) => {
      const id = placedElementId(node);
      return id !== null && removed.has(id);
    });
    const without = placed.length > 0 ? applyDeletion(page, placed.map((node) => node.id)) : page;
    commands.push(setPage(page, pageWithModel(without, next), `model-remove:${elementId}`, 'Remove element from model'));
  }
  // Highest index first so earlier removals do not shift later ones.
  removals.sort((a, b) => (b.kind === 'remove-page' ? b.index : 0) - (a.kind === 'remove-page' ? a.index : 0));
  commands.push(...removals);
  return commands.length === 0 ? null : batch('model-remove', 'Remove element from model', commands);
}

/** Applies a delete-selection command to an in-memory page, without history. */
function applyDeletion(page: ScenePage, nodeIds: readonly string[]): ScenePage {
  const deletion = buildDeleteSelectionCommand(page, nodeIds, []);
  const nodes = new Set(deletion.commands.flatMap((command) => command.kind === 'remove-node' ? [command.node.id] : []));
  const connectors = new Set(deletion.commands.flatMap((command) => command.kind === 'remove-connector' ? [command.connector.id] : []));
  return {
    ...page,
    nodes: page.nodes.filter((node) => !nodes.has(node.id)),
    connectors: page.connectors.filter((connector) => !connectors.has(connector.id)),
  };
}

function stripSteps(steps: readonly FlowStep[], removed: ReadonlySet<string>): readonly FlowStep[] {
  return steps.flatMap((step) => {
    if (step.from && removed.has(step.from)) return [];
    if (step.to && removed.has(step.to)) return [];
    return [{
      ...step,
      ...(step.branches ? { branches: step.branches.map((branch) => ({ ...branch, steps: stripSteps(branch.steps, removed) })) } : {}),
    }];
  });
}

/** Remove placements from one view only; the element stays in the model. */
export function buildArchUnplaceCommand(page: ScenePage, nodeIds: readonly string[]): DocumentCommand | null {
  const placed = nodeIds.filter((nodeId) => {
    const node = page.nodes.find((candidate) => candidate.id === nodeId);
    return Boolean(node && isModelPlacement(node));
  });
  if (placed.length === 0) return null;
  return buildDeleteSelectionCommand(page, placed, []);
}
