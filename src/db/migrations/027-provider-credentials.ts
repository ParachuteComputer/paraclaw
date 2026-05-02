/**
 * `provider_credentials` — agent-provider credential source per-install
 * (Phase 1) with room for per-agent-group overrides (Phase 2).
 *
 *   source = 'claude_setup_token' | 'anthropic_api_key' | 'external_server'
 *
 * Phase 1 has exactly one row, keyed by the sentinel id `'__default__'`.
 * Phase 2 adds real `agent_group_id` rows alongside the sentinel; the
 * resolver picks the real row for that group when present and falls back
 * to the sentinel. This is why the PK is the column itself, not a
 * composite — sentinel-vs-real-id occupies the same slot.
 *
 * `api_key_encrypted` (AES-GCM) holds the single secret string for every
 * source: the Claude setup token (`sk-ant-oat01-...`), the Anthropic API
 * key, or the external-server API key. Source discriminates how the
 * spawn envelope translates that secret — see `spawn.ts`.
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
        agent_group_id    TEXT PRIMARY KEY,
        source            TEXT NOT NULL CHECK (source IN ('claude_setup_token','anthropic_api_key','external_server')),
        -- The single encrypted secret per row. Plaintext is whichever
        -- token/key the operator pasted; spawn.ts threads it into the
        -- right env var for the active source.
        api_key_encrypted TEXT,
        -- external_server only.
        server_url        TEXT,
        updated_at        TEXT NOT NULL
      );
    `);
  },
};
