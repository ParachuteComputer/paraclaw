/**
 * Hub-JWT validation + scope-check tests. Mirrors vault's hub-jwt.test.ts
 * shape but uses vitest + node:http (paraclaw's suite is vitest, not
 * bun:test). A fake JWKS endpoint signs locally with a known RSA keypair;
 * cases cover the spec failure modes plus paraclaw's claw-scope inheritance
 * + vault:admin catch-all.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  authenticate,
  hasScope,
  HubJwtError,
  resetJwksCache,
  SCOPE_CLAW_ADMIN,
  SCOPE_CLAW_READ,
  SCOPE_CLAW_WRITE,
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

interface JwksFixture {
  origin: string;
  stop: () => Promise<void>;
  setKeys: (keys: Keypair[]) => void;
  setUnreachable: (down: boolean) => void;
}

function startJwksFixture(): Promise<JwksFixture> {
  return new Promise((resolve) => {
    let keys: Keypair[] = [];
    let down = false;
    const server = http.createServer((req, res) => {
      if (req.url !== '/.well-known/jwks.json') {
        res.writeHead(404).end('not found');
        return;
      }
      if (down) {
        res.writeHead(503).end('upstream down');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: keys.map((k) => k.publicJwk) }));
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
        setUnreachable: (v) => {
          down = v;
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
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = opts.expiresAtSeconds ?? iat + (opts.ttlSeconds ?? 60);
  return await new SignJWT({
    scope: opts.scope ?? 'claw:read',
    client_id: opts.clientId ?? 'test-client',
  })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? kp.kid })
    .setIssuer(opts.iss ?? 'http://issuer.invalid')
    .setSubject(opts.sub ?? 'user-1')
    .setAudience(opts.aud ?? 'hub')
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti('jti-1')
    .sign(kp.privateKey);
}

let fixture: JwksFixture;
let kp: Keypair;
let prevHubOrigin: string | undefined;

beforeAll(async () => {
  fixture = await startJwksFixture();
  kp = await makeKeypair('k1');
  fixture.setKeys([kp]);
});

afterAll(async () => {
  await fixture.stop();
  if (prevHubOrigin === undefined) delete process.env.PARACLAW_HUB_ORIGIN;
  else process.env.PARACLAW_HUB_ORIGIN = prevHubOrigin;
});

beforeEach(() => {
  prevHubOrigin = process.env.PARACLAW_HUB_ORIGIN;
  process.env.PARACLAW_HUB_ORIGIN = fixture.origin;
  fixture.setUnreachable(false);
  fixture.setKeys([kp]);
  resetJwksCache();
});

afterEach(() => {
  if (prevHubOrigin === undefined) delete process.env.PARACLAW_HUB_ORIGIN;
  else process.env.PARACLAW_HUB_ORIGIN = prevHubOrigin;
});

describe('validateHubJwt', () => {
  it('happy path — surfaces sub + scopes + clientId', async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: 'claw:read claw:write' });
    const claims = await validateHubJwt(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.scopes).toEqual(['claw:read', 'claw:write']);
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
    fixture.setUnreachable(true);
    const token = await signJwt(kp, { iss: fixture.origin });
    await expect(validateHubJwt(token)).rejects.toBeInstanceOf(HubJwtError);
  });
});

describe('hasScope', () => {
  it('exact match', () => {
    expect(hasScope([SCOPE_CLAW_READ], SCOPE_CLAW_READ)).toBe(true);
  });

  it('claw:admin ⊇ claw:write ⊇ claw:read', () => {
    expect(hasScope([SCOPE_CLAW_ADMIN], SCOPE_CLAW_READ)).toBe(true);
    expect(hasScope([SCOPE_CLAW_ADMIN], SCOPE_CLAW_WRITE)).toBe(true);
    expect(hasScope([SCOPE_CLAW_WRITE], SCOPE_CLAW_READ)).toBe(true);
    expect(hasScope([SCOPE_CLAW_READ], SCOPE_CLAW_WRITE)).toBe(false);
    expect(hasScope([SCOPE_CLAW_WRITE], SCOPE_CLAW_ADMIN)).toBe(false);
  });

  it('vault:admin (operator-token catch-all) satisfies every claw scope', () => {
    expect(hasScope([SCOPE_VAULT_ADMIN], SCOPE_CLAW_READ)).toBe(true);
    expect(hasScope([SCOPE_VAULT_ADMIN], SCOPE_CLAW_WRITE)).toBe(true);
    expect(hasScope([SCOPE_VAULT_ADMIN], SCOPE_CLAW_ADMIN)).toBe(true);
  });

  it('hub:admin does NOT satisfy claw scopes', () => {
    expect(hasScope(['hub:admin'], SCOPE_CLAW_READ)).toBe(false);
    expect(hasScope(['hub:admin'], SCOPE_CLAW_WRITE)).toBe(false);
    expect(hasScope(['hub:admin'], SCOPE_CLAW_ADMIN)).toBe(false);
  });

  it('empty scopes never satisfy', () => {
    expect(hasScope([], SCOPE_CLAW_READ)).toBe(false);
  });
});

describe('authenticate', () => {
  it('returns ok with claims for a valid Bearer + sufficient scope', async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: 'claw:write' });
    const r = await authenticate(`Bearer ${token}`, SCOPE_CLAW_READ);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.claims.scopes).toContain('claw:write');
  });

  it('401 on missing header', async () => {
    const r = await authenticate(undefined, SCOPE_CLAW_READ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('401 on malformed header (no Bearer prefix)', async () => {
    const token = await signJwt(kp, { iss: fixture.origin });
    const r = await authenticate(token, SCOPE_CLAW_READ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('401 on invalid token (wrong issuer)', async () => {
    const token = await signJwt(kp, { iss: 'http://attacker.example' });
    const r = await authenticate(`Bearer ${token}`, SCOPE_CLAW_READ);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(401);
  });

  it('403 on insufficient scope — surfaces error_type + required + granted', async () => {
    const token = await signJwt(kp, { iss: fixture.origin, scope: 'claw:read' });
    const r = await authenticate(`Bearer ${token}`, SCOPE_CLAW_WRITE);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(403);
      expect(r.errorType).toBe('insufficient_scope');
      expect(r.requiredScope).toBe(SCOPE_CLAW_WRITE);
      expect(r.grantedScopes).toEqual(['claw:read']);
    }
  });

  it('operator-token shape (vault:admin scope) passes any claw gate', async () => {
    const token = await signJwt(kp, {
      iss: fixture.origin,
      scope: 'hub:admin vault:admin scribe:admin channel:send',
    });
    const r = await authenticate(`Bearer ${token}`, SCOPE_CLAW_ADMIN);
    expect(r.ok).toBe(true);
  });
});
