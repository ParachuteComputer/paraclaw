/**
 * Route-level tests for `/api/vaults*`. The proxy primitives are exercised
 * in `src/web/vault-proxy.test.ts`; this file covers the dispatcher in
 * `routes/vaults.ts` — URL pattern matching, the attached-to-group merge
 * by tokenLabel, vault-not-found 404s, and refresh-cache invalidation.
 *
 * Strategy: stub global `fetch` for the HTTP calls (vault REST + hub
 * well-known), and `vi.mock` the DB/attachment readers so the test
 * doesn't need a real central DB or filesystem groups dir.
 */
import http from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearHubDiscoveryCache } from '../hub-discovery.js';

vi.mock('../../db/connection.js', () => ({
  openDb: () => ({
    prepare: () => ({ all: () => [{ folder: 'group-a' }, { folder: 'group-b' }] }),
    close: () => {},
  }),
}));

vi.mock('../../parachute/vault-mcp.js', () => ({
  listVaultAttachments: vi.fn(() => []),
}));

import { listVaultAttachments } from '../../parachute/vault-mcp.js';
import { handleVaultsRoute } from './vaults.js';

const mockedListVaultAttachments = listVaultAttachments as unknown as ReturnType<typeof vi.fn>;

let prevHub: string | undefined;

beforeEach(() => {
  prevHub = process.env.PARACHUTE_HUB_ORIGIN;
  delete process.env.PARACLAW_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.example';
  clearHubDiscoveryCache();
  mockedListVaultAttachments.mockReset();
  mockedListVaultAttachments.mockReturnValue([]);
});

afterEach(() => {
  if (prevHub === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHub;
  clearHubDiscoveryCache();
  vi.unstubAllGlobals();
});

interface FakeResponse {
  statusCode: number;
  body: unknown;
  headers: Record<string, string>;
  res: http.ServerResponse;
}

function fakeRes(): FakeResponse {
  const captured: FakeResponse = {
    statusCode: 0,
    body: undefined,
    headers: {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    res: undefined as any,
  };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      captured.statusCode = status;
      captured.headers = headers;
    },
    end(chunk: string) {
      try {
        captured.body = chunk ? JSON.parse(chunk) : undefined;
      } catch {
        captured.body = chunk;
      }
    },
  } as unknown as http.ServerResponse;
  captured.res = res;
  return captured;
}

function fakeReq(body?: unknown): http.IncomingMessage {
  if (body === undefined) {
    return Object.assign(Object.create(null), {
      [Symbol.asyncIterator]: async function* () {},
    }) as http.IncomingMessage;
  }
  const buf = Buffer.from(JSON.stringify(body));
  return Object.assign(Object.create(null), {
    [Symbol.asyncIterator]: async function* () {
      yield buf;
    },
  }) as http.IncomingMessage;
}

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Each call returns a fresh Response — Response bodies are single-use. */
function alwaysOk(body: unknown, status = 200) {
  return vi.fn().mockImplementation(async () => jsonOk(body, status));
}

const HUB_VAULTS_BODY = {
  vaults: [
    { name: 'work', url: 'https://h/vault/work', version: '0.4.7' },
    { name: 'personal', url: 'https://h/vault/personal', version: '0.4.7' },
  ],
};

describe('handleVaultsRoute', () => {
  it('GET /api/vaults returns the hub well-known list', async () => {
    vi.stubGlobal('fetch', alwaysOk(HUB_VAULTS_BODY));
    const cap = fakeRes();
    const handled = await handleVaultsRoute({
      pathname: '/api/vaults',
      method: 'GET',
      url: new URL('https://x/api/vaults'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(handled).toBe(true);
    expect(cap.statusCode).toBe(200);
    expect(cap.body).toEqual({ vaults: HUB_VAULTS_BODY.vaults });
  });

  it('POST /api/vaults/refresh clears the cache so the next call refetches', async () => {
    const stub = alwaysOk(HUB_VAULTS_BODY);
    vi.stubGlobal('fetch', stub);
    // Prime the cache via GET.
    await handleVaultsRoute({
      pathname: '/api/vaults',
      method: 'GET',
      url: new URL('https://x/api/vaults'),
      req: fakeReq(),
      res: fakeRes().res,
      authHeader: 'Bearer x',
    });
    expect(stub).toHaveBeenCalledTimes(1);
    // Same call — cache hit, no extra fetch.
    await handleVaultsRoute({
      pathname: '/api/vaults',
      method: 'GET',
      url: new URL('https://x/api/vaults'),
      req: fakeReq(),
      res: fakeRes().res,
      authHeader: 'Bearer x',
    });
    expect(stub).toHaveBeenCalledTimes(1);
    // Refresh forces a refetch.
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/refresh',
      method: 'POST',
      url: new URL('https://x/api/vaults/refresh'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(200);
    expect(stub).toHaveBeenCalledTimes(2);
  });

  it('GET /api/vaults/:name returns 404 when the vault is unknown', async () => {
    vi.stubGlobal('fetch', alwaysOk(HUB_VAULTS_BODY));
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/ghost',
      method: 'GET',
      url: new URL('https://x/api/vaults/ghost'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(404);
    expect(cap.body).toMatchObject({ error: expect.stringContaining('ghost') });
  });

  it('GET /api/vaults/:name surfaces attached groups via listVaultAttachments', async () => {
    vi.stubGlobal('fetch', alwaysOk(HUB_VAULTS_BODY));
    mockedListVaultAttachments.mockReturnValue([
      {
        folder: 'group-a',
        mcpName: 'parachute-vault',
        attachment: {
          vaultBaseUrl: 'https://h/vault/work',
          scope: 'vault:read',
          tokenLabel: 'claw-a',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
      {
        folder: 'group-b',
        mcpName: 'parachute-vault',
        attachment: {
          // Different vault — must not appear in the response.
          vaultBaseUrl: 'https://h/vault/personal',
          scope: 'vault:write',
          tokenLabel: 'claw-b',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
    ]);
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/work',
      method: 'GET',
      url: new URL('https://x/api/vaults/work'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(200);
    const body = cap.body as { vault: unknown; attachedGroups: Array<{ folder: string }> };
    expect(body.vault).toMatchObject({ name: 'work' });
    expect(body.attachedGroups).toHaveLength(1);
    expect(body.attachedGroups[0]).toMatchObject({ folder: 'group-a', tokenLabel: 'claw-a' });
  });

  it('GET /api/vaults/:name/tokens enriches each token with attachedTo by tokenLabel', async () => {
    const fetchStub = vi
      .fn()
      // 1st call: hub well-known (resolveVaultBaseUrl)
      .mockResolvedValueOnce(jsonOk(HUB_VAULTS_BODY))
      // 2nd call: vault GET /tokens
      .mockResolvedValueOnce(
        jsonOk({
          tokens: [
            { id: 't_1', label: 'claw-work', scopes: ['vault:read'] },
            { id: 't_2', label: 'orphan-token', scopes: ['vault:read'] },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchStub);
    mockedListVaultAttachments.mockReturnValue([
      {
        folder: 'group-a',
        mcpName: 'parachute-vault',
        attachment: {
          vaultBaseUrl: 'https://h/vault/work',
          scope: 'vault:read',
          tokenLabel: 'claw-work',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
    ]);

    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/work/tokens',
      method: 'GET',
      url: new URL('https://x/api/vaults/work/tokens'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer the-jwt',
    });
    expect(cap.statusCode).toBe(200);
    const body = cap.body as { tokens: Array<{ id: string; attachedTo: Array<{ folder: string }> }> };
    const claw = body.tokens.find((t) => t.id === 't_1');
    const orphan = body.tokens.find((t) => t.id === 't_2');
    expect(claw?.attachedTo).toEqual([{ folder: 'group-a', scope: 'vault:read' }]);
    expect(orphan?.attachedTo).toEqual([]);
    // Vault was hit with the operator's JWT verbatim.
    expect(fetchStub).toHaveBeenLastCalledWith(
      'https://h/vault/work/tokens',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer the-jwt' }),
      }),
    );
  });

  it('GET /api/vaults/:name/tokens mirrors a vault 401 verbatim (consent prompt path)', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(HUB_VAULTS_BODY))
      .mockResolvedValueOnce(jsonOk({ error: 'missing vault:work:admin' }, 401));
    vi.stubGlobal('fetch', fetchStub);
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/work/tokens',
      method: 'GET',
      url: new URL('https://x/api/vaults/work/tokens'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(401);
    expect(cap.body).toMatchObject({ error: 'missing vault:work:admin' });
  });

  it('POST /api/vaults/:name/tokens forwards body and mirrors the vault 201', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(HUB_VAULTS_BODY))
      .mockResolvedValueOnce(jsonOk({ id: 't_new', token: 'pvt_new', label: 'fresh' }, 201));
    vi.stubGlobal('fetch', fetchStub);
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/work/tokens',
      method: 'POST',
      url: new URL('https://x/api/vaults/work/tokens'),
      req: fakeReq({ label: 'fresh', scopes: ['vault:read'] }),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(201);
    expect(cap.body).toMatchObject({ id: 't_new' });
    const [, init] = fetchStub.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      label: 'fresh',
      scopes: ['vault:read'],
    });
  });

  it('POST /api/vaults/:name/tokens returns 400 on invalid JSON body', async () => {
    vi.stubGlobal('fetch', alwaysOk(HUB_VAULTS_BODY));
    const badReq = Object.assign(Object.create(null), {
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('{not-json');
      },
    }) as http.IncomingMessage;
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/work/tokens',
      method: 'POST',
      url: new URL('https://x/api/vaults/work/tokens'),
      req: badReq,
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(400);
  });

  it('DELETE /api/vaults/:name/tokens/:id forwards and mirrors the vault 200', async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(jsonOk(HUB_VAULTS_BODY))
      .mockResolvedValueOnce(jsonOk({ ok: true }));
    vi.stubGlobal('fetch', fetchStub);
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/work/tokens/t_abc123',
      method: 'DELETE',
      url: new URL('https://x/api/vaults/work/tokens/t_abc123'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(200);
    expect(fetchStub).toHaveBeenLastCalledWith(
      'https://h/vault/work/tokens/t_abc123',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns 404 for token routes when vault name is unknown', async () => {
    vi.stubGlobal('fetch', alwaysOk(HUB_VAULTS_BODY));
    const cap = fakeRes();
    await handleVaultsRoute({
      pathname: '/api/vaults/ghost/tokens',
      method: 'GET',
      url: new URL('https://x/api/vaults/ghost/tokens'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(cap.statusCode).toBe(404);
  });

  it('returns false for an unmatched path so the dispatcher falls through', async () => {
    const cap = fakeRes();
    const handled = await handleVaultsRoute({
      pathname: '/api/something-else',
      method: 'GET',
      url: new URL('https://x/api/something-else'),
      req: fakeReq(),
      res: cap.res,
      authHeader: 'Bearer x',
    });
    expect(handled).toBe(false);
  });
});
