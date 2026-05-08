/**
 * Boot-time port resolution + bind-failure tests for paraclaw#145.
 *
 * Issue: the web server hardcoded its port to 1944 (env-overridable but
 * never reading services.json), and `upsertService` re-stamped 1944 on
 * every boot — operator-edited services.json values were silently
 * reverted, and a port collision with scribe (also racing for 1944) made
 * the second-to-bind crash with EADDRINUSE that hub-side `parachute
 * start` didn't surface. Fix: services.json > env > default 1944, plus
 * a loud bind-error path. Precedence is symmetric with parachute-scribe#41
 * (services.json > SCRIBE_PORT > PORT > default 1943) so operators who
 * learn the rule from one service don't get surprised by the other —
 * the bug class both PRs address is "stale env clobbers operator-set
 * manifest values," and services.json-wins is what fixes it.
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
const ENV_KEYS = ['PARACHUTE_AGENT_WEB_PORT', 'PARACLAW_WEB_PORT'] as const;
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
