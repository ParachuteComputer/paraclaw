/**
 * Canonical platform_id encoding for paraclaw.
 *
 * Two shapes coexist on disk during the v2-format rollout (refactor: see
 * `feat/channel-wiring-impl` design notes). After the startup backfill runs,
 * every messaging_groups row uses the v2 form below; older readers (queue
 * tables that snapshot platform_id values) may still have v1 strings until
 * the rows themselves are rewritten through their natural lifecycle.
 *
 * v1 (legacy):    `<channel>:<native>`           — pre-multi-bot
 * v2 (current):   `<channel>:<botId>:<native>`   — adds the bot dimension
 *
 * `<native>` is the platform's own conversation id and may itself contain
 * colons — e.g. Discord: `<guildId>:<channelId>` or `@me:<userId>`. The
 * decoder splits on the first two colons only and treats the rest as native,
 * so `discord:<botId>:@me:<userId>` round-trips correctly.
 *
 * Why the bot dimension?
 *   On Telegram, a DM's chat_id IS the user's user_id. So if Aaron DMs
 *   bot1 his chat_id is 1190596288; if Aaron DMs bot2 his chat_id is also
 *   1190596288. Two distinct conversations, same v1 platform_id —
 *   collision on `messaging_groups UNIQUE(channel_type, platform_id)`.
 *   Encoding the bot id as the second segment makes routing per-bot.
 */

export interface DecodedPlatformId {
  /** Channel/platform tag, e.g. `telegram`, `discord`. */
  channel: string;
  /** Bot id segment if present (v2 format), else `null` for legacy v1 strings. */
  botId: string | null;
  /** Platform-native id (chat_id, guild:channel pair, `@me:userId`, …). */
  native: string;
}

/**
 * Build a v2-format platform_id. Always emits `<channel>:<botId>:<native>`
 * regardless of what the native id contains, because consumers split on the
 * first two colons.
 */
export function encodePlatformId(channel: string, botId: string, native: string): string {
  return `${channel}:${botId}:${native}`;
}

/**
 * Decode a platform_id into its parts. Tolerates both v1 (`<channel>:<native>`)
 * and v2 (`<channel>:<botId>:<native>`) shapes — `botId` is `null` for v1.
 *
 * The v1/v2 disambiguation is **caller-aware**: the decoder cannot tell which
 * shape it is looking at from the string alone (a Discord v1
 * `discord:<guildId>:<channelId>` has the same colon count as a Telegram v2
 * `telegram:<botId>:<chatId>`). Callers that need the bot id must call
 * {@link decodePlatformIdAs} with the expected shape.
 */
export function decodePlatformId(prefixed: string): DecodedPlatformId {
  const firstColon = prefixed.indexOf(':');
  if (firstColon === -1) {
    return { channel: prefixed, botId: null, native: '' };
  }
  const channel = prefixed.slice(0, firstColon);
  const rest = prefixed.slice(firstColon + 1);
  return { channel, botId: null, native: rest };
}

/**
 * Decode assuming the v2 shape (`<channel>:<botId>:<native>`). Returns
 * `botId === null` and `native` set to the full remainder if the string
 * has only one colon (legacy v1) — callers can branch on that.
 */
export function decodePlatformIdAs(prefixed: string, expectVersion: 'v2'): DecodedPlatformId {
  void expectVersion;
  const firstColon = prefixed.indexOf(':');
  if (firstColon === -1) {
    return { channel: prefixed, botId: null, native: '' };
  }
  const channel = prefixed.slice(0, firstColon);
  const afterChannel = prefixed.slice(firstColon + 1);
  const secondColon = afterChannel.indexOf(':');
  if (secondColon === -1) {
    // v1: <channel>:<native>, no bot dimension.
    return { channel, botId: null, native: afterChannel };
  }
  const botId = afterChannel.slice(0, secondColon);
  const native = afterChannel.slice(secondColon + 1);
  return { channel, botId, native };
}

/**
 * Determine whether a platform ID needs a channel-type prefix.
 *
 * Chat SDK adapters (Telegram, Discord, Slack, Teams, etc.) namespace their
 * platform IDs with a channel prefix: "telegram:123456", "discord:guild:chan".
 * The router stores channel_type and platform_id in separate columns, but
 * Chat SDK adapters send the prefixed form as the platform_id — so any code
 * that writes messaging_groups rows must produce the same shape the adapter
 * will later emit as event.platformId, or router lookups miss and messages
 * get silently dropped.
 *
 * Native adapters (Signal, WhatsApp, iMessage) use their own ID formats and
 * send them as-is — no channel prefix. WhatsApp/iMessage emit JIDs/emails
 * containing '@'. Signal emits raw phone numbers ('+15551234567') for DMs
 * and 'group:<id>' for group chats. Prefixing any of these would cause a
 * mismatch with what the adapter later emits.
 */
export function namespacedPlatformId(channel: string, raw: string): string {
  if (raw.startsWith(`${channel}:`)) return raw;
  if (raw.includes('@')) return raw;
  if (raw.startsWith('+') || raw.startsWith('group:')) return raw;
  return `${channel}:${raw}`;
}
