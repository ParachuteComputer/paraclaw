/**
 * Coverage for migration 024 (paraclaw#11). Both source tables happen to be
 * empty in Aaron's install, so backfill correctness can only be verified with
 * fixtures: insert representative rows into `pending_questions` and
 * `pending_approvals`, then run 024 and assert the resulting `approvals`
 * shape.
 *
 * Strategy: pre-record `collapse-approvals` in `schema_version` so
 * `runMigrations()` skips it, build the pre-024 DB, seed fixtures, then call
 * `migration024.up(db)` directly. This is the cheapest way to exercise the
 * backfill without exporting the private migrations list.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../index.js';
import { migration024 } from './024-collapse-approvals.js';

function applyAllExcept024(): void {
  const db = initTestDb();
  // Mark 024 as already-applied so runMigrations skips it.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
    INSERT INTO schema_version (version, name, applied) VALUES (9999, 'collapse-approvals', '2026-01-01');
  `);
  runMigrations(db);
}

function seedAgentGroupAndSession(id: string, agentGroupId: string, sessionId: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
     VALUES (?, ?, ?, NULL, 'selective', datetime('now'))`,
  ).run(agentGroupId, agentGroupId, agentGroupId);
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
     VALUES (?, ?, NULL, NULL, NULL, 'active', 'stopped', NULL, datetime('now'))`,
  ).run(sessionId, agentGroupId);
}

interface ApprovalRow {
  id: string;
  kind: string;
  agent_group_id: string;
  session_id: string | null;
  body: string;
  status: string;
  created_at: string;
  expires_at: string | null;
}

beforeEach(() => {
  applyAllExcept024();
});

afterEach(() => {
  closeDb();
});

describe('migration 024 — backfill', () => {
  it('questions-only fixture maps to kind="question" with derived agent_group_id', () => {
    seedAgentGroupAndSession('seed-q', 'ag-q', 'sess-q');
    const db = getDb();
    db.prepare(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'q-1',
      'sess-q',
      'msg-out-1',
      'discord:111',
      'discord',
      'thread-1',
      'Pick one',
      JSON.stringify([{ label: 'Yes', selectedLabel: 'Yes', value: 'yes' }]),
      '2026-04-01T00:00:00Z',
    );

    migration024.up(db);

    const rows = db.prepare(`SELECT * FROM approvals ORDER BY id`).all() as ApprovalRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('q-1');
    expect(rows[0].kind).toBe('question');
    expect(rows[0].agent_group_id).toBe('ag-q'); // derived from session
    expect(rows[0].session_id).toBe('sess-q');
    expect(rows[0].status).toBe('pending');
    const body = JSON.parse(rows[0].body) as Record<string, unknown>;
    expect(body.title).toBe('Pick one');
    expect(body.message_out_id).toBe('msg-out-1');
    expect(body.platform_id).toBe('discord:111');
    expect(body.channel_type).toBe('discord');
    expect(body.thread_id).toBe('thread-1');
    expect(Array.isArray(body.options)).toBe(true);
  });

  it('approval-per-action fixtures map to kind=action with payload + routing in body', () => {
    seedAgentGroupAndSession('seed-a', 'ag-a', 'sess-a');
    const db = getDb();
    const insertApproval = db.prepare(
      `INSERT INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, platform_message_id, expires_at, status, title, options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fixtures: Array<[string, string, Record<string, unknown>]> = [
      ['a-install', 'install_packages', { packages: ['curl'] }],
      ['a-mcp', 'add_mcp_server', { name: 'tavily', url: 'https://x' }],
      ['a-cred', 'credential', { provider: 'github' }],
    ];
    for (const [id, action, payload] of fixtures) {
      insertApproval.run(
        id,
        'sess-a',
        id,
        action,
        JSON.stringify(payload),
        '2026-04-02T00:00:00Z',
        'ag-a',
        'slack',
        'C0001',
        'msg-1',
        null,
        'pending',
        `Approve ${action}?`,
        JSON.stringify([{ label: 'Approve', selectedLabel: '✅', value: 'approve' }]),
      );
    }

    migration024.up(db);

    const rows = db.prepare(`SELECT * FROM approvals ORDER BY id`).all() as ApprovalRow[];
    // SQLite ORDER BY id is a lexicographic sort over the row-id strings,
    // not insertion order. Fixture ids `a-cred` < `a-install` < `a-mcp`,
    // so the kinds line up as credential → install_packages → add_mcp_server.
    // Renaming a fixture id will reshuffle this list — re-derive, don't
    // chase by re-sorting.
    expect(rows.map((r) => r.kind)).toEqual(['credential', 'install_packages', 'add_mcp_server']);
    for (const r of rows) {
      expect(r.agent_group_id).toBe('ag-a');
      expect(r.session_id).toBe('sess-a');
      expect(r.status).toBe('pending');
      const body = JSON.parse(r.body) as Record<string, unknown>;
      expect(body.title).toContain('Approve');
      expect(body.platform_id).toBe('C0001');
      expect(body.channel_type).toBe('slack');
      expect(body.platform_message_id).toBe('msg-1');
      expect(typeof body.payload).toBe('object');
    }
    const installRow = rows.find((r) => r.kind === 'install_packages')!;
    const installBody = JSON.parse(installRow.body) as { payload: { packages: string[] } };
    expect(installBody.payload.packages).toEqual(['curl']);
  });

  it('mixed fixture — questions and approvals both copy over', () => {
    seedAgentGroupAndSession('seed-m', 'ag-m', 'sess-m');
    const db = getDb();
    db.prepare(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'q-mix',
      'sess-m',
      'mout-1',
      null,
      null,
      null,
      'Mixed Q',
      JSON.stringify([{ label: 'Y', selectedLabel: 'Y', value: 'y' }]),
      '2026-04-03T00:00:00Z',
    );
    db.prepare(
      `INSERT INTO pending_approvals
         (approval_id, session_id, request_id, action, payload, created_at,
          agent_group_id, channel_type, platform_id, platform_message_id, expires_at, status, title, options_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'a-mix',
      'sess-m',
      'a-mix',
      'install_packages',
      JSON.stringify({ packages: ['jq'] }),
      '2026-04-03T00:00:00Z',
      'ag-m',
      null,
      null,
      null,
      null,
      'pending',
      'Install jq?',
      JSON.stringify([{ label: 'Approve', selectedLabel: '✅', value: 'approve' }]),
    );

    migration024.up(db);

    const rows = db.prepare(`SELECT id, kind FROM approvals ORDER BY id`).all() as ApprovalRow[];
    expect(rows).toEqual([
      expect.objectContaining({ id: 'a-mix', kind: 'install_packages' }),
      expect.objectContaining({ id: 'q-mix', kind: 'question' }),
    ]);
  });

  it('drops orphan question whose session vanished', () => {
    const db = getDb();
    // Insert a pending_question with a session_id pointing nowhere — backfill
    // can't derive agent_group_id, so the row should be dropped (not crash).
    // Bypass FK by disabling temporarily — pending_questions FKs sessions(id).
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare(
      `INSERT INTO pending_questions
         (question_id, session_id, message_out_id, platform_id, channel_type, thread_id, title, options_json, created_at)
       VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
    ).run(
      'q-orphan',
      'sess-gone',
      'mout-x',
      'Orphan',
      JSON.stringify([{ label: 'Y', selectedLabel: 'Y', value: 'y' }]),
      '2026-04-04T00:00:00Z',
    );
    db.exec('PRAGMA foreign_keys = ON');

    migration024.up(db);

    const rows = db.prepare(`SELECT id FROM approvals`).all() as { id: string }[];
    expect(rows).toEqual([]);
  });

  it('drops legacy source tables after backfill', () => {
    const db = getDb();
    migration024.up(db);
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('pending_questions','pending_approvals')`,
      )
      .all() as { name: string }[];
    expect(tables).toEqual([]);
    const approvals = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'approvals'`).all() as {
      name: string;
    }[];
    expect(approvals.map((t) => t.name)).toEqual(['approvals']);
  });
});
