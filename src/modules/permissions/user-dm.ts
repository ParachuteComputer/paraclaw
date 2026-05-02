/**
 * User DM resolution.
 *
 * Exposes one primitive: `ensureUserDm(userId, opts?)` returns (or lazily
 * creates) the `messaging_groups` row that the host should deliver to
 * when it wants to DM a given user. Everything that needs to cold-DM a
 * user — approvals, pairing handshakes, host notifications — goes
 * through this function.
 *
 * ## Two-class resolution
 *
 * Channels split cleanly into two classes based on whether the user id is
 * already the DM platform id:
 *
 *   - **Direct-addressable** (Telegram, WhatsApp, iMessage, email, Matrix):
 *     user handle IS the DM chat id. No adapter method needed; we just
 *     mint a messaging_group row with `platform_id = handle`.
 *
 *   - **Resolution-required** (Discord, Slack, Teams, Webex, gChat):
 *     user id and DM channel id are different. The adapter must implement
 *     `openDM(handle)`, which Chat SDK's `chat.openDM` handles for us via
 *     the bridge. The returned channel id becomes the `platform_id`.
 *
 * ## Bot-aware caching (migration 026)
 *
 * The cache PK is `(user_id, channel_type, bot_id)`. Callers that know
 * which bot the DM should reach pass `opts.botId` and get bot-pinned
 * resolution: cache reads scope to that bot, cold-resolve goes through
 * the live adapter for `(channel, botId)` (not just the first adapter
 * for that channel), and the resulting cache row is written under that
 * bot's id.
 *
 * Callers that don't pass a bot id get the legacy "first adapter for
 * this channel" behavior, with cache rows under `bot_id = ''` — the
 * configurable channel-default slot. The settings UI lets the operator
 * point that slot at a specific bot's DM, and `pickApprovalDelivery`
 * falls through to it when an exact-bot resolve fails.
 *
 * ## Caching
 *
 * Successful resolutions are persisted in `user_dms`. The cache survives
 * restarts; first-time DMs on a given `(channel, bot)` pair pay one
 * `openDM` round trip, everyone after is a pure DB read.
 *
 * The underlying platform APIs (`POST /users/@me/channels` on Discord,
 * `conversations.open` on Slack, etc.) are idempotent and return the
 * same channel on repeated calls, so re-resolving after a cache miss is
 * always safe — worst case we round-trip redundantly.
 */
import { getChannelAdapter, getChannelAdapterByBotId } from '../../channels/channel-registry.js';
import { getMessagingGroup, getMessagingGroupByPlatform, createMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { ChannelAdapter } from '../../channels/adapter.js';
import type { MessagingGroup, User } from '../../types.js';
import { getUser } from './db/users.js';
import { getUserDm, upsertUserDm } from './db/user-dms.js';

export interface EnsureUserDmOptions {
  /**
   * Pin the resolution to a specific bot. When set, the cache is read /
   * written under that exact bot id and cold-resolve uses the adapter
   * registered for `(channelType, botId)`. When omitted (or empty
   * string), the legacy "first adapter for this channel" path runs and
   * the cache row lands under `bot_id = ''` (the configurable
   * channel-default slot).
   */
  botId?: string | null;
}

/**
 * Return a messaging_group usable to DM this user, creating it lazily if
 * needed. Returns null when:
 *   - the user id isn't namespaced (no `kind:handle` prefix)
 *   - the user's channel has no adapter registered (or, when `opts.botId`
 *     is set, no adapter is registered for that exact `(channel, bot)`)
 *   - the channel needs openDM but its adapter doesn't implement it
 *   - openDM throws (platform error, user blocked bot, the bot can't
 *     initiate a DM until the user has messaged it first, etc.)
 *
 * Callers should treat null as "this user is unreachable on this
 * channel + bot pair." `pickApprovalDelivery` translates that into a
 * channel-default fallback before giving up entirely.
 */
export async function ensureUserDm(userId: string, opts?: EnsureUserDmOptions): Promise<MessagingGroup | null> {
  const user = getUser(userId);
  if (!user) {
    log.warn('ensureUserDm: user not found', { userId });
    return null;
  }

  const { channelType, handle } = parseUserId(user);
  if (!channelType || !handle) {
    log.warn('ensureUserDm: user id not namespaced', { userId });
    return null;
  }

  const botId = opts?.botId ?? '';

  // Cache hit: existing user_dms row → load and return the messaging_group.
  const cached = getUserDm(userId, channelType, botId);
  if (cached) {
    const mg = getMessagingGroup(cached.messaging_group_id);
    if (mg) return mg;
    // Row points to a deleted messaging_group — fall through and re-resolve.
    log.warn('ensureUserDm: cached row references missing messaging_group, re-resolving', {
      userId,
      botId,
      messagingGroupId: cached.messaging_group_id,
    });
  }

  // Cache miss: pick the adapter. With a bot id we MUST use that exact
  // bot's adapter — falling back to "any adapter for this channel" would
  // re-introduce the bug Proposal C is fixing (cross-bot delivery).
  const adapter = botId ? getChannelAdapterByBotId(channelType, botId) : getChannelAdapter(channelType);
  if (!adapter) {
    log.warn('ensureUserDm: no adapter for channel/bot', { channelType, botId });
    return null;
  }

  const dmPlatformId = await resolveDmPlatformId(adapter, channelType, handle);
  if (!dmPlatformId) return null;

  // Find-or-create the underlying messaging_group. A DM we received
  // earlier may already have a row matching (channel_type, platform_id).
  const now = new Date().toISOString();
  let mg = getMessagingGroupByPlatform(channelType, dmPlatformId);
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: dmPlatformId,
      name: user.display_name,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    };
    createMessagingGroup(mg);
    log.info('ensureUserDm: created DM messaging_group', {
      userId,
      channelType,
      botId,
      messagingGroupId: mgId,
    });
  }

  upsertUserDm({
    user_id: userId,
    channel_type: channelType,
    bot_id: botId,
    messaging_group_id: mg.id,
    resolved_at: now,
  });

  return mg;
}

/**
 * Call the adapter's openDM if it has one; otherwise fall through to using
 * the handle directly. Returns null if openDM throws (platform-side
 * refusal — Telegram bots can't DM first, Discord blocked-by-recipient,
 * etc.).
 */
async function resolveDmPlatformId(
  adapter: ChannelAdapter,
  channelType: string,
  handle: string,
): Promise<string | null> {
  if (!adapter.openDM) {
    // Direct-addressable channel — handle doubles as the DM chat id.
    return handle;
  }
  try {
    return await adapter.openDM(handle);
  } catch (err) {
    log.error('ensureUserDm: adapter.openDM failed', {
      channelType,
      botId: adapter.botId ?? null,
      handle,
      err,
    });
    return null;
  }
}

function parseUserId(user: User): { channelType: string; handle: string } | { channelType: null; handle: null } {
  const idx = user.id.indexOf(':');
  if (idx < 0) return { channelType: null, handle: null };
  const prefix = user.id.slice(0, idx);
  const handle = user.id.slice(idx + 1);
  if (!prefix || !handle) return { channelType: null, handle: null };
  // Teams user IDs use a `29:` prefix, not `teams:`. When the id prefix
  // isn't a registered adapter, fall back to user.kind and treat the full
  // id as the handle.
  if (!getChannelAdapter(prefix) && user.kind && getChannelAdapter(user.kind)) {
    return { channelType: user.kind, handle: user.id };
  }
  return { channelType: prefix, handle };
}
