/**
 * Selective-mode enforcement: a secret with `assigned_mode = 'selective'`
 * is injected only into agent groups with an explicit row here. `'all'`-mode
 * secrets ignore this table entirely (current resolveInjectableSecrets
 * behaviour). The composite PK keeps assignments idempotent — re-assigning
 * is a no-op rather than a duplicate row.
 *
 * ON DELETE CASCADE on both FKs: when a secret or agent group is deleted,
 * its assignments evaporate. There's no soft-delete / audit row here — the
 * activity log (PR2) is the audit surface.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration016: Migration = {
  version: 16,
  name: 'secret-assignments',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS secret_assignments (
        secret_id      TEXT NOT NULL REFERENCES secrets(id) ON DELETE CASCADE,
        agent_group_id TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        created_at     TEXT NOT NULL,
        PRIMARY KEY (secret_id, agent_group_id)
      );
      CREATE INDEX IF NOT EXISTS idx_secret_assignments_agent_group
        ON secret_assignments(agent_group_id);
    `);
  },
};
