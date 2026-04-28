/**
 * Per-agent allowlist for OAuth connections — same shape as
 * `secret_assignments` from migration 016. A connection is visible to an
 * agent group only if there's a row here joining the two.
 *
 * Composite PK on (agent_group_id, app_connection_id) prevents duplicate
 * grants. Both FKs cascade so a deleted agent group or revoked
 * connection cleans up the join rows automatically.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'agent-app-connections',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_app_connections (
        agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        app_connection_id  TEXT NOT NULL REFERENCES app_connections(id) ON DELETE CASCADE,
        created_at         TEXT NOT NULL,
        PRIMARY KEY (agent_group_id, app_connection_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agent_app_connections_conn
        ON agent_app_connections(app_connection_id);
    `);
  },
};
