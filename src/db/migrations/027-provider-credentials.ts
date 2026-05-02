/**
 * `provider_credentials` — agent-provider credential source per-install
 * (Phase 1) with room for per-agent-group overrides (Phase 2).
 *
 *   source = 'claude_code_oauth' | 'anthropic_api_key' | 'external_server'
 *
 * Phase 1 has exactly one row, keyed by the sentinel id `'__default__'`.
 * Phase 2 adds real `agent_group_id` rows alongside the sentinel; the
 * resolver picks the real row for that group when present and falls back
 * to the sentinel. This is why the PK is the column itself, not a
 * composite — sentinel-vs-real-id occupies the same slot.
 *
 * `credentials_json` (encrypted) holds the entire `~/.claude/.credentials.json`
 * blob for `claude_code_oauth` (used as the fallback when the host file is
 * unreadable at spawn). For `anthropic_api_key` and `external_server` the
 * key + url live alongside in their own columns; we don't reuse this column
 * to keep each source's storage shape obvious.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration027: Migration = {
  version: 27,
  name: 'provider-credentials',
  up(db: Database) {
    db.exec(`
      CREATE TABLE provider_credentials (
        -- Sentinel id '__default__' for the install-wide row; real
        -- agent_group_id values land here in Phase 2 to override.
        agent_group_id   TEXT PRIMARY KEY,
        source           TEXT NOT NULL CHECK (source IN ('claude_code_oauth','anthropic_api_key','external_server')),
        -- Encrypted blobs (AES-GCM, src/secrets/crypto.ts). Plaintext varies
        -- by source: claude_code_oauth -> the full .credentials.json string;
        -- anthropic_api_key / external_server -> the API key. Optional for
        -- claude_code_oauth (host file is the primary read).
        credentials_json TEXT,
        api_key_encrypted TEXT,
        -- external_server only.
        server_url       TEXT,
        updated_at       TEXT NOT NULL
      );
    `);
  },
};
