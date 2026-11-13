import { migrateSceneDocument } from '@/opencanvas/domain/document/migration';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import { V2DocumentInvalidError, V2ServerError } from './v2Errors';
import {
  assertStorableV2Document,
  openRecord,
  type V2DocumentRepository,
  type V2DocumentSummary,
  type V2Thumbnail,
} from './v2Repository';

export interface HttpApiOptions {
  /** The API root, e.g. `/api` (same origin, behind nginx or the dev proxy). */
  readonly baseUrl: string;
  /** The signed-in person's session token; null when signed out. */
  readonly getToken: () => Promise<string | null>;
  readonly fetch?: typeof fetch;
}

const UNREACHABLE = 'The document server didn’t answer. Check your connection, then try again.';
const SIGNED_OUT = 'You are signed out. Sign in again to reach your documents.';

async function call(options: HttpApiOptions, method: string, path: string, body?: unknown): Promise<Response> {
  const token = await options.getToken();
  try {
    return await (options.fetch ?? fetch)(`${options.baseUrl}/v1${path}`, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (error) {
    throw new V2ServerError(UNREACHABLE, { cause: error });
  }
}

/** The answer, or the server's reason in the person's terms. */
async function expect<T>(response: Response, action: string): Promise<T> {
  if (response.status === 401) throw new V2ServerError(SIGNED_OUT);
  if (response.status === 413) throw new V2ServerError('This diagram is too large for the document server (16 MB).');
  if (!response.ok) throw new V2ServerError(`The document server couldn’t ${action} (${response.status}). Try again.`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

const path = (id: string) => encodeURIComponent(id);

/** `V2DocumentRepository` over the owner API: the same saved/stale contract as the browser store, one owner per sign-in. */
export function createHttpV2Repository(options: HttpApiOptions): V2DocumentRepository {
  return {
    saveDocument: async (id, document, revision, expectedRevision = revision - 1, savedAt) => {
      assertStorableV2Document(document);
      const response = await call(options, 'PUT', `/docs/${path(id)}`, { document, revision, expectedRevision, ...(savedAt ? { savedAt } : {}) });
      if (response.status === 409) return { status: 'stale', storedRevision: (await response.json() as { storedRevision: number }).storedRevision };
      if (response.status === 422) throw new V2DocumentInvalidError((await response.json() as { issue: { path: string; message: string } }).issue);
      return expect(response, 'save this diagram');
    },
    loadDocument: async (id) => {
      const response = await call(options, 'GET', `/docs/${path(id)}`);
      if (response.status === 404) return { status: 'missing' };
      const opened = openRecord(await expect<unknown>(response, 'open this diagram'));
      return opened.status === 'invalid' ? { status: 'corrupt', issues: opened.issues } : opened;
    },
    listDocuments: async () => expect<V2DocumentSummary[]>(await call(options, 'GET', '/docs'), 'list your diagrams'),
    listArchive: async () => expect<V2DocumentSummary[]>(await call(options, 'GET', '/docs/archive'), 'list the archive'),
    archiveDocuments: async (ids) => expect(await call(options, 'POST', '/docs/archive', { ids }), 'archive'),
    restoreDocuments: async (ids) => expect(await call(options, 'POST', '/docs/restore', { ids }), 'restore'),
    deleteDocument: async (id) => expect(await call(options, 'DELETE', `/docs/${path(id)}`), 'delete this diagram'),
    saveThumbnail: async (id, thumbnail) => expect(await call(options, 'PUT', `/thumbs/${path(id)}`, { thumbnail }), 'save the preview'),
    listThumbnails: async () => {
      const rows = await expect<{ id: string; thumbnail: V2Thumbnail | null }[]>(await call(options, 'GET', '/thumbs'), 'list previews');
      return new Map(rows.map((row) => [row.id, row.thumbnail]));
    },
  };
}

export interface PublishedLink {
  readonly slug: string;
  readonly publicUrl: string;
  readonly publishedRevision: number;
  readonly publishedAt: string;
}

/** The owner's side of public pages: a read-only snapshot of the saved revision behind an unguessable link. */
export function createPublishingClient(options: HttpApiOptions) {
  return {
    status: async (id: string): Promise<PublishedLink | null> => {
      const response = await call(options, 'GET', `/docs/${path(id)}/publish`);
      return response.status === 404 ? null : expect<PublishedLink>(response, 'read the public link');
    },
    publish: async (id: string): Promise<PublishedLink> => {
      const response = await call(options, 'POST', `/docs/${path(id)}/publish`);
      if (response.status === 404) throw new V2ServerError('Wait for this diagram to save, then publish it.');
      return expect<PublishedLink>(response, 'publish this diagram');
    },
    unpublish: async (id: string): Promise<void> => expect(await call(options, 'DELETE', `/docs/${path(id)}/publish`), 'unpublish this diagram'),
  };
}

export type PublishedDocument =
  | { readonly status: 'ok'; readonly document: SceneDocumentV1; readonly publishedAt: string }
  | { readonly status: 'missing' }
  | { readonly status: 'error'; readonly message: string; readonly retry: boolean };

/** Anonymous: no token is sent, so a public page never depends on who is looking. */
export async function fetchPublishedDocument(baseUrl: string, slug: string, fetchImpl: typeof fetch = fetch): Promise<PublishedDocument> {
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/v1/public/${encodeURIComponent(slug)}`);
  } catch {
    return { status: 'error', message: UNREACHABLE, retry: true };
  }
  if (response.status === 404) return { status: 'missing' };
  if (response.status === 429) return { status: 'error', message: 'Too many visits from this network. Try again in a minute.', retry: true };
  if (!response.ok) return { status: 'error', message: `The document server failed (${response.status}). Try again.`, retry: true };
  const body = await response.json() as { document: unknown; publishedAt: string };
  const migrated = migrateSceneDocument(body.document);
  if (migrated.success === false) {
    return { status: 'error', retry: false, message: migrated.reason === 'newer-schema'
      ? 'This diagram was published by a newer version of OpenFlowKit. Reload to update, then try again.'
      : 'This published diagram is damaged and can’t be shown.' };
  }
  return { status: 'ok', document: migrated.document, publishedAt: body.publishedAt };
}
