// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDocument, createTestNode } from '@/opencanvas/testing/builders/documentBuilder';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import { createJwtVerifier } from './auth';
import { openDatabase, SCHEMA_VERSION } from './database';
import { createDocumentStore } from './documentStore';
import { createRateLimiter } from './rateLimit';
import { createApiHandler } from './server';
import { mintPublicSlug } from './slug';
import { createTestSigner } from './testSigner';

const labeled = (label: string): SceneDocumentV1 => createTestDocument({ nodes: [createTestNode('node-1', { content: { label } })] });

let dir: string;
let db: DatabaseSync;
let server: Server;
let base: string;
let alice: string;
let bob: string;
let audit: { event: string; fields: Record<string, unknown> }[];
let signer: Awaited<ReturnType<typeof createTestSigner>>;

async function start(publicLimit = 100): Promise<void> {
  db = openDatabase(join(dir, 'openflowkit.db'));
  const handler = createApiHandler({
    store: createDocumentStore(db),
    verify: createJwtVerifier({ jwks: signer.jwks }),
    mintSlug: mintPublicSlug,
    allowPublicRead: createRateLimiter(publicLimit, 60_000),
    appUrl: 'https://app.example/',
    log: (event, fields) => audit.push({ event, fields }),
  });
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
}

async function stop(): Promise<void> {
  await new Promise((resolve) => server.close(resolve));
  db.close();
}

function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}): Promise<Response> {
  const { token, json, ...rest } = init;
  return fetch(`${base}${path}`, {
    ...rest,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ofk-api-'));
  audit = [];
  signer = await createTestSigner();
  const exp = Date.now() / 1000 + 600;
  alice = await signer.sign({ sub: 'user_alice', exp });
  bob = await signer.sign({ sub: 'user_bob', exp });
  await start();
});

afterEach(async () => {
  await stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('owner API', () => {
  it('turns away a request without a valid token', async () => {
    expect((await call('/docs')).status).toBe(401);
    expect((await call('/docs/d1', { token: 'x.y.z' })).status).toBe(401);
    const expired = await signer.sign({ sub: 'user_alice', exp: Date.now() / 1000 - 600 });
    expect((await call('/docs', { token: expired })).status).toBe(401);
    expect((await call('/docs/d1', { method: 'PUT', json: { document: labeled('A'), revision: 1 } })).status).toBe(401);
  });

  it('saves, keeps stale-revision protection, and survives a restart', async () => {
    expect((await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('One'), revision: 1 } })).status).toBe(200);
    const stale = await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('Other tab'), revision: 1, expectedRevision: 0 } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ status: 'stale', storedRevision: 1 });

    await stop();
    await start();
    const loaded = await (await call('/docs/d1', { token: alice })).json();
    expect(loaded).toMatchObject({ id: 'd1', revision: 1 });
    expect(loaded.document.pages[0].nodes[0].content.label).toBe('One');
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()).toEqual({ v: SCHEMA_VERSION });
    expect((await call('/docs/d1', { token: bob })).status).toBe(404);
  });

  it('lists, archives, restores, stores previews and deletes', async () => {
    await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('Alpha'), revision: 1 } });
    await call('/thumbs/d1', { method: 'PUT', token: alice, json: { thumbnail: { light: '<svg/>', dark: '<svg/>' } } });
    expect(await (await call('/docs', { token: alice })).json()).toEqual([expect.objectContaining({ id: 'd1', searchText: expect.stringContaining('alpha') })]);
    expect(await (await call('/thumbs', { token: alice })).json()).toEqual([{ id: 'd1', thumbnail: { light: '<svg/>', dark: '<svg/>' } }]);
    expect((await call('/docs/archive', { method: 'POST', token: alice, json: { ids: ['d1'] } })).status).toBe(204);
    expect(await (await call('/docs', { token: alice })).json()).toEqual([]);
    expect(await (await call('/docs/archive', { token: alice })).json()).toEqual([expect.objectContaining({ id: 'd1', archivedAt: expect.any(String) })]);
    await call('/docs/restore', { method: 'POST', token: alice, json: { ids: ['d1'] } });
    expect((await call('/docs/d1', { method: 'DELETE', token: alice })).status).toBe(204);
    expect((await call('/docs/d1', { token: alice })).status).toBe(404);
    expect(await (await call('/thumbs', { token: alice })).json()).toEqual([]);
  });

  it('refuses an invalid document and an oversized body', async () => {
    const invalid = await call('/docs/d1', { method: 'PUT', token: alice, json: { document: { ...labeled('A'), pages: 'x' }, revision: 1 } });
    expect(invalid.status).toBe(422);
    const huge = await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('x'.repeat(17 * 1024 * 1024)), revision: 1 } }).catch(() => null);
    expect(huge === null || huge.status === 413).toBe(true);
  });
});

describe('public pages', () => {
  it('serves only the published revision, without owner ids, until unpublished', async () => {
    await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('Public'), revision: 1 } });
    const published = await (await call('/docs/d1/publish', { method: 'POST', token: alice })).json();
    expect(published).toMatchObject({ publishedRevision: 1, publicUrl: `https://app.example/#/p/${published.slug}` });
    expect(published.slug).toHaveLength(43);
    expect(audit.find((entry) => entry.event === 'publish')?.fields).toMatchObject({ owner: 'user_alice', document: 'd1' });
    expect(JSON.stringify(audit)).not.toContain(published.slug);

    await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('Secret draft'), revision: 2 } });
    const response = await call(`/public/${published.slug}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const text = await response.text();
    expect(text).toContain('Public');
    expect(text).not.toContain('Secret draft');
    expect(text).not.toContain('user_alice');

    expect((await call('/docs/d1/publish', { method: 'DELETE', token: alice })).status).toBe(204);
    expect(audit.some((entry) => entry.event === 'unpublish')).toBe(true);
    expect((await call(`/public/${published.slug}`)).status).toBe(404);
  });

  it('cannot publish or unpublish another owner\'s document', async () => {
    await call('/docs/d1', { method: 'PUT', token: alice, json: { document: labeled('A'), revision: 1 } });
    expect((await call('/docs/d1/publish', { method: 'POST', token: bob })).status).toBe(404);
    const published = await (await call('/docs/d1/publish', { method: 'POST', token: alice })).json();
    await call('/docs/d1/publish', { method: 'DELETE', token: bob });
    expect((await call(`/public/${published.slug}`)).status).toBe(200);
  });

  it('rate limits the public endpoint per client', async () => {
    await stop();
    await start(2);
    const slug = mintPublicSlug();
    expect([(await call(`/public/${slug}`)).status, (await call(`/public/${slug}`)).status, (await call(`/public/${slug}`)).status]).toEqual([404, 404, 429]);
  });
});
