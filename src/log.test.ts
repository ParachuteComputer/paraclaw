/**
 * `migrateLegacyLogFilenames` — idempotent rename of `logs/paraclaw{,.error}.log`
 * to `logs/parachute-agent{,.error}.log` at host startup. The launchd plist /
 * systemd unit still controls where the live daemon writes; the migration is
 * about preserving the historical log file under the new name so tools that
 * tail the new path see prior entries. See log.ts comment for the supervisor
 * caveat.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyLogFilenames } from './log.js';

let scratchRoot: string;

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-log-migrate-'));
  fs.mkdirSync(path.join(scratchRoot, 'logs'), { recursive: true });
});

afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('migrateLegacyLogFilenames', () => {
  it('renames paraclaw.log + paraclaw.error.log to parachute-agent.* when present', () => {
    fs.writeFileSync(path.join(scratchRoot, 'logs', 'paraclaw.log'), 'normal-history\n');
    fs.writeFileSync(path.join(scratchRoot, 'logs', 'paraclaw.error.log'), 'error-history\n');

    migrateLegacyLogFilenames(scratchRoot);

    expect(fs.readFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.log'), 'utf8')).toBe('normal-history\n');
    expect(fs.readFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.error.log'), 'utf8')).toBe(
      'error-history\n',
    );
    expect(fs.existsSync(path.join(scratchRoot, 'logs', 'paraclaw.log'))).toBe(false);
    expect(fs.existsSync(path.join(scratchRoot, 'logs', 'paraclaw.error.log'))).toBe(false);
  });

  it('is a no-op when only the new names exist (post-migration / fresh install)', () => {
    fs.writeFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.log'), 'fresh\n');

    migrateLegacyLogFilenames(scratchRoot);

    expect(fs.readFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.log'), 'utf8')).toBe('fresh\n');
    expect(fs.existsSync(path.join(scratchRoot, 'logs', 'paraclaw.log'))).toBe(false);
  });

  it('keeps both files when new+legacy coexist (do not clobber post-migration writes)', () => {
    // After plist regen the supervisor opens the new file. If the operator
    // never deleted the orphan `paraclaw.log` from a prior boot, the
    // migration must NOT overwrite the live `parachute-agent.log` — we
    // leave both alone so the operator can `rm` the orphan deliberately.
    fs.writeFileSync(path.join(scratchRoot, 'logs', 'paraclaw.log'), 'orphan\n');
    fs.writeFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.log'), 'live\n');

    migrateLegacyLogFilenames(scratchRoot);

    expect(fs.readFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.log'), 'utf8')).toBe('live\n');
    expect(fs.readFileSync(path.join(scratchRoot, 'logs', 'paraclaw.log'), 'utf8')).toBe('orphan\n');
  });

  it('handles only one of the two legacy files existing', () => {
    fs.writeFileSync(path.join(scratchRoot, 'logs', 'paraclaw.error.log'), 'errors-only\n');

    migrateLegacyLogFilenames(scratchRoot);

    expect(fs.existsSync(path.join(scratchRoot, 'logs', 'parachute-agent.log'))).toBe(false);
    expect(fs.readFileSync(path.join(scratchRoot, 'logs', 'parachute-agent.error.log'), 'utf8')).toBe('errors-only\n');
  });

  it('is a no-op on a missing logs/ directory', () => {
    fs.rmSync(path.join(scratchRoot, 'logs'), { recursive: true, force: true });

    expect(() => migrateLegacyLogFilenames(scratchRoot)).not.toThrow();
    expect(fs.existsSync(path.join(scratchRoot, 'logs'))).toBe(false);
  });
});
