/**
 * OAuth provider client configs (BYOC — Bring Your Own Client).
 *
 * One row per provider. The user (operator) registers their own OAuth
 * client with the provider (e.g. Google Cloud Console), then drops the
 * `client_id` + `client_secret` here. paraclaw uses these to mint
 * authorize URLs and exchange codes for tokens.
 *
 *   - `client_secret_encrypted` is `iv || ciphertext || authTag` (base64),
 *     same wire format as `secrets.value_encrypted`. Encryption key is
 *     HKDF-derived from the master key with info `paraclaw.oauth.v1`.
 *   - `scopes_default` is a space-separated OAuth scope string applied
 *     when the operator doesn't override at authorize-time.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration018: Migration = {
  version: 18,
  name: 'oauth-app-configs',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS app_configs (
        id                       TEXT PRIMARY KEY,
        provider                 TEXT NOT NULL UNIQUE,
        client_id                TEXT NOT NULL,
        client_secret_encrypted  TEXT NOT NULL,
        scopes_default           TEXT NOT NULL DEFAULT '',
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL
      );
    `);
  },
};
