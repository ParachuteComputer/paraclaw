/**
 * OAuth 2.0 client for the Paraclaw web UI. The hub is the authorization
 * server (parachute-patterns/patterns/hub-as-issuer.md):
 *
 *   1. GET  /api/discovery           — returns `{ hubOrigin }` so the bundle
 *                                       doesn't bake the origin in.
 *   2. POST <hub>/oauth/register      — RFC 7591 DCR; we cache the client_id
 *                                       in localStorage keyed by hub origin.
 *   3. GET  <hub>/oauth/authorize     — PKCE-S256, redirect-back.
 *   4. <app>/oauth/callback           — code + state; we exchange for tokens.
 *   5. POST <hub>/oauth/token         — authorization_code, then refresh_token
 *                                       on 401 from /api/* before re-login.
 *
 * Scopes: `claw:admin claw:write vault:read vault:write`. `claw:admin` is
 * required for /api/secrets writes + the setup wizard install-channel
 * step; `claw:write` is the bar for /api/approvals decisions and
 * /api/sessions/:id/close. The vault scopes anticipate the vault tokens-API
 * REST endpoint (paraclaw#4 companion vault issue); today the server still
 * shells out, but minting the user JWT with vault:* now means no re-consent
 * later.
 *
 * Existing users with cached tokens that lack a newly-required scope will
 * hit 403 with a body like `requires the X scope`. The api.ts wrapper
 * detects that shape and triggers re-auth (clearTokens + beginLogin) so
 * upgrades don't strand users behind a manual `localStorage.clear()`.
 * (paraclaw#33)
 */
interface DiscoveryResponse {
  hubOrigin: string;
}

interface ClientRecord {
  client_id: string;
}

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch seconds
}

interface FlowState {
  verifier: string;
  state: string;
  redirect_uri: string;
  hub_origin: string;
}

const REQUESTED_SCOPES = "claw:admin claw:write vault:read vault:write";
const DISCOVERY_KEY = "paraclaw.discovery";
const FLOW_KEY = "paraclaw.flow";

function clientKey(hubOrigin: string): string {
  return `paraclaw.client.${hubOrigin}`;
}
function tokensKey(hubOrigin: string): string {
  return `paraclaw.tokens.${hubOrigin}`;
}

function readJson<T>(storage: Storage, key: string): T | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    storage.removeItem(key);
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown): void {
  storage.setItem(key, JSON.stringify(value));
}

function getRedirectUri(): string {
  // Vite's BASE_URL has a trailing slash (`/` or `/claw/`), so the join
  // yields `http://host/oauth/callback` or `http://host/claw/oauth/callback`.
  return `${window.location.origin}${import.meta.env.BASE_URL}oauth/callback`;
}

async function getDiscovery(): Promise<DiscoveryResponse> {
  const cached = readJson<DiscoveryResponse>(localStorage, DISCOVERY_KEY);
  if (cached) return cached;
  // Fetch raw — discovery is unauthenticated, and routing it through the API
  // wrapper would create a bootstrap dep cycle (api ↔ auth). Mount-aware:
  // BASE_URL prepended so the request hits paraclaw under /claw/ on tailnet
  // rather than the hub origin's root (which 404s on /api/discovery).
  const url = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/discovery`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`${url} failed: ${res.status}`);
  const fresh = (await res.json()) as DiscoveryResponse;
  writeJson(localStorage, DISCOVERY_KEY, fresh);
  return fresh;
}

async function ensureClient(hubOrigin: string): Promise<string> {
  const cached = readJson<ClientRecord>(localStorage, clientKey(hubOrigin));
  if (cached?.client_id) return cached.client_id;
  const redirectUri = getRedirectUri();
  const res = await fetch(`${hubOrigin}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      scope: REQUESTED_SCOPES,
      client_name: "Paraclaw web UI",
      token_endpoint_auth_method: "none",
    }),
  });
  if (!res.ok) {
    throw new Error(`hub /oauth/register failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { client_id: string };
  writeJson(localStorage, clientKey(hubOrigin), { client_id: body.client_id });
  return body.client_id;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return new Uint8Array(digest);
}

async function makePkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(await sha256(verifier));
  return { verifier, challenge };
}

/** Kick off the OAuth dance. Top-level navigation; never returns. */
export async function beginLogin(): Promise<never> {
  const { hubOrigin } = await getDiscovery();
  const clientId = await ensureClient(hubOrigin);
  const { verifier, challenge } = await makePkcePair();
  const state = base64UrlEncode(randomBytes(16));
  const redirectUri = getRedirectUri();
  const flow: FlowState = {
    verifier,
    state,
    redirect_uri: redirectUri,
    hub_origin: hubOrigin,
  };
  writeJson(sessionStorage, FLOW_KEY, flow);
  const u = new URL(`${hubOrigin}/oauth/authorize`);
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", REQUESTED_SCOPES);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", state);
  window.location.replace(u.toString());
  // Block until navigation actually happens — callers expect this never
  // returns control.
  return new Promise<never>(() => {});
}

/**
 * Exchange `code` for tokens. Throws on any failure (state mismatch, hub
 * error, missing flow). Callers should catch + show the error and offer a
 * retry that calls beginLogin().
 */
export async function handleCallback(params: URLSearchParams): Promise<void> {
  const flow = readJson<FlowState>(sessionStorage, FLOW_KEY);
  if (!flow) throw new Error("no in-flight OAuth flow — restart sign-in");
  sessionStorage.removeItem(FLOW_KEY);
  const err = params.get("error");
  if (err) {
    throw new Error(`hub returned OAuth error: ${err} — ${params.get("error_description") ?? ""}`);
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) throw new Error("hub callback missing code or state");
  if (state !== flow.state) throw new Error("OAuth state mismatch — possible CSRF");
  const clientId = readJson<ClientRecord>(localStorage, clientKey(flow.hub_origin))?.client_id;
  if (!clientId) throw new Error("client registration missing — restart sign-in");
  const tokens = await postToken(flow.hub_origin, {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: flow.redirect_uri,
    code_verifier: flow.verifier,
  });
  storeTokens(flow.hub_origin, tokens);
}

async function postToken(
  hubOrigin: string,
  form: Record<string, string>,
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) body.set(k, v);
  const res = await fetch(`${hubOrigin}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`hub /oauth/token failed: ${res.status} ${txt}`);
  }
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
}

function storeTokens(
  hubOrigin: string,
  t: { access_token: string; refresh_token: string; expires_in: number },
): void {
  const expires_at = Math.floor(Date.now() / 1000) + t.expires_in;
  const ts: TokenSet = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at,
  };
  writeJson(localStorage, tokensKey(hubOrigin), ts);
}

function readTokens(hubOrigin: string): TokenSet | null {
  return readJson<TokenSet>(localStorage, tokensKey(hubOrigin));
}

/**
 * Returns the current access token if we have one for the cached hub
 * origin, regardless of expiry — the API wrapper handles 401-refresh. If
 * we don't even have discovery yet, returns null (caller should prompt
 * login).
 */
export function getAccessToken(): string | null {
  const disc = readJson<DiscoveryResponse>(localStorage, DISCOVERY_KEY);
  if (!disc) return null;
  return readTokens(disc.hubOrigin)?.access_token ?? null;
}

/**
 * Refresh the access token using the stored refresh token. Returns the
 * new access token, or null if refresh isn't possible (no refresh, hub
 * rejected). Caller should fall back to beginLogin() on null.
 */
export async function refreshAccessToken(): Promise<string | null> {
  const disc = readJson<DiscoveryResponse>(localStorage, DISCOVERY_KEY);
  if (!disc) return null;
  const tokens = readTokens(disc.hubOrigin);
  if (!tokens?.refresh_token) return null;
  const clientId = readJson<ClientRecord>(localStorage, clientKey(disc.hubOrigin))?.client_id;
  if (!clientId) return null;
  try {
    const fresh = await postToken(disc.hubOrigin, {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });
    storeTokens(disc.hubOrigin, fresh);
    return fresh.access_token;
  } catch {
    return null;
  }
}

/** Drop tokens; keeps discovery + client_id (DCR is one-shot per origin). */
export function clearTokens(): void {
  const disc = readJson<DiscoveryResponse>(localStorage, DISCOVERY_KEY);
  if (!disc) return;
  localStorage.removeItem(tokensKey(disc.hubOrigin));
}
