import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { SecretMode } from '../types.js';
import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { _setMasterKeyForTest } from './master-key.js';
import {
  addAssignment,
  deleteSecret,
  findStaleSessionsForSecret,
  getSecret,
  getSecretById,
  listAssignments,
  listSecrets,
  putSecret,
  removeAssignment,
  replaceAssignments,
  resolveInjectableSecrets,
} from './index.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _setMasterKeyForTest(crypto.randomBytes(32));
});

afterEach(() => {
  closeDb();
});

function seedAgentGroup(db: ReturnType<typeof initTestDb>, id: string, mode: SecretMode = 'selective') {
  db.prepare(
    `INSERT INTO agent_groups (id, folder, name, secret_mode, created_at)
     VALUES (?, ?, ?, ?, datetime('now'))`,
  ).run(id, id, id, mode);
}

describe('secrets store', () => {
  it('round-trips a global secret', () => {
    putSecret('SLACK_BOT_TOKEN', 'xoxb-1234');
    expect(getSecret('SLACK_BOT_TOKEN')).toBe('xoxb-1234');
  });

  it('returns undefined for missing names', () => {
    expect(getSecret('NOT_THERE')).toBeUndefined();
  });

  it('updates an existing secret in place', () => {
    const id1 = putSecret('NAME', 'v1');
    const id2 = putSecret('NAME', 'v2');
    expect(id1).toBe(id2);
    expect(getSecret('NAME')).toBe('v2');
  });

  it('lists secret metadata without exposing values', () => {
    putSecret('A', 'aaa');
    putSecret('B', 'bbb', { kind: 'channel-token' });
    const rows = listSecrets();
    expect(rows.map((r) => r.name).sort()).toEqual(['A', 'B']);
    expect(rows.find((r) => r.name === 'B')?.kind).toBe('channel-token');
    expect(rows[0]).not.toHaveProperty('value_encrypted');
  });

  it('agent-scoped secret beats a global one with the same name', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'g1');

    putSecret('TOKEN', 'global-value');
    putSecret('TOKEN', 'g1-value', { agent_group_id: 'g1' });

    expect(getSecret('TOKEN')).toBe('global-value');
    expect(getSecret('TOKEN', 'g1')).toBe('g1-value');
  });

  it('falls back to global when no scoped row exists', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'g1');

    putSecret('SHARED', 'global-only');
    expect(getSecret('SHARED', 'g1')).toBe('global-only');
  });

  it('deletes by id', () => {
    const id = putSecret('ZAP', 'value');
    expect(deleteSecret(id)).toBe(true);
    expect(getSecret('ZAP')).toBeUndefined();
    expect(deleteSecret(id)).toBe(false);
  });

  it('resolveInjectableSecrets in mode=all unions global + scoped, scoped wins', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'g1', 'all');

    putSecret('G', 'global-only');
    putSecret('S', 'scoped-only', { agent_group_id: 'g1' });
    putSecret('B', 'global-B', {});
    putSecret('B', 'scoped-B', { agent_group_id: 'g1' });

    const env = resolveInjectableSecrets('g1');
    expect(env.get('G')).toBe('global-only');
    expect(env.get('S')).toBe('scoped-only');
    expect(env.get('B')).toBe('scoped-B');
  });

  it('mode=selective injects nothing without explicit assignments', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'g1', 'selective');

    putSecret('GLOBAL', 'value');
    putSecret('SCOPED', 'value', { agent_group_id: 'g1' });

    const env = resolveInjectableSecrets('g1');
    expect(env.size).toBe(0);
  });

  it('unknown agent_group_id resolves as no-secrets (selective default)', () => {
    putSecret('GLOBAL', 'v');
    expect(resolveInjectableSecrets('does-not-exist').size).toBe(0);
  });
});

describe('secret assignments (selective mode)', () => {
  it('round-trips: assignment to A injects into A, not B', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'selective');
    seedAgentGroup(db, 'B', 'selective');

    const secretId = putSecret('SHARED_KEY', 'top-secret');
    addAssignment(secretId, 'A');

    expect(resolveInjectableSecrets('A').get('SHARED_KEY')).toBe('top-secret');
    expect(resolveInjectableSecrets('B').has('SHARED_KEY')).toBe(false);
  });

  it('list/replace/add/remove cycle', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A');
    seedAgentGroup(db, 'B');
    seedAgentGroup(db, 'C');

    const id = putSecret('K', 'v');
    expect(listAssignments(id)).toEqual([]);

    replaceAssignments(id, ['A', 'B']);
    expect(listAssignments(id)).toEqual(['A', 'B']);

    addAssignment(id, 'C');
    expect(listAssignments(id)).toEqual(['A', 'B', 'C']);

    // re-add is a no-op (composite PK)
    expect(addAssignment(id, 'C')).toBe(false);

    removeAssignment(id, 'A');
    expect(listAssignments(id)).toEqual(['B', 'C']);

    replaceAssignments(id, []);
    expect(listAssignments(id)).toEqual([]);
  });

  it('replaceAssignments throws on unknown secret', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    expect(() => replaceAssignments('does-not-exist', [])).toThrow(/secret not found/);
  });

  it('deleting a secret cascades its assignments', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A');

    const id = putSecret('K', 'v');
    addAssignment(id, 'A');
    expect(listAssignments(id)).toEqual(['A']);

    deleteSecret(id);

    const remaining = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM secret_assignments`).get();
    expect(remaining?.n).toBe(0);
  });

  it('selective group + assignment + scoped secret in mode=all peer group', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'selective');
    seedAgentGroup(db, 'B', 'all');

    // Global with explicit assignment to A only — A sees it via assignment,
    // B sees its own scoped row instead (scoped wins on name collision).
    const globalId = putSecret('TOKEN', 'shared-via-allowlist');
    addAssignment(globalId, 'A');
    putSecret('TOKEN', 'b-only', { agent_group_id: 'B' });

    expect(resolveInjectableSecrets('A').get('TOKEN')).toBe('shared-via-allowlist');
    expect(resolveInjectableSecrets('B').get('TOKEN')).toBe('b-only');
  });
});

describe('findStaleSessionsForSecret', () => {
  function seedSession(
    db: ReturnType<typeof initTestDb>,
    sessionId: string,
    agentGroupId: string,
    createdAt: string,
    containerStatus: 'running' | 'idle' | 'stopped' = 'running',
  ) {
    db.prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, NULL, NULL, NULL, 'active', ?, NULL, ?)`,
    ).run(sessionId, agentGroupId, containerStatus, createdAt);
  }

  function bumpSecretUpdatedAt(db: ReturnType<typeof initTestDb>, secretId: string, updatedAt: string) {
    db.prepare(`UPDATE secrets SET updated_at = ? WHERE id = ?`).run(updatedAt, secretId);
  }

  it('returns sessions spawned before a global secret was updated, when assigned', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'selective');

    // Session created at t=10
    seedSession(db, 'sess-A', 'A', '2026-01-01T00:00:10.000Z');

    // Global secret with assignment to A; secret updated at t=20 (after spawn)
    const sid = putSecret('TOKEN', 'v');
    addAssignment(sid, 'A');
    bumpSecretUpdatedAt(db, sid, '2026-01-01T00:00:20.000Z');

    const stale = findStaleSessionsForSecret(sid);
    expect(stale).toHaveLength(1);
    expect(stale[0].sessionId).toBe('sess-A');
    expect(stale[0].agentGroupId).toBe('A');
    expect(stale[0].secretUpdatedAt).toBe('2026-01-01T00:00:20.000Z');
    expect(stale[0].sessionCreatedAt).toBe('2026-01-01T00:00:10.000Z');
  });

  it('skips sessions spawned AFTER the secret update', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'selective');

    const sid = putSecret('TOKEN', 'v');
    addAssignment(sid, 'A');
    bumpSecretUpdatedAt(db, sid, '2026-01-01T00:00:10.000Z');

    // Session spawned at t=20 — after the secret update — already has env.
    seedSession(db, 'sess-A', 'A', '2026-01-01T00:00:20.000Z');

    expect(findStaleSessionsForSecret(sid)).toEqual([]);
  });

  it('skips non-running sessions (idle and stopped)', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'all');

    const sid = putSecret('TOKEN', 'v');
    bumpSecretUpdatedAt(db, sid, '2026-01-01T00:00:20.000Z');

    seedSession(db, 'sess-running', 'A', '2026-01-01T00:00:10.000Z', 'running');
    seedSession(db, 'sess-idle', 'A', '2026-01-01T00:00:10.000Z', 'idle');
    seedSession(db, 'sess-stopped', 'A', '2026-01-01T00:00:10.000Z', 'stopped');

    const stale = findStaleSessionsForSecret(sid);
    expect(stale.map((s) => s.sessionId)).toEqual(['sess-running']);
  });

  it('skips groups that would not inject the global (selective + no assignment)', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'selective');
    seedAgentGroup(db, 'B', 'selective');

    const sid = putSecret('TOKEN', 'v');
    addAssignment(sid, 'A'); // only A is assigned
    bumpSecretUpdatedAt(db, sid, '2026-01-01T00:00:20.000Z');

    seedSession(db, 'sess-A', 'A', '2026-01-01T00:00:10.000Z');
    seedSession(db, 'sess-B', 'B', '2026-01-01T00:00:10.000Z');

    const stale = findStaleSessionsForSecret(sid);
    expect(stale.map((s) => s.sessionId)).toEqual(['sess-A']);
  });

  it('includes mode=all groups even without an explicit assignment', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'all');

    const sid = putSecret('TOKEN', 'v');
    bumpSecretUpdatedAt(db, sid, '2026-01-01T00:00:20.000Z');

    seedSession(db, 'sess-A', 'A', '2026-01-01T00:00:10.000Z');
    expect(findStaleSessionsForSecret(sid).map((s) => s.sessionId)).toEqual(['sess-A']);
  });

  it('scoped secret only marks its own group stale', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A', 'all');
    seedAgentGroup(db, 'B', 'all');

    const sid = putSecret('TOKEN', 'v', { agent_group_id: 'A' });
    bumpSecretUpdatedAt(db, sid, '2026-01-01T00:00:20.000Z');

    seedSession(db, 'sess-A', 'A', '2026-01-01T00:00:10.000Z');
    seedSession(db, 'sess-B', 'B', '2026-01-01T00:00:10.000Z');

    expect(findStaleSessionsForSecret(sid).map((s) => s.sessionId)).toEqual(['sess-A']);
  });

  it('returns [] for a missing secret id', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    expect(findStaleSessionsForSecret('does-not-exist')).toEqual([]);
  });
});

describe('getSecretById', () => {
  it('returns the metadata row, never the value', () => {
    const id = putSecret('NAME', 'plaintext');
    const row = getSecretById(id);
    expect(row?.id).toBe(id);
    expect(row?.name).toBe('NAME');
    expect(row).not.toHaveProperty('value_encrypted');
  });

  it('returns undefined for a missing id', () => {
    expect(getSecretById('does-not-exist')).toBeUndefined();
  });
});
