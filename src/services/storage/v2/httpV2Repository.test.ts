// @vitest-environment node
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDocument, createTestNode } from '@/opencanvas/testing/builders/documentBuilder';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import { createJwtVerifier } from '../../../../api/auth';
import { migrate } from '../../../../api/database';
import { createDocumentStore } from '../../../../api/documentStore';
import { createApiHandler } from '../../../../api/server';
import { mintPublicSlug } from '../../../../api/slug';
import { createTestSigner } from '../../../../api/testSigner';
import { createHttpV2Repository, createPublishingClient, fetchPublishedDocument } from './httpV2Repository';
import { V2DocumentInvalidError, V2ServerError, describeStorageFailure } from './v2Errors';

const labeled = (label: string): SceneDocumentV1 => createTestDocument({ nodes: [createTestNode('node-1', { content: { label } })] });

let server: Server;
let baseUrl: string;
let token: string | null;

beforeEach(async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  const signer = await createTestSigner();
  token = await signer.sign({ sub: 'user_1', exp: Date.now() / 1000 + 600 });
  const handler = createApiHandler({
    store: createDocumentStore(db), verify: createJwtVerifier({ jwks: signer.jwks }), mintSlug: mintPublicSlug,
    allowPublicRead: () => true, log: () => undefined,
  });
  server = createServer((request, response) => { void handler(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const repository = () => createHttpV2Repository({ baseUrl, getToken: async () => token });

describe('createHttpV2Repository', () => {
  it('keeps the browser store\'s saved/stale contract', async () => {
    const repo = repository();
    expect((await repo.saveDocument('d1', labeled('One'), 1)).status).toBe('saved');
    expect(await repo.saveDocument('d1', labeled('Other tab'), 1, 0)).toEqual({ status: 'stale', storedRevision: 1 });
    const loaded = await repo.loadDocument('d1');
    expect(loaded.status).toBe('ok');
    expect(loaded.status === 'ok' && loaded.record.document.pages[0]?.nodes[0]?.content.label).toBe('One');
    expect(await repo.loadDocument('nope')).toEqual({ status: 'missing' });
  });

  it('lists, archives, restores, stores previews and deletes', async () => {
    const repo = repository();
    await repo.saveDocument('d1', labeled('Alpha'), 1);
    await repo.saveThumbnail('d1', { light: '<svg/>', dark: '<svg/>' });
    expect((await repo.listThumbnails()).get('d1')).toEqual({ light: '<svg/>', dark: '<svg/>' });
    await repo.archiveDocuments(['d1']);
    expect(await repo.listDocuments()).toEqual([]);
    expect((await repo.listArchive()).map((summary) => summary.id)).toEqual(['d1']);
    await repo.restoreDocuments(['d1']);
    expect((await repo.listDocuments()).map((summary) => summary.name)).toHaveLength(1);
    await repo.deleteDocument('d1');
    expect(await repo.loadDocument('d1')).toEqual({ status: 'missing' });
  });

  it('refuses an invalid document before it leaves the browser', async () => {
    const broken = { ...labeled('x'), pages: 'nope' } as unknown as SceneDocumentV1;
    await expect(repository().saveDocument('d1', broken, 1)).rejects.toBeInstanceOf(V2DocumentInvalidError);
  });

  it('says signed out on a missing token, and unreachable on a closed port', async () => {
    token = null;
    const signedOut = await repository().listDocuments().catch((error: unknown) => error);
    expect(signedOut).toBeInstanceOf(V2ServerError);
    expect(describeStorageFailure(signedOut).message).toMatch(/signed out/);

    // A port nothing listens on: bound, read, then released.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const closedPort = (probe.address() as AddressInfo).port;
    await new Promise((resolve) => probe.close(resolve));
    const unreachable = await createHttpV2Repository({ baseUrl: `http://127.0.0.1:${closedPort}/api`, getToken: async () => 't' })
      .listDocuments().catch((error: unknown) => error);
    expect(describeStorageFailure(unreachable).message).toMatch(/didn’t answer/);
  });
});

describe('publishing', () => {
  it('publishes a snapshot anyone can fetch without a token, until unpublished', async () => {
    const options = { baseUrl, getToken: async () => token };
    await createHttpV2Repository(options).saveDocument('d1', labeled('Shown'), 1);
    const client = createPublishingClient(options);
    expect(await client.status('d1')).toBeNull();
    const link = await client.publish('d1');
    expect(await client.status('d1')).toMatchObject({ slug: link.slug });
    const visit = await fetchPublishedDocument(baseUrl, link.slug);
    expect(visit.status === 'ok' && visit.document.pages[0]?.nodes[0]?.content.label).toBe('Shown');
    await client.unpublish('d1');
    expect(await fetchPublishedDocument(baseUrl, link.slug)).toEqual({ status: 'missing' });
  });

  it('asks to wait for the save when the document is not stored yet', async () => {
    await expect(createPublishingClient({ baseUrl, getToken: async () => token }).publish('unsaved')).rejects.toThrow(/save/);
  });
});
