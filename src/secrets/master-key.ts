/**
 * Master key bootstrap. Stores a 32-byte (256-bit) random key at
 * `~/.parachute/claw/master.key` with mode 0600. Generated on first start;
 * loaded from disk on subsequent starts.
 *
 * The key is never written to logs, never sent over the wire, never put in
 * env vars. Loss of the file = loss of every encrypted secret (no recovery
 * path); rotation requires re-encrypting every row.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KEY_LEN = 32;
const KEY_DIR = path.join(os.homedir(), '.parachute', 'claw');
const KEY_PATH = path.join(KEY_DIR, 'master.key');

let cached: Buffer | null = null;

export function getMasterKeyPath(): string {
  return KEY_PATH;
}

export function loadOrCreateMasterKey(): Buffer {
  if (cached) return cached;

  if (fs.existsSync(KEY_PATH)) {
    // Refuse to load a key file that's group/world readable. The file was
    // created with mode 0600; if something has loosened it (chmod, restore
    // from a backup tarball, etc.) we'd rather fail loud than silently keep
    // serving secrets out of a file anyone on the box can read.
    const stat = fs.statSync(KEY_PATH);
    const perm = stat.mode & 0o777;
    if ((stat.mode & 0o077) !== 0) {
      throw new Error(
        `Master key at ${KEY_PATH} has permissive mode 0${perm.toString(8).padStart(3, '0')}; ` +
          `expected 0600. Run: chmod 600 ${KEY_PATH}`,
      );
    }
    const buf = fs.readFileSync(KEY_PATH);
    if (buf.length !== KEY_LEN) {
      throw new Error(`Master key at ${KEY_PATH} is ${buf.length} bytes; expected ${KEY_LEN}`);
    }
    cached = buf;
    return buf;
  }

  fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 });
  const key = crypto.randomBytes(KEY_LEN);
  fs.writeFileSync(KEY_PATH, key, { mode: 0o600 });
  cached = key;
  return key;
}

/** Test-only: clear the cached key so a different one can be loaded. */
export function _resetMasterKeyCache(): void {
  cached = null;
}

/** Test-only: install a key without touching disk. */
export function _setMasterKeyForTest(key: Buffer): void {
  if (key.length !== KEY_LEN) throw new Error(`test key must be ${KEY_LEN} bytes`);
  cached = key;
}
