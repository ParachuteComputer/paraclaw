/**
 * Tests for env-var-driven config resolution.
 *
 * `vi.resetModules()` is required because config.ts resolves PARACHUTE_DIR
 * at import time — the const captures whatever PARACHUTE_HOME / HOME are
 * at first load. Tests that flip env vars must re-import to observe the
 * new resolution.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_PARACHUTE_HOME = process.env.PARACHUTE_HOME;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_PARACHUTE_HOME === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = ORIGINAL_PARACHUTE_HOME;
});

describe('PARACHUTE_DIR resolution', () => {
  it('PARACHUTE_HOME wins when set', async () => {
    process.env.PARACHUTE_HOME = '/tmp/sandbox-home';
    process.env.HOME = '/Users/test';
    const cfg = await import('./config.js');
    expect(cfg.PARACHUTE_DIR).toBe('/tmp/sandbox-home');
    expect(cfg.CENTRAL_DB_DIR).toBe('/tmp/sandbox-home/claw');
  });

  it('falls back to <HOME>/.parachute when PARACHUTE_HOME unset', async () => {
    delete process.env.PARACHUTE_HOME;
    process.env.HOME = '/Users/test';
    const cfg = await import('./config.js');
    expect(cfg.PARACHUTE_DIR).toBe(path.join('/Users/test', '.parachute'));
    expect(cfg.CENTRAL_DB_DIR).toBe(path.join('/Users/test', '.parachute', 'claw'));
  });

  it('master.key lives next to the central DB under PARACHUTE_DIR/claw', async () => {
    process.env.PARACHUTE_HOME = '/tmp/sandbox-home-2';
    const cfg = await import('./config.js');
    const { getMasterKeyPath } = await import('./secrets/master-key.js');
    expect(getMasterKeyPath()).toBe(path.join(cfg.CENTRAL_DB_DIR, 'master.key'));
    expect(getMasterKeyPath().startsWith('/tmp/sandbox-home-2/claw/')).toBe(true);
  });

  it('PARACLAW_CENTRAL_DB_PATH still overrides the DB path independently', async () => {
    process.env.PARACHUTE_HOME = '/tmp/ignored-for-db-path';
    process.env.PARACLAW_CENTRAL_DB_PATH = '/tmp/explicit/db.sqlite';
    const cfg = await import('./config.js');
    expect(cfg.CENTRAL_DB_PATH).toBe('/tmp/explicit/db.sqlite');
    delete process.env.PARACLAW_CENTRAL_DB_PATH;
  });

  it('PARACHUTE_HOME + PARACLAW_CENTRAL_DB_PATH split: DB takes the override, master.key follows PARACHUTE_HOME', async () => {
    // Intentional split. PARACLAW_CENTRAL_DB_PATH is an escape hatch for
    // landing the DB on a different volume (e.g. NVMe scratch) while keeping
    // the rest of paraclaw's persistent state — including the encryption
    // key — under PARACHUTE_HOME. Anyone exporting just the DB file alone
    // is doing it wrong: the ciphertext is unreadable without the master
    // key that lives next to PARACHUTE_HOME's claw/ dir.
    process.env.PARACHUTE_HOME = '/tmp/sandbox-split';
    process.env.PARACLAW_CENTRAL_DB_PATH = '/var/db/claw.db';
    const cfg = await import('./config.js');
    const { getMasterKeyPath } = await import('./secrets/master-key.js');
    expect(cfg.CENTRAL_DB_PATH).toBe('/var/db/claw.db');
    expect(getMasterKeyPath()).toBe(path.join('/tmp/sandbox-split/claw', 'master.key'));
    delete process.env.PARACLAW_CENTRAL_DB_PATH;
  });
});
