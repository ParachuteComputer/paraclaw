import type { UserDm } from '../../../types.js';
import { getDb } from '../../../db/connection.js';

/**
 * Insert or replace a user DM cache row. Migration 026 added the
 * `bot_id` column to the PK; callers may pass `''` (empty string) to
 * write the configurable channel-default slot, or a real bot id for a
 * specific cache.
 */
export function upsertUserDm(row: UserDm): void {
  getDb()
    .prepare(
      `INSERT INTO user_dms (user_id, channel_type, bot_id, messaging_group_id, resolved_at)
       VALUES (@user_id, @channel_type, @bot_id, @messaging_group_id, @resolved_at)
       ON CONFLICT(user_id, channel_type, bot_id) DO UPDATE SET
         messaging_group_id = excluded.messaging_group_id,
         resolved_at = excluded.resolved_at`,
    )
    .run(row);
}

/**
 * Look up the cache row for `(user, channel, bot)`. `botId` defaults to
 * `''` so legacy callers that don't yet know about bots get the
 * channel-default slot — which is what they want before
 * `pickApprovalDelivery` was extended to thread the origin bot through.
 */
export function getUserDm(userId: string, channelType: string, botId: string = ''): UserDm | undefined {
  return getDb()
    .prepare('SELECT * FROM user_dms WHERE user_id = ? AND channel_type = ? AND bot_id = ?')
    .get(userId, channelType, botId) as UserDm | undefined;
}

/**
 * All cache rows for one user, across every `(channel_type, bot_id)`
 * pair. Order is unspecified — callers that care about a specific bot
 * should use {@link getUserDm} directly.
 */
export function getUserDmsForUser(userId: string): UserDm[] {
  return getDb().prepare('SELECT * FROM user_dms WHERE user_id = ?').all(userId) as UserDm[];
}

export function deleteUserDm(userId: string, channelType: string, botId: string = ''): void {
  getDb()
    .prepare('DELETE FROM user_dms WHERE user_id = ? AND channel_type = ? AND bot_id = ?')
    .run(userId, channelType, botId);
}

/**
 * List the channel-default rows (`bot_id = ''`) for one user. The
 * settings UI uses this to render "default approval bot per channel"
 * — one row per channel where the user has any DM cached.
 */
export function getDefaultUserDmsForUser(userId: string): UserDm[] {
  return getDb()
    .prepare("SELECT * FROM user_dms WHERE user_id = ? AND bot_id = '' ORDER BY channel_type")
    .all(userId) as UserDm[];
}
