/**
 * OAuth user grants — one row per (provider × authorized account).
 *
 *   - `app_config_id` FKs to `app_configs(id)`. ON DELETE CASCADE: if the
 *     operator drops their Google client config, every connection minted
 *     against it is gone too (the tokens were issued to that client_id
 *     and would 401 anyway).
 *   - `account_email` + `account_id` come from the provider's userinfo
 *     endpoint at callback time. `(app_config_id, account_id)` is unique
 *     so re-authorizing the same account just refreshes tokens in place.
 *   - `access_token_encrypted` / `refresh_token_encrypted` are AES-GCM
 *     ciphertext (base64) with the same `paraclaw.oauth.v1` derived key
 *     as `app_configs.client_secret_encrypted`.
 *   - `scopes_granted` is space-separated; what the provider actually
 *     gave us, not what we asked for.
 *   - `expires_at` is ISO-8601; refresh-token flow renews `access_token`
 *     and bumps this. NULL means provider didn't return an expiry.
 *   - `metadata_json` is a freeform JSON blob for provider-specific
 *     fields (e.g. Google's `id_token`, GitHub's `installation_id`).
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'oauth-app-connections',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_connections (
        id                        TEXT PRIMARY KEY,
        app_config_id             TEXT NOT NULL REFERENCES app_configs(id) ON DELETE CASCADE,
        account_email             TEXT,
        account_id                TEXT NOT NULL,
        access_token_encrypted    TEXT NOT NULL,
        refresh_token_encrypted   TEXT,
        scopes_granted            TEXT NOT NULL DEFAULT '',
        expires_at                TEXT,
        label                     TEXT NOT NULL,
        metadata_json             TEXT,
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL,
        UNIQUE (app_config_id, account_id)
      );
      CREATE INDEX IF NOT EXISTS idx_app_connections_config ON app_connections(app_config_id);
      CREATE INDEX IF NOT EXISTS idx_app_connections_email ON app_connections(account_email);
    `);
  },
};
