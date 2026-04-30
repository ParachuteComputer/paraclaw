/**
 * JWT-forwarding helper for paraclaw → vault HTTP calls.
 *
 * Per the chosen v1 admin auth model (Option C in
 * `docs/design/2026-04-29-vault-management-ui.md` § Admin auth model):
 * paraclaw forwards the *operator's* hub-issued session JWT to the vault
 * unmodified. The vault validates `vault:<name>:admin` against the hub's
 * JWKS — same path it uses for any hub-issued JWT — so paraclaw doesn't
 * downgrade or re-issue.
 *
 * The helper is intentionally thin: name → URL resolution lives in the
 * caller (route handlers do that via `fetchHubVaults()`); this just wraps
 * fetch with the right headers and surfaces vault errors as structured
 * results so the route handler can propagate the status verbatim.
 */
import { fetchHubVaults, type VaultListing, type FetchLike } from './hub-discovery.js';

export interface VaultProxyOpts {
  method: 'GET' | 'POST' | 'DELETE';
  /** Vault base URL, no trailing slash, no `/tokens` suffix. */
  vaultBaseUrl: string;
  /** Sub-path, must start with `/` (e.g. `/tokens`, `/tokens/t_abc123def456`). */
  subpath: string;
  /** Operator's `Authorization: Bearer <jwt>` header value, forwarded as-is. */
  authHeader: string;
  /** Optional JSON body — POST only. */
  body?: unknown;
  /** Test seam. */
  fetchImpl?: FetchLike;
}

export interface VaultProxyResult {
  status: number;
  body: unknown;
}

/**
 * Forward a request to a vault and return the parsed result. Network errors
 * surface as 502; HTTP errors come back with the vault's status so the route
 * handler can mirror it (a 401 from vault means the caller's JWT is missing
 * `vault:<name>:admin` — surface that to the browser to trigger consent).
 */
export async function forwardToVault(opts: VaultProxyOpts): Promise<VaultProxyResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${opts.vaultBaseUrl.replace(/\/+$/, '')}${opts.subpath}`;
  const headers: Record<string, string> = {
    Authorization: opts.authHeader,
    Accept: 'application/json',
  };
  const init: RequestInit = { method: opts.method, headers };
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  let res: Response;
  try {
    res = await fetchImpl(url, init);
  } catch (err) {
    return {
      status: 502,
      body: { error: `vault unreachable: ${err instanceof Error ? err.message : String(err)}` },
    };
  }
  let body: unknown = null;
  const text = await res.text();
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: `vault returned non-JSON: ${text.slice(0, 200)}` };
    }
  }
  return { status: res.status, body };
}

/**
 * Resolve a vault name to its hub-published base URL. Returns null if the
 * name doesn't match any registered vault — caller responds 404.
 *
 * The base URL is the well-known doc's `vault.url`, which is the
 * public-routable form (e.g. `https://hub.tail.../vault/<name>`). Strip
 * any trailing slash before returning so callers can append `/tokens`
 * etc. without double-slashing.
 */
export async function resolveVaultBaseUrl(name: string, fetchImpl?: FetchLike): Promise<string | null> {
  const vaults: VaultListing[] = await fetchHubVaults(fetchImpl);
  const hit = vaults.find((v) => v.name === name);
  if (!hit) return null;
  return hit.url.replace(/\/+$/, '');
}

/**
 * Mint a vault token via HTTP. Used both by the public `POST /api/vaults/
 * /:name/tokens` endpoint and by the legacy implicit-mint paths in
 * `/attach-vault` / `POST /api/groups` so the shell-out can go.
 *
 * Returns the vault's response verbatim (status + body) — the route handler
 * decides what to surface to the browser.
 */
export async function mintVaultTokenHttp(opts: {
  vaultBaseUrl: string;
  authHeader: string;
  label: string;
  scopes: string[];
  expiresAt?: string | null;
  fetchImpl?: FetchLike;
}): Promise<VaultProxyResult> {
  return forwardToVault({
    method: 'POST',
    vaultBaseUrl: opts.vaultBaseUrl,
    subpath: '/tokens',
    authHeader: opts.authHeader,
    body: {
      label: opts.label,
      scopes: opts.scopes,
      expires_at: opts.expiresAt ?? null,
    },
    fetchImpl: opts.fetchImpl,
  });
}
