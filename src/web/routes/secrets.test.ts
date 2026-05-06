/**
 * HTTP-boundary tests for the secrets route — currently focused on the
 * staleness probe added with paraclaw#103. The mutation surfaces (POST,
 * DELETE, /assignments) are exercised by `src/secrets/secrets.test.ts` at
 * the helper level; this file complements that with the route dispatcher.
 *
 * Auth gating (`agent:read` for GET, `agent:admin` for mutation) lives in
 * `src/web/server.ts` upstream of `handleSecretsRoute`, so 401/403 cases
 * belong to `auth.test.ts` rather than the route layer — the handler is
 * never reached without a passing scope check. We assert the handler's
 * own contract here (status, body shape, 404 for missing rows).
 */
import http from 'node:http';
import crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db/connection.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { _setMasterKeyForTest } from '../../secrets/master-key.js';
import { addAssignment, putSecret } from '../../secrets/index.js';
import { handleSecretsRoute, listInjectableSecretsForGroupView } from './secrets.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _setMasterKeyForTest(crypto.randomBytes(32));
});

afterEach(() => {
  closeDb();
});

interface FakeResponse {
  statusCode: number;
  body: unknown;
  res: http.ServerResponse;
}

function fakeRes(): FakeResponse {
  const captured: FakeResponse = {
    statusCode: 0,
    body: undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: undefined as any,
  };
  const res = {
    writeHead(status: number) {
      captured.statusCode = status;
    },
    end(chunk: string) {
      try {
        captured.body = chunk ? JSON.parse(chunk) : undefined;
      } catch {
        captured.body = chunk;
      }
    },
  } as unknown as http.ServerResponse;
  captured.res = res;
  return captured;
}

function fakeReq(): http.IncomingMessage {
  return Object.assign(Object.create(null), {
    [Symbol.asyncIterator]: async function* () {},
  }) as http.IncomingMessage;
}

function seedAgentGroup(id: string, secretMode: 'all' | 'selective' = 'selective') {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, folder, name, secret_mode, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`,
    )
    .run(id, id, id, secretMode);
}

function seedSession(sessionId: string, agentGroupId: string, createdAt: string) {
  getDb()
    .prepare(
      `INSERT INTO sessions
         (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (?, ?, NULL, NULL, NULL, 'active', 'running', NULL, ?)`,
    )
    .run(sessionId, agentGroupId, createdAt);
}

function bumpSecretUpdatedAt(secretId: string, updatedAt: string) {
  getDb().prepare(`UPDATE secrets SET updated_at = ? WHERE id = ?`).run(updatedAt, secretId);
}

describe('GET /api/secrets/:id/stale-sessions', () => {
  it('returns 200 with the secret metadata + the stale-session list', async () => {
    seedAgentGroup('group-a', 'selective');
    // Session spawned at t=10, secret bumped to t=20 — session is stale.
    seedSession('sess-1', 'group-a', '2026-01-01T00:00:10.000Z');
    const sid = putSecret('TOKEN', 'v');
    addAssignment(sid, 'group-a');
    bumpSecretUpdatedAt(sid, '2026-01-01T00:00:20.000Z');

    const cap = fakeRes();
    const handled = await handleSecretsRoute({
      pathname: `/api/secrets/${sid}/stale-sessions`,
      method: 'GET',
      url: new URL(`https://x/api/secrets/${sid}/stale-sessions`),
      req: fakeReq(),
      res: cap.res,
    });

    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(200);
    expect(cap.body).toMatchObject({
      secretId: sid,
      secretUpdatedAt: '2026-01-01T00:00:20.000Z',
      staleSessions: [
        {
          sessionId: 'sess-1',
          agentGroupId: 'group-a',
          agentGroupName: 'group-a',
          agentGroupFolder: 'group-a',
          sessionCreatedAt: '2026-01-01T00:00:10.000Z',
          secretUpdatedAt: '2026-01-01T00:00:20.000Z',
        },
      ],
    });
  });

  it('returns 200 with an empty staleSessions array when nothing is stale', async () => {
    seedAgentGroup('group-a', 'selective');
    // Session spawned AFTER the secret update — not stale.
    const sid = putSecret('TOKEN', 'v');
    addAssignment(sid, 'group-a');
    bumpSecretUpdatedAt(sid, '2026-01-01T00:00:10.000Z');
    seedSession('sess-fresh', 'group-a', '2026-01-01T00:00:20.000Z');

    const cap = fakeRes();
    await handleSecretsRoute({
      pathname: `/api/secrets/${sid}/stale-sessions`,
      method: 'GET',
      url: new URL(`https://x/api/secrets/${sid}/stale-sessions`),
      req: fakeReq(),
      res: cap.res,
    });

    expect(cap.statusCode).toBe(200);
    expect(cap.body).toMatchObject({ secretId: sid, staleSessions: [] });
  });

  it('returns 404 for an unknown secret id', async () => {
    const cap = fakeRes();
    const handled = await handleSecretsRoute({
      pathname: '/api/secrets/does-not-exist/stale-sessions',
      method: 'GET',
      url: new URL('https://x/api/secrets/does-not-exist/stale-sessions'),
      req: fakeReq(),
      res: cap.res,
    });

    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(404);
    expect(cap.body).toMatchObject({ error: expect.stringContaining('does-not-exist') });
  });

  it('falls through (returns false) on non-GET methods so the dispatcher can keep looking', async () => {
    const cap = fakeRes();
    const handled = await handleSecretsRoute({
      pathname: '/api/secrets/anything/stale-sessions',
      method: 'POST',
      url: new URL('https://x/api/secrets/anything/stale-sessions'),
      req: fakeReq(),
      res: cap.res,
    });
    expect(handled).toBe(false);
  });
});

describe('listInjectableSecretsForGroupView (paraclaw#104)', () => {
  it('projects scoped/assigned/global rows into the wire shape', () => {
    seedAgentGroup('group-x', 'all');
    const scopedId = putSecret('SCOPED', 'v', { agent_group_id: 'group-x' });
    const assignedId = putSecret('ASSIGNED', 'v');
    addAssignment(assignedId, 'group-x');
    const globalId = putSecret('GLOBAL', 'v');

    const view = listInjectableSecretsForGroupView('group-x');
    const byName = new Map(view.map((r) => [r.name, r]));

    expect(byName.get('SCOPED')).toMatchObject({
      id: scopedId,
      name: 'SCOPED',
      kind: 'generic',
      agentGroupId: 'group-x',
      scope: 'scoped',
    });
    expect(byName.get('ASSIGNED')).toMatchObject({
      id: assignedId,
      agentGroupId: null,
      scope: 'assigned',
    });
    expect(byName.get('GLOBAL')).toMatchObject({
      id: globalId,
      agentGroupId: null,
      scope: 'global',
    });

    // Wire shape is camelCase, never the snake_case DB row.
    for (const row of view) {
      expect(row).not.toHaveProperty('agent_group_id');
      expect(row).not.toHaveProperty('value_encrypted');
      expect(row).toHaveProperty('createdAt');
      expect(row).toHaveProperty('updatedAt');
    }
  });

  it('returns [] for a group whose secret_mode is selective with no assignments', () => {
    seedAgentGroup('empty', 'selective');
    putSecret('GLOBAL', 'v');
    expect(listInjectableSecretsForGroupView('empty')).toEqual([]);
  });
});
