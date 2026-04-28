/**
 * Per-agent allowlist for OAuth connections — the `agent_app_connections`
 * join table. A connection is only visible/injectable to an agent group
 * if there's a row joining the two.
 */
import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';

function db(): Database {
  return getDb();
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface AgentForConnection {
  agent_group_id: string;
  agent_group_folder: string;
  agent_group_name: string;
  created_at: string;
}

export function listAgentsForConnection(connectionId: string): AgentForConnection[] {
  return db()
    .prepare<AgentForConnection>(
      `SELECT a.agent_group_id   AS agent_group_id,
              g.folder           AS agent_group_folder,
              g.name             AS agent_group_name,
              a.created_at       AS created_at
         FROM agent_app_connections a
         JOIN agent_groups g ON g.id = a.agent_group_id
        WHERE a.app_connection_id = @connection_id
        ORDER BY g.name`,
    )
    .all({ connection_id: connectionId });
}

/** Map of connectionId → agent count, populated in one query for the list view. */
export function countAgentsByConnection(): Map<string, number> {
  const rows = db()
    .prepare<{ app_connection_id: string; n: number }>(
      `SELECT app_connection_id, COUNT(*) AS n
         FROM agent_app_connections
         GROUP BY app_connection_id`,
    )
    .all();
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.app_connection_id, r.n);
  return out;
}

export function listConnectionsForAgent(agentGroupId: string): string[] {
  return db()
    .prepare<{ app_connection_id: string }>(
      `SELECT app_connection_id FROM agent_app_connections WHERE agent_group_id = @agent_group_id`,
    )
    .all({ agent_group_id: agentGroupId })
    .map((r) => r.app_connection_id);
}

/** Atomically replace the allowlist for a connection. */
export function setAgentsForConnection(connectionId: string, agentGroupIds: string[]): void {
  const tx = db().transaction((ids: string[]) => {
    db()
      .prepare(`DELETE FROM agent_app_connections WHERE app_connection_id = @connection_id`)
      .run({ connection_id: connectionId });
    const insert = db().prepare(
      `INSERT OR IGNORE INTO agent_app_connections
         (agent_group_id, app_connection_id, created_at)
       VALUES (@agent_group_id, @app_connection_id, @created_at)`,
    );
    const now = nowIso();
    for (const id of ids) {
      insert.run({ agent_group_id: id, app_connection_id: connectionId, created_at: now });
    }
  });
  tx(agentGroupIds);
}

export function addAgentToConnection(connectionId: string, agentGroupId: string): void {
  db()
    .prepare(
      `INSERT OR IGNORE INTO agent_app_connections
         (agent_group_id, app_connection_id, created_at)
       VALUES (@agent_group_id, @app_connection_id, @created_at)`,
    )
    .run({
      agent_group_id: agentGroupId,
      app_connection_id: connectionId,
      created_at: nowIso(),
    });
}

export function removeAgentFromConnection(connectionId: string, agentGroupId: string): boolean {
  const r = db()
    .prepare(
      `DELETE FROM agent_app_connections
        WHERE app_connection_id = @connection_id AND agent_group_id = @agent_group_id`,
    )
    .run({ connection_id: connectionId, agent_group_id: agentGroupId });
  return r.changes > 0;
}
