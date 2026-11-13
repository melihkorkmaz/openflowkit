import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import type { V2Thumbnail } from '@/services/storage/v2/v2Repository';
import { AuthError } from './auth';
import type { DocumentStore } from './documentStore';
import { PUBLIC_SLUG_PATTERN } from './slug';

export interface ApiOptions {
  readonly store: DocumentStore;
  readonly verify: (token: string) => Promise<{ readonly sub: string }>;
  readonly mintSlug: () => string;
  /** False once the client's address has used up its window on the public endpoint. */
  readonly allowPublicRead: (clientKey: string) => boolean;
  /** Where the app is served, for the public link; absent, the request's own origin. */
  readonly appUrl?: string;
  /** Behind nginx: the client is X-Real-IP, not the proxy's socket. */
  readonly trustProxy?: boolean;
  /** One JSON line per call: publish and unpublish land here for audit. */
  readonly log: (event: string, fields: Record<string, unknown>) => void;
}

/** A whole document as JSON; the browser store has no cap, a request needs one. */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_IDS = 1_000;
const ID_PATTERN = /^[\w.:-]{1,200}$/;

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // Never cached anywhere: an unpublished link must stop opening at once, and owner data is private.
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* falls through */ }
  throw new HttpError(400, 'Body must be a JSON object.');
}

function documentId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'Bad document id.');
  return id;
}

function idList(body: Record<string, unknown>): string[] {
  const { ids } = body;
  if (!Array.isArray(ids) || ids.length > MAX_IDS || !ids.every((id) => typeof id === 'string' && ID_PATTERN.test(id))) {
    throw new HttpError(400, `ids must be a list of up to ${MAX_IDS} document ids.`);
  }
  return ids as string[];
}

function thumbnailOf(value: unknown): V2Thumbnail | null {
  if (value === null) return null;
  const thumbnail = value as { light?: unknown; dark?: unknown } | undefined;
  if (typeof thumbnail?.light !== 'string' || typeof thumbnail.dark !== 'string') throw new HttpError(400, 'thumbnail must be {light, dark} or null.');
  return { light: thumbnail.light, dark: thumbnail.dark };
}

/** A slug in a log line: enough to match a report, never the whole secret. */
const slugHint = (slug: string) => `${slug.slice(0, 6)}…`;

export function createApiHandler(options: ApiOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const { store, log } = options;

  function clientKey(request: IncomingMessage): string {
    const real = options.trustProxy ? request.headers['x-real-ip'] : undefined;
    return (typeof real === 'string' && real) || request.socket.remoteAddress || 'unknown';
  }

  function publicUrl(request: IncomingMessage, slug: string): string {
    const host = (options.trustProxy ? request.headers['x-forwarded-host'] : undefined) ?? request.headers.host ?? 'localhost';
    const proto = options.trustProxy && typeof request.headers['x-forwarded-proto'] === 'string' ? request.headers['x-forwarded-proto'] : 'http';
    const base = (options.appUrl ?? `${proto}://${String(host)}`).replace(/\/+$/, '');
    return `${base}/#/p/${slug}`;
  }

  async function owner(request: IncomingMessage): Promise<string> {
    const header = request.headers.authorization ?? '';
    const match = /^Bearer (\S+)$/.exec(header);
    if (!match) throw new HttpError(401, 'Sign in to reach your documents.');
    try {
      return (await options.verify(match[1]!)).sub;
    } catch (error) {
      if (error instanceof AuthError) throw new HttpError(401, error.message);
      throw error;
    }
  }

  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const path = new URL(request.url ?? '/', 'http://local').pathname.replace(/\/+$/, '');
    let match: RegExpExecArray | null;

    if (path === '/api/v1/health' && method === 'GET') return send(response, 200, { ok: true });

    if ((match = /^\/api\/v1\/public\/([^/]+)$/.exec(path)) && method === 'GET') {
      if (!options.allowPublicRead(clientKey(request))) throw new HttpError(429, 'Too many requests. Try again in a minute.');
      const slug = match[1]!;
      const snapshot = PUBLIC_SLUG_PATTERN.test(slug) ? store.readPublic(slug) : null;
      if (!snapshot) throw new HttpError(404, 'This link does not open a diagram. It may have been unpublished.');
      return send(response, 200, snapshot);
    }

    if (!path.startsWith('/api/v1/')) throw new HttpError(404, 'Not found.');
    const ownerId = await owner(request);

    if (path === '/api/v1/docs' && method === 'GET') return send(response, 200, store.listDocuments(ownerId));
    if (path === '/api/v1/docs/archive' && method === 'GET') return send(response, 200, store.listArchive(ownerId));
    if (path === '/api/v1/docs/archive' && method === 'POST') {
      store.archiveDocuments(ownerId, idList(await readJson(request)));
      return send(response, 204);
    }
    if (path === '/api/v1/docs/restore' && method === 'POST') {
      store.restoreDocuments(ownerId, idList(await readJson(request)));
      return send(response, 204);
    }
    if (path === '/api/v1/thumbs' && method === 'GET') return send(response, 200, store.listThumbnails(ownerId));
    if ((match = /^\/api\/v1\/thumbs\/([^/]+)$/.exec(path)) && method === 'PUT') {
      const id = documentId(match[1]!);
      store.saveThumbnail(ownerId, id, thumbnailOf((await readJson(request)).thumbnail));
      return send(response, 204);
    }

    if ((match = /^\/api\/v1\/docs\/([^/]+)\/publish$/.exec(path))) {
      const id = documentId(match[1]!);
      if (method === 'GET') {
        const live = store.publication(ownerId, id);
        if (!live) throw new HttpError(404, 'Not published.');
        return send(response, 200, { ...live, publicUrl: publicUrl(request, live.slug) });
      }
      if (method === 'POST') {
        const published = store.publish(ownerId, id, options.mintSlug);
        if (!published) throw new HttpError(404, 'Save the document before publishing it.');
        log('publish', { owner: ownerId, document: id, revision: published.publishedRevision, slug: slugHint(published.slug) });
        return send(response, 200, { ...published, publicUrl: publicUrl(request, published.slug) });
      }
      if (method === 'DELETE') {
        const revoked = store.unpublish(ownerId, id);
        log('unpublish', { owner: ownerId, document: id, revoked });
        return send(response, 204);
      }
    }

    if ((match = /^\/api\/v1\/docs\/([^/]+)$/.exec(path))) {
      const id = documentId(match[1]!);
      if (method === 'GET') {
        const record = store.loadDocument(ownerId, id);
        return record ? send(response, 200, record) : send(response, 404, { status: 'missing' });
      }
      if (method === 'PUT') {
        const body = await readJson(request);
        const { document, revision, expectedRevision, savedAt } = body;
        if (typeof document !== 'object' || document === null || !Number.isInteger(revision)
          || (expectedRevision !== undefined && !Number.isInteger(expectedRevision))
          || (savedAt !== undefined && (typeof savedAt !== 'string' || Number.isNaN(Date.parse(savedAt))))) {
          throw new HttpError(400, 'Expected {document, revision, expectedRevision?, savedAt?}.');
        }
        const result = store.saveDocument(ownerId, id, document as SceneDocumentV1, revision as number,
          (expectedRevision as number | undefined) ?? (revision as number) - 1, savedAt as string | undefined);
        if (result.status === 'invalid') return send(response, 422, { error: result.issue.message, issue: result.issue });
        return send(response, result.status === 'stale' ? 409 : 200, result);
      }
      if (method === 'DELETE') {
        store.deleteDocument(ownerId, id);
        return send(response, 204);
      }
    }
    throw new HttpError(404, 'Not found.');
  }

  return async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      if (error instanceof HttpError) {
        if (!response.headersSent) send(response, error.status, { error: error.message });
        // An oversized body is left unread: close rather than drain it.
        if (error.status === 413) request.destroy();
        return;
      }
      log('error', { method: request.method, path: request.url?.split('?')[0], message: error instanceof Error ? error.message : String(error) });
      if (!response.headersSent) send(response, 500, { error: 'The server failed. Try again.' });
    }
  };
}
