/**
 * Add a `CHECK (secret_mode IN ('all', 'selective'))` constraint to
 * `agent_groups`. The TS layer narrows `SecretMode = 'all' | 'selective'`
 * already, but a stray raw SQL writer (a future migration, an ad-hoc
 * fix-up script) could land an out-of-range value the readers would then
 * silently treat as `selective`. Belt-and-suspenders.
 *
 * SQLite doesn't allow `ALTER TABLE … ADD CHECK`. The only path is the
 * recreate-and-rename dance: build the new table with the CHECK inline,
 * copy the rows, drop the old, rename in place. `defer_foreign_keys`
 * lets the dance happen inside the migration's wrapping transaction —
 * `PRAGMA foreign_keys=OFF` would be silently ignored mid-txn.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration025: Migration = {
  version: 25,
  name: 'secret-mode-check',
  up(db: Database) {
    db.exec(`
      PRAGMA defer_foreign_keys = TRUE;

      CREATE TABLE agent_groups_new (
        id               TEXT PRIMARY KEY,
        name             TEXT NOT NULL,
        folder           TEXT NOT NULL UNIQUE,
        agent_provider   TEXT,
        secret_mode      TEXT NOT NULL DEFAULT 'selective'
                           CHECK (secret_mode IN ('all', 'selective')),
        created_at       TEXT NOT NULL
      );

      INSERT INTO agent_groups_new (id, name, folder, agent_provider, secret_mode, created_at)
        SELECT id, name, folder, agent_provider, secret_mode, created_at
          FROM agent_groups;

      DROP TABLE agent_groups;
      ALTER TABLE agent_groups_new RENAME TO agent_groups;
    `);
  },
};
