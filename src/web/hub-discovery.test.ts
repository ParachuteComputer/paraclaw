/**
 * Tests the hub-discovery client. The contract under test is the
 * well-known shape (`vaults: [{name, url, version}]`) — same as
 * `parachute-patterns/patterns/module-protocol.md` documents — and the
 * 30s in-process cache so we don't hammer the hub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearHubDiscoveryCache, fetchHubVaults } from './hub-discovery.js';

let prevHubOrigin: string | undefined;

beforeEach(() => {
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
  delete process.env.PARACLAW_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.example';
  clearHubDiscoveryCache();
});

afterEach(() => {
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  clearHubDiscoveryCache();
});

function makeFetchStub(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: async () => body,
  } as Response);
}

describe('fetchHubVaults', () => {
  it('GETs /.well-known/parachute.json on the resolved hub origin', async () => {
    const stub = makeFetchStub({ vaults: [] });
    await fetchHubVaults(stub);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith(
      'https://parachute.example/.well-known/parachute.json',
      expect.objectContaining({ headers: { Accept: 'application/json' } }),
    );
  });

  it('returns the vaults array as-is from the well-known doc', async () => {
    const vaults = [
      { name: 'default', url: 'https://parachute.example/vault/default', version: '0.3.0' },
      { name: 'work', url: 'https://parachute.example/vault/work', version: '0.3.0' },
    ];
    const stub = makeFetchStub({ vaults });
    expect(await fetchHubVaults(stub)).toEqual(vaults);
  });

  it('returns [] when the well-known has no vaults block', async () => {
    const stub = makeFetchStub({ services: [] });
    expect(await fetchHubVaults(stub)).toEqual([]);
  });

  it('caches results within the TTL — second call does not hit fetch', async () => {
    const stub = makeFetchStub({ vaults: [{ name: 'default', url: 'https://h/vault/default', version: '0.3.0' }] });
    let t = 1_000_000;
    const now = () => t;
    await fetchHubVaults(stub, now);
    t += 5_000;
    await fetchHubVaults(stub, now);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('refetches after the 30s TTL elapses', async () => {
    const stub = makeFetchStub({ vaults: [] });
    let t = 1_000_000;
    const now = () => t;
    await fetchHubVaults(stub, now);
    t += 31_000;
    await fetchHubVaults(stub, now);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('refetches when the hub origin changes (e.g. PARACHUTE_HUB_ORIGIN flipped)', async () => {
    const stub = makeFetchStub({ vaults: [] });
    let t = 1_000_000;
    const now = () => t;
    await fetchHubVaults(stub, now);
    process.env.PARACHUTE_HUB_ORIGIN = 'https://other.example';
    await fetchHubVaults(stub, now);
    expect(stub).toHaveBeenCalledTimes(2);
    expect(stub).toHaveBeenLastCalledWith('https://other.example/.well-known/parachute.json', expect.anything());
  });

  it('throws on non-2xx so the endpoint can surface the error to the UI', async () => {
    const stub = makeFetchStub({}, { ok: false, status: 503 });
    await expect(fetchHubVaults(stub)).rejects.toThrow(/503/);
  });
});
