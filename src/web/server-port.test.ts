/**
 * Boot-time port resolution + bind-failure tests for paraclaw#145, plus
 * the bare `PORT` env tier added in paraclaw#147 to match scribe's
 * 4-tier ladder (parachute-scribe/src/port-resolve.ts).
 *
 * Issue: the web server hardcoded its port to 1944 (env-overridable but
 * never reading services.json), and `upsertService` re-stamped 1944 on
 * every boot — operator-edited services.json values were silently
 * reverted, and a port collision with scribe (also racing for 1944) made
 * the second-to-bind crash with EADDRINUSE that hub-side `parachute
 * start` didn't surface. Fix: services.json > PARACHUTE_AGENT_WEB_PORT
 * > PORT > default 1944, plus a loud bind-error path. Precedence is
 * symmetric with parachute-scribe (services.json > SCRIBE_PORT > PORT >
 * default 1943) so operators who learn the rule from one service don't
 * get surprised by the other — the bug class paraclaw#145 addresses is
 * "stale env clobbers operator-set manifest values," and
 * services.json-wins is what fixes it. The bare `PORT` tier (paraclaw#147)
 * is the generic PaaS / hub-injection path that `parachute install
 * parachute-agent` writes into the service-managed `.env`; it sits below
 * the specific env so an operator's `PARACHUTE_AGENT_WEB_PORT` shell
 * export isn't silently overridden by a stale `PORT=…` line. The 4-tier
 * ladder is documented in `parachute-patterns/patterns/cli-as-port-authority.md`
 * (patterns#45).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolvePort } from './server.js';
import { upsertService } from './services-manifest.js';

let tmp: string;
let manifestPath: string;
// PORT must be scrubbed alongside the agent-specific names — paraclaw#147
// added a bare-PORT tier, and a stray PORT in the test runner's env (e.g.
// inherited from a parent shell) would otherwise leak into the
// "manifest absent + no env vars → default" assertions.
const ENV_KEYS = ['PARACHUTE_AGENT_WEB_PORT', 'PARACLAW_WEB_PORT', 'PORT'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paraclaw-server-port-'));
  manifestPath = join(tmp, 'services.json');
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('resolvePort — paraclaw#145 services.json port respect', () => {
  it('falls back to the canonical default 1944 when no env + no manifest entry', () => {
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1944);
    expect(r.source).toBe('default');
    expect(r.existingEntry).toBeNull();
  });

  it('reads port from services.json when an entry exists (the #145 regression)', () => {
    // Pre-fix: this returned 1944 regardless of what services.json said,
    // which is exactly how operator-edited values got silently reverted.
    upsertService(
      { name: 'agent', port: 1947, paths: ['/agent'], health: '/api/health', version: '0.1.3-rc.1' },
      manifestPath,
    );
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1947);
    expect(r.source).toBe('manifest');
    expect(r.existingEntry?.port).toBe(1947);
  });

  it('services.json wins over env (the stale-env-vs-services.json case)', () => {
    // Critical regression test mirroring scribe#41: hub's port-assigner
    // walked the canonical slot to 1944 once and stamped that value into
    // a service-managed env file. Pre-fix (env > services.json), the
    // stale env stamp silently clobbered an operator's manifest edit on
    // every boot. Post-fix (services.json > env), the operator's pin
    // wins and the stale env is ignored. Symmetric with scribe so the
    // pattern is consistent across both modules.
    upsertService(
      { name: 'agent', port: 1947, paths: ['/agent'], health: '/api/health', version: '0.1.3-rc.2' },
      manifestPath,
    );
    process.env.PARACHUTE_AGENT_WEB_PORT = '1944';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1947);
    expect(r.source).toBe('manifest');
    expect(r.existingEntry?.port).toBe(1947);
  });

  it('env var binds when there is no services.json entry', () => {
    // No manifest entry means env is the next tier — first-run /
    // fresh-install path where hub's port-assigner has stamped a value
    // into the agent's .env but the services manifest does not yet
    // carry an `agent` row. The port value here matches the canonical
    // default deliberately to confirm `source` reports the env tier
    // (not 'default') even when env happens to carry the canonical
    // number.
    process.env.PARACHUTE_AGENT_WEB_PORT = '1944';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1944);
    expect(r.source).toBe('env');
    expect(r.existingEntry).toBeNull();
  });

  it('legacy PARACLAW_WEB_PORT is honored when fresh name is unset and manifest has no entry', () => {
    process.env.PARACLAW_WEB_PORT = '1958';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1958);
    expect(r.source).toBe('env');
  });

  it('rejects a non-numeric env override loudly rather than coercing to NaN', () => {
    process.env.PARACHUTE_AGENT_WEB_PORT = 'not-a-port';
    expect(() => resolvePort(manifestPath)).toThrow(/not a valid port/);
  });

  it('rejects an out-of-range env override (0, negative, > 65535)', () => {
    process.env.PARACHUTE_AGENT_WEB_PORT = '0';
    expect(() => resolvePort(manifestPath)).toThrow(/not a valid port/);
    process.env.PARACHUTE_AGENT_WEB_PORT = '70000';
    expect(() => resolvePort(manifestPath)).toThrow(/not a valid port/);
  });

  it('rejects a non-integer (fractional) env override', () => {
    // paraclaw#148 review fold: pre-fix the guard used Number.isFinite
    // alone, so `1.5` coerced to a finite-but-non-integer that slipped
    // past resolution and crashed deeper in `server.listen()` with an
    // error that didn't name the env var. Scribe's `parsePort` uses an
    // integer regex `/^[1-9]\d{0,4}$/` and never lets a fractional past
    // — agent now uses `Number.isInteger` for parity. Reject loudly here
    // so the misconfig surfaces with the env name attached.
    process.env.PARACHUTE_AGENT_WEB_PORT = '1.5';
    expect(() => resolvePort(manifestPath)).toThrow(/PARACHUTE_AGENT_WEB_PORT is not a valid port/);
  });

  it('treats an empty env value as unset (falls through to manifest / default)', () => {
    // Some shells (and the older paraclaw .env loader) export blank lines
    // as empty strings; treating '' as a valid port would break those.
    process.env.PARACHUTE_AGENT_WEB_PORT = '';
    upsertService(
      { name: 'agent', port: 1947, paths: ['/agent'], health: '/api/health', version: '0.1.3-rc.1' },
      manifestPath,
    );
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1947);
    expect(r.source).toBe('manifest');
  });
});

describe('resolvePort — paraclaw#147 bare PORT env tier', () => {
  // The four cases from #147 spec, in the precedence order they exercise.
  // Symmetric with parachute-scribe/src/port-resolve.test.ts; same shape
  // as the patterns#45 documented ladder. The point is to pin every
  // adjacent ordering so a future refactor that flips two tiers can't
  // pass the existing #145 tests by coincidence.

  it('manifest absent + PARACHUTE_AGENT_WEB_PORT=1947 + PORT=1948 → binds 1947 (specific env wins)', () => {
    // Concrete decision: an operator's deliberate `export
    // PARACHUTE_AGENT_WEB_PORT=…` must not be silently overridden by a
    // stale `PORT=…` left in the service-managed `.env` by a previous
    // hub install. Specific-env-over-bare-PORT is the rule.
    process.env.PARACHUTE_AGENT_WEB_PORT = '1947';
    process.env.PORT = '1948';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1947);
    expect(r.source).toBe('env');
    expect(r.existingEntry).toBeNull();
  });

  it('manifest absent + no specific env + PORT=1948 → binds 1948 (bare PORT used as fallback)', () => {
    // The generic PaaS / hub-injection path. `parachute install
    // parachute-agent` writes `PORT=<n>` into the service-managed `.env`;
    // when no agent-specific override is set and the manifest has no
    // entry yet (first-run / fresh install), bare PORT is what the
    // service binds.
    process.env.PORT = '1948';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1948);
    expect(r.source).toBe('port');
    expect(r.existingEntry).toBeNull();
  });

  it('manifest absent + no env vars → binds 1944 (canonical default)', () => {
    // Sanity: the default tier still terminates the chain when nothing
    // upstream is set. Already covered in the #145 block; re-pinned here
    // alongside the new #147 cases so the four-case spec lives as one
    // adjacent cluster matching scribe's port-resolve.test.ts.
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1944);
    expect(r.source).toBe('default');
    expect(r.existingEntry).toBeNull();
  });

  it('manifest=1949 + PARACHUTE_AGENT_WEB_PORT=1947 + PORT=1948 → binds 1949 (manifest wins over both env tiers)', () => {
    // Top of the ladder: services.json beats every env tier, including
    // bare PORT. Re-asserts the #145 invariant in the presence of the
    // new tier, so a future refactor that promotes PORT above manifest
    // by mistake fails this test.
    upsertService(
      { name: 'agent', port: 1949, paths: ['/agent'], health: '/api/health', version: '0.1.3-rc.3' },
      manifestPath,
    );
    process.env.PARACHUTE_AGENT_WEB_PORT = '1947';
    process.env.PORT = '1948';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1949);
    expect(r.source).toBe('manifest');
    expect(r.existingEntry?.port).toBe(1949);
  });

  it('treats an empty PORT value as unset (falls through to default)', () => {
    // Mirrors the existing empty-string handling for the specific env
    // tier — keeps the two env tiers symmetric. A blank `PORT=` line in
    // a `.env` file shouldn't crash boot or coerce to NaN.
    process.env.PORT = '';
    const r = resolvePort(manifestPath);
    expect(r.port).toBe(1944);
    expect(r.source).toBe('default');
  });

  it('rejects a non-numeric PORT loudly rather than coercing to NaN', () => {
    // Same parsing strictness as `PARACHUTE_AGENT_WEB_PORT` — surface a
    // misconfigured `.env` immediately instead of silently degrading to
    // the canonical default and masking the misconfig.
    process.env.PORT = 'not-a-port';
    expect(() => resolvePort(manifestPath)).toThrow(/PORT is not a valid port/);
  });

  it('rejects an out-of-range PORT (0, > 65535)', () => {
    process.env.PORT = '0';
    expect(() => resolvePort(manifestPath)).toThrow(/PORT is not a valid port/);
    process.env.PORT = '70000';
    expect(() => resolvePort(manifestPath)).toThrow(/PORT is not a valid port/);
  });

  it('rejects a non-integer (fractional) PORT', () => {
    // Symmetric with the PARACHUTE_AGENT_WEB_PORT fractional-reject
    // case — both env tiers must share scribe's `parsePort` strictness
    // so a `PORT=1.5` line in a service-managed `.env` is named loudly,
    // not coerced to a non-integer that crashes later in
    // `server.listen()` without the env var attached. See the matching
    // case in the #145 block for the full rationale (paraclaw#148 fold).
    process.env.PORT = '1.5';
    expect(() => resolvePort(manifestPath)).toThrow(/PORT is not a valid port/);
  });
});

describe('http.Server EADDRINUSE behavior — paraclaw#145 fail-loudly', () => {
  it('reports EADDRINUSE on bind conflict so the boot path can fail visibly', async () => {
    // Sanity-pin the underlying behavior we rely on: when two listeners
    // race for the same port, Node emits an `error` event with code
    // EADDRINUSE rather than throwing inline. The agent's startWebServer
    // now wires an `error` handler that logs the named conflict and
    // process.exit(1)s, so the supervisor (launchd / systemd / hub-spawn)
    // sees the failure instead of a half-booted host process. We can't
    // assert process.exit here without forking, but pinning the EADDRINUSE
    // event protects us against a Node-version regression silently
    // changing the surface.
    const a = http.createServer();
    await new Promise<void>((resolve) => a.listen(0, '127.0.0.1', () => resolve()));
    const port = (a.address() as { port: number }).port;

    const b = http.createServer();
    const errPromise = new Promise<NodeJS.ErrnoException>((resolve) => {
      b.once('error', (err) => resolve(err as NodeJS.ErrnoException));
    });
    b.listen(port, '127.0.0.1');
    const err = await errPromise;
    expect(err.code).toBe('EADDRINUSE');

    await new Promise<void>((resolve) => a.close(() => resolve()));
    // `b` never bound, no need to close.
  });
});
