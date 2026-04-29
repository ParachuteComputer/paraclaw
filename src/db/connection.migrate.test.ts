/**
 * Coverage for migrateCentralDbLocation — operator-data-loss-prevention helper
 * that copies the central DB out of the project tree to its operator-owned
 * home (`~/.parachute/claw/paraclaw.db`). Three cases pinned: fresh install,
 * existing legacy, both present.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateCentralDbLocation } from './connection.js';

let tmp: string;
let legacy: string;
let current: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paraclaw-central-db-migrate-'));
  legacy = join(tmp, 'legacy', 'v2.db');
  // Nested under a not-yet-created directory so we exercise the mkdir path.
  current = join(tmp, 'home', '.parachute', 'claw', 'paraclaw.db');
  mkdirSync(join(tmp, 'legacy'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrateCentralDbLocation', () => {
  it('fresh install — no legacy, no current — is a noop', () => {
    migrateCentralDbLocation(legacy, current);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(current)).toBe(false);
  });

  it('existing legacy — copies (not renames) to current with chmod 0600', () => {
    writeFileSync(legacy, 'central-db-bytes');

    migrateCentralDbLocation(legacy, current);

    // Both must exist — copy preserves the legacy as a backup.
    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(readFileSync(current, 'utf8')).toBe('central-db-bytes');
    expect(readFileSync(legacy, 'utf8')).toBe('central-db-bytes');
    // chmod 0600 — owner-only. Skip on platforms where mode bits don't apply.
    if (process.platform !== 'win32') {
      expect(statSync(current).mode & 0o777).toBe(0o600);
    }
  });

  it('both present — current wins, legacy left untouched (no clobber)', () => {
    writeFileSync(legacy, 'old');
    mkdirSync(join(tmp, 'home', '.parachute', 'claw'), { recursive: true });
    writeFileSync(current, 'new');

    migrateCentralDbLocation(legacy, current);

    expect(readFileSync(current, 'utf8')).toBe('new');
    expect(readFileSync(legacy, 'utf8')).toBe('old');
  });
});
