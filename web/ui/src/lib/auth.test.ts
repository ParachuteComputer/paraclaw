/**
 * auth.ts unit tests. Today's surface is the localStorage / sessionStorage
 * key migration from the paraclaw-era prefix to `parachute-agent.*`. Existing
 * 0.0.x operators have cached discovery + DCR client_id + tokens under the
 * old prefix; without migration their first reload after upgrading to
 * 0.1.0 silently re-runs OAuth + leaves a stale client row on the hub.
 *
 * Tracked in parachute-agent#108. The migration is meant to be called once
 * at SPA bootstrap (in main.tsx) before anything else touches storage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildAuthorizeUrl,
  ensureClient,
  migrateLegacyAuthKeys,
  REQUESTED_SCOPES,
} from './auth.ts';

// jsdom's Storage in this vitest config doesn't reliably expose the full
// Storage prototype methods (the `--localstorage-file` warning at runtime
// hints the underlying impl is a partial). Install a Map-backed fake on
// the global so the migration helper sees a real-feeling Storage surface.
function makeStorageFake(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key(i: number): string | null {
      return Array.from(m.keys())[i] ?? null;
    },
    getItem(k: string): string | null {
      return m.has(k) ? (m.get(k) as string) : null;
    },
    setItem(k: string, v: string): void {
      m.set(k, String(v));
    },
    removeItem(k: string): void {
      m.delete(k);
    },
    clear(): void {
      m.clear();
    },
  };
}

beforeEach(() => {
  vi.stubGlobal('localStorage', makeStorageFake());
  vi.stubGlobal('sessionStorage', makeStorageFake());
});

describe('migrateLegacyAuthKeys', () => {
  it('migrates the static localStorage keys (discovery + setup wizard)', () => {
    localStorage.setItem('paraclaw.discovery', '{"hubOrigin":"http://hub"}');
    localStorage.setItem('paraclaw.setupWizard.v2', '{"furthestStep":"prereqs"}');

    migrateLegacyAuthKeys();

    expect(localStorage.getItem('parachute-agent.discovery')).toBe('{"hubOrigin":"http://hub"}');
    expect(localStorage.getItem('parachute-agent.setupWizard.v2')).toBe('{"furthestStep":"prereqs"}');
    expect(localStorage.getItem('paraclaw.discovery')).toBeNull();
    expect(localStorage.getItem('paraclaw.setupWizard.v2')).toBeNull();
  });

  it('migrates the in-flight OAuth flow key from sessionStorage', () => {
    sessionStorage.setItem('paraclaw.flow', '{"verifier":"v","state":"s"}');

    migrateLegacyAuthKeys();

    expect(sessionStorage.getItem('parachute-agent.flow')).toBe('{"verifier":"v","state":"s"}');
    expect(sessionStorage.getItem('paraclaw.flow')).toBeNull();
  });

  it('migrates per-hub-origin client + tokens keys, preserving the suffix', () => {
    localStorage.setItem('paraclaw.client.http://hub-a', '{"client_id":"a"}');
    localStorage.setItem('paraclaw.client.http://hub-b', '{"client_id":"b"}');
    localStorage.setItem('paraclaw.tokens.http://hub-a', '{"access_token":"t-a"}');
    localStorage.setItem('paraclaw.tokens.http://hub-b', '{"access_token":"t-b"}');

    migrateLegacyAuthKeys();

    expect(localStorage.getItem('parachute-agent.client.http://hub-a')).toBe('{"client_id":"a"}');
    expect(localStorage.getItem('parachute-agent.client.http://hub-b')).toBe('{"client_id":"b"}');
    expect(localStorage.getItem('parachute-agent.tokens.http://hub-a')).toBe('{"access_token":"t-a"}');
    expect(localStorage.getItem('parachute-agent.tokens.http://hub-b')).toBe('{"access_token":"t-b"}');
    expect(localStorage.getItem('paraclaw.client.http://hub-a')).toBeNull();
    expect(localStorage.getItem('paraclaw.tokens.http://hub-b')).toBeNull();
  });

  it('is a no-op when no legacy keys exist (fresh install)', () => {
    localStorage.setItem('parachute-agent.discovery', '{"hubOrigin":"http://hub"}');

    migrateLegacyAuthKeys();

    expect(localStorage.getItem('parachute-agent.discovery')).toBe('{"hubOrigin":"http://hub"}');
    expect(localStorage.length).toBe(1);
  });

  it('is idempotent — repeated calls leave already-migrated state untouched', () => {
    localStorage.setItem('paraclaw.discovery', '{"hubOrigin":"http://hub"}');
    localStorage.setItem('paraclaw.tokens.http://hub', '{"access_token":"t"}');

    migrateLegacyAuthKeys();
    migrateLegacyAuthKeys();

    // Spreading a Storage fake enumerates its method properties, not the
    // stored data — so a snapshot-equality check would pass regardless of
    // behavior. Assert the post-state explicitly: legacy keys gone, new
    // keys hold the original values, and storage holds exactly the two
    // migrated entries (no orphans, no duplicates).
    expect(localStorage.getItem('paraclaw.discovery')).toBeNull();
    expect(localStorage.getItem('paraclaw.tokens.http://hub')).toBeNull();
    expect(localStorage.getItem('parachute-agent.discovery')).toBe('{"hubOrigin":"http://hub"}');
    expect(localStorage.getItem('parachute-agent.tokens.http://hub')).toBe('{"access_token":"t"}');
    expect(localStorage.length).toBe(2);
  });

  it('drops the stale legacy key when both old and new exist (new wins)', () => {
    // This shape only happens if something wrote the legacy key after a
    // prior migration ran — extremely unlikely in production, but the
    // helper has to be deterministic about which value survives.
    localStorage.setItem('paraclaw.discovery', '{"hubOrigin":"http://stale"}');
    localStorage.setItem('parachute-agent.discovery', '{"hubOrigin":"http://current"}');

    migrateLegacyAuthKeys();

    expect(localStorage.getItem('parachute-agent.discovery')).toBe('{"hubOrigin":"http://current"}');
    expect(localStorage.getItem('paraclaw.discovery')).toBeNull();
  });

  it('does not touch unrelated paraclaw-prefixed keys outside the OAuth surface', () => {
    // Defensive: if some other module ever uses a `paraclaw.foo` key, the
    // OAuth migration shouldn't sweep it. Only the four documented prefixes
    // and two static keys move.
    localStorage.setItem('paraclaw.unrelated', 'keep-me');
    localStorage.setItem('paraclaw.discovery', '{"hubOrigin":"http://hub"}');

    migrateLegacyAuthKeys();

    expect(localStorage.getItem('paraclaw.unrelated')).toBe('keep-me');
    expect(localStorage.getItem('parachute-agent.discovery')).toBe('{"hubOrigin":"http://hub"}');
  });
});

/**
 * Bootstrap-scope narrowing — paraclaw#136. The agent SPA used to request
 * `vault:read vault:write` at bootstrap, but every vault flow already runs
 * the paraclaw#56 re-consent pattern (narrow `vault:<name>:admin` via
 * extraScopes), so the broad bootstrap scopes were dead weight on the
 * consent screen. These tests pin the post-narrowing surface so a future
 * edit can't silently re-add vault scopes to the bootstrap grant.
 */
describe('REQUESTED_SCOPES + buildAuthorizeUrl', () => {
  const baseOpts = {
    hubOrigin: 'http://hub.test',
    clientId: 'client-abc',
    redirectUri: 'http://app.test/agent/oauth/callback',
    challenge: 'challenge-xyz',
    state: 'state-123',
  };

  it('REQUESTED_SCOPES is exactly "agent:admin agent:write" — no vault:* at bootstrap', () => {
    expect(REQUESTED_SCOPES).toBe('agent:admin agent:write');
    expect(REQUESTED_SCOPES).not.toMatch(/vault:/);
  });

  it('builds an authorize URL with only agent:* scopes when extraScopes is empty', () => {
    const u = buildAuthorizeUrl(baseOpts);
    expect(u.searchParams.get('scope')).toBe('agent:admin agent:write');
    // Belt-and-suspenders: the URL string itself must not carry any
    // vault scope, even URL-encoded.
    expect(u.toString()).not.toMatch(/vault(%3A|:)/);
  });

  it('appends a narrow vault:<name>:admin scope when passed in extraScopes', () => {
    const u = buildAuthorizeUrl({ ...baseOpts, extraScopes: ['vault:default:admin'] });
    const scope = u.searchParams.get('scope') ?? '';
    expect(scope.split(' ')).toEqual(['agent:admin', 'agent:write', 'vault:default:admin']);
  });

  it('de-dupes extraScopes that are already in REQUESTED_SCOPES', () => {
    const u = buildAuthorizeUrl({
      ...baseOpts,
      extraScopes: ['agent:admin', 'vault:foo:admin'],
    });
    const scope = u.searchParams.get('scope') ?? '';
    // agent:admin should appear exactly once even though it was passed
    // again — the consent screen would otherwise show the same scope twice.
    expect(scope.split(' ').filter((s) => s === 'agent:admin')).toHaveLength(1);
    expect(scope.split(' ')).toContain('vault:foo:admin');
  });

  it('writes the standard PKCE-S256 query params alongside the scope', () => {
    const u = buildAuthorizeUrl(baseOpts);
    expect(u.origin + u.pathname).toBe('http://hub.test/oauth/authorize');
    expect(u.searchParams.get('client_id')).toBe('client-abc');
    expect(u.searchParams.get('redirect_uri')).toBe('http://app.test/agent/oauth/callback');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('code_challenge')).toBe('challenge-xyz');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe('state-123');
  });
});

/**
 * Regression-pin the OAuth client_name in the `/oauth/register` body —
 * paraclaw#137. The hub's consent screen renders this string verbatim, so
 * it's operator-visible UX, not a free-form internal identifier. The
 * 0.1.0 brand sweep renamed "Paraclaw web UI" → "Parachute Agent web UI"
 * (commit 2a83e77 / PR #112); this test prevents a future rename or copy
 * regression from silently shipping a stale brand on the consent screen.
 *
 * No production behavior change — the existing string literal at line ~166
 * is the only thing this test asserts on.
 */
describe('ensureClient — /oauth/register body', () => {
  it('sends client_name "Parachute Agent web UI" on first registration', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ client_id: 'returned-client-id' }),
    });
    vi.stubGlobal('fetch', fetchSpy);

    const id = await ensureClient('http://hub.test');

    expect(id).toBe('returned-client-id');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://hub.test/oauth/register');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.client_name).toBe('Parachute Agent web UI');
    // Belt: also pin scope + auth method so a future copy edit can't ship
    // a partially-renamed body.
    expect(body.scope).toBe(REQUESTED_SCOPES);
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('does not call fetch when a cached client_id is already in localStorage', async () => {
    localStorage.setItem(
      'parachute-agent.client.http://hub.test',
      JSON.stringify({ client_id: 'cached-client-id' }),
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const id = await ensureClient('http://hub.test');

    expect(id).toBe('cached-client-id');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
