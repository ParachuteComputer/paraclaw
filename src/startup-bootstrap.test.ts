/**
 * Tests for the startup bootstrap (`.env` token copy + messaging_groups
 * v1→v2 backfill). The bootstrap reads from the registry's getActiveAdapters
 * + readEnvFile, so each test stands up a real central DB plus a fake
 * adapter and a stubbed env source.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetActiveAdaptersForTest, _setActiveAdapterForTest } from './channels/channel-registry.js';
import type { ChannelAdapter } from './channels/adapter.js';
import { createMessagingGroup, getMessagingGroup } from './db/messaging-groups.js';
import { closeDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getSecret, putSecret } from './secrets/index.js';
import {
  backfillMessagingGroupsToV2,
  bootstrapChannelTokensToSecrets,
  channelTokenSecretName,
} from './startup-bootstrap.js';

let envDir: string | null = null;
let envCwd: string | null = null;

function fakeAdapter(channelType: string, botId: string | null): ChannelAdapter {
  return {
    name: channelType,
    channelType,
    botId,
    supportsThreads: false,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

function writeEnvFile(contents: string): void {
  envDir = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclaw-bootstrap-test-'));
  fs.writeFileSync(path.join(envDir, '.env'), contents);
  envCwd = process.cwd();
  process.chdir(envDir);
}

beforeEach(() => {
  // master.key for AES-GCM lives next to the central DB; use HOME override
  // (master-key.ts reads ~/.parachute/...) by routing HOME at the top of
  // each test.
  process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'paraclaw-bootstrap-home-'));
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  _resetActiveAdaptersForTest();
  closeDb();
  if (envCwd) {
    process.chdir(envCwd);
    envCwd = null;
  }
  if (envDir) {
    fs.rmSync(envDir, { recursive: true, force: true });
    envDir = null;
  }
  vi.unstubAllEnvs();
});

describe('backfillMessagingGroupsToV2', () => {
  it('rewrites legacy telegram:<chatId> → telegram:<botId>:<chatId>', () => {
    _setActiveAdapterForTest(fakeAdapter('telegram', '8792496425'));
    createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:1190596288',
      name: 'Aaron DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    const upgraded = backfillMessagingGroupsToV2();
    expect(upgraded).toBe(1);
    expect(getMessagingGroup('mg-1')!.platform_id).toBe('telegram:8792496425:1190596288');
  });

  it('rewrites legacy discord:<guildId>:<channelId> → discord:<botId>:<guildId>:<channelId>', () => {
    _setActiveAdapterForTest(fakeAdapter('discord', 'app-1'));
    createMessagingGroup({
      id: 'mg-2',
      channel_type: 'discord',
      platform_id: 'discord:guild999:chan111',
      name: 'guild',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    backfillMessagingGroupsToV2();
    expect(getMessagingGroup('mg-2')!.platform_id).toBe('discord:app-1:guild999:chan111');
  });

  it('preserves an @me DM segment intact under the new bot dim', () => {
    _setActiveAdapterForTest(fakeAdapter('discord', 'app-1'));
    createMessagingGroup({
      id: 'mg-3',
      channel_type: 'discord',
      platform_id: 'discord:@me:user456',
      name: 'DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    backfillMessagingGroupsToV2();
    expect(getMessagingGroup('mg-3')!.platform_id).toBe('discord:app-1:@me:user456');
  });

  it('is idempotent — already-v2 rows are not double-prefixed', () => {
    _setActiveAdapterForTest(fakeAdapter('telegram', 'bot1'));
    createMessagingGroup({
      id: 'mg-4',
      channel_type: 'telegram',
      platform_id: 'telegram:bot1:1190596288',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    expect(backfillMessagingGroupsToV2()).toBe(0);
    expect(getMessagingGroup('mg-4')!.platform_id).toBe('telegram:bot1:1190596288');
    // Second run must also be a no-op.
    expect(backfillMessagingGroupsToV2()).toBe(0);
    expect(getMessagingGroup('mg-4')!.platform_id).toBe('telegram:bot1:1190596288');
  });

  it('does not re-prefix already-v2 rows that belong to a registered-but-not-yet-active secondary bot', () => {
    // Reproduces the live regression that corrupted TechneRobot's rows on
    // reboot: only the .env primary adapter is active at boot, but the
    // secondary bot's CHANNEL_BOT_TOKEN secret is already in the table
    // (Proposal A: register-bot persists the token before adapter spawn).
    // The backfill iterates over the primary; if it forgets the secondary's
    // botId, it sees the secondary's already-v2 row, treats it as v1, and
    // re-prefixes it under the primary → 4-segment garbage id.
    _setActiveAdapterForTest(fakeAdapter('telegram', 'primary-bot'));
    putSecret(channelTokenSecretName('telegram', 'secondary-bot'), 'tg-token-2', {
      kind: 'channel-token',
      agent_group_id: null,
    });
    createMessagingGroup({
      id: 'mg-primary',
      channel_type: 'telegram',
      platform_id: 'telegram:primary-bot:1190596288',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    createMessagingGroup({
      id: 'mg-secondary',
      channel_type: 'telegram',
      platform_id: 'telegram:secondary-bot:-1002245300962',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });

    expect(backfillMessagingGroupsToV2()).toBe(0);
    expect(getMessagingGroup('mg-primary')!.platform_id).toBe('telegram:primary-bot:1190596288');
    expect(getMessagingGroup('mg-secondary')!.platform_id).toBe('telegram:secondary-bot:-1002245300962');

    // Second pass must remain a no-op even with mixed-bot rows present.
    expect(backfillMessagingGroupsToV2()).toBe(0);
    expect(getMessagingGroup('mg-primary')!.platform_id).toBe('telegram:primary-bot:1190596288');
    expect(getMessagingGroup('mg-secondary')!.platform_id).toBe('telegram:secondary-bot:-1002245300962');
  });

  it('skips channels with no active adapter (e.g. install with only Telegram running)', () => {
    _setActiveAdapterForTest(fakeAdapter('telegram', 'bot1'));
    // Discord row with no Discord adapter — must be left untouched until
    // its adapter comes up on a future restart.
    createMessagingGroup({
      id: 'mg-5',
      channel_type: 'discord',
      platform_id: 'discord:guild:chan',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    backfillMessagingGroupsToV2();
    expect(getMessagingGroup('mg-5')!.platform_id).toBe('discord:guild:chan');
  });
});

describe('bootstrapChannelTokensToSecrets', () => {
  it('copies TELEGRAM_BOT_TOKEN into a per-bot secret row keyed by botId', () => {
    writeEnvFile('TELEGRAM_BOT_TOKEN=tg-secret-token\n');
    _setActiveAdapterForTest(fakeAdapter('telegram', '8792496425'));
    bootstrapChannelTokensToSecrets();
    const name = channelTokenSecretName('telegram', '8792496425');
    expect(getSecret(name)).toBe('tg-secret-token');
  });

  it('is idempotent — re-running with the same value does not duplicate', () => {
    writeEnvFile('TELEGRAM_BOT_TOKEN=tg-secret-token\n');
    _setActiveAdapterForTest(fakeAdapter('telegram', 'bot1'));
    bootstrapChannelTokensToSecrets();
    bootstrapChannelTokensToSecrets();
    expect(getSecret(channelTokenSecretName('telegram', 'bot1'))).toBe('tg-secret-token');
  });

  it('skips adapters without a botId (e.g. CLI admin transport)', () => {
    writeEnvFile('TELEGRAM_BOT_TOKEN=tg-secret-token\n');
    _setActiveAdapterForTest(fakeAdapter('cli', null));
    bootstrapChannelTokensToSecrets();
    expect(getSecret('CHANNEL_BOT_TOKEN:cli:')).toBeUndefined();
  });

  it('skips channels with no env var mapping (no-op for unknown channels)', () => {
    writeEnvFile('SOMETHING_ELSE=x\n');
    _setActiveAdapterForTest(fakeAdapter('whatsapp', 'wa-bot'));
    bootstrapChannelTokensToSecrets();
    expect(getSecret(channelTokenSecretName('whatsapp', 'wa-bot'))).toBeUndefined();
  });
});
