/**
 * Live status for an agent group: whether its container is alive right now,
 * how many sessions are active, and last-message timestamps from the per-
 * session DBs.
 *
 * The web server polls this so the UI can show "which agents are alive."
 * NanoClaw's `isContainerRunning(sessionId)` (in-memory map in
 * container-runner.ts) is host-process scoped — useless from the web server.
 * Heartbeat file mtime is the only cross-process liveness signal:
 *
 *   data/v2-sessions/<agent_group_id>/<session_id>/.heartbeat
 *
 * The container's agent-runner touches this on every poll iteration.
 * NanoClaw's host sweep runs at 60s intervals; we use 90s as the "alive"
 * threshold so the dot doesn't blink during a sweep tick.
 */
import fs from 'node:fs';

import { type Database, openDb } from '../db/connection.js';

import { getAgentGroupByFolder } from '../db/agent-groups.js';
import { getSessionsByAgentGroup } from '../db/sessions.js';
import { heartbeatPath, inboundDbPath, outboundDbPath } from '../session-manager.js';

export const DEFAULT_ALIVE_THRESHOLD_MS = 90_000;

export interface SessionStatus {
  sessionId: string;
  status: 'active' | 'closed';
  containerStatus: 'running' | 'idle' | 'stopped';
  alive: boolean;
  lastHeartbeatAt: string | null;
  lastMessageInAt: string | null;
  lastMessageOutAt: string | null;
  createdAt: string;
  lastActiveAt: string | null;
}

export interface GroupStatus {
  containerRunning: boolean;
  activeSessionCount: number;
  sessionCount: number;
  lastHeartbeatAt: string | null;
  lastMessageInAt: string | null;
  lastMessageOutAt: string | null;
  sessions: SessionStatus[];
}

export interface GroupStatusOpts {
  /** Override the alive threshold (mainly for tests). */
  aliveThresholdMs?: number;
  /** Inject "now" for deterministic tests. */
  nowMs?: number;
}

export function getGroupStatus(folder: string, opts: GroupStatusOpts = {}): GroupStatus | null {
  const group = getAgentGroupByFolder(folder);
  if (!group) return null;

  const aliveThresholdMs = opts.aliveThresholdMs ?? DEFAULT_ALIVE_THRESHOLD_MS;
  const nowMs = opts.nowMs ?? Date.now();

  const sessions = getSessionsByAgentGroup(group.id).map((s) =>
    readSessionStatus(group.id, s, nowMs, aliveThresholdMs),
  );

  return {
    containerRunning: sessions.some((s) => s.alive),
    activeSessionCount: sessions.filter((s) => s.alive).length,
    sessionCount: sessions.filter((s) => s.status === 'active').length,
    lastHeartbeatAt: latest(sessions.map((s) => s.lastHeartbeatAt)),
    lastMessageInAt: latest(sessions.map((s) => s.lastMessageInAt)),
    lastMessageOutAt: latest(sessions.map((s) => s.lastMessageOutAt)),
    sessions,
  };
}

function readSessionStatus(
  agentGroupId: string,
  session: {
    id: string;
    status: 'active' | 'closed';
    container_status: 'running' | 'idle' | 'stopped';
    created_at: string;
    last_active: string | null;
  },
  nowMs: number,
  aliveThresholdMs: number,
): SessionStatus {
  const heartbeatMs = readHeartbeatMtimeMs(agentGroupId, session.id);
  const alive = heartbeatMs > 0 && nowMs - heartbeatMs <= aliveThresholdMs;

  return {
    sessionId: session.id,
    status: session.status,
    containerStatus: session.container_status,
    alive,
    lastHeartbeatAt: heartbeatMs > 0 ? new Date(heartbeatMs).toISOString() : null,
    lastMessageInAt: maxTimestamp(inboundDbPath(agentGroupId, session.id), 'messages_in'),
    lastMessageOutAt: maxTimestamp(outboundDbPath(agentGroupId, session.id), 'messages_out'),
    createdAt: session.created_at,
    lastActiveAt: session.last_active,
  };
}

function readHeartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  try {
    return fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
  } catch {
    return 0;
  }
}

function maxTimestamp(dbPath: string, table: 'messages_in' | 'messages_out'): string | null {
  if (!fs.existsSync(dbPath)) return null;
  let db: Database | null = null;
  try {
    db = openDb(dbPath, { readonly: true });
    const row = db.prepare(`SELECT MAX(timestamp) AS ts FROM ${table}`).get() as { ts: string | null } | undefined;
    return row?.ts ?? null;
  } catch {
    // Session DB not initialized yet, schema mismatch, or transient lock — caller treats null as "no data".
    return null;
  } finally {
    db?.close();
  }
}

function latest(values: (string | null)[]): string | null {
  let best: string | null = null;
  for (const v of values) {
    if (!v) continue;
    if (!best || v > best) best = v;
  }
  return best;
}
