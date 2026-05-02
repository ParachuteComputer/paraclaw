/**
 * Host-side reader for the operator's Claude Code OAuth credentials file.
 *
 * macOS / Linux: `~/.claude/.credentials.json` (leading dot). On macOS,
 * Claude Code may also store this in the keychain under
 * "Claude Code-credentials" — we don't read the keychain here; on installs
 * where the file isn't on disk, the operator pastes a key or runs
 * `claude login` to materialize the file.
 *
 * We return the raw string so the caller can pass it through unchanged
 * into the container's `.credentials.json` (the SDK parses it itself).
 * The shape today is `{"claudeAiOauth":{"accessToken":...,"refreshToken":
 * ...,"expiresAt":...,"scopes":[...]},...}` but we don't validate — if
 * Claude Code ships a new field, our pass-through propagates it.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../../log.js';

export const CLAUDE_CODE_OAUTH_FILE = path.join(os.homedir(), '.claude', '.credentials.json');

/**
 * Read the host's `.credentials.json`. Returns null if the file is missing
 * or unreadable — both are non-fatal at spawn time (the spawn falls back
 * to the last-stored copy in `provider_credentials.credentials_json`).
 */
export function readClaudeCodeOAuth(): string | null {
  try {
    if (!fs.existsSync(CLAUDE_CODE_OAUTH_FILE)) return null;
    return fs.readFileSync(CLAUDE_CODE_OAUTH_FILE, 'utf8');
  } catch (err) {
    log.warn('Could not read Claude Code OAuth credentials file', {
      path: CLAUDE_CODE_OAUTH_FILE,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** True iff the host file currently exists. Used by auto-detect at wire time. */
export function hasClaudeCodeOAuth(): boolean {
  try {
    return fs.existsSync(CLAUDE_CODE_OAUTH_FILE);
  } catch {
    return false;
  }
}
