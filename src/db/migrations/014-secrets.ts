/**
 * Local secrets store: AES-256-GCM encryption with a master key at
 * `~/.parachute/claw/master.key`, decrypted in-process at session spawn,
 * injected into per-session containers as env vars.
 *
 *   - `value_encrypted` is `iv || ciphertext || authTag` (12 + N + 16 bytes),
 *     base64-encoded. Storing IV alongside ciphertext keeps each row
 *     self-contained.
 *   - `agent_group_id` is nullable: NULL = global, non-NULL = scoped to that
 *     group only.
 *   - `assigned_mode` is `all` (every agent sees this secret) or `selective`
 *     (allowlist join table — not yet wired; column reserved for the UI's
 *     per-agent-group injection picker).
 *
 * Migration 015 drops the now-vestigial `host_pattern` column.
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
