/**
 * Channel adapter registry.
 *
 * Channels self-register on import. The host calls initChannelAdapters() at startup
 * to instantiate and set up all registered adapters.
 */
import type { ChannelAdapter, ChannelRegistration, ChannelSetup } from './adapter.js';
import { log } from '../log.js';
import { decodePlatformIdAs } from '../platform-id.js';

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

/**
 * Resolve the adapter responsible for a given v2 platform_id by decoding
 * its bot segment. Falls back to the channel-type-only lookup for legacy
 * v1 ids (botId === null) so deliveries against not-yet-backfilled rows
 * still go somewhere sensible during the rollout window.
 */
export function getChannelAdapterForPlatformId(
  channelType: string,
  platformId: string,
): ChannelAdapter | undefined {
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
 * Instantiate and set up all registered channel adapters.
 * Skips adapters that return null (missing credentials).
 */
export async function initChannelAdapters(setupFn: (adapter: ChannelAdapter) => ChannelSetup): Promise<void> {
  for (const [name, registration] of registry) {
    try {
      const adapter = await registration.factory();
      if (!adapter) {
        log.warn('Channel credentials missing, skipping', { channel: name });
        continue;
      }

      const setup = setupFn(adapter);
      // Transient network failures during adapter init (e.g. Telegram deleteWebhook
      // hitting a DNS hiccup at boot) would otherwise leave the channel permanently
      // dead until manual restart. Retry only on NetworkError so misconfigs (bad
      // tokens, etc.) still fail fast.
      let attempt = 0;
      while (true) {
        try {
          await adapter.setup(setup);
          break;
        } catch (err) {
          if (isNetworkError(err) && attempt < SETUP_RETRY_DELAYS_MS.length) {
            const delay = SETUP_RETRY_DELAYS_MS[attempt]!;
            log.warn('Channel adapter setup failed with network error, retrying', {
              channel: name,
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
