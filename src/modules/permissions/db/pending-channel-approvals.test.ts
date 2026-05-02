import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config.js', async () => {
  const actual = await vi.importActual('../../../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-pending-channel-approvals' };
});

const TEST_DIR = '/tmp/paraclaw-test-pending-channel-approvals';

const sampleRow = (messagingGroupId: string) => ({
  messaging_group_id: messagingGroupId,
  agent_group_id: 'ag-1',
  original_message: '{"text":"hi"}',
  approver_user_id: 'user-1',
  created_at: new Date().toISOString(),
  title: 'Card',
  options_json: '[]',
});

describe('pending_channel_approvals atomic create', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.resetModules();
    const { initTestDb, runMigrations } = await import('../../../db/index.js');
    const db = initTestDb();
    runMigrations(db);
    const { createAgentGroup } = await import('../../../db/agent-groups.js');
    const { createMessagingGroup } = await import('../../../db/messaging-groups.js');
    createAgentGroup({
      id: 'ag-1',
      folder: 'group-1',
      name: 'G',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });
    for (const id of ['mg-1', 'mg-2']) {
      createMessagingGroup({
        id,
        channel_type: 'telegram',
        platform_id: `telegram:bot:${id}`,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'request_approval',
        created_at: new Date().toISOString(),
      });
    }
    const { upsertUser } = await import('./users.js');
    upsertUser({
      id: 'user-1',
      kind: 'human',
      display_name: 'User',
      created_at: new Date().toISOString(),
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('../../../db/index.js');
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('returns true on first insert, false on duplicate, and never throws', async () => {
    const { createPendingChannelApproval, getPendingChannelApproval } = await import('./pending-channel-approvals.js');

    const first = createPendingChannelApproval(sampleRow('mg-1'));
    expect(first).toBe(true);

    // Concurrent inbounds racing past the dedup check used to throw
    // `UNIQUE constraint failed`. With ON CONFLICT DO NOTHING they
    // return false silently and the caller skips delivery without an
    // ERROR-level log line.
    const second = createPendingChannelApproval(sampleRow('mg-1'));
    expect(second).toBe(false);

    const stored = getPendingChannelApproval('mg-1');
    expect(stored?.title).toBe('Card');
  });

  it('lets a different messaging_group_id through without conflict', async () => {
    const { createPendingChannelApproval } = await import('./pending-channel-approvals.js');
    expect(createPendingChannelApproval(sampleRow('mg-1'))).toBe(true);
    expect(createPendingChannelApproval(sampleRow('mg-2'))).toBe(true);
  });
});
