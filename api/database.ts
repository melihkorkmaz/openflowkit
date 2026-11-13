import { DatabaseSync } from 'node:sqlite';

/** Append-only: a shipped migration never changes, the next one fixes it. Version = index + 1. */
const MIGRATIONS: readonly string[] = [
  `CREATE TABLE documents (
     owner_id TEXT NOT NULL,
     id TEXT NOT NULL,
     revision INTEGER NOT NULL,
     schema_version INTEGER NOT NULL,
     document_json TEXT NOT NULL,
     saved_at TEXT NOT NULL,
     archived_at TEXT NULL,
     PRIMARY KEY (owner_id, id)
   );
   CREATE TABLE thumbnails (
     owner_id TEXT NOT NULL,
     document_id TEXT NOT NULL,
     light_svg TEXT NULL,
     dark_svg TEXT NULL,
     oversized INTEGER NOT NULL DEFAULT 0,
     updated_at TEXT NOT NULL,
     PRIMARY KEY (owner_id, document_id),
     FOREIGN KEY (owner_id, document_id) REFERENCES documents(owner_id, id) ON DELETE CASCADE
   );
   -- The snapshot is the document at published_revision: later edits never leak into the public page.
   CREATE TABLE published_documents (
     owner_id TEXT NOT NULL,
     document_id TEXT NOT NULL,
     public_slug TEXT NOT NULL UNIQUE,
     published_revision INTEGER NOT NULL,
     snapshot_json TEXT NOT NULL,
     published_at TEXT NOT NULL,
     revoked_at TEXT NULL,
     PRIMARY KEY (owner_id, document_id),
     FOREIGN KEY (owner_id, document_id) REFERENCES documents(owner_id, id) ON DELETE CASCADE
   );`,
];

/** Opens (creating if needed) the database at `path` and brings its schema up to date. */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number | null };
  for (let version = (row.version ?? 0) + 1; version <= MIGRATIONS.length; version += 1) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(MIGRATIONS[version - 1]!);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(version, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;
