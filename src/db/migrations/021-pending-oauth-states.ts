/**
 * pending_oauth_states — DB-backed CSRF tokens for the OAuth authorize→callback
 * round-trip. The `state` parameter passed in the authorize redirect is a
 * CSPRNG-random opaque string mapped here to the originating context
 * (provider, optional agentGroupId, redirect URI, expires_at).
 *
 * Row lifecycle:
 *   - INSERT at /authorize, ~10min TTL
 *   - DELETE at /callback (single-use; second redemption is a 400)
 *   - sweep prunes anything past expires_at
 *
 * DB-backed (vs in-memory) so daemon restart mid-flow doesn't drop a
 * legitimate user's authorize attempt — they finish in their browser and
 * the callback still finds the row.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'pending-oauth-states',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_oauth_states (
        state           TEXT PRIMARY KEY,
        provider        TEXT NOT NULL,
        agent_group_id  TEXT,
        redirect_uri    TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        expires_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_oauth_states_expires ON pending_oauth_states(expires_at);
    `);
  },
};
