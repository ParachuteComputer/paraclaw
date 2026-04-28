import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { _setMasterKeyForTest } from './master-key.js';
import {
  addAssignment,
  deleteSecret,
  getSecret,
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

function seedAgentGroup(db: ReturnType<typeof initTestDb>, id: string) {
  db.prepare(
    `INSERT INTO agent_groups (id, folder, name, created_at)
     VALUES (?, ?, ?, datetime('now'))`,
  ).run(id, id, id);
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

  it('resolveInjectableSecrets unions global + scoped, scoped wins', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'g1');

    putSecret('G', 'global-only');
    putSecret('S', 'scoped-only', { agent_group_id: 'g1' });
    putSecret('B', 'global-B', {});
    putSecret('B', 'scoped-B', { agent_group_id: 'g1' });

    const env = resolveInjectableSecrets('g1');
    expect(env.get('G')).toBe('global-only');
    expect(env.get('S')).toBe('scoped-only');
    expect(env.get('B')).toBe('scoped-B');
  });

  it('skips assigned_mode=selective rows from resolveInjectableSecrets', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'g1');

    putSecret('OPT_IN', 'value', { assigned_mode: 'selective' });
    putSecret('AUTO', 'value', { assigned_mode: 'all' });

    const env = resolveInjectableSecrets('g1');
    expect(env.has('OPT_IN')).toBe(false);
    expect(env.has('AUTO')).toBe(true);
  });
});

describe('secret assignments (selective mode)', () => {
  it('round-trips: selective secret with assignment to A injects into A, not B', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A');
    seedAgentGroup(db, 'B');

    const secretId = putSecret('SHARED_KEY', 'top-secret', { assigned_mode: 'selective' });
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

    const id = putSecret('K', 'v', { assigned_mode: 'selective' });
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

    const id = putSecret('K', 'v', { assigned_mode: 'selective' });
    addAssignment(id, 'A');
    expect(listAssignments(id)).toEqual(['A']);

    deleteSecret(id);

    const remaining = db.prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM secret_assignments`).get();
    expect(remaining?.n).toBe(0);
  });

  it('selective + assignment lets agent-scoped secrets coexist via name', () => {
    const db = initTestDb();
    runMigrations(db);
    _setMasterKeyForTest(crypto.randomBytes(32));
    seedAgentGroup(db, 'A');
    seedAgentGroup(db, 'B');

    // Global selective with assignment to A only.
    const globalId = putSecret('TOKEN', 'shared-via-allowlist', { assigned_mode: 'selective' });
    addAssignment(globalId, 'A');
    // Scoped-to-B (mode: all) — different value, only B sees it.
    putSecret('TOKEN', 'b-only', { agent_group_id: 'B' });

    expect(resolveInjectableSecrets('A').get('TOKEN')).toBe('shared-via-allowlist');
    expect(resolveInjectableSecrets('B').get('TOKEN')).toBe('b-only');
  });
});
