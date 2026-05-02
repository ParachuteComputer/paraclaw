/**
 * Tests for pickApprover + pickApprovalDelivery — the approver-selection
 * half of what used to live in src/access.ts. Moved here in PR #7 alongside
 * the approvals re-tier.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import type { ChannelAdapter, OutboundMessage } from '../../channels/adapter.js';
import {
  _resetActiveAdaptersForTest,
  _setActiveAdapterForTest,
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { pickApprovalDelivery, pickApprover } from './primitive.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  _resetActiveAdaptersForTest();
  closeDb();
});

/**
 * Inject a bot-pinned mock adapter directly into the active registry.
 * Bypasses `registerChannelAdapter` / `initChannelAdapters` so a single
 * test can mount more than one adapter on the same channel type — the
 * factory-based mount overwrites within a channel.
 */
function injectBotAdapter(
  channelType: string,
  botId: string,
  openDM?: (handle: string) => Promise<string>,
): { openDMCalls: string[] } {
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: `${channelType}:${botId}`,
    channelType,
    botId,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver() {
      return undefined;
    },
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  _setActiveAdapterForTest(adapter);
  return { openDMCalls };
}

async function mountMockAdapter(
  channelType: string,
  openDM?: (handle: string) => Promise<string>,
): Promise<{ delivered: OutboundMessage[]; openDMCalls: string[] }> {
  const delivered: OutboundMessage[] = [];
  const openDMCalls: string[] = [];
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver(_platformId, _threadId, message) {
      delivered.push(message);
      return undefined;
    },
    async setTyping() {},
  };
  if (openDM) {
    adapter.openDM = async (handle: string) => {
      openDMCalls.push(handle);
      return openDM(handle);
    };
  }
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
  return { delivered, openDMCalls };
}

function seedAgentGroup(id: string): void {
  createAgentGroup({
    id,
    name: id.toUpperCase(),
    folder: id,
    agent_provider: null,
    created_at: now(),
  });
}

function seedUser(id: string, kind: string): void {
  createUser({ id, kind, display_name: null, created_at: now() });
}

describe('pickApprover', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
    seedAgentGroup('ag-2');
  });

  it('prefers scoped admins, then globals, then owners — deduplicated', () => {
    seedUser('u-owner', 'telegram');
    seedUser('u-ga', 'telegram');
    seedUser('u-sa', 'telegram');
    grantRole({ user_id: 'u-owner', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-ga', role: 'admin', agent_group_id: null, granted_by: null, granted_at: now() });
    grantRole({ user_id: 'u-sa', role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });

    expect(pickApprover('ag-1')).toEqual(['u-sa', 'u-ga', 'u-owner']);
    expect(pickApprover('ag-2')).toEqual(['u-ga', 'u-owner']);
    expect(pickApprover(null)).toEqual(['u-ga', 'u-owner']);
  });

  it('returns empty list when nobody is privileged', () => {
    expect(pickApprover('ag-1')).toEqual([]);
  });
});

describe('pickApprovalDelivery', () => {
  beforeEach(() => {
    seedAgentGroup('ag-1');
  });

  it('returns the first reachable approver', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');
    seedUser('telegram:222', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111', 'telegram:222'], 'telegram');
    expect(result?.userId).toBe('telegram:111');
    expect(result?.messagingGroup.platform_id).toBe('111');
  });

  it('prefers same-channel-kind approver on tie-break', async () => {
    await mountMockAdapter('telegram');
    await mountMockAdapter('discord', async (h) => `dm-${h}`);
    seedUser('telegram:111', 'telegram');
    seedUser('discord:222', 'discord');

    const result = await pickApprovalDelivery(['telegram:111', 'discord:222'], 'discord');
    expect(result?.userId).toBe('discord:222');
  });

  it('falls through to any reachable approver when none match origin', async () => {
    await mountMockAdapter('telegram');
    seedUser('telegram:111', 'telegram');

    const result = await pickApprovalDelivery(['telegram:111'], 'discord');
    expect(result?.userId).toBe('telegram:111');
  });

  it('returns null when nobody is reachable', async () => {
    seedUser('telegram:111', 'telegram');
    expect(await pickApprovalDelivery(['telegram:111'], 'telegram')).toBeNull();
  });

  /**
   * The 3-step fallback chain (paraclaw#67 PR1):
   *   1. same-channel approver, exact (channel, originBotId) match
   *   2. same-channel approver, channel-default `bot_id=''` slot
   *   3. cross-channel approver, channel-default slot
   * `viaFallbackBot` is true whenever an originBotId was requested but
   * the delivery landed on the channel-default slot — the caller uses
   * that to surface "this card was routed via your default bot, not the
   * one the inbound came from" in the body.
   */
  describe('bot-aware fallback chain (migration 026)', () => {
    function seedMg(id: string, channelType: string, platformId: string): void {
      createMessagingGroup({
        id,
        channel_type: channelType,
        platform_id: platformId,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: now(),
      });
    }
    function seedUserDm(userId: string, channelType: string, botId: string, mgId: string): void {
      upsertUserDm({
        user_id: userId,
        channel_type: channelType,
        bot_id: botId,
        messaging_group_id: mgId,
        resolved_at: now(),
      });
    }

    it('step 1: prefers exact bot match over channel-default slot', async () => {
      injectBotAdapter('telegram', 'primary-bot');
      injectBotAdapter('telegram', 'secondary-bot');
      seedUser('telegram:111', 'telegram');
      seedMg('mg-default', 'telegram', 'telegram::111');
      seedMg('mg-secondary', 'telegram', 'telegram:secondary-bot:111');
      seedUserDm('telegram:111', 'telegram', '', 'mg-default');
      seedUserDm('telegram:111', 'telegram', 'secondary-bot', 'mg-secondary');

      const result = await pickApprovalDelivery(['telegram:111'], 'telegram', 'secondary-bot');
      expect(result?.userId).toBe('telegram:111');
      expect(result?.messagingGroup.id).toBe('mg-secondary');
      expect(result?.viaFallbackBot).toBe(false);
    });

    it('step 2: falls back to channel-default when origin bot has no DM cached and openDM fails', async () => {
      injectBotAdapter('telegram', 'primary-bot');
      // secondary-bot adapter throws on openDM — Telegram's "bots can't
      // initiate" error. Step 1 returns null, step 2 hits the cached
      // channel-default row.
      injectBotAdapter('telegram', 'secondary-bot', async () => {
        throw new Error("bots can't initiate DMs");
      });
      seedUser('telegram:111', 'telegram');
      seedMg('mg-default', 'telegram', 'telegram::111');
      seedUserDm('telegram:111', 'telegram', '', 'mg-default');

      const result = await pickApprovalDelivery(['telegram:111'], 'telegram', 'secondary-bot');
      expect(result?.userId).toBe('telegram:111');
      expect(result?.messagingGroup.id).toBe('mg-default');
      expect(result?.viaFallbackBot).toBe(true);
    });

    it('step 2: cold-resolves the channel-default slot when nothing is cached but a default adapter exists', async () => {
      // Single bot active for telegram. Step 1 (exact 'secondary-bot' match)
      // can't run — no adapter for that bot id. Step 2 calls ensureUserDm
      // with no bot id, which hits the first telegram adapter and
      // cold-resolves through it.
      const fallback = injectBotAdapter('telegram', 'primary-bot', async (h) => `tg:${h}`);
      seedUser('telegram:111', 'telegram');

      const result = await pickApprovalDelivery(['telegram:111'], 'telegram', 'secondary-bot');
      expect(result?.userId).toBe('telegram:111');
      expect(result?.viaFallbackBot).toBe(true);
      expect(fallback.openDMCalls).toEqual(['111']);
    });

    it('step 3: cross-channel fallback when no same-channel approver is reachable', async () => {
      // No discord adapter at all. Step 1 + 2 (same channel = discord)
      // find no approver to reach. Step 3 walks any channel and lands on
      // the cached telegram DM.
      injectBotAdapter('telegram', 'primary-bot');
      seedUser('telegram:111', 'telegram');
      seedUser('discord:222', 'discord');
      seedMg('mg-tg-default', 'telegram', 'telegram::111');
      seedUserDm('telegram:111', 'telegram', '', 'mg-tg-default');

      const result = await pickApprovalDelivery(['discord:222', 'telegram:111'], 'discord', 'discord-bot-1');
      expect(result?.userId).toBe('telegram:111');
      expect(result?.messagingGroup.id).toBe('mg-tg-default');
      expect(result?.viaFallbackBot).toBe(true);
    });

    it('viaFallbackBot=false when no originBotId is supplied (legacy single-bot install)', async () => {
      injectBotAdapter('telegram', 'primary-bot', async (h) => `tg:${h}`);
      seedUser('telegram:111', 'telegram');

      const result = await pickApprovalDelivery(['telegram:111'], 'telegram', null);
      expect(result?.userId).toBe('telegram:111');
      expect(result?.viaFallbackBot).toBe(false);
    });
  });
});
