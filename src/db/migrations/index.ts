import type { Database } from '../connection.js';

import { log } from '../../log.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
import { migration013 } from './013-approval-render-metadata.js';
import { migration014 } from './014-secrets.js';
import { migration015 } from './015-secrets-drop-host-pattern.js';
import { migration016 } from './016-secret-assignments.js';
import { migration017 } from './017-agent-activity.js';
import { migration018 } from './018-oauth-app-configs.js';
import { migration019 } from './019-oauth-app-connections.js';
import { migration020 } from './020-agent-app-connections.js';
import { migration021 } from './021-pending-oauth-states.js';
import { migration022 } from './022-app-connections-provider.js';
import { migration023 } from './023-agent-group-secret-mode.js';
import { migration024 } from './024-collapse-approvals.js';
import { migration025 } from './025-secret-mode-check.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
  /**
   * Set true for migrations that recreate a parent table (the SQLite
   * "build new + copy + drop + rename" dance). The runner toggles
   * `PRAGMA foreign_keys = OFF` connection-scope BEFORE entering the
   * wrapping transaction and re-enables it after.
   *
   * `PRAGMA defer_foreign_keys = TRUE` is NOT enough — it only delays
   * the FK check to commit-time, where any pre-existing orphan row in a
   * referencing table (e.g. a dangling `sessions.agent_group_id` left
   * over from pre-FK-enforcement days) will still fail the migration on
   * a real install. SQLite forbids changing `foreign_keys` mid-txn, so
   * the toggle has to live in the runner, not the migration body.
   *
   * Migrations setting this MUST NOT introduce new orphan rows; the
   * fix-existing-orphans question is separate (and out of scope for a
   * schema-shape migration like 025).
   */
  disableForeignKeys?: boolean;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  moduleApprovalsTitleOptions,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  migration016,
  migration017,
  migration018,
  migration019,
  migration020,
  migration021,
  migration022,
  migration023,
  migration024,
  migration025,
];

export function runMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // Uniqueness is keyed on `name`, not `version`. This lets module
  // migrations (added later by install skills) pick arbitrary version
  // numbers without coordinating across modules. `version` stays on
  // the Migration object as an ordering hint within the barrel array;
  // the stored `version` column is auto-assigned at insert time as an
  // applied-order number.
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    if (m.disableForeignKeys) db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        m.up(db);
        const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as {
          v: number;
        }).v;
        db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
          next,
          m.name,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (m.disableForeignKeys) db.exec('PRAGMA foreign_keys = ON');
    }
    log.info('Migration applied', { name: m.name });
  }
}
