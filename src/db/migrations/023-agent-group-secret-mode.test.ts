/**
 * Coverage for migration 023 (paraclaw#9). Real installs have either no
 * secrets or a single mode per group, so the interesting paths — mixed-mode
 * collapse and group-level fan-out — only get exercised with fixtures.
 *
 * Strategy: pre-record `agent-group-secret-mode` in `schema_version` so
 * `runMigrations()` skips it, build the pre-023 DB shape (no `secret_mode`
 * column on `agent_groups`, `assigned_mode` still present on `secrets`),
 * seed fixtures, then call `migration023.up(db)` directly and assert.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../index.js';
import { migration023 } from './023-agent-group-secret-mode.js';

function applyAllExcept023(): void {
  const db = initTestDb();
  // Mark 023 as already-applied so runMigrations skips it. 024 doesn't
  // depend on the secret_mode column, so it runs cleanly afterwards.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
    INSERT INTO schema_version (version, name, applied) VALUES (9999, 'agent-group-secret-mode', '2026-01-01');
  `);
  runMigrations(db);
}

function seedAgentGroup(id: string): void {
  // Pre-023: agent_groups has no secret_mode column.
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, NULL, datetime('now'))`,
    )
    .run(id, id, id);
}

function seedSecret(id: string, agentGroupId: string | null, assignedMode: 'all' | 'selective'): void {
  // Pre-023: secrets still has assigned_mode.
  getDb()
    .prepare(
      `INSERT INTO secrets (id, name, value_encrypted, kind, agent_group_id, assigned_mode, created_at, updated_at)
       VALUES (?, ?, 'enc-stub', 'generic', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(id, id, agentGroupId, assignedMode);
}

beforeEach(() => {
  applyAllExcept023();
});

afterEach(() => {
  closeDb();
});

describe('migration 023 — agent_groups.secret_mode backfill', () => {
  it('uniform "all" backfills group to all', () => {
    seedAgentGroup('ag-all');
    seedSecret('s1', 'ag-all', 'all');
    seedSecret('s2', 'ag-all', 'all');

    migration023.up(getDb());

    const row = getDb().prepare(`SELECT secret_mode FROM agent_groups WHERE id = ?`).get('ag-all') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('all');
  });

  it('uniform "selective" backfills group to selective', () => {
    seedAgentGroup('ag-sel');
    seedSecret('s3', 'ag-sel', 'selective');
    seedSecret('s4', 'ag-sel', 'selective');

    migration023.up(getDb());

    const row = getDb().prepare(`SELECT secret_mode FROM agent_groups WHERE id = ?`).get('ag-sel') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('selective');
  });

  it('mixed-mode collapses to "all" (errs on the side of injecting)', () => {
    seedAgentGroup('ag-mix');
    seedSecret('s5', 'ag-mix', 'all');
    seedSecret('s6', 'ag-mix', 'selective');

    migration023.up(getDb());

    const row = getDb().prepare(`SELECT secret_mode FROM agent_groups WHERE id = ?`).get('ag-mix') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('all');
  });

  it('group with no in-scope secrets keeps the new default (selective)', () => {
    seedAgentGroup('ag-empty');
    // No secrets seeded for ag-empty. No globals either.

    migration023.up(getDb());

    const row = getDb().prepare(`SELECT secret_mode FROM agent_groups WHERE id = ?`).get('ag-empty') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('selective');
  });

  it('global "all" secret pulls otherwise-empty group to all', () => {
    seedAgentGroup('ag-only-global');
    seedSecret('s-glob', null, 'all');

    migration023.up(getDb());

    const row = getDb().prepare(`SELECT secret_mode FROM agent_groups WHERE id = ?`).get('ag-only-global') as {
      secret_mode: string;
    };
    expect(row.secret_mode).toBe('all');
  });

  it('drops the now-vestigial secrets.assigned_mode column', () => {
    seedAgentGroup('ag-drop');
    seedSecret('s-drop', 'ag-drop', 'all');

    migration023.up(getDb());

    const cols = getDb().prepare(`PRAGMA table_info(secrets)`).all() as { name: string }[];
    expect(cols.map((c) => c.name)).not.toContain('assigned_mode');
  });
});
