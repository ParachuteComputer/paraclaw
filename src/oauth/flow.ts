/**
 * Provider-agnostic OAuth flow primitives.
 *
 *   1. `buildAuthorizeUrl` — assembles the redirect URL the user's
 *      browser hits to consent. Includes client_id, scope, state,
 *      redirect_uri, plus provider-specific extras (e.g. Google's
 *      `access_type=offline`).
 *   2. `exchangeCode` — POST to the token endpoint with the auth code
 *      from the callback. Returns the raw token payload.
 *   3. `fetchUserinfo` — pulls the provider's userinfo with the
 *      newly-minted access token; the caller passes it through
 *      `provider.extractAccount` to derive the row's `label` /
 *      `account_email` / `account_id`.
 *   4. `revokeToken` — best-effort; provider returning non-2xx is logged
 *      but doesn't block local row deletion.
 */
import { log } from '../log.js';
import type { ProviderSpec } from './providers/index.js';

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
}

export function buildAuthorizeUrl(opts: {
  provider: ProviderSpec;
  clientId: string;
  scopes: string;
  state: string;
  redirectUri: string;
}): string {
  const u = new URL(opts.provider.authUrl);
  u.searchParams.set('client_id', opts.clientId);
  u.searchParams.set('redirect_uri', opts.redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', opts.scopes || opts.provider.defaultScopes);
  u.searchParams.set('state', opts.state);
  for (const [k, v] of Object.entries(opts.provider.extraAuthParams ?? {})) {
    u.searchParams.set(k, v);
  }
  return u.toString();
}

export async function exchangeCode(opts: {
  provider: ProviderSpec;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
  });
  const res = await fetch(opts.provider.tokenUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange ${res.status}: ${text}`);
  }
  return (await res.json()) as TokenResponse;
}

export async function fetchUserinfo(opts: { provider: ProviderSpec; accessToken: string }): Promise<unknown> {
  const res = await fetch(opts.provider.userinfoUrl, {
    headers: { authorization: `Bearer ${opts.accessToken}`, accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`userinfo ${res.status}: ${text}`);
  }
  return await res.json();
}

/** Best-effort. Returns true on 2xx, false otherwise (and logs). */
export async function revokeToken(opts: { provider: ProviderSpec; accessToken: string }): Promise<boolean> {
  if (!opts.provider.revokeUrl) return false;
  try {
    const u = new URL(opts.provider.revokeUrl);
    u.searchParams.set('token', opts.accessToken);
    const res = await fetch(u.toString(), { method: 'POST' });
    if (!res.ok) {
      log.warn('oauth revoke non-2xx', { provider: opts.provider.slug, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.warn('oauth revoke failed', {
      provider: opts.provider.slug,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
