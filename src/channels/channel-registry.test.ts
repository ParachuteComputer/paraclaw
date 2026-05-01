/**
 * Tests for the v2 channel adapter registry and integration with host.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../db/connection.js';
import fs from 'fs';

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';

// Mock container runner
vi.mock('../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

// Override DATA_DIR for tests
vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-channels' };
});

const TEST_DIR = '/tmp/paraclaw-test-channels';

function now() {
  return new Date().toISOString();
}

/** Create a mock ChannelAdapter for testing. */
function createMockAdapter(
  channelType: string,
): ChannelAdapter & { delivered: OutboundMessage[]; inbound: InboundMessage[] } {
  const delivered: OutboundMessage[] = [];
  const inbound: InboundMessage[] = [];
  let setupConfig: ChannelSetup | null = null;

  return {
    name: channelType,
    channelType,
    supportsThreads: false,
    delivered,
    inbound,

    async setup(config: ChannelSetup) {
      setupConfig = config;
    },

    async teardown() {
      setupConfig = null;
    },

    isConnected() {
      return setupConfig !== null;
    },

    async deliver(
      _platformId: string,
      _threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      delivered.push(message);
      return undefined;
    },

    async setTyping() {},
  };
}

describe('channel registry', () => {
  // Import fresh modules for each test to avoid registry pollution
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should register and retrieve channel adapters', async () => {
    const { registerChannelAdapter, getRegisteredChannelNames, getChannelContainerConfig } =
      await import('./channel-registry.js');

    registerChannelAdapter('test-channel', {
      factory: () => createMockAdapter('test'),
      containerConfig: {
        env: { TEST_KEY: 'value' },
      },
    });

    expect(getRegisteredChannelNames()).toContain('test-channel');
    expect(getChannelContainerConfig('test-channel')).toEqual({
      env: { TEST_KEY: 'value' },
    });
  });

  it('should skip adapters that return null (missing credentials)', async () => {
    const { registerChannelAdapter, initChannelAdapters, getActiveAdapters } = await import('./channel-registry.js');

    registerChannelAdapter('no-creds', {
      factory: () => null,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Should not have any active adapters for channels with null factory returns
    const active = getActiveAdapters();
    const noCreds = active.find((a) => a.name === 'no-creds');
    expect(noCreds).toBeUndefined();
  });
});

describe('channel + router integration', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const { initTestDb, runMigrations, createAgentGroup, createMessagingGroup, createMessagingGroupAgent } =
      await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({
      id: 'ag-1',
      name: 'Test Agent',
      folder: 'test-agent',
      agent_provider: null,
      created_at: now(),
    });
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'mock',
      platform_id: 'chan-100',
      name: 'Test Channel',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now(),
    });
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/index.js');
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('should route inbound message from adapter to session DB', async () => {
    const { routeInbound } = await import('../router.js');
    const { findSession } = await import('../db/sessions.js');
    const { inboundDbPath } = await import('../session-manager.js');

    // Simulate what the adapter bridge does: stringify content, call routeInbound
    const inboundContent = { sender: 'TestUser', senderId: 'u1', text: 'Hello from adapter', isFromMe: false };

    await routeInbound({
      channelType: 'mock',
      platformId: 'chan-100',
      threadId: null,
      message: {
        id: 'msg-adapter-1',
        kind: 'chat',
        content: JSON.stringify(inboundContent),
        timestamp: now(),
      },
    });

    // Verify session was created and message written
    const session = findSession('mg-1', null);
    expect(session).toBeDefined();

    const dbPath = inboundDbPath('ag-1', session!.id);
    const db = openDb(dbPath);
    const rows = db.prepare('SELECT * FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();

    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe('Hello from adapter');
  });

  it('should deliver outbound message through delivery adapter bridge', async () => {
    const { setDeliveryAdapter } = await import('../delivery.js');
    const { getChannelAdapter, registerChannelAdapter, initChannelAdapters } = await import('./channel-registry.js');

    // Register and init a mock adapter
    const mockAdapter = createMockAdapter('mock');
    registerChannelAdapter('mock-delivery', {
      factory: () => mockAdapter,
    });

    await initChannelAdapters(() => ({
      conversations: [],
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Set up delivery adapter bridge (same pattern as index.ts)
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, kind, content) {
        const adapter = getChannelAdapter(channelType);
        if (!adapter) return undefined;
        return adapter.deliver(platformId, threadId, { kind, content: JSON.parse(content) });
      },
    });

    // Simulate delivery
    const adapter = getChannelAdapter('mock');
    if (adapter) {
      await adapter.deliver('chan-100', null, { kind: 'chat', content: { text: 'Agent response' } });
    }

    expect(mockAdapter.delivered).toHaveLength(1);
    expect((mockAdapter.delivered[0].content as { text: string }).text).toBe('Agent response');
  });
});

describe('multi-bot routing via dynamic register-bot', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const { initTestDb, runMigrations } = await import('../db/index.js');
    const db = initTestDb();
    runMigrations(db);
    const { _resetActiveAdaptersForTest } = await import('./channel-registry.js');
    _resetActiveAdaptersForTest();
  });

  afterEach(async () => {
    const { closeDb } = await import('../db/index.js');
    const { _resetActiveAdaptersForTest } = await import('./channel-registry.js');
    _resetActiveAdaptersForTest();
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('registers two bots on the same channel-type and routes by botId', async () => {
    const {
      registerChannelAdapter,
      registerBotAdapter,
      initChannelAdapters,
      getActiveAdapters,
      getChannelAdapter,
      getChannelAdapterForPlatformId,
    } = await import('./channel-registry.js');
    const { encodePlatformId } = await import('../platform-id.js');

    // Channel that supports multi-bot — spawnFromSecret returns a fresh
    // adapter whose botId is parsed from the secret name's trailing segment.
    // Mirrors discord.ts's spawnFromSecret shape; telegram would call getMe
    // but we keep the test in-memory.
    registerChannelAdapter('multi-mock', {
      factory: () => null,
      spawnFromSecret: async (secretName) => {
        const botId = secretName.split(':').pop()!;
        const adapter = createMockAdapter('multi-mock');
        return { ...adapter, botId };
      },
    });

    // Init with no .env-backed primary, then dynamically register two bots.
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    const a = await registerBotAdapter('multi-mock', 'CHANNEL_BOT_TOKEN:multi-mock:bot-A', 'token-A');
    const b = await registerBotAdapter('multi-mock', 'CHANNEL_BOT_TOKEN:multi-mock:bot-B', 'token-B');
    expect(a?.botId).toBe('bot-A');
    expect(b?.botId).toBe('bot-B');

    // Both adapters live, keyed independently.
    const active = getActiveAdapters().filter((x) => x.channelType === 'multi-mock');
    expect(active).toHaveLength(2);
    expect(active.map((x) => x.botId).sort()).toEqual(['bot-A', 'bot-B']);

    // v2 platform_id's bot segment selects the right adapter.
    const pidA = encodePlatformId('multi-mock', 'bot-A', 'chat-1');
    const pidB = encodePlatformId('multi-mock', 'bot-B', 'chat-1');
    expect(getChannelAdapterForPlatformId('multi-mock', pidA)).toBe(a);
    expect(getChannelAdapterForPlatformId('multi-mock', pidB)).toBe(b);

    // Channel-type-only lookup picks one (not deterministic which) — that
    // path is for legacy v1 ids only; prove it doesn't throw.
    expect(getChannelAdapter('multi-mock')).toBeDefined();
  });

  it('register-bot is idempotent on (channelType, botId)', async () => {
    const { registerChannelAdapter, registerBotAdapter, initChannelAdapters, getActiveAdapters } =
      await import('./channel-registry.js');

    registerChannelAdapter('idem-mock', {
      factory: () => null,
      spawnFromSecret: async (secretName) => {
        const botId = secretName.split(':').pop()!;
        const adapter = createMockAdapter('idem-mock');
        return { ...adapter, botId };
      },
    });

    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    const first = await registerBotAdapter('idem-mock', 'CHANNEL_BOT_TOKEN:idem-mock:bot-X', 'token-X');
    const second = await registerBotAdapter('idem-mock', 'CHANNEL_BOT_TOKEN:idem-mock:bot-X', 'token-X-rotated');
    expect(first?.botId).toBe('bot-X');
    expect(second).toBe(first);
    const active = getActiveAdapters().filter((x) => x.channelType === 'idem-mock');
    expect(active).toHaveLength(1);
  });

  it('register-bot throws on a channel without spawnFromSecret', async () => {
    const { registerChannelAdapter, registerBotAdapter, initChannelAdapters } = await import('./channel-registry.js');

    registerChannelAdapter('single-only', { factory: () => null });
    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));
    await expect(registerBotAdapter('single-only', 'CHANNEL_BOT_TOKEN:single-only:x', 'tok')).rejects.toThrow(
      /multi-bot/,
    );
  });

  it('spawnSecretsBackedBots brings up persisted bots after restart', async () => {
    const {
      registerChannelAdapter,
      initChannelAdapters,
      spawnSecretsBackedBots,
      getActiveAdapters,
      _resetActiveAdaptersForTest,
    } = await import('./channel-registry.js');
    const { putSecret } = await import('../secrets/index.js');

    registerChannelAdapter('boot-mock', {
      factory: () => null,
      spawnFromSecret: async (secretName) => {
        const botId = secretName.split(':').pop()!;
        const adapter = createMockAdapter('boot-mock');
        return { ...adapter, botId };
      },
    });

    // Persist two tokens as if a previous boot had registered them.
    putSecret('CHANNEL_BOT_TOKEN:boot-mock:bot-1', 'tok-1', { kind: 'channel-token', agent_group_id: null });
    putSecret('CHANNEL_BOT_TOKEN:boot-mock:bot-2', 'tok-2', { kind: 'channel-token', agent_group_id: null });

    await initChannelAdapters(() => ({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    }));

    // Simulate restart: clear actives, then run the boot scan.
    _resetActiveAdaptersForTest();
    await spawnSecretsBackedBots();
    const active = getActiveAdapters().filter((x) => x.channelType === 'boot-mock');
    expect(active.map((x) => x.botId).sort()).toEqual(['bot-1', 'bot-2']);
  });
});
