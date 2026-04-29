/**
 * Coverage for migrateGroupsToClaudeLocal — operator-data-loss-prevention
 * helper that converts the pre-cutover `groups/<name>/CLAUDE.md` to the new
 * `CLAUDE.local.md` model and removes the obsolete `groups/global/` tree.
 * Three cases pinned: fresh install, existing legacy, both present.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateGroupsToClaudeLocal } from './claude-md-compose.js';

let tmp: string;
let groupsDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paraclaw-groups-migrate-'));
  groupsDir = join(tmp, 'groups');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('migrateGroupsToClaudeLocal', () => {
  it('fresh install — groups dir absent — is a noop', () => {
    migrateGroupsToClaudeLocal(groupsDir);
    expect(existsSync(groupsDir)).toBe(false);
  });

  it('existing legacy — renames CLAUDE.md to CLAUDE.local.md, removes .claude-global.md and groups/global/', () => {
    const fam = join(groupsDir, 'family-chat');
    mkdirSync(fam, { recursive: true });
    writeFileSync(join(fam, 'CLAUDE.md'), 'pre-cutover memory');
    // Dangling symlink on the host, valid inside the container — match the real shape.
    symlinkSync('/app/CLAUDE.md', join(fam, '.claude-global.md'));
    mkdirSync(join(groupsDir, 'global'), { recursive: true });
    writeFileSync(join(groupsDir, 'global', 'CLAUDE.md'), 'obsolete shared base');

    migrateGroupsToClaudeLocal(groupsDir);

    expect(existsSync(join(fam, 'CLAUDE.md'))).toBe(false);
    expect(readFileSync(join(fam, 'CLAUDE.local.md'), 'utf8')).toBe('pre-cutover memory');
    expect(existsSync(join(fam, '.claude-global.md'))).toBe(false);
    expect(existsSync(join(groupsDir, 'global'))).toBe(false);
  });

  it('both present — preserves existing CLAUDE.local.md, drops legacy CLAUDE.md untouched', () => {
    // Models the "first spawn already regenerated CLAUDE.md after a previous
    // migration" branch: CLAUDE.local.md has the per-group memory; CLAUDE.md
    // is the fresh composed entry — this path must skip the rename.
    const fam = join(groupsDir, 'family-chat');
    mkdirSync(fam, { recursive: true });
    writeFileSync(join(fam, 'CLAUDE.md'), 'composed entry');
    writeFileSync(join(fam, 'CLAUDE.local.md'), 'per-group memory');

    migrateGroupsToClaudeLocal(groupsDir);

    expect(readFileSync(join(fam, 'CLAUDE.md'), 'utf8')).toBe('composed entry');
    expect(readFileSync(join(fam, 'CLAUDE.local.md'), 'utf8')).toBe('per-group memory');
  });
});
