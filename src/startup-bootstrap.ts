/**
 * Startup-time migrations that depend on runtime state — specifically, the
 * bot ids resolved at adapter init time. SQL migrations run before adapters
 * exist, so anything that needs `adapter.botId` (or the operator's `.env`
 * values) lives here instead of in `src/db/migrations/`.
 *
 * Two responsibilities, both idempotent:
 *
 *   1. **Token bootstrap** — copy each active adapter's bot token from `.env`
 *      into the encrypted secrets table, keyed by `<channel>:<botId>`. PR A
 *      doesn't yet read these tokens back from secrets at adapter spawn; the
 *      copy exists so PR B's dynamic per-bot polling has a populated table
 *      to draw from. Re-running the bootstrap with the same value is a no-op.
 *
 *   2. **messaging_groups v1→v2 platform_id backfill** — every existing row
 *      keyed by the v1 form `<channel>:<native>` is rewritten to the v2 form
 *      `<channel>:<botId>:<native>` so the router's `getMessagingGroupByPlatform`
 *      lookup matches what the chat-sdk-bridge now emits on inbound. Other
 *      tables (pending_questions, dropped_messages, pending_approvals, the
 *      session DBs' messages_in/destinations) are intentionally NOT
 *      backfilled — consumers compare those like-with-like inside one event
 *      lifecycle, so a v1 snapshot taken before the upgrade still resolves
 *      against itself; new rows go in v2-shaped from the moment the bridge
 *      starts emitting v2 ids.
 *
 * Idempotency strategy: detect already-v2 rows by checking whether their
 * second segment equals the active adapter's botId. v1 rows have either
 * no second segment (Telegram `telegram:<chatId>`) or a different second
 * segment (Discord `discord:<guildId>:<channelId>`). The collision case
 * (a chat_id that happens to match the bot's own user id) is vanishingly
 * unlikely given Telegram's id-allocation pattern.
 */
import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { encodePlatformId } from './platform-id.js';
import { getActiveAdapters } from './channels/channel-registry.js';
import { getSecret, putSecret } from './secrets/index.js';

/** `.env` var name carrying each channel's bot token. Empty for channels
 *  paraclaw doesn't manage credentials for in `.env` (CLI, native channels). */
const TOKEN_ENV_FOR_CHANNEL: Record<string, string | undefined> = {
  telegram: 'TELEGRAM_BOT_TOKEN',
  discord: 'DISCORD_BOT_TOKEN',
};

export function channelTokenSecretName(channelType: string, botId: string): string {
  return `CHANNEL_BOT_TOKEN:${channelType}:${botId}`;
}

/**
 * Copy each active adapter's `.env`-sourced bot token into the secrets
 * table under `CHANNEL_BOT_TOKEN:<channel>:<botId>`. Skips channels with
 * no `.env` mapping or no resolved botId.
 */
export function bootstrapChannelTokensToSecrets(): void {
  const envVars = Object.values(TOKEN_ENV_FOR_CHANNEL).filter((v): v is string => typeof v === 'string');
  const env = readEnvFile(envVars);
  for (const adapter of getActiveAdapters()) {
    if (!adapter.botId) continue;
    const envVar = TOKEN_ENV_FOR_CHANNEL[adapter.channelType];
    if (!envVar) continue;
    const value = env[envVar];
    if (!value) continue;
    const name = channelTokenSecretName(adapter.channelType, adapter.botId);
    if (getSecret(name) === value) continue;
    putSecret(name, value, { kind: 'channel-token', agent_group_id: null });
    log.info('Bootstrapped channel bot token to secrets', {
      channelType: adapter.channelType,
      botId: adapter.botId,
    });
  }
}

interface MessagingGroupRow {
  id: string;
  channel_type: string;
  platform_id: string;
}

/** True if the platform_id's bot segment is already the given bot's id. */
function isAlreadyV2(channelType: string, platformId: string, botId: string): boolean {
  const prefix = `${channelType}:`;
  if (!platformId.startsWith(prefix)) return false;
  const after = platformId.slice(prefix.length);
  const colon = after.indexOf(':');
  const slot1 = colon === -1 ? after : after.slice(0, colon);
  return slot1 === botId;
}

/**
 * Rewrite v1 platform_ids in `messaging_groups` to v2 for every channel
 * with an active per-bot adapter. Returns the number of rows upgraded
 * (used by the bootstrap log line and tests).
 */
export function backfillMessagingGroupsToV2(): number {
  const adapters = getActiveAdapters().filter((a) => a.botId);
  if (adapters.length === 0) return 0;
  const select = getDb().prepare<MessagingGroupRow>(
    `SELECT id, channel_type, platform_id
       FROM messaging_groups
      WHERE channel_type = @channel_type`,
  );
  const update = getDb().prepare(`UPDATE messaging_groups SET platform_id = @platform_id WHERE id = @id`);
  let totalUpgraded = 0;
  for (const adapter of adapters) {
    const channel = adapter.channelType;
    const botId = adapter.botId!;
    const rows = select.all({ channel_type: channel });
    let upgraded = 0;
    for (const row of rows) {
      if (isAlreadyV2(channel, row.platform_id, botId)) continue;
      const prefix = `${channel}:`;
      if (!row.platform_id.startsWith(prefix)) continue;
      const native = row.platform_id.slice(prefix.length);
      const v2 = encodePlatformId(channel, botId, native);
      try {
        update.run({ id: row.id, platform_id: v2 });
        upgraded += 1;
      } catch (err) {
        log.error('messaging_groups v2 backfill failed (UNIQUE conflict?)', {
          id: row.id,
          from: row.platform_id,
          to: v2,
          err,
        });
      }
    }
    if (upgraded > 0) {
      log.info('messaging_groups backfilled to v2', {
        channelType: channel,
        botId,
        upgraded,
      });
      totalUpgraded += upgraded;
    }
  }
  return totalUpgraded;
}

export function runStartupBootstrap(): void {
  backfillMessagingGroupsToV2();
  bootstrapChannelTokensToSecrets();
}
