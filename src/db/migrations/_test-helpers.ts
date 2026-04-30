/**
 * Helpers for migration tests. Lives next to migrations so the import path
 * stays one directory deep, and the underscore prefix signals "not a real
 * migration" — the barrel index doesn't import it.
 */
import { initTestDb, runMigrations } from '../index.js';
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

/**
 * Build a fresh in-memory test DB and run every migration in the barrel
 * EXCEPT the ones listed.
 *
 * Implementation: pre-record each skip migration's `name` in
 * `schema_version` so `runMigrations()` treats it as already-applied
 * (skip detection is keyed on `name`, not `version`). The `version`
 * column is auto-assigned via `MAX+1` at insert time, so reusing each
 * skipped migration's own version here is collision-free — the unique
 * index on `name` blocks any duplicate-skip first.
 *
 * Replaces the older sentinel-version trick (e.g. inserting at version
 * 9998/9999) which encoded the migration name as a magic string and
 * silently rotted if the migration was renamed.
 */
export function applyMigrationsExcept(skip: Migration[]): Database {
  const db = initTestDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);
  const stmt = db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)');
  for (const m of skip) {
    stmt.run(m.version, m.name, '2026-01-01');
  }
  runMigrations(db);
  return db;
}
