/**
 * Tests for `getMessagingGroupDetail` and the policy-edit branch of
 * `handleChannelsRoute`. Exercises against a real in-memory DB seeded
 * with `agent_groups`, `messaging_groups`, and `messaging_group_agents`
 * rows so the join in `getMessagingGroupDetail` is covered too.
 *
 * The route handler is tested directly (not via the HTTP server) — auth
 * gating lives in `web/server.ts` and is covered by `auth.test.ts`; this
 * file is about the handler's input validation, the 404/200/405 status
 * shape, and the DB write side effect on PATCH.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroup } from '../../db/messaging-groups.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import type { MessagingGroup, MessagingGroupAgent, AgentGroup } from '../../types.js';
import { getMessagingGroupDetail, handleChannelsRoute } from './channels.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

const now = (): string => new Date().toISOString();

function seedAgentGroup(over: Partial<AgentGroup> = {}): AgentGroup {
  const ag: AgentGroup = {
    id: over.id ?? 'ag_test',
    name: over.name ?? 'Test agents',
    folder: over.folder ?? 'test-agents',
    agent_provider: over.agent_provider ?? null,
    secret_mode: over.secret_mode ?? 'all',
    created_at: over.created_at ?? now(),
  };
  createAgentGroup(ag);
  return ag;
}

function seedMg(over: Partial<MessagingGroup> = {}): MessagingGroup {
  const mg: MessagingGroup = {
    id: over.id ?? 'mg_test',
    channel_type: over.channel_type ?? 'telegram',
    platform_id: over.platform_id ?? 'telegram:111111:222222',
    name: over.name ?? null,
    is_group: over.is_group ?? 0,
    unknown_sender_policy: over.unknown_sender_policy ?? 'request_approval',
    created_at: over.created_at ?? now(),
  };
  createMessagingGroup(mg);
  return mg;
}

function seedMga(mgaOver: Partial<MessagingGroupAgent>): MessagingGroupAgent {
  const mga: MessagingGroupAgent = {
    id: mgaOver.id ?? 'mga_test',
    messaging_group_id: mgaOver.messaging_group_id ?? 'mg_test',
    agent_group_id: mgaOver.agent_group_id ?? 'ag_test',
    engage_mode: mgaOver.engage_mode ?? 'mention',
    engage_pattern: mgaOver.engage_pattern ?? null,
    sender_scope: mgaOver.sender_scope ?? 'all',
    ignored_message_policy: mgaOver.ignored_message_policy ?? 'drop',
    session_mode: mgaOver.session_mode ?? 'shared',
    priority: mgaOver.priority ?? 0,
    created_at: mgaOver.created_at ?? now(),
  };
  createMessagingGroupAgent(mga);
  return mga;
}

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  json(): unknown;
}

function makeReq(body?: unknown): http.IncomingMessage {
  const stream = body === undefined ? Readable.from([]) : Readable.from([Buffer.from(JSON.stringify(body))]);
  return stream as unknown as http.IncomingMessage;
}

function makeRes(): MockRes & http.ServerResponse {
  const captured: { status: number; headers: Record<string, string>; chunks: string[] } = {
    status: 0,
    headers: {},
    chunks: [],
  };
  const res = {
    writeHead(status: number, headers?: Record<string, string>) {
      captured.status = status;
      if (headers) Object.assign(captured.headers, headers);
      return this;
    },
    end(chunk?: string) {
      if (chunk) captured.chunks.push(chunk);
    },
    get statusCode() {
      return captured.status;
    },
    get headers() {
      return captured.headers;
    },
    get body() {
      return captured.chunks.join('');
    },
    json() {
      return JSON.parse(captured.chunks.join(''));
    },
  } as unknown as MockRes & http.ServerResponse;
  return res;
}

describe('getMessagingGroupDetail', () => {
  it('returns null when the messaging group does not exist', () => {
    expect(getMessagingGroupDetail('mg_missing')).toBeNull();
  });

  it('returns metadata + empty wired-agents when no MGAs are wired', () => {
    seedMg({ id: 'mg_empty', name: 'Aaron DM' });
    const view = getMessagingGroupDetail('mg_empty');
    expect(view).not.toBeNull();
    expect(view).toMatchObject({
      id: 'mg_empty',
      channelType: 'telegram',
      platformId: 'telegram:111111:222222',
      displayName: 'Aaron DM',
      unknownSenderPolicy: 'request_approval',
      isGroup: false,
      deniedAt: null,
      wiredAgents: [],
    });
    expect(view!.createdAt).toBeTruthy();
  });

  it('joins wired agents and translates DB engage shape to API shape', () => {
    seedAgentGroup({ id: 'ag_one', folder: 'one', name: 'Agent One' });
    seedMg({ id: 'mg_with_agents' });
    seedMga({
      id: 'mga_engage_all',
      messaging_group_id: 'mg_with_agents',
      agent_group_id: 'ag_one',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      priority: 5,
    });
    const view = getMessagingGroupDetail('mg_with_agents');
    expect(view!.wiredAgents).toHaveLength(1);
    expect(view!.wiredAgents[0]).toMatchObject({
      messagingGroupAgentId: 'mga_engage_all',
      agentGroupId: 'ag_one',
      agentGroupFolder: 'one',
      agentGroupName: 'Agent One',
      engageMode: 'all',
      engagePattern: null,
      senderScope: 'allowlist',
      ignoredMessagePolicy: 'silent',
      priority: 5,
    });
  });

  it('orders wired agents by priority desc, created_at asc', () => {
    seedAgentGroup({ id: 'ag_a', folder: 'a', name: 'A' });
    seedAgentGroup({ id: 'ag_b', folder: 'b', name: 'B' });
    seedAgentGroup({ id: 'ag_c', folder: 'c', name: 'C' });
    seedMg({ id: 'mg_priority' });
    seedMga({
      id: 'mga_low_old',
      messaging_group_id: 'mg_priority',
      agent_group_id: 'ag_a',
      priority: 0,
      created_at: '2026-01-01T00:00:00.000Z',
    });
    seedMga({
      id: 'mga_high_new',
      messaging_group_id: 'mg_priority',
      agent_group_id: 'ag_b',
      priority: 5,
      created_at: '2026-02-01T00:00:00.000Z',
    });
    seedMga({
      id: 'mga_low_new',
      messaging_group_id: 'mg_priority',
      agent_group_id: 'ag_c',
      priority: 0,
      created_at: '2026-02-02T00:00:00.000Z',
    });
    const view = getMessagingGroupDetail('mg_priority');
    expect(view!.wiredAgents.map((w) => w.messagingGroupAgentId)).toEqual([
      'mga_high_new',
      'mga_low_old',
      'mga_low_new',
    ]);
  });
});

describe('handleChannelsRoute — GET /api/channels/mg/:id', () => {
  it('returns 200 with detail body on hit', async () => {
    seedAgentGroup({ id: 'ag_one', folder: 'one', name: 'Agent One' });
    seedMg({ id: 'mg_get' });
    seedMga({ id: 'mga_get', messaging_group_id: 'mg_get', agent_group_id: 'ag_one' });

    const res = makeRes();
    const handled = await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_get',
      method: 'GET',
      req: makeReq(),
      res,
    });
    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messagingGroup: { id: string; wiredAgents: unknown[] } };
    expect(body.messagingGroup.id).toBe('mg_get');
    expect(body.messagingGroup.wiredAgents).toHaveLength(1);
  });

  it('returns 404 on unknown id', async () => {
    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_missing',
      method: 'GET',
      req: makeReq(),
      res,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/messaging group not found/) });
  });
});

describe('handleChannelsRoute — PATCH /api/channels/mg/:id', () => {
  it('updates unknown_sender_policy and returns the new view', async () => {
    seedMg({ id: 'mg_patch', unknown_sender_policy: 'request_approval' });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_patch',
      method: 'PATCH',
      req: makeReq({ unknownSenderPolicy: 'public' }),
      res,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { messagingGroup: { unknownSenderPolicy: string } };
    expect(body.messagingGroup.unknownSenderPolicy).toBe('public');
    expect(getMessagingGroup('mg_patch')!.unknown_sender_policy).toBe('public');
  });

  it('rejects invalid policy value with 400', async () => {
    seedMg({ id: 'mg_patch_bad' });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_patch_bad',
      method: 'PATCH',
      req: makeReq({ unknownSenderPolicy: 'open' }),
      res,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/invalid unknownSenderPolicy: open/) });
    expect(getMessagingGroup('mg_patch_bad')!.unknown_sender_policy).toBe('request_approval');
  });

  it('rejects body without unknownSenderPolicy with 400', async () => {
    seedMg({ id: 'mg_patch_empty' });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_patch_empty',
      method: 'PATCH',
      req: makeReq({}),
      res,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/unknownSenderPolicy is required/) });
  });

  it('returns 404 when the mg does not exist', async () => {
    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_missing',
      method: 'PATCH',
      req: makeReq({ unknownSenderPolicy: 'strict' }),
      res,
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects unsupported methods with 405', async () => {
    seedMg({ id: 'mg_method' });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_method',
      method: 'DELETE',
      req: makeReq(),
      res,
    });
    expect(res.statusCode).toBe(405);
  });

  it('does not collide with /api/channels/:id (single-segment id) routing', async () => {
    // Sanity: the handler treats /api/channels/foo as an mga lookup, not an
    // mg lookup. Without the mg-prefix, it would 404 as a missing wire and
    // never reach the mg branch.
    seedMg({ id: 'mg_collision' });
    expect(getDb().prepare('SELECT id FROM messaging_groups WHERE id = ?').get('mg_collision')).toBeTruthy();

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg_collision',
      method: 'GET',
      req: makeReq(),
      res,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/channel wire not found/) });
  });
});
