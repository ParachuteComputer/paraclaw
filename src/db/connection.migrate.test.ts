/**
 * Coverage for migrateCentralDbLocation + migrateMasterKeyLocation —
 * operator-data-loss-prevention helpers that copy state from the legacy
 * paths to their parachute-agent homes (`<PARACHUTE_DIR>/agent/agent.db`
 * + `<PARACHUTE_DIR>/agent/master.key`). Cases pinned: fresh install,
 * pre-0.0.6 in-tree legacy, pre-0.1.0 paraclaw-era legacy, both legacies
 * present (paraclaw wins), current already on disk (no clobber).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateCentralDbLocation, migrateMasterKeyLocation } from './connection.js';

let tmp: string;
let legacy: string;
let paraclawLegacy: string;
let current: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'parachute-agent-central-db-migrate-'));
  legacy = join(tmp, 'legacy', 'v2.db');
  paraclawLegacy = join(tmp, 'home', '.parachute', 'claw', 'paraclaw.db');
  // Nested under a not-yet-created directory so we exercise the mkdir path.
  current = join(tmp, 'home', '.parachute', 'agent', 'agent.db');
  mkdirSync(join(tmp, 'legacy'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrateCentralDbLocation', () => {
  it('fresh install — no legacy, no current — is a noop', () => {
    migrateCentralDbLocation(legacy, current, paraclawLegacy);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(paraclawLegacy)).toBe(false);
    expect(existsSync(current)).toBe(false);
  });

  it('pre-0.0.6 legacy only — copies to current with chmod 0600, legacy stays as backup', () => {
    writeFileSync(legacy, 'in-tree-db-bytes');

    migrateCentralDbLocation(legacy, current, paraclawLegacy);

    expect(existsSync(legacy)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(readFileSync(current, 'utf8')).toBe('in-tree-db-bytes');
    expect(readFileSync(legacy, 'utf8')).toBe('in-tree-db-bytes');
    if (process.platform !== 'win32') {
      expect(statSync(current).mode & 0o777).toBe(0o600);
    }
  });

  it('pre-0.1.0 paraclaw-era legacy only — copies to current with chmod 0600, legacy stays as backup', () => {
    mkdirSync(join(tmp, 'home', '.parachute', 'claw'), { recursive: true });
    writeFileSync(paraclawLegacy, 'paraclaw-era-bytes');

    migrateCentralDbLocation(legacy, current, paraclawLegacy);

    expect(existsSync(paraclawLegacy)).toBe(true);
    expect(existsSync(current)).toBe(true);
    expect(readFileSync(current, 'utf8')).toBe('paraclaw-era-bytes');
    expect(readFileSync(paraclawLegacy, 'utf8')).toBe('paraclaw-era-bytes');
    if (process.platform !== 'win32') {
      expect(statSync(current).mode & 0o777).toBe(0o600);
    }
  });

  it('both legacies present — paraclaw-era wins (more recent state)', () => {
    writeFileSync(legacy, 'in-tree');
    mkdirSync(join(tmp, 'home', '.parachute', 'claw'), { recursive: true });
    writeFileSync(paraclawLegacy, 'paraclaw');

    migrateCentralDbLocation(legacy, current, paraclawLegacy);

    expect(readFileSync(current, 'utf8')).toBe('paraclaw');
    expect(readFileSync(legacy, 'utf8')).toBe('in-tree');
    expect(readFileSync(paraclawLegacy, 'utf8')).toBe('paraclaw');
  });

  it('current already exists — every legacy left untouched (no clobber)', () => {
    writeFileSync(legacy, 'old');
    mkdirSync(join(tmp, 'home', '.parachute', 'claw'), { recursive: true });
    writeFileSync(paraclawLegacy, 'older');
    mkdirSync(join(tmp, 'home', '.parachute', 'agent'), { recursive: true });
    writeFileSync(current, 'new');

    migrateCentralDbLocation(legacy, current, paraclawLegacy);

    expect(readFileSync(current, 'utf8')).toBe('new');
    expect(readFileSync(legacy, 'utf8')).toBe('old');
    expect(readFileSync(paraclawLegacy, 'utf8')).toBe('older');
  });
});

describe('migrateMasterKeyLocation', () => {
  let legacyDir: string;
  let currentDir: string;
  let legacyKey: string;
  let currentKey: string;

  beforeEach(() => {
    legacyDir = join(tmp, 'home', '.parachute', 'claw');
    currentDir = join(tmp, 'home', '.parachute', 'agent');
    legacyKey = join(legacyDir, 'master.key');
    currentKey = join(currentDir, 'master.key');
  });

  it('fresh install — no legacy, no current — is a noop', () => {
    migrateMasterKeyLocation(legacyDir, currentDir);
    expect(existsSync(legacyKey)).toBe(false);
    expect(existsSync(currentKey)).toBe(false);
  });

  it('legacy key only — copies to current with chmod 0600, legacy stays as backup', () => {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyKey, 'k'.repeat(32));

    migrateMasterKeyLocation(legacyDir, currentDir);

    expect(existsSync(legacyKey)).toBe(true);
    expect(existsSync(currentKey)).toBe(true);
    expect(readFileSync(currentKey, 'utf8')).toBe('k'.repeat(32));
    if (process.platform !== 'win32') {
      expect(statSync(currentKey).mode & 0o777).toBe(0o600);
    }
  });

  it('current key already exists — legacy left untouched (no clobber)', () => {
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(legacyKey, 'old-key-bytes-padding-to-32-aaaa');
    mkdirSync(currentDir, { recursive: true });
    writeFileSync(currentKey, 'new-key-bytes-padding-to-32-aaaa');

    migrateMasterKeyLocation(legacyDir, currentDir);

    expect(readFileSync(currentKey, 'utf8')).toBe('new-key-bytes-padding-to-32-aaaa');
    expect(readFileSync(legacyKey, 'utf8')).toBe('old-key-bytes-padding-to-32-aaaa');
  });
});
