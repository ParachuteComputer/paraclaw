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
 * second segment matches *any* known bot id for the channel — the union of
 * active adapters + every botId persisted under `CHANNEL_BOT_TOKEN:<channel>:`
 * in the secrets table. Comparing against only the iteration's adapter
 * misclassifies rows already-v2 for a *secondary* bot as v1 and re-prefixes
 * them, producing a 4-segment garbage id; consulting secrets too means even
 * pre-spawn secondary bots (Proposal A defers adapter spawn until wire) are
 * recognized.
 */
import { getDb } from './db/connection.js';
import { readEnvFile } from './env.js';
import { log } from './log.js';
import { encodePlatformId } from './platform-id.js';
import { getActiveAdapters } from './channels/channel-registry.js';
import { getSecret, listSecrets, putSecret } from './secrets/index.js';

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
    const existing = getSecret(name);
    if (existing === value) continue;
    putSecret(name, value, { kind: 'channel-token', agent_group_id: null });
    if (existing === undefined) {
      log.info('Bootstrapped channel bot token to secrets', {
        channelType: adapter.channelType,
        botId: adapter.botId,
      });
    } else {
      // `.env` value diverged from what we previously stored — operator
      // rotated the token. Single line so token-rotation events show up
      // in `logs/paraclaw.log` without needing a separate observability
      // surface.
      log.info('Channel bot token rotated', {
        channelType: adapter.channelType,
        botId: adapter.botId,
      });
    }
  }
}

interface MessagingGroupRow {
  id: string;
  channel_type: string;
  platform_id: string;
}

/**
 * True if the platform_id's bot segment matches *any* known bot id for this
 * channel — not just the active adapter's. The set must be the union of
 * every botId the install has ever registered (active adapters + persisted
 * `CHANNEL_BOT_TOKEN:<channel>:<botId>` secrets), or rows already-v2 for a
 * secondary bot get re-prefixed under the iteration's primary botId and end
 * up with a 4-segment platform_id like `telegram:primary:secondary:chat`.
 *
 * Collision case: if a v1 row's first native segment happens to equal one
 * of the known bot ids (a Telegram chat_id matching a bot's own user_id, or
 * a Discord guild id matching an application id), it would be misclassified
 * as already-v2 and skipped. Vanishingly unlikely given how those id spaces
 * are allocated — flagged here so a future operator hitting the case knows
 * where to look.
 */
function isAlreadyV2(channelType: string, platformId: string, knownBotIds: ReadonlySet<string>): boolean {
  const prefix = `${channelType}:`;
  if (!platformId.startsWith(prefix)) return false;
  const after = platformId.slice(prefix.length);
  const colon = after.indexOf(':');
  const slot1 = colon === -1 ? after : after.slice(0, colon);
  return knownBotIds.has(slot1);
}

/**
 * Union of every known bot id per channel: the live adapters + every botId
 * that appears in a `CHANNEL_BOT_TOKEN:<channel>:<botId>` secret name. We
 * consult secrets because at boot only the `.env` primary is yet active;
 * secondary bots persisted via `/register-bot` haven't been adapter-spawned
 * yet (Proposal A defers spawn until `/wire-channel`), but their tokens are
 * already in the secrets table — and rows pointing at them are already v2.
 */
function knownBotIdsPerChannel(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (channel: string, botId: string) => {
    let set = out.get(channel);
    if (!set) {
      set = new Set();
      out.set(channel, set);
    }
    set.add(botId);
  };
  for (const a of getActiveAdapters()) {
    if (a.botId) add(a.channelType, a.botId);
  }
  for (const s of listSecrets(null)) {
    if (s.kind !== 'channel-token') continue;
    const parts = s.name.split(':');
    if (parts.length < 3 || parts[0] !== 'CHANNEL_BOT_TOKEN') continue;
    const channel = parts[1];
    const botId = parts.slice(2).join(':');
    if (!channel || !botId) continue;
    add(channel, botId);
  }
  return out;
}

/**
 * Rewrite v1 platform_ids in `messaging_groups` to v2 for every channel
 * with an active per-bot adapter. Returns the number of rows upgraded
 * (used by the bootstrap log line and tests).
 */
export function backfillMessagingGroupsToV2(): number {
  const adapters = getActiveAdapters().filter((a) => a.botId);
  if (adapters.length === 0) return 0;
  const knownByChannel = knownBotIdsPerChannel();
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
    const known = knownByChannel.get(channel) ?? new Set([botId]);
    const rows = select.all({ channel_type: channel });
    let upgraded = 0;
    for (const row of rows) {
      if (isAlreadyV2(channel, row.platform_id, known)) continue;
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
