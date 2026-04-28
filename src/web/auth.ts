/**
 * Hub-issued JWT validation. Paraclaw's web server as resource server: trusts
 * tokens that the hub signs against keys we fetch from `/.well-known/jwks.json`.
 *
 * Shape mirrors `parachute-vault/src/hub-jwt.ts` deliberately — same trust
 * model, same load-bearing checks (`iss` strict; `aud` parsed not enforced).
 * The shared scope-guard library proposed in cli#59 will eventually absorb
 * both.
 *
 * Hub origin resolution: `PARACLAW_HUB_ORIGIN` (test override) →
 * `PARACHUTE_HUB_ORIGIN` (the hub lifecycle stamps this on every spawned
 * service — see `parachute-hub/src/commands/lifecycle.ts`) → loopback
 * `http://127.0.0.1:1939`. We intentionally do NOT read services.json —
 * the hub is the dispatcher, not a registered service in that file
 * (matching vault's choice). Tailnet-served paraclaw must see the hub's
 * tailnet origin or `iss` mismatch rejects every JWT.
 *
 * Scope vocabulary introduced here: `claw:read` / `claw:write` / `claw:admin`
 * with `admin ⊇ write ⊇ read` inheritance per
 * `parachute-patterns/patterns/oauth-scopes.md`. `vault:admin` is the
 * operator-token catch-all and satisfies any claw scope check (operator
 * token is what local CLI/scripts present; it carries `vault:admin` per
 * `parachute-hub/src/operator-token.ts`).
 */
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

const DEFAULT_HUB_LOOPBACK = 'http://127.0.0.1:1939';

export const SCOPE_CLAW_READ = 'claw:read' as const;
export const SCOPE_CLAW_WRITE = 'claw:write' as const;
export const SCOPE_CLAW_ADMIN = 'claw:admin' as const;
export const SCOPE_VAULT_ADMIN = 'vault:admin' as const;

export type ClawScope = typeof SCOPE_CLAW_READ | typeof SCOPE_CLAW_WRITE | typeof SCOPE_CLAW_ADMIN;

export function getHubOrigin(): string {
  const override = process.env.PARACLAW_HUB_ORIGIN?.replace(/\/$/, '');
  if (override && override.length > 0) return override;
  const fromHub = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, '');
  if (fromHub && fromHub.length > 0) return fromHub;
  return DEFAULT_HUB_LOOPBACK;
}

export interface HubJwtClaims {
  sub: string;
  scopes: string[];
  aud: string | undefined;
  jti: string | undefined;
  clientId: string | undefined;
}

export class HubJwtError extends Error {
  override name = 'HubJwtError';
}

type JwksGetter = ReturnType<typeof createRemoteJWKSet>;
let cachedGetter: JwksGetter | null = null;
let cachedOrigin: string | null = null;

function getJwksGetter(origin: string): JwksGetter {
  if (cachedGetter && cachedOrigin === origin) return cachedGetter;
  cachedGetter = createRemoteJWKSet(new URL(`${origin}/.well-known/jwks.json`), {
    cacheMaxAge: 5 * 60 * 1000,
    cooldownDuration: 30 * 1000,
  });
  cachedOrigin = origin;
  return cachedGetter;
}

export function resetJwksCache(): void {
  cachedGetter = null;
  cachedOrigin = null;
}

/**
 * Verify a presented JWT against the hub's JWKS. Throws `HubJwtError` on any
 * failure. The `iss` claim MUST equal the configured hub origin — load-bearing
 * trust check; without it, anyone could mint a token against any RSA key and
 * pass verification.
 */
export async function validateHubJwt(token: string): Promise<HubJwtClaims> {
  const origin = getHubOrigin();
  const getter = getJwksGetter(origin);

  let payload: JWTPayload;
  try {
    const verified = await jwtVerify(token, getter, { issuer: origin });
    payload = verified.payload;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HubJwtError(`hub JWT verification failed: ${msg}`);
  }

  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new HubJwtError('hub JWT missing required `sub` claim');
  }

  const scopeRaw = (payload as { scope?: unknown }).scope;
  const scopes = typeof scopeRaw === 'string' ? parseScopes(scopeRaw) : [];
  const aud = typeof payload.aud === 'string' ? payload.aud : undefined;
  const jti = typeof payload.jti === 'string' ? payload.jti : undefined;
  const clientIdRaw = (payload as { client_id?: unknown }).client_id;
  const clientId = typeof clientIdRaw === 'string' ? clientIdRaw : undefined;

  return { sub: payload.sub, scopes, aud, jti, clientId };
}

export function parseScopes(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does `granted` satisfy `required`?
 *
 * Inheritance rules:
 *   - `claw:admin` ⊇ `claw:write` ⊇ `claw:read`
 *   - `vault:admin` (operator-token catch-all) satisfies every `claw:*`
 *   - `hub:admin` does NOT — narrow boundary; admins of the hub identity
 *     surface aren't implicitly admins of every resource server.
 */
export function hasScope(granted: string[], required: ClawScope): boolean {
  if (granted.includes(required)) return true;
  if (granted.includes(SCOPE_VAULT_ADMIN)) return true;
  if (required === SCOPE_CLAW_READ) {
    return granted.includes(SCOPE_CLAW_WRITE) || granted.includes(SCOPE_CLAW_ADMIN);
  }
  if (required === SCOPE_CLAW_WRITE) {
    return granted.includes(SCOPE_CLAW_ADMIN);
  }
  return false;
}

export interface AuthOk {
  ok: true;
  claims: HubJwtClaims;
}
export interface AuthFail {
  ok: false;
  status: 401 | 403;
  error: string;
  errorType?: 'insufficient_scope';
  requiredScope?: ClawScope;
  grantedScopes?: string[];
}
export type AuthResult = AuthOk | AuthFail;

function extractBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = header.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Single seam every `/api/*` handler runs through. Pulls `Authorization:
 * Bearer <jwt>` off the request, validates it, checks scope. Returns
 * structured pass/fail rather than throwing so callers can shape the
 * response uniformly (RFC-6749-style 403 body for insufficient_scope).
 */
export async function authenticate(authHeader: string | undefined, required: ClawScope): Promise<AuthResult> {
  const token = extractBearer(authHeader);
  if (!token) {
    return { ok: false, status: 401, error: 'missing or malformed Authorization header' };
  }
  let claims: HubJwtClaims;
  try {
    claims = await validateHubJwt(token);
  } catch (err) {
    return {
      ok: false,
      status: 401,
      error: err instanceof HubJwtError ? err.message : 'token validation failed',
    };
  }
  if (!hasScope(claims.scopes, required)) {
    return {
      ok: false,
      status: 403,
      error: `This endpoint requires the '${required}' scope.`,
      errorType: 'insufficient_scope',
      requiredScope: required,
      grantedScopes: claims.scopes,
    };
  }
  return { ok: true, claims };
}
