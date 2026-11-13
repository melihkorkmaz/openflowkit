// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { createTestDocument, createTestNode } from '@/opencanvas/testing/builders/documentBuilder';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import { V2_THUMBNAIL_MAX_CHARS } from '@/services/storage/v2/v2Repository';
import { migrate } from './database';
import { createDocumentStore, type DocumentStore } from './documentStore';

const labeled = (label: string): SceneDocumentV1 => createTestDocument({ nodes: [createTestNode('node-1', { content: { label } })] });

let store: DocumentStore;
let slugs: number;
const mint = () => `slug-${(slugs += 1)}`;

beforeEach(() => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  store = createDocumentStore(db);
  slugs = 0;
});

describe('saveDocument', () => {
  it('saves when nothing is stored, then only on the expected revision', () => {
    expect(store.saveDocument('alice', 'd1', labeled('One'), 1, 0).status).toBe('saved');
    expect(store.saveDocument('alice', 'd1', labeled('Two'), 2, 1).status).toBe('saved');
    expect(store.saveDocument('alice', 'd1', labeled('Late'), 2, 1)).toEqual({ status: 'stale', storedRevision: 2 });
    expect(store.loadDocument('alice', 'd1')?.document.pages[0]?.nodes[0]?.content.label).toBe('Two');
  });

  it('refuses a document that would not open again', () => {
    const broken = { ...labeled('x'), pages: 'nope' } as unknown as SceneDocumentV1;
    expect(store.saveDocument('alice', 'd1', broken, 1, 0).status).toBe('invalid');
    expect(store.loadDocument('alice', 'd1')).toBeNull();
  });

  it('keeps owners apart: the same id is two documents', () => {
    store.saveDocument('alice', 'd1', labeled('A'), 1, 0);
    expect(store.loadDocument('bob', 'd1')).toBeNull();
    expect(store.saveDocument('bob', 'd1', labeled('B'), 1, 0).status).toBe('saved');
    expect(store.listDocuments('alice').map((summary) => summary.searchText)).toEqual([expect.stringContaining('a')]);
    expect(store.loadDocument('alice', 'd1')?.document.pages[0]?.nodes[0]?.content.label).toBe('A');
  });

  it('brings an archived document back when a tab still editing it saves', () => {
    store.saveDocument('alice', 'd1', labeled('A'), 1, 0);
    store.archiveDocuments('alice', ['d1']);
    expect(store.listDocuments('alice')).toEqual([]);
    expect(store.listArchive('alice').map((summary) => summary.id)).toEqual(['d1']);
    store.saveDocument('alice', 'd1', labeled('A2'), 2, 1);
    expect(store.listDocuments('alice').map((summary) => summary.id)).toEqual(['d1']);
  });
});

describe('thumbnails', () => {
  it('stores a preview, null for an oversized one, and drops one for a document not stored', () => {
    store.saveDocument('alice', 'd1', labeled('A'), 1, 0);
    store.saveDocument('alice', 'd2', labeled('B'), 1, 0);
    store.saveThumbnail('alice', 'd1', { light: '<svg/>', dark: '<svg/>' });
    store.saveThumbnail('alice', 'd2', { light: 'x'.repeat(V2_THUMBNAIL_MAX_CHARS), dark: 'x' });
    store.saveThumbnail('alice', 'gone', { light: '<svg/>', dark: '<svg/>' });
    expect(store.listThumbnails('alice')).toEqual(expect.arrayContaining([
      { id: 'd1', thumbnail: { light: '<svg/>', dark: '<svg/>' } },
      { id: 'd2', thumbnail: null },
    ]));
    expect(store.listThumbnails('alice')).toHaveLength(2);
  });
});

describe('publishing', () => {
  it('serves the snapshot at the published revision, not later edits', () => {
    store.saveDocument('alice', 'd1', labeled('Published'), 1, 0);
    const published = store.publish('alice', 'd1', mint)!;
    store.saveDocument('alice', 'd1', labeled('Draft'), 2, 1);
    const snapshot = store.readPublic(published.slug)!;
    expect(snapshot.publishedRevision).toBe(1);
    expect((snapshot.document as SceneDocumentV1).pages[0]?.nodes[0]?.content.label).toBe('Published');
    expect(JSON.stringify(snapshot)).not.toContain('alice');
  });

  it('keeps a live slug on republish; after unpublish the old slug is dead and a new one is minted', () => {
    store.saveDocument('alice', 'd1', labeled('A'), 1, 0);
    const first = store.publish('alice', 'd1', mint)!;
    expect(store.publish('alice', 'd1', mint)!.slug).toBe(first.slug);
    expect(store.unpublish('alice', 'd1')).toBe(true);
    expect(store.readPublic(first.slug)).toBeNull();
    expect(store.publication('alice', 'd1')).toBeNull();
    const second = store.publish('alice', 'd1', mint)!;
    expect(second.slug).not.toBe(first.slug);
    expect(store.readPublic(second.slug)).not.toBeNull();
  });

  it('publishes nothing for a document another owner holds, and deleting unpublishes', () => {
    store.saveDocument('alice', 'd1', labeled('A'), 1, 0);
    expect(store.publish('bob', 'd1', mint)).toBeNull();
    const published = store.publish('alice', 'd1', mint)!;
    store.deleteDocument('alice', 'd1');
    expect(store.readPublic(published.slug)).toBeNull();
  });
});
