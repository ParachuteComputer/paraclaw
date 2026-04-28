/**
 * Read the hub's discovery doc to enumerate registered vaults.
 *
 * Source of truth: `<hubOrigin>/.well-known/parachute.json` (the documented
 * discovery contract per `parachute-patterns/patterns/module-protocol.md`).
 * The hub stamps `PARACHUTE_HUB_ORIGIN` on every lifecycle-spawned service
 * (paraclaw#19); we resolve via `getHubOrigin()` so tailnet-hosted paraclaw
 * sees its tailnet-routable hub origin.
 *
 * Why not `~/.parachute/services.json` directly: that file holds **port +
 * loopback path**, which gives `http://127.0.0.1:<port>/vault/...`. The
 * vault URL chosen here gets baked into each agent container's
 * `container.json` as the MCP target. Loopback works only when the agent
 * shares the host network namespace; for any non-host-network container
 * (or peer-tailnet vault) the agent can't reach it. The well-known doc
 * surfaces the public-routable URL (`https://<host>/vault/<label>`),
 * which is the right thing to bake in.
 *
 * Cache: 30s in-process. Discovery is approximately static between
 * installs — refreshing every few seconds would be wasteful, but caching
 * forever would silently miss a freshly-installed vault. 30s is a balance
 * users won't notice, and per-process restart clears it anyway.
 */
import { getHubOrigin } from './auth.js';

export interface VaultListing {
  name: string;
  url: string;
  version: string;
}

interface ParachuteDiscovery {
  vaults?: VaultListing[];
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  origin: string;
  fetchedAt: number;
  vaults: VaultListing[];
}

let cache: CacheEntry | null = null;

export function clearHubDiscoveryCache(): void {
  cache = null;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function fetchHubVaults(
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<VaultListing[]> {
  const origin = getHubOrigin();
  if (cache && cache.origin === origin && now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.vaults;
  }
  const url = `${origin}/.well-known/parachute.json`;
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    throw new Error(`hub discovery ${res.status} ${res.statusText} from ${url}`);
  }
  const doc = (await res.json()) as ParachuteDiscovery;
  const vaults = Array.isArray(doc.vaults) ? doc.vaults : [];
  cache = { origin, fetchedAt: now(), vaults };
  return vaults;
}
