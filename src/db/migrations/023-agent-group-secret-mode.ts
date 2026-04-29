/**
 * Move `assigned_mode` from `secrets` (per-secret) to `agent_groups.secret_mode`
 * (per-group). Mode is a property of the recipient agent group ("how should
 * this group's secrets get injected?"), not of each individual credential.
 *
 * Default for new groups is `selective` — operators must opt a credential in
 * before it lands in container env. This errs on the side of withholding
 * (cf. paraclaw#9), unlike the per-secret default of `all` we're replacing.
 *
 * Backfill rule: per agent_group, look at every in-scope secret (rows scoped
 * to that group OR global). If all such secrets shared one mode, adopt it.
 * If modes were mixed, adopt the most-permissive (`all`) and warn so the
 * operator notices any previously-selective scoped secret is now injected.
 * Groups with no in-scope secrets keep the new default (`selective`).
 */
import { log } from '../../log.js';
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration023: Migration = {
  version: 23,
  name: 'agent-group-secret-mode',
  up(db: Database) {
    db.exec(`
      ALTER TABLE agent_groups
        ADD COLUMN secret_mode TEXT NOT NULL DEFAULT 'selective';
    `);

    interface Row {
      id: string;
      modes: string | null;
    }
    const rows = db
      .prepare<Row>(
        `SELECT g.id AS id,
                GROUP_CONCAT(DISTINCT s.assigned_mode) AS modes
           FROM agent_groups g
           LEFT JOIN secrets s
             ON s.agent_group_id = g.id OR s.agent_group_id IS NULL
          GROUP BY g.id`,
      )
      .all();

    const updateMode = db.prepare(`UPDATE agent_groups SET secret_mode = @mode WHERE id = @id`);

    for (const r of rows) {
      if (!r.modes) continue;
      const modes = r.modes.split(',').filter(Boolean);
      if (modes.length === 0) continue;
      let chosen: 'all' | 'selective';
      if (modes.length === 1) {
        chosen = modes[0] as 'all' | 'selective';
      } else {
        chosen = 'all';
        log.warn('agent_group has mixed-mode secrets — collapsing to all', {
          agent_group_id: r.id,
          modes,
        });
      }
      updateMode.run({ id: r.id, mode: chosen });
    }

    db.exec(`ALTER TABLE secrets DROP COLUMN assigned_mode;`);
  },
};
