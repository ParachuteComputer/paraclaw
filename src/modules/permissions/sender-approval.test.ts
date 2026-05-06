/**
 * Integration tests for the unknown-sender request_approval flow
 * (ACTION-ITEMS item 5).
 *
 * Covers:
 *  - request_approval policy fires `requestSenderApproval` on first unknown
 *    message from a sender
 *  - In-flight dedup: second message from the same sender while pending is
 *    silently dropped (no second card, no second row)
 *  - Approve path: member added, original message replayed via routeInbound,
 *    container woken
 *  - Deny path: pending row deleted, no member added
 *  - Approve replay with attachment: row + file land cleanly at the
 *    namespaced messages_in.id path (paraclaw#97)
 *  - Approve replay with MUTATED original_message: on-disk attachment file
 *    is preserved byte-for-byte; the dup-skip path absorbs the second write
 *    so a path-normalization or any pre-replay mutation can't clobber state
 *    that's already committed (paraclaw#97 — #96 invariant under the
 *    sender-approval entry point)
 */
import fs from 'fs';
import path from 'path';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import { openDb } from '../../db/connection.js';
import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { inboundDbPath, sessionDir } from '../../session-manager.js';
import { upsertUser } from './db/users.js';
import { grantRole } from './db/user-roles.js';

// Mock container runner — prevent actual docker spawn.
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Mock delivery adapter — record card deliveries for assertions.
const deliverMock = vi.fn().mockResolvedValue('plat-msg-id');
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: deliverMock,
  }),
}));

// Mock ensureUserDm to return the approver's existing messaging group
// instead of hitting a real openDM RPC.
vi.mock('./user-dm.js', () => ({
  ensureUserDm: vi.fn(async (userId: string) => {
    const { getDb } = await import('../../db/connection.js');
    const row = getDb()
      .prepare(
        `SELECT mg.* FROM messaging_groups mg
           JOIN user_dms ud ON ud.messaging_group_id = mg.id
          WHERE ud.user_id = ?`,
      )
      .get(userId);
    return row;
  }),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-sender-approval' };
});

const TEST_DIR = '/tmp/paraclaw-test-sender-approval';

function now() {
  return new Date().toISOString();
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  // Side-effect imports: register hooks (permissions module) AFTER the
  // mocks are in place so the access gate / response handler pick up the
  // mocked delivery + user-dm helpers.
  await import('./index.js');

  // Fixtures: agent group, messaging group with request_approval, wiring,
  // owner + DM messaging group for approver delivery.
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });

  createMessagingGroup({
    id: 'mg-chat',
    channel_type: 'telegram',
    platform_id: 'chat-123',
    name: 'Group Chat',
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-chat',
    agent_group_id: 'ag-1',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });

  // Owner user + their DM messaging group (pickApprover + ensureUserDm target).
  upsertUser({ id: 'telegram:owner', kind: 'telegram', display_name: 'Owner', created_at: now() });
  grantRole({
    user_id: 'telegram:owner',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'telegram',
    platform_id: 'dm-owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const { getDb } = await import('../../db/connection.js');
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run('telegram:owner', 'telegram', 'mg-dm-owner', now());

  deliverMock.mockClear();
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function stranger(text: string) {
  return {
    channelType: 'telegram',
    platformId: 'chat-123',
    threadId: null,
    message: {
      id: `stranger-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat' as const,
      content: JSON.stringify({
        senderId: 'tg:stranger',
        senderName: 'Stranger',
        text,
      }),
      timestamp: now(),
    },
  };
}

describe('unknown-sender request_approval flow', () => {
  it('delivers an approval card on first unknown message', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(stranger('hi'));

    // Wait for the fire-and-forget requestSenderApproval to resolve.
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channel, platformId, thread, kind, content] = deliverMock.mock.calls[0];
    expect(channel).toBe('telegram');
    expect(platformId).toBe('dm-owner'); // delivered to owner's DM
    expect(thread).toBeNull();
    expect(kind).toBe('chat-sdk');
    const payload = JSON.parse(content as string);
    expect(payload.type).toBe('ask_question');
    expect(payload.questionId).toMatch(/^nsa-/);

    const { getDb } = await import('../../db/connection.js');
    const rows = getDb().prepare('SELECT * FROM pending_sender_approvals').all();
    expect(rows).toHaveLength(1);
  });

  it('dedups a second message from the same stranger while pending', async () => {
    const { routeInbound } = await import('../../router.js');
    await routeInbound(stranger('hello'));
    await new Promise((r) => setTimeout(r, 10));
    await routeInbound(stranger('are you there?'));
    await new Promise((r) => setTimeout(r, 10));

    expect(deliverMock).toHaveBeenCalledTimes(1);
    const { getDb } = await import('../../db/connection.js');
    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it('approve → adds member and replays the original message', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { wakeContainer } = await import('../../container-runner.js');
    (wakeContainer as unknown as ReturnType<typeof vi.fn>).mockClear();

    await routeInbound(stranger('please let me in'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    // Fire the approve click through the response-handler chain.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        // Chat SDK's onAction surfaces the raw platform userId (e.g. Telegram
        // chat id). The permissions handler namespaces it with channelType to
        // match users(id).
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Member row added for the stranger against the wired agent group.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('tg:stranger', 'ag-1');
    expect(member).toBeDefined();

    // Pending row cleared.
    const stillPending = getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number };
    expect(stillPending.c).toBe(0);

    // Message replayed + container woken.
    expect(wakeContainer).toHaveBeenCalled();
  });

  it('deny → deletes the pending row without adding a member', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(stranger('hello'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'reject',
        userId: 'owner', // raw platform id — handler namespaces with channelType
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    const count = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number }).c;
    expect(count).toBe(0);
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('tg:stranger', 'ag-1');
    expect(member).toBeUndefined();
  });

  it('approve_and_allow → admits the sender, flips MG policy to public, and emits an audit log', async () => {
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');
    const { getMessagingGroup } = await import('../../db/messaging-groups.js');
    const { log } = await import('../../log.js');

    const infoSpy = vi.spyOn(log, 'info');

    await routeInbound(stranger('let everyone in'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve_and_allow',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Sender admitted (same as 'approve' branch).
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('tg:stranger', 'ag-1');
    expect(member).toBeDefined();

    // MG flipped to public so future strangers skip the gate.
    const mg = getMessagingGroup('mg-chat');
    expect(mg?.unknown_sender_policy).toBe('public');

    // Audit log entry includes operator + MG + before-state for traceability.
    const auditCalls = infoSpy.mock.calls.filter(([, data]) => {
      return (
        typeof data === 'object' &&
        data !== null &&
        (data as { audit?: string }).audit === 'sender_approval_policy_flip'
      );
    });
    expect(auditCalls).toHaveLength(1);
    const [, auditFields] = auditCalls[0] as [string, Record<string, unknown>];
    expect(auditFields).toMatchObject({
      messagingGroupId: 'mg-chat',
      agentGroupId: 'ag-1',
      approverId: 'telegram:owner',
      fromPolicy: 'request_approval',
      toPolicy: 'public',
    });

    // Pending row cleared.
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(0);

    infoSpy.mockRestore();
  });

  it('approve_and_allow → idempotent on already-public MG, audit still fires with fromPolicy=public', async () => {
    // Pre-flip the MG to public to simulate a second click after a prior
    // always-allow has already happened. The button is shown unconditionally
    // (Aaron's call) so this branch can fire even when policy is already
    // public.
    const { updateMessagingGroup, getMessagingGroup } = await import('../../db/messaging-groups.js');
    updateMessagingGroup('mg-chat', { unknown_sender_policy: 'public' });

    // With public policy, the access gate skips the unknown-sender flow —
    // so we can't trigger the approval via routeInbound. Seed the pending
    // row directly to exercise just the click handler. Upsert the sender
    // user first so addMember's FK to users(id) holds.
    upsertUser({ id: 'tg:later-stranger', kind: 'telegram', display_name: 'Later', created_at: now() });
    const { createPendingSenderApproval } = await import('./db/pending-sender-approvals.js');
    const approvalId = 'nsa-test-idempotent';
    createPendingSenderApproval({
      id: approvalId,
      messaging_group_id: 'mg-chat',
      agent_group_id: 'ag-1',
      sender_identity: 'tg:later-stranger',
      sender_name: 'Later',
      original_message: JSON.stringify(stranger('hello again')),
      approver_user_id: 'telegram:owner',
      created_at: now(),
      title: 'New sender',
      options_json: '[]',
    });

    const { log } = await import('../../log.js');
    const infoSpy = vi.spyOn(log, 'info');

    const { getResponseHandlers } = await import('../../response-registry.js');
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: approvalId,
        value: 'approve_and_allow',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // Policy stays public (no regression).
    expect(getMessagingGroup('mg-chat')?.unknown_sender_policy).toBe('public');

    // Audit log fires with fromPolicy='public' so the click is traceable
    // even when the DB write was a no-op.
    const auditCalls = infoSpy.mock.calls.filter(([, data]) => {
      return (
        typeof data === 'object' &&
        data !== null &&
        (data as { audit?: string }).audit === 'sender_approval_policy_flip'
      );
    });
    expect(auditCalls).toHaveLength(1);
    const [, auditFields] = auditCalls[0] as [string, Record<string, unknown>];
    expect(auditFields).toMatchObject({ fromPolicy: 'public', toPolicy: 'public' });

    infoSpy.mockRestore();
  });

  it('rejects clicks from an unauthorized user (prevents self-admit via forwarded card)', async () => {
    // Stranger triggers the approval flow; card goes to the owner.
    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(stranger('can I play'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    // A random user (not the stranger, not the owner, not an admin) tries to
    // click the approval — e.g. they got the card forwarded. Should be
    // rejected without admitting them.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        userId: 'random-bystander', // not owner, not admin
        channelType: 'telegram',
        platformId: 'dm-random',
        threadId: null,
      });
      if (claimed) break;
    }

    // No member added for the stranger.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('tg:stranger', 'ag-1');
    expect(member).toBeUndefined();

    // Pending row is still there — a legitimate approver can still act on it.
    const stillPending = (getDb().prepare('SELECT COUNT(*) AS c FROM pending_sender_approvals').get() as { c: number })
      .c;
    expect(stillPending).toBe(1);
  });

  it('accepts a click from a global admin even if they are not the designated approver', async () => {
    // Pre-seed a separate admin user so we can click as them.
    upsertUser({ id: 'telegram:admin-bob', kind: 'telegram', display_name: 'Bob', created_at: now() });
    grantRole({
      user_id: 'telegram:admin-bob',
      role: 'admin',
      agent_group_id: null,
      granted_by: 'telegram:owner',
      granted_at: now(),
    });

    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    await routeInbound(stranger('knock knock'));
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    // Admin clicks approve (not the designated approver, which was owner).
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        userId: 'admin-bob',
        channelType: 'telegram',
        platformId: 'dm-bob',
        threadId: null,
      });
      if (claimed) break;
    }

    // Stranger admitted thanks to the admin's authority.
    const member = getDb()
      .prepare('SELECT 1 AS x FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get('tg:stranger', 'ag-1');
    expect(member).toBeDefined();
  });

  // ── paraclaw#97: replay-path coverage ──────────────────────────────────
  //
  // The unit tests above prove the response handler's bookkeeping (member
  // added, pending row cleared, wake fired). The two tests below assert the
  // full chain through routeInbound → writeSessionMessage on a message
  // carrying a real attachment, plus the #96 file-clobber invariant under
  // this entry point.

  function strangerWithAttachment(textValue: string, attachmentBytes: Buffer) {
    return {
      channelType: 'telegram',
      platformId: 'chat-123',
      threadId: null,
      message: {
        id: 'tg-msg-with-att',
        kind: 'chat' as const,
        content: JSON.stringify({
          senderId: 'tg:stranger',
          senderName: 'Stranger',
          text: textValue,
          attachments: [
            { name: 'photo.jpg', type: 'image', size: attachmentBytes.length, data: attachmentBytes.toString('base64') },
          ],
        }),
        timestamp: now(),
      },
    };
  }

  it('approve replay → attachment lands cleanly at the namespaced messages_in.id path (paraclaw#97)', async () => {
    const ORIGINAL_BYTES = Buffer.from('first-pic');
    const event = strangerWithAttachment('see photo', ORIGINAL_BYTES);

    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    // First route: gate denies (request_approval), pending row created. The
    // wired agent has ignored_message_policy='drop', so no accumulate write
    // happens — the replay will be the first writer of this messages_in.id.
    await routeInbound(event);
    await new Promise((r) => setTimeout(r, 10));

    const { getDb } = await import('../../db/connection.js');
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();

    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // The replay's deliverToAgent created the session — find it for the
    // wired agent group and assert the row + file landed at the right spot.
    const sess = getDb().prepare('SELECT id FROM sessions WHERE agent_group_id = ?').get('ag-1') as { id: string };
    expect(sess).toBeDefined();

    const inboundDb = openDb(inboundDbPath('ag-1', sess.id));
    const rows = inboundDb.prepare('SELECT id, content FROM messages_in').all() as Array<{
      id: string;
      content: string;
    }>;
    inboundDb.close();

    expect(rows).toHaveLength(1);
    // messageIdForAgent namespaces the platform id with agent_group_id so a
    // multi-agent fan-out can't collide on messages_in.id (router.ts).
    const namespacedId = 'tg-msg-with-att:ag-1';
    expect(rows[0].id).toBe(namespacedId);

    // Row content carries localPath after extractAttachmentFiles ran post-
    // commit; inline base64 is gone.
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.attachments[0].localPath).toBe(`inbox/${namespacedId}/photo.jpg`);
    expect(parsed.attachments[0].data).toBeUndefined();

    const filePath = path.join(sessionDir('ag-1', sess.id), 'inbox', namespacedId, 'photo.jpg');
    expect(fs.existsSync(filePath)).toBe(true);
    expect(fs.readFileSync(filePath).equals(ORIGINAL_BYTES)).toBe(true);
  });

  it('approve replay with MUTATED original_message: on-disk file preserved (paraclaw#97 — #96 invariant)', async () => {
    // Switch the wired agent to accumulate so the gate-denied first attempt
    // writes the row + extracts the file BEFORE the approval card is acted
    // on. This is the racing-dispatch shape #92 caught: two writers for the
    // same messages_in.id, one from accumulate-on-gate-deny, one from the
    // approval replay.
    const { getDb } = await import('../../db/connection.js');
    getDb().prepare(`UPDATE messaging_group_agents SET ignored_message_policy = 'accumulate' WHERE id = ?`).run('mga-1');

    const ORIGINAL_BYTES = Buffer.from('first-pic');
    const MUTATED_BYTES = Buffer.from('CLOBBERED');
    const event = strangerWithAttachment('see photo', ORIGINAL_BYTES);

    const { routeInbound } = await import('../../router.js');
    const { getResponseHandlers } = await import('../../response-registry.js');

    // First route: gate denies, but accumulate writes the row + extracts the
    // file with ORIGINAL_BYTES.
    await routeInbound(event);
    await new Promise((r) => setTimeout(r, 10));

    const sess = getDb().prepare('SELECT id FROM sessions WHERE agent_group_id = ?').get('ag-1') as { id: string };
    expect(sess).toBeDefined();
    const namespacedId = 'tg-msg-with-att:ag-1';
    const filePath = path.join(sessionDir('ag-1', sess.id), 'inbox', namespacedId, 'photo.jpg');
    expect(fs.readFileSync(filePath).equals(ORIGINAL_BYTES)).toBe(true);

    // Mutate the pending row's original_message to carry MUTATED_BYTES. This
    // mirrors any pre-replay normalization (path replacement, ContentRecord
    // re-encoding, retry with re-fetched payload) that produces a JSON event
    // whose attachment bytes don't match what's already on disk.
    const pending = getDb().prepare('SELECT id FROM pending_sender_approvals').get() as { id: string };
    expect(pending).toBeDefined();
    const mutatedEvent = strangerWithAttachment('see photo', MUTATED_BYTES);
    getDb()
      .prepare('UPDATE pending_sender_approvals SET original_message = ? WHERE id = ?')
      .run(JSON.stringify(mutatedEvent), pending.id);

    // Approve. Replay's writeSessionMessage hits ON CONFLICT (id already
    // present from the accumulate write), so extractAttachmentFiles never
    // runs and the on-disk file stays put.
    for (const handler of getResponseHandlers()) {
      const claimed = await handler({
        questionId: pending.id,
        value: 'approve',
        userId: 'owner',
        channelType: 'telegram',
        platformId: 'dm-owner',
        threadId: null,
      });
      if (claimed) break;
    }

    // 1. File on disk is byte-for-byte the original — no mutated clobber.
    const onDisk = fs.readFileSync(filePath);
    expect(onDisk.equals(ORIGINAL_BYTES)).toBe(true);
    expect(onDisk.equals(MUTATED_BYTES)).toBe(false);

    // 2. Exactly one row in messages_in (the accumulate write); the replay
    //    didn't slip a second row in.
    const inboundDb = openDb(inboundDbPath('ag-1', sess.id));
    const rows = inboundDb.prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>;
    inboundDb.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(namespacedId);
  });
});
