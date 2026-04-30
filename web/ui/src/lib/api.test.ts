/**
 * api.ts unit tests — focused on the auth-gate behavior of `request<T>`.
 * The vault token-mgmt helpers (mint/revoke/detach) thread an
 * `authExtraScopes` hint so that a 403 scope-mismatch from the back-end
 * triggers re-auth with the narrow per-vault scope appended, not just the
 * broad REQUESTED_SCOPES set (paraclaw#56).
 *
 * Strategy: mock `auth.ts` so we can assert the exact arguments to
 * beginLogin / refreshAccessToken / clearTokens; mock `fetch` to shape the
 * wire response (200 / 403 with scope-mismatch body / 403 with unrelated
 * body). beginLogin in production never returns (it does
 * window.location.replace), so we mock it to *reject* — that lets the
 * `await beginLogin(...)` inside request<T> propagate, and we assert on
 * what it was called with.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as auth from './auth.ts';

vi.mock('./auth.ts', () => ({
  beginLogin: vi.fn(),
  clearTokens: vi.fn(),
  getAccessToken: vi.fn(() => 'cached-token'),
  refreshAccessToken: vi.fn(),
}));

beforeEach(() => {
  // Each test does `await import('./api.ts')` after stubbing fetch. Without
  // resetModules, vitest hands back the already-evaluated module from the
  // first test in the file, so later tests see the *first* test's stubbed
  // fetch — leading to false greens or confusing failures when one body
  // shape is tested while another should fire. Reset between tests so
  // every dynamic import re-evaluates against the current global stub.
  vi.resetModules();
  vi.mocked(auth.getAccessToken).mockReturnValue('cached-token');
  // Reject so the `await beginLogin(...)` in request<T> resolves the chain
  // and the caller's promise settles — letting us await + assert.
  vi.mocked(auth.beginLogin).mockRejectedValue(new Error('beginLogin called (test)'));
  vi.mocked(auth.refreshAccessToken).mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('mintVaultToken — auth gate on 403', () => {
  it('passes vault:<name>:admin to beginLogin when the vault returns scope-mismatch', async () => {
    // Factory-per-call: a Response body is single-consume, so a single
    // mockResolvedValue would let isScopeMismatch.clone().text() drain the
    // body for the first test and leave a stale Response with an empty
    // body for any subsequent code path.
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { error: "This endpoint requires the 'vault:work:admin' scope" }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(
      api.mintVaultToken('work', { label: 'claw-x', scopes: ['vault:read'] }),
    ).rejects.toThrow(/beginLogin called/);

    expect(auth.clearTokens).toHaveBeenCalled();
    expect(auth.beginLogin).toHaveBeenCalledWith(['vault:work:admin']);
  });
});

describe('revokeVaultToken — auth gate on 403', () => {
  it('passes vault:<name>:admin to beginLogin', async () => {
    // Factory-per-call: a Response body is single-consume, so a single
    // mockResolvedValue would let isScopeMismatch.clone().text() drain the
    // body for the first test and leave a stale Response with an empty
    // body for any subsequent code path.
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { error: "This endpoint requires the 'vault:work:admin' scope" }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(api.revokeVaultToken('work', 't_abc')).rejects.toThrow(/beginLogin called/);

    expect(auth.beginLogin).toHaveBeenCalledWith(['vault:work:admin']);
  });
});

describe('detachVault — auth gate on 403', () => {
  it('threads authExtraScopes from caller through to beginLogin', async () => {
    // Factory-per-call: a Response body is single-consume, so a single
    // mockResolvedValue would let isScopeMismatch.clone().text() drain the
    // body for the first test and leave a stale Response with an empty
    // body for any subsequent code path.
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, { error: "This endpoint requires the 'vault:work:admin' scope" }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(
      api.detachVault('research', {
        mcpName: 'parachute-vault',
        revokeToken: true,
        authExtraScopes: ['vault:work:admin'],
      }),
    ).rejects.toThrow(/beginLogin called/);

    expect(auth.beginLogin).toHaveBeenCalledWith(['vault:work:admin']);
  });

  it('omits scope hint when caller did not supply one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, { error: 'This endpoint requires the claw:admin scope' }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(api.detachVault('research', { revokeToken: false })).rejects.toThrow(
      /beginLogin called/,
    );

    expect(auth.beginLogin).toHaveBeenCalledWith(undefined);
  });
});

describe('non-scope 403 does NOT trigger re-auth', () => {
  it('throws HttpError(403) when body is unrelated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(
      api.mintVaultToken('work', { label: 'x', scopes: ['vault:read'] }),
    ).rejects.toMatchObject({
      name: 'HttpError',
      status: 403,
    });
    expect(auth.beginLogin).not.toHaveBeenCalled();
    expect(auth.clearTokens).not.toHaveBeenCalled();
  });
});

describe('happy path — 200 returns parsed body and skips auth', () => {
  it('mintVaultToken returns the parsed MintedVaultToken', async () => {
    const minted = {
      token: 'pvt_secret',
      id: 't_new',
      label: 'claw-x',
      scopes: ['vault:read'],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, minted));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    const result = await api.mintVaultToken('work', { label: 'claw-x', scopes: ['vault:read'] });

    expect(result).toEqual(minted);
    expect(auth.beginLogin).not.toHaveBeenCalled();
  });
});
