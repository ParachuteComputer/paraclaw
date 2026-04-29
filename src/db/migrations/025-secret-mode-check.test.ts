/**
 * Migration 025 (paraclaw#28): CHECK constraint on agent_groups.secret_mode.
 * Verify it (a) preserves existing rows across the table recreate-and-rename
 * and (b) rejects out-of-range writes that previously would have been
 * silently accepted.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../index.js';
import { migration025 } from './025-secret-mode-check.js';
import { applyMigrationsExcept } from './_test-helpers.js';

afterEach(() => {
  closeDb();
});

describe('migration 025 — secret_mode CHECK constraint', () => {
  it('preserves rows already in agent_groups across the table recreate', () => {
    // Apply everything up through 024, leaving 025 unrun. Insert a row
    // with the pre-025 shape (no CHECK constraint). Then run 025 directly
    // and confirm the row survives the DROP-and-RENAME dance.
    //
    // The migration runner wraps each migration in a transaction so
    // `PRAGMA defer_foreign_keys = TRUE` defers FK checks until commit;
    // we replicate that wrapping here, otherwise the DROP TABLE
    // agent_groups would trip the FKs on sessions/secrets/etc.
    const db = applyMigrationsExcept([migration025]);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (?, ?, ?, NULL, 'all', datetime('now'))`,
    ).run('keepme', 'keepme', 'keepme');

    db.transaction(() => migration025.up(db))();

    const row = db.prepare(`SELECT * FROM agent_groups WHERE id = ?`).get('keepme') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('all');
  });

  it('rejects out-of-range writes', () => {
    const db = initTestDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
           VALUES (?, ?, ?, NULL, 'bogus', datetime('now'))`,
        )
        .run('badmode', 'badmode', 'badmode'),
    ).toThrow(/CHECK constraint/i);
  });

  it('still accepts both valid modes', () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (?, ?, ?, NULL, 'all', datetime('now'))`,
    ).run('g-all', 'g-all', 'g-all');
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (?, ?, ?, NULL, 'selective', datetime('now'))`,
    ).run('g-sel', 'g-sel', 'g-sel');
    const rows = db
      .prepare(`SELECT id, secret_mode FROM agent_groups WHERE id IN ('g-all', 'g-sel') ORDER BY id`)
      .all() as { id: string; secret_mode: string }[];
    expect(rows).toEqual([
      { id: 'g-all', secret_mode: 'all' },
      { id: 'g-sel', secret_mode: 'selective' },
    ]);
  });
});
