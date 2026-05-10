/**
 * Hub-JWT validation + scope-check tests. Mirrors vault's hub-jwt.test.ts
 * shape but uses vitest + node:http (paraclaw's suite is vitest, not
 * bun:test). A fake JWKS endpoint signs locally with a known RSA keypair;
 * cases cover the spec failure modes plus paraclaw's agent-scope inheritance
 * + vault:admin catch-all + legacy `claw:*` compat normalization.
 *
 * Hub-side fixture serves BOTH `/.well-known/jwks.json` AND
 * `/.well-known/parachute-revocation.json` — single server, two endpoints,
 * mutable state flags. Pattern mirrors scribe's `auth-hub-jwt.test.ts` so
 * the three RS adopters share a fixture shape; agent's twist is node:http +
 * vitest in place of `Bun.serve` + bun:test. scope-guard's own unit suite
 * covers the cache mechanics (TTL refresh, fail-open with last-good,
 * single-flight); this file pins the agent-side wiring + the response-shape
 * contract.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  authenticate,
  getHubOrigin,
  hasScope,
  HubJwtError,
  resetJwksCache,
  resetRevocationCache,
  SCOPE_AGENT_ADMIN,
  SCOPE_AGENT_READ,
  SCOPE_AGENT_WRITE,
  SCOPE_VAULT_ADMIN,
  validateHubJwt,
} from './auth.js';

interface Keypair {
  // jose's generateKeyPair returns CryptoKey under WebCrypto; type narrowly to
  // avoid pulling in lib.dom.
  privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  publicJwk: { kty: string; n: string; e: string; kid: string; alg: string; use: string };
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: {
      kty: 'RSA',
      n: jwk.n!,
      e: jwk.e!,
      kid,
      alg: 'RS256',
      use: 'sig',
    },
    kid,
  };
}

interface HubFixture {
  origin: string;
  stop: () => Promise<void>;
  setKeys: (keys: Keypair[]) => void;
  /** When true, the JWKS endpoint returns 503 — exercises JWKS unreachable. */
  setJwksFails: (down: boolean) => void;
  /** Drive the revocation list contents; empty by default. */
  setRevoked: (jtis: string[]) => void;
  /** When true, the revocation endpoint returns 503 — exercises fail-closed. */
  setRevocationFails: (fails: boolean) => void;
}

function startHubFixture(): Promise<HubFixture> {
  return new Promise((resolve) => {
    let keys: Keypair[] = [];
    let jwksDown = false;
    let revokedJtis: string[] = [];
    let revocationFails = false;
    const server = http.createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        if (jwksDown) {
          res.writeHead(503).end('upstream down');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }));
        return;
      }
      if (req.url === '/.well-known/parachute-revocation.json') {
        if (revocationFails) {
          res.writeHead(503).end('hub down');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ generated_at: new Date().toISOString(), jtis: revokedJtis }));
        return;
      }
      res.writeHead(404).end('not found');
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${port}`,
        stop: () =>
          new Promise<void>((r) => {
            server.close(() => r());
          }),
        setKeys: (next) => {
          keys = next;
        },
        setJwksFails: (v) => {
          jwksDown = v;
        },
        setRevoked: (jtis) => {
          revokedJtis = jtis;
        },
        setRevocationFails: (v) => {
          revocationFails = v;
        },
      });
    });
  });
}

interface SignOpts {
  iss?: string;
  aud?: string;
  sub?: string;
  scope?: string;
  ttlSeconds?: number;
  expiresAtSeconds?: number;
  kid?: string;
  clientId?: string;
  /** Override the default jti — needed when a test wants to revoke this exact token. */
  jti?: string;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.expiresAtSeconds ?? iat + (opts.ttlSeconds ?? 60);
  return await new SignJWT({
    scope: opts.scope ?? 'agent:read',
    client_id: opts.clientId ?? 'test-client',
  })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? kp.kid })
    .setIssuer(opts.iss ?? 'http://issuer.invalid')
    .setSubject(opts.sub ?? 'user-1')
    .setAudience(opts.aud ?? 'hub')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(opts.jti ?? 'jti-1')
    .sign(kp.privateKey);
}

let fixture: HubFixture;
let kp: Keypair;
let prevHubOrigin: string | undefined;

beforeAll(async () => {
  fixture = await startHubFixture();
  kp = await makeKeypair('k1');
  fixture.setKeys([kp]);
});

afterAll(async () => {
  await fixture.stop();
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
  else process.env.PARACHUTE_AGENT_HUB_ORIGIN = prevHubOrigin;
});

beforeEach(() => {
  prevHubOrigin = process.env.PARACHUTE_AGENT_HUB_ORIGIN;
  process.env.PARACHUTE_AGENT_HUB_ORIGIN = fixture.origin;
  fixture.setJwksFails(false);
  fixture.setKeys([kp]);
  fixture.setRevoked([]);
  fixture.setRevocationFails(false);
  resetJwksCache();
  resetRevocationCache();
});

afterEach(() => {
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
  else process.env.PARACHUTE_AGENT_HUB_ORIGIN = prevHubOrigin;
  resetJwksCache();
  resetRevocationCache();
});

describe('validateHubJwt', () => {
  it('happy path — surfaces sub + scopes + clientId', async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: 'agent:read agent:write' });
    const claims = await validateHubJwt(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.scopes).toEqual(['agent:read', 'agent:write']);
    expect(claims.clientId).toBe('test-client');
  });

  it('rejects token with wrong issuer', async () => {
    const token = await signJwt(kp, { iss: 'http://attacker.example' });
    await expect(validateHubJwt(token)).rejects.toBeInstanceOf(HubJwtError);
  });

  it('rejects expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    const token = await signJwt(kp, { iss: fixture.origin, expiresAtSeconds: past });
    await expect(validateHubJwt(token)).rejects.toBeInstanceOf(HubJwtError);
  });

  it('rejects token signed by an unpublished key', async () => {
    const otherKp = await makeKeypair('k1');
    const token = await signJwt(otherKp, { iss: fixture.origin });
    await expect(validateHubJwt(token)).rejects.toBeInstanceOf(HubJwtError);
  });

  it('rejects when JWKS endpoint is unreachable', async () => {
    fixture.setJwksFails(true);
    const token = await signJwt(kp, { iss: fixture.origin });
    await expect(validateHubJwt(token)).rejects.toBeInstanceOf(HubJwtError);
  });
});

describe('getHubOrigin', () => {
  // The hub lifecycle (parachute-hub/src/commands/lifecycle.ts) stamps
  // PARACHUTE_HUB_ORIGIN onto every spawned service so iss-strict JWT
  // validation works behind tailnet proxying. PARACHUTE_AGENT_HUB_ORIGIN
  // is the test/per-service override; legacy PARACLAW_HUB_ORIGIN is read
  // through 0.1.x with a one-shot deprecation warning (drop in 0.2.0).
  // Loopback fallback exists for local-dev when the hub isn't supervising
  // the process.
  let prevAgent: string | undefined;
  let prevParaclaw: string | undefined;
  let prevParachute: string | undefined;

  beforeEach(() => {
    prevAgent = process.env.PARACHUTE_AGENT_HUB_ORIGIN;
    prevParaclaw = process.env.PARACLAW_HUB_ORIGIN;
    prevParachute = process.env.PARACHUTE_HUB_ORIGIN;
    delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
    delete process.env.PARACLAW_HUB_ORIGIN;
    delete process.env.PARACHUTE_HUB_ORIGIN;
  });

  afterEach(() => {
    if (prevAgent === undefined) delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
    else process.env.PARACHUTE_AGENT_HUB_ORIGIN = prevAgent;
    if (prevParaclaw === undefined) delete process.env.PARACLAW_HUB_ORIGIN;
    else process.env.PARACLAW_HUB_ORIGIN = prevParaclaw;
    if (prevParachute === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
    else process.env.PARACHUTE_HUB_ORIGIN = prevParachute;
  });

  it('reads PARACHUTE_HUB_ORIGIN as primary (set by hub lifecycle)', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.taildf9ce2.ts.net';
    expect(getHubOrigin()).toBe('https://parachute.taildf9ce2.ts.net');
  });

  it('PARACHUTE_AGENT_HUB_ORIGIN overrides PARACHUTE_HUB_ORIGIN', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.taildf9ce2.ts.net';
    process.env.PARACHUTE_AGENT_HUB_ORIGIN = 'http://localhost:9999';
    expect(getHubOrigin()).toBe('http://localhost:9999');
  });

  it('PARACLAW_HUB_ORIGIN overrides PARACHUTE_HUB_ORIGIN (legacy pair takes precedence)', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.taildf9ce2.ts.net';
    process.env.PARACLAW_HUB_ORIGIN = 'http://localhost:9998';
    expect(getHubOrigin()).toBe('http://localhost:9998');
  });

  it('PARACHUTE_AGENT_HUB_ORIGIN takes precedence over legacy PARACLAW_HUB_ORIGIN', () => {
    process.env.PARACLAW_HUB_ORIGIN = 'http://legacy.example';
    process.env.PARACHUTE_AGENT_HUB_ORIGIN = 'http://current.example';
    expect(getHubOrigin()).toBe('http://current.example');
  });

  it('falls back to loopback when neither env is set', () => {
    expect(getHubOrigin()).toBe('http://127.0.0.1:1939');
  });

  it('strips trailing slash from either env', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'https://hub.example/';
    expect(getHubOrigin()).toBe('https://hub.example');
    process.env.PARACHUTE_AGENT_HUB_ORIGIN = 'https://override.example/';
    expect(getHubOrigin()).toBe('https://override.example');
  });
});

describe('hasScope', () => {
  it('exact match', () => {
    expect(hasScope([SCOPE_AGENT_READ], SCOPE_AGENT_READ)).toBe(true);
  });

  it('agent:admin ⊇ agent:write ⊇ agent:read', () => {
    expect(hasScope([SCOPE_AGENT_ADMIN], SCOPE_AGENT_READ)).toBe(true);
    expect(hasScope([SCOPE_AGENT_ADMIN], SCOPE_AGENT_WRITE)).toBe(true);
    expect(hasScope([SCOPE_AGENT_WRITE], SCOPE_AGENT_READ)).toBe(true);
    expect(hasScope([SCOPE_AGENT_READ], SCOPE_AGENT_WRITE)).toBe(false);
    expect(hasScope([SCOPE_AGENT_WRITE], SCOPE_AGENT_ADMIN)).toBe(false);
  });

  it('vault:admin (operator-token catch-all) satisfies every agent scope', () => {
    expect(hasScope([SCOPE_VAULT_ADMIN], SCOPE_AGENT_READ)).toBe(true);
    expect(hasScope([SCOPE_VAULT_ADMIN], SCOPE_AGENT_WRITE)).toBe(true);
    expect(hasScope([SCOPE_VAULT_ADMIN], SCOPE_AGENT_ADMIN)).toBe(true);
  });

  it('hub:admin does NOT satisfy agent scopes', () => {
    expect(hasScope(['hub:admin'], SCOPE_AGENT_READ)).toBe(false);
    expect(hasScope(['hub:admin'], SCOPE_AGENT_WRITE)).toBe(false);
    expect(hasScope(['hub:admin'], SCOPE_AGENT_ADMIN)).toBe(false);
  });

  it('legacy `claw:*` grants are normalized to `agent:*` (pre-0.1.0 compat)', () => {
    expect(hasScope(['claw:read'], SCOPE_AGENT_READ)).toBe(true);
    expect(hasScope(['claw:write'], SCOPE_AGENT_READ)).toBe(true);
    expect(hasScope(['claw:admin'], SCOPE_AGENT_WRITE)).toBe(true);
    expect(hasScope(['claw:admin'], SCOPE_AGENT_ADMIN)).toBe(true);
    expect(hasScope(['claw:read'], SCOPE_AGENT_WRITE)).toBe(false);
  });

  it('empty scopes never satisfy', () => {
    expect(hasScope([], SCOPE_AGENT_READ)).toBe(false);
  });
});

describe('authenticate', () => {
  it('returns ok with claims for a valid Bearer + sufficient scope', async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: 'agent:write' });
    const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_READ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.scopes).toContain('agent:write');
  });

  it('401 on missing header', async () => {
    const r = await authenticate(undefined, SCOPE_AGENT_READ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('401 on malformed header (no Bearer prefix)', async () => {
    const token = await signJwt(kp, { iss: fixture.origin });
    const r = await authenticate(token, SCOPE_AGENT_READ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('401 on invalid token (wrong issuer)', async () => {
    const token = await signJwt(kp, { iss: 'http://attacker.example' });
    const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_READ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('403 on insufficient scope — surfaces error_type + required + granted', async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: 'agent:read' });
    const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_WRITE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('insufficient_scope');
      expect(r.requiredScope).toBe(SCOPE_AGENT_WRITE);
      expect(r.grantedScopes).toEqual(['agent:read']);
    }
  });

  it('operator-token shape (vault:admin scope) passes any agent gate', async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      scope: 'hub:admin vault:admin scribe:admin channel:send',
    });
    const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_ADMIN);
    expect(r.ok).toBe(true);
  });
});

describe('authenticate — revocation enforcement (Phase 4)', () => {
  // Three integration cases pinning the agent-side wiring + the response-shape
  // contract. scope-guard's own unit suite covers cache mechanics; this block
  // verifies that revocation outcomes propagate through `authenticate()` with
  // the right sanitization + audit-log invariants.

  it('happy path: signed valid JWT not in revocation list → 200 + claims', async () => {
    fixture.setRevoked([]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      scope: 'agent:read',
      jti: 'jti-not-revoked',
    });
    const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_READ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.jti).toBe('jti-not-revoked');
  });

  it('revoked jti → 401 sanitized; full diagnostic (with jti) routed to console.warn audit log', async () => {
    const revokedJti = 'jti-revoked-by-operator';
    fixture.setRevoked([revokedJti]);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      scope: 'agent:read',
      jti: revokedJti,
    });

    // Spy + suppress so the assertion is the audit-trail invariant for this
    // scenario, not a stderr inspection. Pattern carries from vault PR #281
    // through scribe PR #43 to here.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_READ);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(401);
        // Client-facing message must NOT carry the jti — that's a server-side
        // audit-log concern only. See the `code === "revoked"` branch in
        // auth.ts:authenticate for the sanitization.
        expect(r.error).toBe('token has been revoked');
        expect(r.error).not.toContain(revokedJti);
      }

      // Audit-log invariant: console.warn fires exactly once with a message
      // that carries the jti, so an operator chasing a 401 in production logs
      // can correlate to which token was retired.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]![0] as string;
      expect(warnArg).toContain(revokedJti);
      expect(warnArg).toContain('revoked');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('revocation list unreachable on cold start → 401 sanitized; full diagnostic routed to console.warn', async () => {
    // Hub is reachable for JWKS but the revocation endpoint 503s. Cold cache
    // + first-fetch-fail = "unknown" outcome, surfaced as
    // HubJwtError(code: "revocation_unavailable"). Client gets a code-shaped
    // sentence; the implementation-detail phrasing ("no last-good cache")
    // stays in the server-side audit log.
    fixture.setRevocationFails(true);
    const token = await signJwt(kp, {
      iss: fixture.origin,
      scope: 'agent:read',
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await authenticate(`Bearer ${token}`, SCOPE_AGENT_READ);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.status).toBe(401);
        // Client message: code-shaped, no internals.
        expect(r.error).toBe('token cannot be validated: revocation list unavailable');
        // The internal phrase "no last-good cache" is a scope-guard
        // implementation detail and must not leak into the public response.
        expect(r.error).not.toContain('last-good cache');
      }

      // Audit-log invariant: full diagnostic routed to console.warn so
      // operators can distinguish cold-start from sustained outage.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      const warnArg = warnSpy.mock.calls[0]![0] as string;
      expect(warnArg).toContain('no last-good cache');
    } finally {
      warnSpy.mockRestore();
    }
  });
});
