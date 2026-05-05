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
    await expect(api.mintVaultToken('work', { label: 'claw-x', scopes: ['vault:read'] })).rejects.toThrow(
      /beginLogin called/,
    );

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
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(403, { error: 'This endpoint requires the agent:admin scope' }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(api.detachVault('research', { revokeToken: false })).rejects.toThrow(/beginLogin called/);

    expect(auth.beginLogin).toHaveBeenCalledWith(undefined);
  });
});

describe('attachVault — auth gate on 403', () => {
  it('threads authExtraScopes from caller through to beginLogin (paraclaw#65)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, {
        error: "vault token mint failed: This endpoint requires the 'vault:techne:admin' scope",
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(
      api.attachVault(
        'techne',
        { scope: 'vault:read', vaultBaseUrl: 'https://example/vault/techne' },
        { authExtraScopes: ['vault:techne:admin'] },
      ),
    ).rejects.toThrow(/beginLogin called/);

    expect(auth.beginLogin).toHaveBeenCalledWith(['vault:techne:admin']);
  });

  it('omits scope hint when caller did not supply one', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(403, {
        error: "vault token mint failed: This endpoint requires the 'vault:techne:admin' scope",
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(
      api.attachVault('techne', { scope: 'vault:read', vaultBaseUrl: 'https://example/vault/techne' }),
    ).rejects.toThrow(/beginLogin called/);

    expect(auth.beginLogin).toHaveBeenCalledWith(undefined);
  });
});

describe('createGroup — auth gate on 403', () => {
  it('threads authExtraScopes when create-with-attach 403s on vault scope (paraclaw#65)', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse(403, {
        error: "vault token mint failed: This endpoint requires the 'vault:techne:admin' scope",
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(
      api.createGroup(
        {
          name: 'Techne',
          folder: 'techne',
          vault: { scope: 'vault:read', vaultBaseUrl: 'https://example/vault/techne' },
        },
        { authExtraScopes: ['vault:techne:admin'] },
      ),
    ).rejects.toThrow(/beginLogin called/);

    expect(auth.beginLogin).toHaveBeenCalledWith(['vault:techne:admin']);
  });
});

describe('non-scope 403 does NOT trigger re-auth', () => {
  it('throws HttpError(403) when body is unrelated', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(403, { error: 'forbidden' }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await expect(api.mintVaultToken('work', { label: 'x', scopes: ['vault:read'] })).rejects.toMatchObject({
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

describe('updateMessagingGroupPolicy — body shape and method', () => {
  // Server-side validateMgPatchInput keys on `unknownSenderPolicy` exactly;
  // pin the wire shape here so a future rename doesn't silently regress.
  it('PATCHes /channels/mg/:id with unknownSenderPolicy', async () => {
    const result = {
      messagingGroup: {
        id: 'mg_1',
        channelType: 'telegram',
        platformId: 'telegram:42:1',
        displayName: null,
        isGroup: false,
        unknownSenderPolicy: 'public',
        deniedAt: null,
        createdAt: '2026-04-20T10:00:00Z',
        wiredAgents: [],
      },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, result));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    const view = await api.updateMessagingGroupPolicy('mg_1', 'public');

    expect(view.unknownSenderPolicy).toBe('public');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/channels\/mg\/mg_1$/);
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ unknownSenderPolicy: 'public' });
  });

  it('surfaces server 400 as HttpError(400) without re-auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, { error: 'invalid unknownSenderPolicy: open' }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    // Cast through unknown so we can drive the bad-input branch even though
    // `open` isn't a valid UnknownSenderPolicy at the type level — the
    // server is what we're pinning here, not the static check.
    type UnknownSenderPolicy = import('./api.ts').UnknownSenderPolicy;
    await expect(
      api.updateMessagingGroupPolicy('mg_1', 'open' as unknown as UnknownSenderPolicy),
    ).rejects.toMatchObject({ name: 'HttpError', status: 400 });
    expect(auth.beginLogin).not.toHaveBeenCalled();
  });
});

describe('getMessagingGroupDetail — happy path', () => {
  it('parses { messagingGroup } envelope and returns the view', async () => {
    const view = {
      id: 'mg_x',
      channelType: 'discord',
      platformId: 'discord:@me:99',
      displayName: 'Aaron DM',
      isGroup: false,
      unknownSenderPolicy: 'request_approval',
      deniedAt: null,
      createdAt: '2026-04-20T10:00:00Z',
      wiredAgents: [
        {
          messagingGroupAgentId: 'mga_1',
          agentGroupId: 'ag_1',
          agentGroupFolder: 'main',
          agentGroupName: 'Main',
          engageMode: 'mention',
          engagePattern: null,
          senderScope: 'unrestricted',
          ignoredMessagePolicy: 'drop',
          priority: 0,
          createdAt: '2026-04-20T10:00:00Z',
        },
      ],
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { messagingGroup: view }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    const result = await api.getMessagingGroupDetail('mg_x');
    expect(result).toEqual(view);
  });
});

describe('wireChannelToGroup — body contract with server', () => {
  // Server keys on `channelType` (matches DB column + WireDmInput). Helper
  // accepts `channel` for ergonomics; this test pins the wire boundary so
  // a future rename can't silently regress to "channelType must be …" 400s.
  it('serializes input.channel as channelType in the request body', async () => {
    const result = {
      messagingGroupId: 'mg_1',
      messagingGroupAgentId: 'mga_1',
      platformId: 'telegram:42',
      created: { messagingGroup: true, wiring: true },
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, result));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await api.wireChannelToGroup('forge', {
      channel: 'telegram',
      botId: '7654321',
      botUserId: '42',
      operatorUserId: '42',
      displayName: 'Forge DM',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      channelType: 'telegram',
      botId: '7654321',
      botUserId: '42',
      operatorUserId: '42',
      displayName: 'Forge DM',
    });
    expect(body.channel).toBeUndefined();
  });
});

describe('channel-wire helpers — pinned to /channels/mga/:id', () => {
  // PR3 disambiguates per-MG and per-MGA detail under prefixed paths. Pin
  // the helper paths so a future refactor can't silently fall back to the
  // single-segment `/channels/:id` shape that PR3 deleted.
  function wireView(over: Partial<import('./api.ts').ChannelWireView> = {}): import('./api.ts').ChannelWireView {
    return {
      id: 'mga_1',
      channelType: 'telegram',
      messagingGroupId: 'mg_1',
      platformId: 'telegram:42:1',
      displayName: null,
      agentGroupId: 'ag_1',
      agentGroupFolder: 'main',
      agentGroupName: 'Main',
      engageMode: 'mention',
      engagePattern: null,
      senderScope: 'unrestricted',
      ignoredMessagePolicy: 'drop',
      priority: 0,
      createdAt: '2026-04-20T10:00:00Z',
      ...over,
    };
  }

  it('getChannelWireDetail GETs /channels/mga/:id and unwraps { wire }', async () => {
    const view = wireView({ id: 'mga_x', engageMode: 'all' });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { wire: view }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    const result = await api.getChannelWireDetail('mga_x');

    expect(result).toEqual(view);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/channels\/mga\/mga_x$/);
    expect((init as RequestInit).method ?? 'GET').toBe('GET');
  });

  it('updateChannelWire PATCHes /channels/mga/:id with the input body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { wire: wireView({ engageMode: 'all' }) }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await api.updateChannelWire('mga_1', { engageMode: 'all', priority: 3 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/channels\/mga\/mga_1$/);
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ engageMode: 'all', priority: 3 });
  });

  it('deleteChannelWire DELETEs /channels/mga/:id', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { id: 'mga_1', deleted: true }));
    vi.stubGlobal('fetch', fetchMock);

    const api = await import('./api.ts');
    await api.deleteChannelWire('mga_1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toMatch(/\/api\/channels\/mga\/mga_1$/);
    expect((init as RequestInit).method).toBe('DELETE');
  });
});
