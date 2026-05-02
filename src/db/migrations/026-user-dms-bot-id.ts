/**
 * Extend `user_dms` PK to include `bot_id` so the cache disambiguates
 * approvals on multi-bot installs (paraclaw#67 follow-up — Proposal C).
 *
 * Before:  PRIMARY KEY (user_id, channel_type)
 * After:   PRIMARY KEY (user_id, channel_type, bot_id)   -- bot_id NOT NULL DEFAULT ''
 *
 * Why the column instead of a sibling table: the cache's purpose is
 * "given an approver and a channel + bot, what messaging_group do I
 * deliver to?" — a key extension is the honest representation. A
 * sibling table would force every reader to do an existence check
 * across both tables to find the right row.
 *
 * Backfill: every legacy row migrates with `bot_id = ''`. The empty
 * string is the configurable system-default slot — a settings UI lets
 * the operator point it at a specific bot's DM, and the resolver falls
 * through to it when an exact `(user, channel, originBotId)` cache miss
 * cold-resolves into a "bots can't DM first" failure (Telegram). See
 * `pickApprovalDelivery` in `src/modules/approvals/primitive.ts`.
 *
 * Idempotency: schema_version gate; uses the rename-rebuild dance
 * because SQLite can't add a column to an existing PK. Sets
 * `disableForeignKeys: true` for the same reason 025 does — the
 * runner toggles `PRAGMA foreign_keys = OFF` connection-scope so
 * pre-existing orphan rows in referencing tables don't fail the
 * commit-time deferred check.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration026: Migration = {
  version: 26,
  name: 'user-dms-bot-id',
  disableForeignKeys: true,
  up(db: Database) {
    db.exec(`
      CREATE TABLE user_dms_new (
        user_id            TEXT NOT NULL REFERENCES users(id),
        channel_type       TEXT NOT NULL,
        bot_id             TEXT NOT NULL DEFAULT '',
        messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
        resolved_at        TEXT NOT NULL,
        PRIMARY KEY (user_id, channel_type, bot_id)
      );

      INSERT INTO user_dms_new (user_id, channel_type, bot_id, messaging_group_id, resolved_at)
        SELECT user_id, channel_type, '', messaging_group_id, resolved_at
          FROM user_dms;

      DROP TABLE user_dms;
      ALTER TABLE user_dms_new RENAME TO user_dms;
    `);
  },
};
