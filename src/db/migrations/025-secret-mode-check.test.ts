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
    // with the pre-025 shape (no CHECK constraint). Then run 025 the
    // way the runner runs it (FKs off connection-scope, then a tx
    // around `up`) and confirm the row survives the DROP-and-RENAME.
    const db = applyMigrationsExcept([migration025]);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (?, ?, ?, NULL, 'all', datetime('now'))`,
    ).run('keepme', 'keepme', 'keepme');

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => migration025.up(db))();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    const row = db.prepare(`SELECT * FROM agent_groups WHERE id = ?`).get('keepme') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('all');
  });

  it('survives an orphan FK row in a referencing table (paraclaw#54)', () => {
    // Production-flavored regression: real installs carry pre-FK-era
    // orphan rows (e.g. a `sessions.agent_group_id` whose parent was
    // never inserted or got dropped). Migration 025's first cut used
    // `defer_foreign_keys = TRUE`, which delays the FK check to commit
    // and then trips it on the orphan, taking the whole boot down with
    // a `FOREIGN KEY constraint failed` Startup error. Plant the
    // production-shaped triple — real parent, valid child pointing at
    // it, AND orphan child pointing at a never-existed parent — and
    // run 025 the way the runner runs it. Empirically, the deferred
    // check only fires when the renamed parent has live referencing
    // children, so the orphan-only fixture isn't enough; a bare orphan
    // slips past `defer_foreign_keys=TRUE`.
    const db = applyMigrationsExcept([migration025]);

    // Real parent + valid child (the natural way, FKs ON).
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (?, ?, ?, NULL, 'all', datetime('now'))`,
    ).run('g-real', 'g-real', 'g-real');
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at)
       VALUES (?, ?, NULL, NULL, 'active', datetime('now'))`,
    ).run('valid-session', 'g-real');

    // Orphan child: foreign_keys is ON by default in test DBs
    // (initTestDb), so flip it off to plant one. This mirrors how the
    // orphan appeared on Aaron's DB — early-era operations under
    // foreign_keys = OFF, never reconciled.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at)
       VALUES (?, ?, NULL, NULL, 'active', datetime('now'))`,
    ).run('orphan-session', 'never-existed-agent-group');
    db.exec('PRAGMA foreign_keys = ON');

    // Verify the FK violation is real *before* running the migration —
    // i.e. the fixture would actually trip a deferred check.
    const violationsBefore = db.prepare(`PRAGMA foreign_key_check`).all() as {
      table: string;
      rowid: number;
      parent: string;
      fkid: number;
    }[];
    expect(violationsBefore.some((v) => v.table === 'sessions' && v.parent === 'agent_groups')).toBe(true);

    // Run 025 via the real runner so the disableForeignKeys flag is
    // exercised end-to-end. Drop the fake-applied marker first so the
    // runner picks it up.
    db.prepare('DELETE FROM schema_version WHERE name = ?').run('secret-mode-check');
    expect(() => runMigrations(db)).not.toThrow();

    // Both children are still there, the parent survived the recreate,
    // the migration recorded itself, and the CHECK constraint is in
    // place.
    const orphan = db.prepare(`SELECT id, agent_group_id FROM sessions WHERE id = ?`).get('orphan-session') as {
      id: string;
      agent_group_id: string;
    };
    expect(orphan).toEqual({ id: 'orphan-session', agent_group_id: 'never-existed-agent-group' });
    const valid = db.prepare(`SELECT id, agent_group_id FROM sessions WHERE id = ?`).get('valid-session') as {
      id: string;
      agent_group_id: string;
    };
    expect(valid).toEqual({ id: 'valid-session', agent_group_id: 'g-real' });
    const parent = db.prepare(`SELECT id FROM agent_groups WHERE id = ?`).get('g-real') as { id: string };
    expect(parent?.id).toBe('g-real');
    const applied = db.prepare(`SELECT name FROM schema_version WHERE name = ?`).get('secret-mode-check') as {
      name: string;
    };
    expect(applied?.name).toBe('secret-mode-check');
    expect(() =>
      db
        .prepare(
          `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
           VALUES (?, ?, ?, NULL, 'bogus', datetime('now'))`,
        )
        .run('badmode-after-fix', 'badmode-after-fix', 'badmode-after-fix'),
    ).toThrow(/CHECK constraint/i);
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
