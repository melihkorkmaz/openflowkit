import type { DatabaseSync } from 'node:sqlite';
import type { SceneDocumentV1 } from '@/opencanvas/domain/document/types';
import type { DocumentValidationIssue } from '@/opencanvas/domain/document/validation';
import {
  V2_THUMBNAIL_MAX_CHARS,
  storableV2DocumentIssue,
  summarizeV2Record,
  type V2DocumentRecord,
  type V2DocumentSummary,
  type V2Thumbnail,
} from '@/services/storage/v2/v2Repository';

export type SaveResult =
  | { readonly status: 'saved'; readonly record: V2DocumentRecord }
  | { readonly status: 'stale'; readonly storedRevision: number }
  | { readonly status: 'invalid'; readonly issue: DocumentValidationIssue };

export interface Publication {
  readonly slug: string;
  readonly publishedRevision: number;
  readonly publishedAt: string;
}

/** What an anonymous visitor gets: the snapshot and when it was taken, never who owns it. */
export interface PublicSnapshot {
  readonly document: unknown;
  readonly publishedRevision: number;
  readonly publishedAt: string;
}

interface DocumentRow {
  id: string;
  revision: number;
  schema_version: number;
  document_json: string;
  saved_at: string;
  archived_at: string | null;
}

function toRecord(row: DocumentRow): V2DocumentRecord {
  return {
    id: row.id,
    revision: row.revision,
    schemaVersion: row.schema_version,
    document: JSON.parse(row.document_json) as SceneDocumentV1,
    savedAt: row.saved_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
  };
}

function inTransaction<T>(db: DatabaseSync, run: () => T): T {
  // IMMEDIATE takes the write lock before the read, so a second process cannot commit between them.
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/** Every method takes the verified owner id first: no query reaches a row another owner wrote. */
export function createDocumentStore(db: DatabaseSync, now: () => Date = () => new Date()) {
  const selectRevision = db.prepare('SELECT revision FROM documents WHERE owner_id = ? AND id = ?');
  const upsert = db.prepare(`INSERT INTO documents (owner_id, id, revision, schema_version, document_json, saved_at, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (owner_id, id) DO UPDATE SET revision = excluded.revision, schema_version = excluded.schema_version,
      document_json = excluded.document_json, saved_at = excluded.saved_at, archived_at = NULL`);
  const selectOne = db.prepare('SELECT id, revision, schema_version, document_json, saved_at, archived_at FROM documents WHERE owner_id = ? AND id = ?');
  const selectActive = db.prepare('SELECT id, revision, schema_version, document_json, saved_at, archived_at FROM documents WHERE owner_id = ? AND archived_at IS NULL ORDER BY saved_at DESC');
  const selectArchived = db.prepare('SELECT id, revision, schema_version, document_json, saved_at, archived_at FROM documents WHERE owner_id = ? AND archived_at IS NOT NULL ORDER BY archived_at DESC');
  const setArchived = db.prepare('UPDATE documents SET archived_at = ? WHERE owner_id = ? AND id = ?');
  const remove = db.prepare('DELETE FROM documents WHERE owner_id = ? AND id = ?');
  // A preview for a document not stored (deleted meanwhile, or saved later) is dropped, never orphaned.
  const upsertThumbnail = db.prepare(`INSERT INTO thumbnails (owner_id, document_id, light_svg, dark_svg, oversized, updated_at)
    SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM documents WHERE owner_id = ? AND id = ?)
    ON CONFLICT (owner_id, document_id) DO UPDATE SET light_svg = excluded.light_svg, dark_svg = excluded.dark_svg,
      oversized = excluded.oversized, updated_at = excluded.updated_at`);
  const selectThumbnails = db.prepare('SELECT document_id, light_svg, dark_svg FROM thumbnails WHERE owner_id = ?');
  const selectPublication = db.prepare('SELECT public_slug, published_revision, published_at, revoked_at FROM published_documents WHERE owner_id = ? AND document_id = ?');
  const upsertPublication = db.prepare(`INSERT INTO published_documents (owner_id, document_id, public_slug, published_revision, snapshot_json, published_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT (owner_id, document_id) DO UPDATE SET public_slug = excluded.public_slug, published_revision = excluded.published_revision,
      snapshot_json = excluded.snapshot_json, published_at = excluded.published_at, revoked_at = NULL`);
  const revokePublication = db.prepare('UPDATE published_documents SET revoked_at = ? WHERE owner_id = ? AND document_id = ? AND revoked_at IS NULL');
  const selectPublic = db.prepare('SELECT snapshot_json, published_revision, published_at FROM published_documents WHERE public_slug = ? AND revoked_at IS NULL');

  const list = (owner: string, archived: boolean): V2DocumentSummary[] =>
    ((archived ? selectArchived : selectActive).all(owner) as unknown as DocumentRow[]).map((row) => summarizeV2Record(toRecord(row)));

  const publication = (owner: string, id: string): Publication | null => {
    const row = selectPublication.get(owner, id) as { public_slug: string; published_revision: number; published_at: string; revoked_at: string | null } | undefined;
    return row && row.revoked_at === null ? { slug: row.public_slug, publishedRevision: row.published_revision, publishedAt: row.published_at } : null;
  };

  return {
    /** Compare-and-swap, as the browser repository: writes only while the stored revision is `expectedRevision`, or nothing is stored. */
    saveDocument(owner: string, id: string, document: SceneDocumentV1, revision: number, expectedRevision: number, savedAt?: string): SaveResult {
      const issue = storableV2DocumentIssue(document);
      if (issue) return { status: 'invalid', issue };
      return inTransaction(db, () => {
        const stored = selectRevision.get(owner, id) as { revision: number } | undefined;
        if (stored && stored.revision !== expectedRevision) return { status: 'stale', storedRevision: stored.revision };
        const record: V2DocumentRecord = { id, revision, schemaVersion: document.schemaVersion, document, savedAt: savedAt ?? now().toISOString() };
        // A save from a tab still editing an archived document brings it back, as in the browser store.
        upsert.run(owner, id, revision, record.schemaVersion, JSON.stringify(document), record.savedAt);
        return { status: 'saved', record };
      });
    },
    loadDocument(owner: string, id: string): V2DocumentRecord | null {
      const row = selectOne.get(owner, id) as unknown as DocumentRow | undefined;
      return row ? toRecord(row) : null;
    },
    listDocuments: (owner: string) => list(owner, false),
    listArchive: (owner: string) => list(owner, true),
    archiveDocuments(owner: string, ids: readonly string[]): void {
      const at = now().toISOString();
      inTransaction(db, () => { for (const id of ids) setArchived.run(at, owner, id); });
    },
    restoreDocuments(owner: string, ids: readonly string[]): void {
      inTransaction(db, () => { for (const id of ids) setArchived.run(null, owner, id); });
    },
    /** Its thumbnail and publication go with it (cascade): a deleted document's public link stops opening. */
    deleteDocument(owner: string, id: string): void {
      remove.run(owner, id);
    },
    saveThumbnail(owner: string, id: string, thumbnail: V2Thumbnail | null): void {
      const oversized = thumbnail !== null && thumbnail.light.length + thumbnail.dark.length > V2_THUMBNAIL_MAX_CHARS;
      const kept = thumbnail && !oversized ? thumbnail : null;
      upsertThumbnail.run(owner, id, kept?.light ?? null, kept?.dark ?? null, oversized ? 1 : 0, now().toISOString(), owner, id);
    },
    listThumbnails(owner: string): { id: string; thumbnail: V2Thumbnail | null }[] {
      return (selectThumbnails.all(owner) as { document_id: string; light_svg: string | null; dark_svg: string | null }[])
        .map((row) => ({ id: row.document_id, thumbnail: row.light_svg !== null && row.dark_svg !== null ? { light: row.light_svg, dark: row.dark_svg } : null }));
    },
    publication,
    /**
     * Snapshots the stored document at its current revision. A live link keeps its slug (people already have it);
     * a revoked one never comes back: publishing again mints a new slug. `null` when the document is not stored.
     */
    publish(owner: string, id: string, mintSlug: () => string): Publication | null {
      return inTransaction(db, () => {
        const row = selectOne.get(owner, id) as unknown as DocumentRow | undefined;
        if (!row) return null;
        const live = publication(owner, id);
        const slug = live?.slug ?? mintSlug();
        const publishedAt = now().toISOString();
        upsertPublication.run(owner, id, slug, row.revision, row.document_json, publishedAt);
        return { slug, publishedRevision: row.revision, publishedAt };
      });
    },
    /** True when a live link was revoked. */
    unpublish(owner: string, id: string): boolean {
      return Number(revokePublication.run(now().toISOString(), owner, id).changes) > 0;
    },
    readPublic(slug: string): PublicSnapshot | null {
      const row = selectPublic.get(slug) as { snapshot_json: string; published_revision: number; published_at: string } | undefined;
      return row ? { document: JSON.parse(row.snapshot_json), publishedRevision: row.published_revision, publishedAt: row.published_at } : null;
    },
  };
}

export type DocumentStore = ReturnType<typeof createDocumentStore>;
