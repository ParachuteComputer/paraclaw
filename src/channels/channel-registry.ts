/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { decodePlatformIdAs } from '../platform-id.js';
import { listSecrets, getSecret } from '../secrets/index.js';

const SETUP_RETRY_DELAYS_MS = [2000, 5000, 10000];

/** Duck-type check — adapters that throw an Error with `name === 'NetworkError'`
 * (Chat SDK's `@chat-adapter/shared.NetworkError` and similar) get a retry on
 * setup. Avoids depending on `@chat-adapter/shared` at trunk level. */
function isNetworkError(err: unknown): err is Error {
  return err instanceof Error && err.name === 'NetworkError';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const registry = new Map<string, ChannelRegistration>();
/**
 * Active adapters keyed by `<channelType>\0<botId>` so two adapters on the
 * same channel type but different bots (e.g. two Telegram bots) can coexist.
 * Adapters without a bot dimension (CLI admin transport) key under empty
 * botId.
 */
const activeAdapters = new Map<string, ChannelAdapter>();

/**
 * Cached host-callbacks builder, set by {@link initChannelAdapters} the
 * first time it runs. Reused by {@link spawnSecretsBackedBots} (boot scan)
 * and {@link registerBotAdapter} (dynamic per-bot adds via the HTTP
 * register-bot endpoint) so every adapter — primary or dynamic — wires
 * inbound through the same router callbacks.
 */
let cachedSetupFn: ((adapter: ChannelAdapter) => ChannelSetup) | null = null;

function adapterKey(channelType: string, botId: string | null | undefined): string {
  return `${channelType}\0${botId ?? ''}`;
}

/** Register a channel adapter factory. Called by channel modules on import. */
export function registerChannelAdapter(name: string, registration: ChannelRegistration): void {
  registry.set(name, registration);
}

/**
 * Get a live adapter by channel type. Returns the first adapter registered
 * under that type — meaningful only in single-bot-per-platform installs
 * (the current state through PR A). Multi-bot callers must use
 * {@link getChannelAdapterForPlatformId} so the right bot's adapter is
 * selected by the v2 platform_id's bot dimension.
 */
export function getChannelAdapter(channelType: string): ChannelAdapter | undefined {
  for (const [key, adapter] of activeAdapters) {
    if (key.startsWith(`${channelType}\0`)) return adapter;
  }
  return undefined;
}

/** Resolve a live adapter by exact `(channelType, botId)`. Returns undefined if no adapter for that bot is active. */
export function getChannelAdapterByBotId(channelType: string, botId: string): ChannelAdapter | undefined {
  return activeAdapters.get(adapterKey(channelType, botId));
}

/**
 * Resolve the adapter responsible for a given v2 platform_id by decoding
 * its bot segment. Falls back to the channel-type-only lookup for legacy
 * v1 ids (botId === null) so deliveries against not-yet-backfilled rows
 * still go somewhere sensible during the rollout window.
 */
export function getChannelAdapterForPlatformId(channelType: string, platformId: string): ChannelAdapter | undefined {
  const decoded = decodePlatformIdAs(platformId, 'v2');
  if (decoded.botId !== null) {
    const exact = activeAdapters.get(adapterKey(channelType, decoded.botId));
    if (exact) return exact;
  }
  return getChannelAdapter(channelType);
}

/** Get all active adapters. */
export function getActiveAdapters(): ChannelAdapter[] {
  return [...activeAdapters.values()];
}

/** Get all registered channel names. */
export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}

/** Get container config for a channel (used by container-runner for additional mounts/env). */
export function getChannelContainerConfig(name: string): ChannelRegistration['containerConfig'] {
  return registry.get(name)?.containerConfig;
}

/**
 * Run an adapter's setup with NetworkError retry — the same retry loop both
 * {@link initChannelAdapters} and the dynamic register helpers share so
 * boot-time and runtime adds get identical resilience semantics.
 */
async function setupAdapterWithRetry(adapter: ChannelAdapter, setup: ChannelSetup, label: string): Promise<void> {
  let attempt = 0;
  while (true) {
    try {
      await adapter.setup(setup);
      return;
    } catch (err) {
      if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
        const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
        log.warn('Channel adapter setup failed with network error, retrying', {
          channel: label,
          attempt: attempt + 1,
          delayMs: delay,
          err: err.message,
        });
        await sleep(delay);
        attempt += 1;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  cachedSetupFn = setupFn;
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      await setupAdapterWithRetry(adapter, setupFn(adapter), name);
      activeAdapters.set(adapterKey(adapter.channelType, adapter.botId), adapter);
      log.info('Channel adapter started', {
        channel: name,
        type: adapter.channelType,
        botId: adapter.botId ?? null,
      });
    } catch (err) {
      log.error('Failed to start channel adapter', { channel: name, err });
    }
  }
}

/**
 * Register an adapter for a specific bot at runtime — used by the
 * `POST /api/channels/{channel}/register-bot` endpoint after the operator
 * pastes a token via the wire-channel UI.
 *
 * Resolves the channel's `spawnFromSecret` hook to build the adapter, runs
 * setup with the same callbacks the primary adapter uses, and slots it into
 * `activeAdapters` keyed by `(channelType, botId)`. Idempotent: if an
 * adapter is already active for this `(channelType, botId)` it returns the
 * existing one instead of double-registering.
 *
 * Throws if the channel doesn't expose `spawnFromSecret` (single-bot
 * channel) or if `initChannelAdapters` hasn't run yet (no cached setup
 * callbacks). Returns null if the spawn hook itself returns null (token
 * rejected at the platform).
 */
export async function registerBotAdapter(
  channelType: string,
  secretName: string,
  secretValue: string,
): Promise<ChannelAdapter | null> {
  const registration = registry.get(channelType);
  if (!registration) throw new Error(`unknown channel: ${channelType}`);
  if (!registration.spawnFromSecret) {
    throw new Error(`channel does not support multi-bot operation: ${channelType}`);
  }
  if (!cachedSetupFn) {
    throw new Error('initChannelAdapters has not run yet — cannot register dynamic bot');
  }
  const adapter = await registration.spawnFromSecret(secretName, secretValue);
  if (!adapter) return null;
  const key = adapterKey(adapter.channelType, adapter.botId);
  const existing = activeAdapters.get(key);
  if (existing) {
    log.info('Channel adapter already active for bot, skipping re-setup', {
      channel: channelType,
      botId: adapter.botId ?? null,
    });
    return existing;
  }
  await setupAdapterWithRetry(adapter, cachedSetupFn(adapter), channelType);
  activeAdapters.set(key, adapter);
  log.info('Channel adapter registered dynamically', {
    channel: channelType,
    botId: adapter.botId ?? null,
  });
  return adapter;
}

/**
 * Boot-time scan that brings up adapters for every persisted
 * `CHANNEL_BOT_TOKEN:<channel>:<botId>` secret that (a) has at least one
 * wired messaging_group_agents row and (b) isn't already covered by the
 * `.env`-seeded primary adapter. Run AFTER `initChannelAdapters` and
 * AFTER `runStartupBootstrap`.
 *
 * Orphan rule (paraclaw#67 Proposal A): a secret with no MGA wiring is
 * "registered but inert" — the operator validated a token but never
 * committed it to a group. We deliberately don't spawn its adapter at
 * boot, because doing so would re-introduce the validate-then-poll race
 * that pre-A behavior had: an adapter polling without a wire feeds
 * inbounds straight into the unwired-channel approval cascade. Operators
 * recover by completing the wire from `/claw/channels/new` (the wire
 * endpoint spawns the adapter atomically with the MGA insert).
 *
 * Skips channels with no `spawnFromSecret` hook. Logs but doesn't throw
 * on individual spawn failures — one bad token shouldn't keep the rest
 * offline.
 */
export async function spawnSecretsBackedBots(): Promise<void> {
  const tokens = listSecrets(null).filter((s) => s.kind === 'channel-token' && s.name.startsWith('CHANNEL_BOT_TOKEN:'));
  for (const row of tokens) {
    const parts = row.name.split(':');
    if (parts.length < 3) continue;
    const channelType = parts[1]!;
    const botId = parts.slice(2).join(':');
    if (!channelType || !botId) continue;
    const registration = registry.get(channelType);
    if (!registration?.spawnFromSecret) continue;
    if (activeAdapters.has(adapterKey(channelType, botId))) continue;
    if (!hasWiringForBot(channelType, botId)) {
      log.info('Skipping orphan channel bot secret (no wiring)', { channel: channelType, botId });
      continue;
    }
    const value = getSecret(row.name);
    if (!value) {
      log.warn('Channel bot secret has no value, skipping', { secret: row.name });
      continue;
    }
    try {
      const adapter = await registerBotAdapter(channelType, row.name, value);
      if (!adapter) {
        log.warn('Secrets-backed bot spawn returned null', { channel: channelType, botId });
      }
    } catch (err) {
      log.error('Failed to spawn secrets-backed bot', { channel: channelType, botId, err });
    }
  }
}

/**
 * Returns true iff at least one messaging_group_agents row exists wired
 * through a messaging_groups row whose platform_id encodes the given
 * `(channelType, botId)` pair (v2 format `<channel>:<botId>:<native>`).
 *
 * v1 rows (no bot dimension) for the same channel match nothing here —
 * the secrets-backed scan only runs for bots that have a botId in their
 * secret name, and v1 wires don't carry one. That's the correct
 * conservative answer: a v1 wire could belong to *any* bot on that
 * channel, so we can't safely auto-attribute it to this secret.
 */
function hasWiringForBot(channelType: string, botId: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
         FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type = ?
          AND mg.platform_id LIKE ? ESCAPE '\\'
        LIMIT 1`,
    )
    .get(channelType, `${channelType}:${escapeLike(botId)}:%`);
  return row !== undefined;
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * Test-only: inject a fake active adapter so functions that read the
 * registry (e.g. startup-bootstrap) can run without a full setup. Caller
 * is responsible for calling {@link _resetActiveAdaptersForTest} after.
 */
export function _setActiveAdapterForTest(adapter: ChannelAdapter): void {
  activeAdapters.set(adapterKey(adapter.channelType, adapter.botId), adapter);
}

export function _resetActiveAdaptersForTest(): void {
  activeAdapters.clear();
}

/** Tear down all active adapters. */
export async function teardownChannelAdapters(): Promise<void> {
  for (const [key, adapter] of activeAdapters) {
    try {
      await adapter.teardown();
      log.info('Channel adapter stopped', { key, type: adapter.channelType });
    } catch (err) {
      log.error('Failed to stop channel adapter', { key, type: adapter.channelType, err });
    }
  }
  activeAdapters.clear();
}
