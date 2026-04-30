/**
 * Coverage for the JWT-forwarding helper that paraclaw uses to call vault
 * REST endpoints with the operator's hub-issued session JWT
 * (`docs/design/2026-04-29-vault-management-ui.md` § Admin auth model).
 *
 * The contract under test: pass through the Authorization header verbatim,
 * surface vault status codes verbatim (401/403 must reach the browser so it
 * can trigger an OAuth consent flow), parse JSON bodies, and turn network
 * failures into a 502 — never a thrown exception, because the route handler
 * mirrors `result.status` to the browser unmodified.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearHubDiscoveryCache } from './hub-discovery.js';
import { forwardToVault, mintVaultTokenHttp, resolveVaultBaseUrl } from './vault-proxy.js';

let prevHub: string | undefined;

beforeEach(() => {
  prevHub = process.env.PARACHUTE_HUB_ORIGIN;
  delete process.env.PARACLAW_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.example';
  clearHubDiscoveryCache();
});

afterEach(() => {
  if (prevHub === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHub;
  clearHubDiscoveryCache();
});

function jsonResponse(status: number, body: unknown): Response {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

describe('forwardToVault', () => {
  it('GETs the right URL with the operator JWT', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { tokens: [] }));
    const result = await forwardToVault({
      method: 'GET',
      vaultBaseUrl: 'https://h/vault/work',
      subpath: '/tokens',
      authHeader: 'Bearer the-jwt',
      fetchImpl,
    });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ tokens: [] });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://h/vault/work/tokens',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer the-jwt',
          Accept: 'application/json',
        }),
      }),
    );
  });

  it('POSTs JSON body with content-type header', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: 't_abc', token: 'pvt_x' }));
    await forwardToVault({
      method: 'POST',
      vaultBaseUrl: 'https://h/vault/work',
      subpath: '/tokens',
      authHeader: 'Bearer x',
      body: { label: 'test', scopes: ['vault:read'] },
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://h/vault/work/tokens',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ label: 'test', scopes: ['vault:read'] }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('strips a trailing slash off vaultBaseUrl so subpath joins cleanly', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));
    await forwardToVault({
      method: 'GET',
      vaultBaseUrl: 'https://h/vault/work/',
      subpath: '/tokens',
      authHeader: 'Bearer x',
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://h/vault/work/tokens', expect.anything());
  });

  it('mirrors a 401 from the vault — caller surfaces it for consent prompt', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { error: 'missing vault:work:admin' }));
    const result = await forwardToVault({
      method: 'GET',
      vaultBaseUrl: 'https://h/vault/work',
      subpath: '/tokens',
      authHeader: 'Bearer x',
      fetchImpl,
    });
    expect(result.status).toBe(401);
    expect(result.body).toEqual({ error: 'missing vault:work:admin' });
  });

  it('returns a 502 with structured body when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const result = await forwardToVault({
      method: 'GET',
      vaultBaseUrl: 'https://h/vault/work',
      subpath: '/tokens',
      authHeader: 'Bearer x',
      fetchImpl,
    });
    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ error: expect.stringContaining('ECONNREFUSED') });
  });

  it('handles a non-JSON body without throwing', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<!DOCTYPE html>504 from edge', { status: 504 }));
    const result = await forwardToVault({
      method: 'GET',
      vaultBaseUrl: 'https://h/vault/work',
      subpath: '/tokens',
      authHeader: 'Bearer x',
      fetchImpl,
    });
    expect(result.status).toBe(504);
    expect(result.body).toMatchObject({ error: expect.stringContaining('non-JSON') });
  });

  it('handles an empty body by returning null', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 200 }));
    const result = await forwardToVault({
      method: 'DELETE',
      vaultBaseUrl: 'https://h/vault/work',
      subpath: '/tokens/t_abc',
      authHeader: 'Bearer x',
      fetchImpl,
    });
    expect(result.status).toBe(200);
    expect(result.body).toBeNull();
  });
});

describe('resolveVaultBaseUrl', () => {
  it('returns the hub-published URL when the name matches', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        vaults: [
          { name: 'work', url: 'https://h/vault/work', version: '0.4.7' },
          { name: 'personal', url: 'https://h/vault/personal/', version: '0.4.7' },
        ],
      }),
    );
    expect(await resolveVaultBaseUrl('work', fetchImpl)).toBe('https://h/vault/work');
  });

  it('strips trailing slash from the hub-published URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        vaults: [{ name: 'personal', url: 'https://h/vault/personal/', version: '0.4.7' }],
      }),
    );
    expect(await resolveVaultBaseUrl('personal', fetchImpl)).toBe('https://h/vault/personal');
  });

  it('returns null when the vault name is unknown', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { vaults: [] }));
    expect(await resolveVaultBaseUrl('ghost', fetchImpl)).toBeNull();
  });
});

describe('mintVaultTokenHttp', () => {
  it('POSTs to /tokens with label + scopes + null expires_at', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: 't_x', token: 'pvt_x' }));
    const result = await mintVaultTokenHttp({
      vaultBaseUrl: 'https://h/vault/work',
      authHeader: 'Bearer x',
      label: 'claw-personal',
      scopes: ['vault:read', 'vault:write'],
      fetchImpl,
    });
    expect(result.status).toBe(201);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://h/vault/work/tokens',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          label: 'claw-personal',
          scopes: ['vault:read', 'vault:write'],
          expires_at: null,
        }),
      }),
    );
  });

  it('passes expires_at through when provided', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: 't_x', token: 'pvt_x' }));
    await mintVaultTokenHttp({
      vaultBaseUrl: 'https://h/vault/work',
      authHeader: 'Bearer x',
      label: 'short-lived',
      scopes: ['vault:read'],
      expiresAt: '2026-12-31T00:00:00Z',
      fetchImpl,
    });
    const callArgs = fetchImpl.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(callArgs.body)).toMatchObject({ expires_at: '2026-12-31T00:00:00Z' });
  });
});
