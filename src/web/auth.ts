/**
 * Hub-issued JWT validation. Parachute-agent's web server as resource server:
 * trusts tokens that the hub signs against keys we fetch from the hub's
 * `/.well-known/jwks.json`, and rejects tokens whose `jti` appears on the
 * hub's `/.well-known/parachute-revocation.json` list.
 *
 * The trust kernel — JWKS fetch + verify, issuer pin, RFC 7519 string-or-array
 * `aud` handling, revocation-list cache + fail-closed cold-start — lives in
 * the shared `@openparachute/scope-guard` library so vault, scribe, and
 * parachute-agent can't silently drift on the worst place to drift. This
 * file is the agent-side adapter: hub-origin resolution (env-var precedence
 * + loopback fallback), agent-specific scope vocabulary
 * (`agent:read`/`agent:write`/`agent:admin` + `vault:admin` catch-all + legacy
 * `claw:*` normalization), and the `authenticate()` seam every `/api/*`
 * handler runs through.
 *
 * Hub origin resolution: `PARACHUTE_AGENT_HUB_ORIGIN` (test override; legacy
 * `PARACLAW_HUB_ORIGIN` accepted through 0.1.x with a one-shot warning) →
 * `PARACHUTE_HUB_ORIGIN` (the hub lifecycle stamps this on every spawned
 * service — see `parachute-hub/src/commands/lifecycle.ts`) → loopback
 * `http://127.0.0.1:1939`. We intentionally do NOT read services.json —
 * the hub is the dispatcher, not a registered service in that file
 * (matching vault and scribe). Tailnet-served parachute-agent must see the
 * hub's tailnet origin or `iss` mismatch rejects every JWT.
 *
 * Scope vocabulary: `agent:read` / `agent:write` / `agent:admin` with
 * `admin ⊇ write ⊇ read` inheritance per
 * `parachute-patterns/patterns/oauth-scopes.md`. `vault:admin` is the
 * operator-token catch-all and satisfies any agent scope check (operator
 * token is what local CLI/scripts present; it carries `vault:admin` per
 * `parachute-hub/src/operator-token.ts`).
 *
 * Pre-0.1.0 compat: hub-issued tokens may still carry `claw:*` scopes for
 * one cycle. `hasScope` normalizes legacy `claw:*` to `agent:*` so callers
 * with grandfathered grants keep working. Drop the compat normalization in
 * 0.2.0 (tracked as a follow-up at PR open time).
 */
import { createScopeGuard, HubJwtError, type HubJwtClaims } from '@openparachute/scope-guard';

import { readEnvWithLegacy } from '../env.js';

const DEFAULT_HUB_LOOPBACK = 'http://127.0.0.1:1939';

export const SCOPE_AGENT_READ = 'agent:read' as const;
export const SCOPE_AGENT_WRITE = 'agent:write' as const;
export const SCOPE_AGENT_ADMIN = 'agent:admin' as const;
export const SCOPE_VAULT_ADMIN = 'vault:admin' as const;

export type AgentScope = typeof SCOPE_AGENT_READ | typeof SCOPE_AGENT_WRITE | typeof SCOPE_AGENT_ADMIN;

/**
 * Pre-0.1.0 compat: map legacy `claw:*` scope grants to their `agent:*`
 * equivalents so hub-issued tokens minted before the rename keep working.
 * Drop in 0.2.0.
 */
const LEGACY_SCOPE_MAP: Record<string, string> = {
  'claw:read': SCOPE_AGENT_READ,
  'claw:write': SCOPE_AGENT_WRITE,
  'claw:admin': SCOPE_AGENT_ADMIN,
};
function normalizeGranted(s: string): string {
  return LEGACY_SCOPE_MAP[s] ?? s;
}

export function getHubOrigin(): string {
  const override = readEnvWithLegacy('PARACHUTE_AGENT_HUB_ORIGIN', 'PARACLAW_HUB_ORIGIN')?.replace(/\/$/, '');
  if (override && override.length > 0) return override;
  const fromHub = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, '');
  if (fromHub && fromHub.length > 0) return fromHub;
  return DEFAULT_HUB_LOOPBACK;
}

// Process-wide guard. The resolver form lets tests flip env vars between
// cases — scope-guard re-resolves on every `validateHubJwt` and
// `resetJwksCache` call so the env-var change picks up without a server
// restart. JWKS cache (5min/30s defaults) and revocation cache (60s default)
// live inside the guard, shared across requests.
const guard = createScopeGuard({ hubOrigin: () => getHubOrigin() });

export type { HubJwtClaims };
export { HubJwtError };

/**
 * Verify a presented JWT against the hub's JWKS + revocation list. Throws
 * `HubJwtError` (with a `code`) on any failure. The `iss` claim MUST equal
 * the configured hub origin — load-bearing trust check; without it, anyone
 * could mint a token against any RSA key and pass verification. Revocation
 * runs LAST: cheap checks (signature, iss, expiry) reject first, so a bad
 * signature never costs a network roundtrip.
 */
export async function validateHubJwt(token: string): Promise<HubJwtClaims> {
  return guard.validateHubJwt(token);
}

/**
 * Reset the cached JWKS getter. Tests use this to switch origins between
 * cases; production callers shouldn't need it (origin is process-stable).
 */
export function resetJwksCache(): void {
  guard.resetJwksCache();
}

/**
 * Reset the cached revocation list. Tests use this to start from a clean
 * fail-closed state between cases; production callers shouldn't need it
 * (the cache refreshes itself on TTL expiry).
 */
export function resetRevocationCache(): void {
  guard.resetRevocationCache();
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
 *   - `agent:admin` ⊇ `agent:write` ⊇ `agent:read`
 *   - `vault:admin` (operator-token catch-all) satisfies every `agent:*`
 *   - `hub:admin` does NOT — narrow boundary; admins of the hub identity
 *     surface aren't implicitly admins of every resource server.
 *   - Legacy `claw:*` grants are normalized to `agent:*` (pre-0.1.0 compat;
 *     drop in 0.2.0).
 */
export function hasScope(granted: string[], required: AgentScope): boolean {
  const normalized = granted.map(normalizeGranted);
  if (normalized.includes(required)) return true;
  if (normalized.includes(SCOPE_VAULT_ADMIN)) return true;
  if (required === SCOPE_AGENT_READ) {
    return normalized.includes(SCOPE_AGENT_WRITE) || normalized.includes(SCOPE_AGENT_ADMIN);
  }
  if (required === SCOPE_AGENT_WRITE) {
    return normalized.includes(SCOPE_AGENT_ADMIN);
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
  requiredScope?: AgentScope;
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
 *
 * Revocation-related codes get sanitized client messages: server-side
 * audit log carries the full diagnostic (jti for `revoked`,
 * implementation-detail phrasing for `revocation_unavailable`); the
 * unauthenticated caller gets a code-shaped sentence with no internals.
 * Inheritable pattern across vault/scribe/agent — all revocation-related
 * codes get sanitized client messages, full detail lives in server-side
 * audit logs. Other HubJwtError codes (signature, audience, expired, etc.)
 * carry generic messages and are forwarded as-is.
 */
export async function authenticate(authHeader: string | undefined, required: AgentScope): Promise<AuthResult> {
  const token = extractBearer(authHeader);
  if (!token) {
    return { ok: false, status: 401, error: 'missing or malformed Authorization header' };
  }
  let claims: HubJwtClaims;
  try {
    claims = await validateHubJwt(token);
  } catch (err) {
    if (err instanceof HubJwtError) {
      if (err.code === 'revoked') {
        console.warn(`[agent-auth] hub JWT rejected: ${err.message}`);
        return { ok: false, status: 401, error: 'token has been revoked' };
      }
      if (err.code === 'revocation_unavailable') {
        console.warn(`[agent-auth] hub JWT rejected: ${err.message}`);
        return {
          ok: false,
          status: 401,
          error: 'token cannot be validated: revocation list unavailable',
        };
      }
      return { ok: false, status: 401, error: err.message };
    }
    return { ok: false, status: 401, error: 'token validation failed' };
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
