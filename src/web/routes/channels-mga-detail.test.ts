/**
 * Tests for the per-MGA detail block of `handleChannelsRoute`. Covers
 * GET (detail fetch), PATCH (routing-rules update with translation
 * round-tripping), DELETE (unwire), and 404/405 status shapes.
 *
 * Fixture pattern mirrors channels-mg-detail.test.ts — direct route
 * handler invocation against an in-memory DB, no HTTP layer.
 */
import http from 'node:http';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupAgent } from '../../db/messaging-groups.js';
import type { AgentGroup, MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { handleChannelsRoute } from './channels.js';

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

function seedMga(mgaOver: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
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

function seedFullWire(
  override: { mgaId?: string; engage?: Partial<Pick<MessagingGroupAgent, 'engage_mode' | 'engage_pattern'>> } = {},
): { mga: MessagingGroupAgent } {
  const ag = seedAgentGroup({ id: 'ag_routing', folder: 'routing', name: 'Routing agent' });
  const mg = seedMg({ id: 'mg_routing' });
  const mga = seedMga({
    id: override.mgaId ?? 'mga_routing',
    messaging_group_id: mg.id,
    agent_group_id: ag.id,
    engage_mode: override.engage?.engage_mode ?? 'mention',
    engage_pattern: override.engage?.engage_pattern ?? null,
  });
  return { mga };
}

describe('handleChannelsRoute — GET /api/channels/mga/:id', () => {
  it('returns 200 with the wire detail on hit', async () => {
    seedFullWire();

    const res = makeRes();
    const handled = await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'GET',
      req: makeReq(),
      res,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { wire: Record<string, unknown> };
    expect(body.wire).toMatchObject({
      id: 'mga_routing',
      messagingGroupId: 'mg_routing',
      agentGroupId: 'ag_routing',
      agentGroupFolder: 'routing',
      agentGroupName: 'Routing agent',
      channelType: 'telegram',
      platformId: 'telegram:111111:222222',
      engageMode: 'mention',
      engagePattern: null,
      senderScope: 'all',
      ignoredMessagePolicy: 'drop',
      priority: 0,
    });
  });

  it("collapses pattern + '.' sentinel to engageMode 'all' on the API shape", async () => {
    seedFullWire({
      engage: { engage_mode: 'pattern', engage_pattern: '.' },
    });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'GET',
      req: makeReq(),
      res,
    });

    const body = res.json() as { wire: { engageMode: string; engagePattern: string | null } };
    expect(body.wire.engageMode).toBe('all');
    expect(body.wire.engagePattern).toBeNull();
  });

  it("renders mention-sticky as plain 'mention' on the API shape (lossy display)", async () => {
    seedFullWire({
      engage: { engage_mode: 'mention-sticky', engage_pattern: null },
    });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'GET',
      req: makeReq(),
      res,
    });

    const body = res.json() as { wire: { engageMode: string } };
    expect(body.wire.engageMode).toBe('mention');
  });

  it('returns 404 when the wire does not exist', async () => {
    const res = makeRes();
    const handled = await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_missing',
      method: 'GET',
      req: makeReq(),
      res,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/channel wire not found/) });
  });
});

describe('handleChannelsRoute — PATCH /api/channels/mga/:id', () => {
  it('updates routing rules and returns the post-update wire', async () => {
    seedFullWire();

    const res = makeRes();
    const handled = await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'PATCH',
      req: makeReq({
        engageMode: 'pattern',
        engagePattern: '^/ask\\b',
        senderScope: 'allowlist',
        ignoredMessagePolicy: 'silent',
        priority: 7,
      }),
      res,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { wire: Record<string, unknown> };
    expect(body.wire).toMatchObject({
      id: 'mga_routing',
      engageMode: 'pattern',
      engagePattern: '^/ask\\b',
      senderScope: 'allowlist',
      ignoredMessagePolicy: 'silent',
      priority: 7,
    });

    // Persisted in DB shape (sender_scope='known', ignored_message_policy='accumulate').
    const persisted = getMessagingGroupAgent('mga_routing')!;
    expect(persisted.engage_mode).toBe('pattern');
    expect(persisted.engage_pattern).toBe('^/ask\\b');
    expect(persisted.sender_scope).toBe('known');
    expect(persisted.ignored_message_policy).toBe('accumulate');
    expect(persisted.priority).toBe(7);
  });

  it("preserves mention-sticky on the row when the PATCH sets engageMode='mention'", async () => {
    seedFullWire({
      engage: { engage_mode: 'mention-sticky', engage_pattern: null },
    });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'PATCH',
      req: makeReq({ engageMode: 'mention' }),
      res,
    });

    expect(res.statusCode).toBe(200);
    // The DB row keeps mention-sticky — UI doesn't expose the distinction,
    // so a no-op-feeling PATCH shouldn't silently downgrade router behavior.
    const persisted = getMessagingGroupAgent('mga_routing')!;
    expect(persisted.engage_mode).toBe('mention-sticky');
  });

  it("encodes engageMode='all' as DB pattern + '.' sentinel", async () => {
    seedFullWire();

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'PATCH',
      req: makeReq({ engageMode: 'all' }),
      res,
    });

    expect(res.statusCode).toBe(200);
    const persisted = getMessagingGroupAgent('mga_routing')!;
    expect(persisted.engage_mode).toBe('pattern');
    expect(persisted.engage_pattern).toBe('.');
  });

  it('rejects an invalid engageMode with 400 + value echo', async () => {
    seedFullWire();

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'PATCH',
      req: makeReq({ engageMode: 'wave-hands' }),
      res,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringMatching(/invalid engageMode: wave-hands/) });
  });

  it("rejects engagePattern '.' with 400 — bare dot is the 'all' sentinel", async () => {
    // Without this guard the server silently rewrites '.' as the
    // engageMode='all' wire-format sentinel, which round-trips back as
    // 'all' on the next read and silently swallows the user's intent.
    // Force them to pick: \\. for a literal dot, or engageMode='all'.
    seedFullWire();

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'PATCH',
      req: makeReq({ engageMode: 'pattern', engagePattern: '.' }),
      res,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringMatching(/engagePattern '\.' is reserved as the 'all' sentinel/),
    });

    // Row was not modified — still 'mention' / null from the seed.
    const persisted = getMessagingGroupAgent('mga_routing')!;
    expect(persisted.engage_mode).toBe('mention');
    expect(persisted.engage_pattern).toBeNull();
  });

  it("rejects engagePattern '.' even without engageMode in the body", async () => {
    // Same swallow risk via the mode-unchanged branch in apiToDbPatch —
    // pin the validation catches both shapes.
    seedFullWire({ engage: { engage_mode: 'pattern', engage_pattern: '^/ask\\b' } });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'PATCH',
      req: makeReq({ engagePattern: '.' }),
      res,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({
      error: expect.stringMatching(/engagePattern '\.' is reserved as the 'all' sentinel/),
    });
  });

  it('returns 404 when the wire does not exist', async () => {
    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_missing',
      method: 'PATCH',
      req: makeReq({ priority: 9 }),
      res,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('handleChannelsRoute — DELETE /api/channels/mga/:id', () => {
  it('hard-deletes the wire row and returns 200', async () => {
    seedFullWire();

    const res = makeRes();
    const handled = await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'DELETE',
      req: makeReq(),
      res,
    });

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'mga_routing', deleted: true });
    expect(getMessagingGroupAgent('mga_routing')).toBeUndefined();
  });

  it('returns 404 when the wire does not exist', async () => {
    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_missing',
      method: 'DELETE',
      req: makeReq(),
      res,
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('handleChannelsRoute — /api/channels/mga/:id misc', () => {
  it('rejects unsupported methods with 405', async () => {
    seedFullWire();

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mga/mga_routing',
      method: 'POST',
      req: makeReq({ engageMode: 'mention' }),
      res,
    });

    expect(res.statusCode).toBe(405);
  });

  it('does not collide with /api/channels/mg/:id routing', async () => {
    // Sanity: the mg/ block dispatches first, mga/ second. A path of
    // `/api/channels/mg/foo` must NOT be misread as mga lookup.
    seedMg({ id: 'mg_disambig' });

    const res = makeRes();
    await handleChannelsRoute({
      pathname: '/api/channels/mg/mg_disambig',
      method: 'GET',
      req: makeReq(),
      res,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { messagingGroup: { id: string } };
    expect(body.messagingGroup.id).toBe('mg_disambig');
  });
});
