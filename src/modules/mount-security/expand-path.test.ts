/**
 * `expandPath` resolves operator-supplied paths inside the mount-allowlist
 * (`~/projects` etc.) against `HOME_DIR` from src/config.ts. paraclaw#99
 * pulled the HOME-resolution out of this module so the precedence rule
 * (`process.env.HOME` → `os.homedir()`) lives in one place; these tests pin
 * the contract.
 *
 * `vi.resetModules()` is required because config.ts captures HOME_DIR at
 * module load — tests that flip env vars must re-import both config and the
 * mount-security module so the new HOME_DIR threads through.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
});

describe('expandPath HOME resolution', () => {
  it("expands '~/foo' against config.HOME_DIR (default)", async () => {
    process.env.HOME = '/Users/test-default';
    const cfg = await import('../../config.js');
    const { expandPath } = await import('./index.js');
    expect(cfg.HOME_DIR).toBe('/Users/test-default');
    expect(expandPath('~/projects')).toBe(path.join('/Users/test-default', 'projects'));
  });

  it("expands bare '~' to config.HOME_DIR", async () => {
    process.env.HOME = '/Users/test-bare-tilde';
    const { expandPath } = await import('./index.js');
    expect(expandPath('~')).toBe('/Users/test-bare-tilde');
  });

  it('passes absolute paths through path.resolve unchanged', async () => {
    process.env.HOME = '/Users/test-abs';
    const { expandPath } = await import('./index.js');
    // Absolute paths should NOT consult HOME_DIR — they resolve as-is.
    expect(expandPath('/var/data/x')).toBe('/var/data/x');
  });

  it('honors HOME override at module load (sandbox-style override)', async () => {
    // The override path: PARACHUTE_HOME does NOT route mount-allowlist (#99
    // path 2 — operator-host policy is intentionally separate from runtime
    // state), but the bare HOME env var IS honored by config.HOME_DIR for
    // operators who reroute their entire shell session. Pin that flow.
    process.env.HOME = '/tmp/sandbox-home-99';
    const cfg = await import('../../config.js');
    const { expandPath } = await import('./index.js');
    expect(cfg.HOME_DIR).toBe('/tmp/sandbox-home-99');
    expect(expandPath('~/repos')).toBe('/tmp/sandbox-home-99/repos');
    // ALLOWLIST_DIR derives from HOME_DIR — it should follow.
    expect(cfg.ALLOWLIST_DIR).toBe('/tmp/sandbox-home-99/.config/parachute-agent');
  });

  it('does NOT route through PARACHUTE_HOME (operator-policy stays at <HOME>/.config)', async () => {
    // paraclaw#99 path 2 contract: PARACHUTE_HOME reroutes runtime state
    // (DB + master.key) but NOT operator-host policy (mount-allowlist).
    // Pin the split — if a future refactor accidentally collapses the two,
    // sandboxes would silently see different mount permissions than the
    // live install they share a host with.
    process.env.HOME = '/Users/operator';
    process.env.PARACHUTE_HOME = '/tmp/sandbox-home-collapse-check';
    try {
      const cfg = await import('../../config.js');
      expect(cfg.PARACHUTE_DIR).toBe('/tmp/sandbox-home-collapse-check');
      // CENTRAL_DB_DIR follows PARACHUTE_HOME — runtime state.
      expect(cfg.CENTRAL_DB_DIR).toBe('/tmp/sandbox-home-collapse-check/agent');
      // ALLOWLIST_DIR does NOT — operator-host policy.
      expect(cfg.ALLOWLIST_DIR).toBe('/Users/operator/.config/parachute-agent');
      expect(cfg.MOUNT_ALLOWLIST_PATH).toBe('/Users/operator/.config/parachute-agent/mount-allowlist.json');
    } finally {
      delete process.env.PARACHUTE_HOME;
    }
  });
});
