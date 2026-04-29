/**
 * Migration 025 (paraclaw#28): CHECK constraint on agent_groups.secret_mode.
 * Verify it (a) preserves existing rows and (b) rejects out-of-range writes
 * that previously would have been silently accepted.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../index.js';

afterEach(() => {
  closeDb();
});

describe('migration 025 — secret_mode CHECK constraint', () => {
  it('preserves rows already in agent_groups across the table recreate', () => {
    const db = initTestDb();
    runMigrations(db);
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (?, ?, ?, NULL, 'all', datetime('now'))`,
    ).run('keepme', 'keepme', 'keepme');
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
