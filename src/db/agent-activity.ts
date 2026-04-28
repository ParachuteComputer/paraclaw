/**
 * Central `agent_activity` ledger — append-only, drained from each session's
 * outbound.db `activity` table during delivery. Read paths feed the web UI's
 * "what is this agent doing" surface; the table is intended to be
 * inexpensively scannable per-agent-group and per-session, hence the two
 * descending indexes added in migration 017.
 *
 * Cursor: `sessions.activity_synced_seq` is the per-session high-water mark
 * — every row from outbound.db with `seq <= cursor` has either been merged
 * here or was emitted by a session whose container has since stopped (we
 * still drained it on the way out). The merge is single-writer because the
 * delivery loop already serializes per-session via `inflightDeliveries`.
 */
import crypto from 'node:crypto';

import { getDb } from './connection.js';
import type { OutboundActivityRow } from './session-db.js';

export type ActivityKind = 'tool_call' | 'mcp_call' | 'cmd_exec' | 'secret_use';

export interface ActivityRow {
  id: string;
  agent_group_id: string;
  session_id: string;
  kind: string;
  target: string | null;
  summary: string | null;
  created_at: string;
}

export function getActivitySyncedSeq(sessionId: string): number {
  const row = getDb().prepare('SELECT activity_synced_seq AS seq FROM sessions WHERE id = ?').get(sessionId) as
    | { seq: number }
    | undefined;
  return row?.seq ?? 0;
}

/**
 * Insert a batch of outbound activity rows into central `agent_activity` and
 * advance the session's merge cursor in one transaction. No-op when the
 * input is empty so callers don't have to short-circuit. Returns the new
 * cursor value (max input seq, or the unchanged prior cursor).
 */
export function mergeActivityBatch(agentGroupId: string, sessionId: string, rows: OutboundActivityRow[]): number {
  if (rows.length === 0) return getActivitySyncedSeq(sessionId);

  const db = getDb();
  const insert = db.prepare(
    `INSERT INTO agent_activity (id, agent_group_id, session_id, kind, target, summary, created_at)
     VALUES (@id, @agent_group_id, @session_id, @kind, @target, @summary, @created_at)`,
  );
  const updateCursor = db.prepare(
    `UPDATE sessions SET activity_synced_seq = ? WHERE id = ? AND activity_synced_seq < ?`,
  );

  const maxSeq = rows.reduce((acc, r) => (r.seq > acc ? r.seq : acc), 0);

  db.transaction(() => {
    for (const r of rows) {
      insert.run({
        id: crypto.randomUUID(),
        agent_group_id: agentGroupId,
        session_id: sessionId,
        kind: r.kind,
        target: r.target,
        summary: r.summary,
        created_at: r.ts,
      });
    }
    updateCursor.run(maxSeq, sessionId, maxSeq);
  })();

  return maxSeq;
}

export interface ListActivityOpts {
  /** Only return rows with created_at > since (ISO 8601). */
  since?: string;
  /** Cap row count. Defaults to 100, hard-capped at 500 by the route layer. */
  limit?: number;
}

export function listActivityByAgentGroup(agentGroupId: string, opts: ListActivityOpts = {}): ActivityRow[] {
  const limit = opts.limit ?? 100;
  if (opts.since) {
    return getDb()
      .prepare(
        `SELECT * FROM agent_activity
          WHERE agent_group_id = ? AND created_at > ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(agentGroupId, opts.since, limit) as ActivityRow[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM agent_activity
        WHERE agent_group_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(agentGroupId, limit) as ActivityRow[];
}

export function listActivityBySession(sessionId: string, opts: ListActivityOpts = {}): ActivityRow[] {
  const limit = opts.limit ?? 100;
  if (opts.since) {
    return getDb()
      .prepare(
        `SELECT * FROM agent_activity
          WHERE session_id = ? AND created_at > ?
          ORDER BY created_at DESC LIMIT ?`,
      )
      .all(sessionId, opts.since, limit) as ActivityRow[];
  }
  return getDb()
    .prepare(
      `SELECT * FROM agent_activity
        WHERE session_id = ?
        ORDER BY created_at DESC LIMIT ?`,
    )
    .all(sessionId, limit) as ActivityRow[];
}
