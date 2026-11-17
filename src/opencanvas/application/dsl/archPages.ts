import type { CompileWorkspaceResult } from '../../../dsl/compile';
import { contentColor, elementColorKey } from '../../../dsl/families/architecture/scene';
import {
  archFrameOf,
  archModelFromJson,
  archModelOfPage,
  archViewIdOfPage,
  createArchIndex,
  placedElementId,
} from '../../../dsl/model/model';
import { ELEMENT_KIND_LABEL, type ArchElement, type ArchModel } from '../../../dsl/model/types';
import { createDefaultSceneLayer } from '../../domain/document/defaults';
import type { BatchDocumentCommand, DocumentCommand } from '../../domain/commands/types';
import type { JsonObject } from '../../domain/document/json';
import type { SceneDocumentV1, SceneNode, ScenePage } from '../../domain/document/types';
import { buildDslPageCommand } from './dslPageCommand';
import {
  hasAutoIcon,
  hasIcon,
  refreshAutoIcon,
  withElementIcon,
  withoutElementIcon,
  type IconResolver,
} from './iconCommands';

export type ArchElementPatch = Partial<Pick<ArchElement, 'name' | 'tech' | 'desc' | 'doc' | 'tags' | 'links' | 'color' | 'icon'>>;

export interface ModelPage {
  readonly page: ScenePage;
  readonly model: ArchModel;
  readonly viewId: string | null;
}

/**
 * The pages of the model that holds `elementId`, each with the model copy off
 * its frame. Another model's pages never take this model's copy.
 */
// ponytail: element-overlap identity, like workspaceFrames — stamp a workspace id on view frames if two models share an id
export function modelPages(document: SceneDocumentV1, elementId: string): readonly ModelPage[] {
  const all = document.pages.flatMap((page) => {
    const model = archModelOfPage(page);
    return model ? [{ page, model, viewId: archViewIdOfPage(page) }] : [];
  });
  const home = all.find(({ model }) => model.elements.some((element) => element.id === elementId));
  if (!home) return [];
  const ids = new Set(home.model.elements.map((element) => element.id));
  return [home, ...all.filter((entry) => entry !== home && entry.model.elements.some((element) => ids.has(element.id)))];
}

export function isModelPlacement(node: SceneNode): boolean {
  return placedElementId(node) !== null;
}

/** Rewrites a page so its frames carry the new model and its placements follow it. */
export function pageWithModel(page: ScenePage, model: ArchModel, resolveIcon?: IconResolver): ScenePage {
  const index = createArchIndex(model);
  const carriesModel = archFrameOf(page) !== null;
  const nodes = page.nodes.map((node) => {
    const withModelCopy = carriesModel && node.metadata.dsl
      ? { ...node, metadata: { ...node.metadata, dsl: withArchModel(node.metadata.dsl, model) } }
      : node;
    const elementId = placedElementId(node);
    const element = elementId ? index.byId.get(elementId) : undefined;
    if (!element) return withModelCopy;
    // `icon: none` on the element, or `icons: off` on the model, takes the card back to its shape.
    const iconGone = hasIcon(withModelCopy) && (element.icon === 'none' || (model.icons === 'off' && hasAutoIcon(withModelCopy)));
    // An icon the author picked (in the text, or on the canvas for every view) draws the element as its card.
    const iconPicked = !iconGone && resolveIcon && element.icon && element.icon !== 'none' && withModelCopy.content.icon !== element.icon;
    const stripped = iconGone ? withoutElementIcon(withModelCopy, element)
      : iconPicked ? withElementIcon(withModelCopy, element, resolveIcon) : withModelCopy;
    // A rename or a new `tech:` moves an inferred icon with it (needs the host's resolver).
    const drawn = resolveIcon
      ? refreshAutoIcon(stripped, element.name, element.tech, resolveIcon, (plain) => withoutElementIcon(plain, element))
      : stripped;
    const content: Record<string, unknown> = { ...drawn.content,
      label: element.name,
      subLabel: node.kind === 'frame' ? `[${ELEMENT_KIND_LABEL[element.kind]}]` : `[${ELEMENT_KIND_LABEL[element.kind]}${element.tech ? ` · ${element.tech}` : ''}]${element.desc ? `\n${element.desc}` : ''}`,
    };
    if (drawn.kind === 'architecture') {
      content.assetPresentation = 'card';
      content.archProviderLabel = ELEMENT_KIND_LABEL[element.kind];
      content.archResourceType = element.tech ?? '';
      if (element.desc) content.archEnvironment = element.desc; else delete content.archEnvironment;
      // A kind-coloured card follows its element: an authored colour replaces it, a new kind brings its own.
      if (content.archKindColor !== undefined) {
        const { key, fromKind } = elementColorKey(element);
        delete content.customColor;
        if (key) Object.assign(content, contentColor(key)); else delete content.color;
        if (key && fromKind) content.archKindColor = key; else delete content.archKindColor;
      }
    }
    const placement: Record<string, unknown> = { ...(isRecord(drawn.metadata.model) ? drawn.metadata.model : {}), tags: [...element.tags] };
    if (element.desc) placement.desc = element.desc; else delete placement.desc;
    if (element.links.length) placement.links = [...element.links]; else delete placement.links;
    return {
      ...drawn,
      content: content as JsonObject,
      metadata: { ...drawn.metadata, model: placement as JsonObject },
    };
  });
  return { ...page, nodes };
}

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withArchModel(dsl: unknown, model: ArchModel): JsonObject {
  const record: Record<string, unknown> = isRecord(dsl) ? { ...dsl } : {};
  const arch: Record<string, unknown> = isRecord(record.arch) ? { ...record.arch } : {};
  arch.model = model;
  record.arch = arch;
  return record as JsonObject;
}

export function batch(id: string, label: string, commands: readonly DocumentCommand[]): BatchDocumentCommand {
  return { kind: 'batch', id, label, commands };
}

export function setPage(page: ScenePage, after: ScenePage, id: string, label: string): DocumentCommand {
  return { kind: 'set-page', id, label, pageId: page.id, before: page, after };
}

/* ------------------------------------------------------------------ pages */

export interface WorkspacePagesOptions {
  /** A frame the code panel is bound to: its view replaces the frame in place. */
  readonly replaceFrameId?: string;
  /** The page the user generates from: when it holds nothing, the first new view takes it instead of leaving it empty. */
  readonly intoPageId?: string;
  readonly mintId: (prefix: string) => string;
}

interface ModelFrame {
  readonly page: ScenePage;
  readonly frame: SceneNode;
  readonly viewId: string | null;
  readonly ids: ReadonlySet<string>;
}

function frameArch(frame: SceneNode): Pick<ModelFrame, 'viewId' | 'ids'> | null {
  const dsl = frame.metadata.dsl;
  if (!isRecord(dsl) || !isRecord(dsl.arch)) return null;
  const model = archModelFromJson(dsl.arch.model);
  return {
    viewId: typeof dsl.arch.view === 'string' ? dsl.arch.view : null,
    ids: new Set(model?.elements.map((element) => element.id) ?? []),
  };
}

function modelFrameCount(page: ScenePage): number {
  return page.nodes.filter((node) => frameArch(node)).length;
}

/**
 * Model frames that belong to the workspace being generated. Every model
 * without a `views` block is `view:landscape`, so a view id alone can't say
 * whose page it is.
 */
// ponytail: element-overlap identity; two models sharing an id merge — stamp a workspace id on view frames if that bites
function workspaceFrames(document: SceneDocumentV1, workspace: CompileWorkspaceResult): readonly ModelFrame[] {
  const first = workspace.views[0]!.result.frame;
  const incoming = frameArch(first)?.ids ?? new Set<string>();
  return document.pages.flatMap((page) => page.nodes.flatMap((frame) => {
    const arch = frameArch(frame);
    return arch && [...arch.ids].some((id) => incoming.has(id)) ? [{ page, frame, ...arch }] : [];
  }));
}

/** Where each generated view lives: the bound frame for its own view, else this workspace's frame for it. */
export function workspaceViewFrames(
  document: SceneDocumentV1,
  workspace: CompileWorkspaceResult,
  replaceFrameId?: string,
): readonly ({ readonly pageId: string; readonly frameId: string } | null)[] {
  const frames = workspaceFrames(document, workspace);
  return workspace.views.map((view) => {
    const found = frames.find((entry) => entry.viewId === view.viewId && entry.frame.id === replaceFrameId)
      ?? frames.find((entry) => entry.viewId === view.viewId);
    return found ? { pageId: found.page.id, frameId: found.frame.id } : null;
  });
}

/**
 * Generate a C4 workspace: one page per view, matched by stable view id among
 * this workspace's frames, so a regenerate updates the same pages rather than
 * duplicating them and another model's pages are never touched.
 */
export function buildWorkspacePagesCommand(
  document: SceneDocumentV1,
  workspace: CompileWorkspaceResult,
  options: WorkspacePagesOptions,
): DocumentCommand | null {
  if (workspace.views.length === 0) return null;
  const frames = workspaceFrames(document, workspace);
  const boundId = options.replaceFrameId;
  const boundPage = boundId ? document.pages.find((page) => page.nodes.some((node) => node.id === boundId)) : undefined;
  const boundNode = boundPage?.nodes.find((node) => node.id === boundId);
  const boundViewId = boundPage && boundNode ? frameArch(boundNode)?.viewId ?? null : null;
  const live = new Set(workspace.views.map((view) => view.viewId));
  const used = new Set<string>();
  const changed = new Map<string, ScenePage>();
  const inserts: DocumentCommand[] = [];
  // The first view that needs a page takes the empty one the user is on.
  let blank = document.pages.find((page) => page.id === options.intoPageId && page.nodes.length === 0 && page.connectors.length === 0);
  const regenerate = (page: ScenePage, frameId: string, view: CompileWorkspaceResult['views'][number]) => {
    used.add(frameId);
    const before = changed.get(page.id) ?? page;
    const command = buildDslPageCommand(before, view.result, frameId);
    let after = command?.kind === 'set-page' ? command.after : before;
    // A page that holds other diagrams, or that the user renamed, keeps its own name.
    const oldLabel = before.nodes.find((node) => node.id === frameId)?.content.label;
    const unnamed = /^Page \d+$/.test(before.name) || before.name === oldLabel;
    if (unnamed && after.name !== view.name && modelFrameCount(after) <= 1) after = { ...after, name: view.name };
    if (after !== page) changed.set(page.id, after);
  };
  for (const view of workspace.views) {
    const existing = frames.find((entry) => entry.viewId === view.viewId && entry.frame.id !== boundId && !used.has(entry.frame.id));
    // The bound frame takes its own view; a bound frame of no live view takes the first view nothing else holds.
    const boundTakes = boundPage && !used.has(boundId!)
      && (view.viewId === boundViewId || (!existing && !(boundViewId && live.has(boundViewId))));
    if (boundTakes) regenerate(boundPage, boundId!, view);
    else if (existing) regenerate(existing.page, existing.frame.id, view);
    else if (blank) {
      const { name, diagramKind, nodes, connectors, metadata } = viewPage(blank.id, view.viewId, view.name, view.result);
      changed.set(blank.id, { ...blank, name, diagramKind, nodes, connectors, metadata: { ...blank.metadata, ...metadata } });
      blank = undefined;
    } else inserts.push(insertViewPageCommand(document.pages.length + inserts.length, view.viewId, view.name, view.result, options.mintId));
  }
  const commands: DocumentCommand[] = [
    ...document.pages.flatMap((page) => {
      const after = changed.get(page.id);
      return after ? [setPage(page, after, `generate-view:${page.id}`, 'Generate view')] : [];
    }),
    ...inserts,
  ];
  // A workspace is authoritative for its generated views, including a single remaining view.
  if (workspace.views.some((view) => view.viewId.startsWith('view:'))) {
    for (let index = document.pages.length - 1; index >= 0; index -= 1) {
      const page = document.pages[index]!;
      const entry = frames.find((candidate) => candidate.page === page);
      // ponytail: a page holding several diagrams keeps an obsolete one — drop just that frame if it bites
      if (!entry?.viewId || live.has(entry.viewId) || used.has(entry.frame.id) || modelFrameCount(page) !== 1) continue;
      const { viewId, frame } = entry;
      const generated = new Set(page.nodes.filter((node) => placedElementId(node) || node.id === frame.id).map((node) => node.id));
      const notes = page.nodes.filter((node) => !generated.has(node.id));
      if (notes.length === 0) {
        commands.push({kind: 'remove-page', id: `remove-view:${viewId}`, label: 'Remove obsolete view', index, page});
      } else {
        // Invisible ancestor groups keep notes at exactly their original world transform,
        // including nested rotation/scale, without retaining a stale model view.
        const byId = new Map(page.nodes.map((node) => [node.id, node]));
        const ancestors = new Set<string>();
        for (const note of notes) {
          for (let parent = note.parentId; parent; parent = byId.get(parent)?.parentId ?? null) ancestors.add(parent);
        }
        const nodes = page.nodes.filter((node) => !generated.has(node.id) || ancestors.has(node.id)).map((node) =>
          generated.has(node.id) ? {...node, kind: 'group' as const, content: {}, metadata: {}, appearance: {}} : node);
        const {view: _view, ...metadata} = page.metadata;
        const connectors = page.connectors.filter((connector) =>
          !connector.metadata.model && !generated.has(connector.source.nodeId ?? '') && !generated.has(connector.target.nodeId ?? ''));
        commands.push(setPage(page, { ...page, nodes, connectors, metadata }, `detach-view:${viewId}`, 'Keep view notes'));
      }
    }
  }
  if (commands.length === 0) return null;
  if (commands.length === 1) return commands[0]!;
  return batch('architecture-workspace-generate', `Generate ${workspace.views.length} views`, commands);
}

/**
 * Where the generated views land once `command` (from `buildWorkspacePagesCommand`) is applied:
 * the page to open and the frame to fit. `stayOnPageId`, the page Generate ran from, wins when it
 * holds one of these views; else the first view. A view is matched by its model's pages, so two
 * models' landscapes never cross.
 */
export function firstViewLanding(
  document: SceneDocumentV1,
  workspace: CompileWorkspaceResult,
  command: DocumentCommand | null,
  replaceFrameId?: string,
  stayOnPageId?: string,
): { readonly pageId: string; readonly frameId: string } | null {
  const first = workspace.views[0]!;
  const frames = workspaceViewFrames(document, workspace, replaceFrameId);
  const here = stayOnPageId ? frames.find((entry) => entry?.pageId === stayOnPageId) : undefined;
  if (here) return here;
  const held = frames[0];
  if (held) return held;
  const pages = (command?.kind === 'batch' ? command.commands : command ? [command] : [])
    .flatMap((entry) => entry.kind === 'insert-page' ? [entry.page] : entry.kind === 'set-page' ? [entry.after] : []);
  const page = pages.find((candidate) => archViewIdOfPage(candidate) === first.viewId);
  return page ? { pageId: page.id, frameId: first.result.frame.id } : null;
}

function viewPage(pageId: string, viewId: string, name: string, result: CompileWorkspaceResult['views'][number]['result']): ScenePage {
  return {
    id: pageId,
    name,
    diagramKind: result.meta.family,
    layers: [createDefaultSceneLayer()],
    nodes: [result.frame, ...result.groups, ...result.nodes],
    connectors: result.connectors,
    metadata: { view: { id: viewId } },
    extensions: {},
  };
}

function insertViewPageCommand(
  index: number,
  viewId: string,
  name: string,
  result: CompileWorkspaceResult['views'][number]['result'],
  mintId: (prefix: string) => string,
): DocumentCommand {
  const page = viewPage(mintId('page'), viewId, name, result);
  return {
    kind: 'insert-page',
    id: `insert-view-page:${viewId}`,
    label: `Add view ${name}`,
    index,
    page,
  };
}
