/**
 * Tool-invocation activity log.
 *
 * `agent_activity` is a central, append-only ledger of every tool/MCP/cmd
 * call an agent makes. The container writes a per-session row to its own
 * `outbound.db` `activity` table (created on demand in
 * container/agent-runner/src/db/connection.ts); the host's delivery loop
 * merges undrained rows here during `drainSession`. `sessions.activity_synced_seq`
 * is the per-session merge cursor so a slow host doesn't double-import.
 *
 * Privacy note: `summary` MUST NOT carry secret values or full Bash command
 * strings — env-injected secrets can leak into argv. The container side is
 * responsible for sanitization; this layer just stores what arrives.
 */
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'agent-activity',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_activity (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind            TEXT NOT NULL,
        target          TEXT,
        summary         TEXT,
        created_at      TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_activity_group_created
        ON agent_activity(agent_group_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_activity_session_created
        ON agent_activity(session_id, created_at DESC);

      ALTER TABLE sessions ADD COLUMN activity_synced_seq INTEGER NOT NULL DEFAULT 0;
    `);
  },
};
