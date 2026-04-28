/**
 * Local secrets store. Replaces OneCLI as paraclaw's hard dependency for
 * credential storage: AES-256-GCM encryption with a master key at
 * `~/.parachute/claw/master.key`, decrypted in-process at session spawn,
 * injected to per-session containers as env vars.
 *
 * Schema mirrors OneCLI's so the migration command (`migrate-onecli`) can
 * port credentials over without renames. Differences:
 *   - `value_encrypted` is `iv || ciphertext || authTag` (12 + N + 16 bytes),
 *     base64-encoded. Storing IV alongside ciphertext keeps each row
 *     self-contained.
 *   - `agent_group_id` is nullable: NULL = global (any agent group sees it
 *     subject to host_pattern), non-NULL = scoped to that group only.
 *   - `assigned_mode` mirrors OneCLI's "all" / "selective" semantics for the
 *     UI's per-agent-group injection picker.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'secrets',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        id              TEXT PRIMARY KEY,            -- ULID
        name            TEXT NOT NULL,
        value_encrypted TEXT NOT NULL,               -- base64(iv|ct|tag)
        kind            TEXT NOT NULL DEFAULT 'generic',
                                                     -- channel-token | api-key | generic
        agent_group_id  TEXT REFERENCES agent_groups(id),
                                                     -- NULL = global
        assigned_mode   TEXT NOT NULL DEFAULT 'all',
                                                     -- all | selective
        host_pattern    TEXT,                        -- optional host glob
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE (name, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_secrets_agent_group ON secrets(agent_group_id);
      CREATE INDEX IF NOT EXISTS idx_secrets_name ON secrets(name);
    `);
  },
};
