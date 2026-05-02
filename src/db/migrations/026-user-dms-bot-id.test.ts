/**
 * Coverage for migration 026 — user_dms PK extension to include `bot_id`.
 *
 * Strategy: skip 026 via `applyMigrationsExcept`, seed pre-026 rows
 * against the legacy 2-column PK, run the migration, assert that:
 *
 *   - rows survive the rebuild and land at `bot_id = ''` (the
 *     configurable channel-default slot)
 *   - PK now permits a second `(user, channel)` row keyed on a real bot
 *     id (the multi-bot case the legacy schema couldn't represent)
 *   - the legacy `user_dms_legacy` scaffold is gone
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb } from '../index.js';
import { migration026 } from './026-user-dms-bot-id.js';
import { applyMigrationsExcept } from './_test-helpers.js';

function applyAllExcept026(): void {
  applyMigrationsExcept([migration026]);
}

function seedUser(id: string, kind: string): void {
  getDb()
    .prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, datetime('now'))`)
    .run(id, kind);
}

function seedMessagingGroup(id: string, channelType: string, platformId: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, NULL, 0, 'strict', datetime('now'))`,
    )
    .run(id, channelType, platformId);
}

function seedLegacyUserDm(userId: string, channelType: string, mgId: string): void {
  // Pre-026: PK is (user_id, channel_type). Schema has no bot_id.
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
       VALUES (?, ?, ?, datetime('now'))`,
    )
    .run(userId, channelType, mgId);
}

beforeEach(() => {
  applyAllExcept026();
});

afterEach(() => {
  closeDb();
});

describe('migration 026 — user_dms.bot_id PK extension', () => {
  it('preserves legacy rows under bot_id = ""', () => {
    seedUser('telegram:1190596288', 'telegram');
    seedMessagingGroup('mg-1', 'telegram', 'telegram:8792496425:1190596288');
    seedLegacyUserDm('telegram:1190596288', 'telegram', 'mg-1');

    migration026.up(getDb());

    const rows = getDb().prepare(`SELECT user_id, channel_type, bot_id, messaging_group_id FROM user_dms`).all() as {
      user_id: string;
      channel_type: string;
      bot_id: string;
      messaging_group_id: string;
    }[];
    expect(rows).toEqual([
      {
        user_id: 'telegram:1190596288',
        channel_type: 'telegram',
        bot_id: '',
        messaging_group_id: 'mg-1',
      },
    ]);
  });

  it('PK now allows a second row for the same (user, channel) under a different bot', () => {
    seedUser('telegram:1190596288', 'telegram');
    seedMessagingGroup('mg-primary', 'telegram', 'telegram:primary-bot:1190596288');
    seedMessagingGroup('mg-secondary', 'telegram', 'telegram:secondary-bot:1190596288');
    seedLegacyUserDm('telegram:1190596288', 'telegram', 'mg-primary');

    migration026.up(getDb());

    // The legacy row landed under bot_id=''. A bot-pinned write under a
    // real bot id must succeed (the legacy schema would have rejected
    // this on the 2-column PK).
    getDb()
      .prepare(
        `INSERT INTO user_dms (user_id, channel_type, bot_id, messaging_group_id, resolved_at)
         VALUES (?, ?, ?, ?, datetime('now'))`,
      )
      .run('telegram:1190596288', 'telegram', 'secondary-bot', 'mg-secondary');

    const count = getDb()
      .prepare(`SELECT COUNT(*) AS n FROM user_dms WHERE user_id = ? AND channel_type = ?`)
      .get('telegram:1190596288', 'telegram') as { n: number };
    expect(count.n).toBe(2);
  });

  it('drops the legacy rebuild scaffold', () => {
    seedUser('telegram:1', 'telegram');
    seedMessagingGroup('mg-1', 'telegram', 'telegram:b:1');
    seedLegacyUserDm('telegram:1', 'telegram', 'mg-1');

    migration026.up(getDb());

    const tables = getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'user_dms%'`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name).sort()).toEqual(['user_dms']);
  });
});
