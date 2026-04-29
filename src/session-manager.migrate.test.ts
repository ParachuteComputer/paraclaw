/**
 * Coverage for migrateSessionsDir — operator-data-loss-prevention helper that
 * relocates `data/v2-sessions/` to `data/sessions/` on first boot after the
 * rename. Three cases pinned: fresh install, existing legacy, both present.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateSessionsDir } from './session-manager.js';

let tmp: string;
let legacy: string;
let current: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paraclaw-sessions-migrate-'));
  legacy = join(tmp, 'v2-sessions');
  current = join(tmp, 'sessions');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrateSessionsDir', () => {
  it('fresh install — no legacy, no current — is a noop', () => {
    migrateSessionsDir(legacy, current);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(false);
  });

  it('existing legacy — renames to current and preserves contents', () => {
    mkdirSync(join(legacy, 'sess-abc'), { recursive: true });
    writeFileSync(join(legacy, 'sess-abc', 'inbound.db'), 'marker');

    migrateSessionsDir(legacy, current);

    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(true);
    expect(readdirSync(current)).toEqual(['sess-abc']);
    expect(existsSync(join(current, 'sess-abc', 'inbound.db'))).toBe(true);
  });

  it('both present — current wins, legacy left untouched (no clobber)', () => {
    mkdirSync(join(legacy, 'sess-old'), { recursive: true });
    writeFileSync(join(legacy, 'sess-old', 'inbound.db'), 'old');
    mkdirSync(join(current, 'sess-new'), { recursive: true });
    writeFileSync(join(current, 'sess-new', 'inbound.db'), 'new');

    migrateSessionsDir(legacy, current);

    expect(existsSync(legacy)).toBe(true);
    expect(readdirSync(legacy)).toEqual(['sess-old']);
    expect(readdirSync(current)).toEqual(['sess-new']);
  });
});
