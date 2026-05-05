/**
 * `migrateLegacyAllowlistDir` — idempotent move of
 * `~/.config/paraclaw/{mount,sender}-allowlist.json` to
 * `~/.config/parachute-agent/` at host startup. Tests use injected scratch
 * dirs (the function accepts overrides) so we don't touch the real
 * `$HOME/.config`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateLegacyAllowlistDir } from './index.js';

let scratchRoot: string;
let legacyDir: string;
let currentDir: string;

beforeEach(() => {
  scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-allowlist-migrate-'));
  legacyDir = path.join(scratchRoot, 'paraclaw');
  currentDir = path.join(scratchRoot, 'parachute-agent');
});

afterEach(() => {
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});

describe('migrateLegacyAllowlistDir', () => {
  it('moves both legacy allowlist files to the new dir when present', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'mount-allowlist.json'), '{"mount":1}\n');
    fs.writeFileSync(path.join(legacyDir, 'sender-allowlist.json'), '{"sender":1}\n');

    migrateLegacyAllowlistDir(legacyDir, currentDir);

    expect(fs.readFileSync(path.join(currentDir, 'mount-allowlist.json'), 'utf8')).toBe('{"mount":1}\n');
    expect(fs.readFileSync(path.join(currentDir, 'sender-allowlist.json'), 'utf8')).toBe('{"sender":1}\n');
    expect(fs.existsSync(path.join(legacyDir, 'mount-allowlist.json'))).toBe(false);
    expect(fs.existsSync(path.join(legacyDir, 'sender-allowlist.json'))).toBe(false);
  });

  it('is a no-op when the legacy dir does not exist (fresh install)', () => {
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(path.join(currentDir, 'mount-allowlist.json'), '{"fresh":1}\n');

    migrateLegacyAllowlistDir(legacyDir, currentDir);

    expect(fs.readFileSync(path.join(currentDir, 'mount-allowlist.json'), 'utf8')).toBe('{"fresh":1}\n');
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it('does not clobber existing files in the new dir (post-migration coexistence)', () => {
    // The operator may have populated the new dir before re-running an
    // installer that triggers another migration pass. Treat the new file
    // as canonical and leave the legacy orphan alone — the operator
    // deletes it deliberately.
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.mkdirSync(currentDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'mount-allowlist.json'), '{"orphan":1}\n');
    fs.writeFileSync(path.join(currentDir, 'mount-allowlist.json'), '{"live":1}\n');

    migrateLegacyAllowlistDir(legacyDir, currentDir);

    expect(fs.readFileSync(path.join(currentDir, 'mount-allowlist.json'), 'utf8')).toBe('{"live":1}\n');
    expect(fs.readFileSync(path.join(legacyDir, 'mount-allowlist.json'), 'utf8')).toBe('{"orphan":1}\n');
  });

  it('handles only one of the two legacy files existing', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'sender-allowlist.json'), '{"sender":1}\n');

    migrateLegacyAllowlistDir(legacyDir, currentDir);

    expect(fs.existsSync(path.join(currentDir, 'mount-allowlist.json'))).toBe(false);
    expect(fs.readFileSync(path.join(currentDir, 'sender-allowlist.json'), 'utf8')).toBe('{"sender":1}\n');
  });

  it('creates the new dir when it does not yet exist', () => {
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'mount-allowlist.json'), '{"m":1}\n');

    expect(fs.existsSync(currentDir)).toBe(false);

    migrateLegacyAllowlistDir(legacyDir, currentDir);

    expect(fs.statSync(currentDir).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(currentDir, 'mount-allowlist.json'), 'utf8')).toBe('{"m":1}\n');
  });
});
