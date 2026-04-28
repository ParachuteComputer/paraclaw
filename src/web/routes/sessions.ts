/**
 * /api/sessions — global session list + per-session close.
 *
 * The list aggregates every agent group's sessions into one flat view so
 * the /sessions page can show "everything alive across the install" without
 * making N requests against /api/groups/:folder/status. Liveness uses the
 * same heartbeat-mtime computation as `getGroupStatus` (90s default
 * threshold) — see src/parachute/group-status.ts for the rationale.
 *
 * Close behavior: marks the row `status='closed'`, `container_status='stopped'`
 * in the central DB. The host process owns the container lifecycle —
 * `killContainer` reads from a host-process-only `activeContainers` Map and
 * is a no-op when called from this (separate) web process. The container
 * therefore keeps running until either the host's sweep tick reaps it on
 * an idle ceiling, or the upcoming web-merge directive collapses host +
 * web into a single `bun src/index.ts` boot — at which point killContainer
 * works directly because both surfaces share the activeContainers map.
 *
 * UI consequence today: the row flips to status='closed' immediately, the
 * container's `alive` indicator may stay true for up to 30 minutes (the
 * sweep ceiling) before it idles out. Acceptable for the rebuild's
 * intermediate state; the merge PR removes the gap.
 */
import http from 'node:http';

import fs from 'node:fs';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getSession, getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { DEFAULT_ALIVE_THRESHOLD_MS } from '../../parachute/group-status.js';
import { heartbeatPath } from '../../session-manager.js';

interface SessionView {
  id: string;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  messagingGroupId: string | null;
  status: 'active' | 'closed';
  containerStatus: 'running' | 'idle' | 'stopped';
  alive: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  lastHeartbeatAt: string | null;
}

function readHeartbeatMtimeMs(agentGroupId: string, sessionId: string): number {
  try {
    return fs.statSync(heartbeatPath(agentGroupId, sessionId)).mtimeMs;
  } catch {
    return 0;
  }
}

function listAllSessions(): SessionView[] {
  const nowMs = Date.now();
  const out: SessionView[] = [];
  for (const group of getAllAgentGroups()) {
    for (const s of getSessionsByAgentGroup(group.id)) {
      const heartbeatMs = readHeartbeatMtimeMs(group.id, s.id);
      const alive = heartbeatMs > 0 && nowMs - heartbeatMs <= DEFAULT_ALIVE_THRESHOLD_MS;
      out.push({
        id: s.id,
        agentGroupId: group.id,
        agentGroupFolder: group.folder,
        agentGroupName: group.name,
        messagingGroupId: s.messaging_group_id,
        status: s.status,
        containerStatus: s.container_status,
        alive,
        createdAt: s.created_at,
        lastActiveAt: s.last_active,
        lastHeartbeatAt: heartbeatMs > 0 ? new Date(heartbeatMs).toISOString() : null,
      });
    }
  }
  // Newest first — matches the UI's natural reading order.
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const error = (res: http.ServerResponse, status: number, message: string): void =>
  json(res, status, { error: message });

export interface SessionsRouteContext {
  pathname: string;
  method: string;
  res: http.ServerResponse;
}

export async function handleSessionsRoute(ctx: SessionsRouteContext): Promise<boolean> {
  const { pathname, method, res } = ctx;

  if (pathname === '/api/sessions' && method === 'GET') {
    json(res, 200, { sessions: listAllSessions() });
    return true;
  }

  // POST /api/sessions/:id/close
  const closeMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/close$/);
  if (closeMatch && method === 'POST') {
    const id = decodeURIComponent(closeMatch[1]);
    const session = getSession(id);
    if (!session) {
      error(res, 404, `session not found: ${id}`);
      return true;
    }
    if (session.status === 'closed') {
      // Idempotent — already closed, return the current view.
      json(res, 200, { id, status: 'closed' });
      return true;
    }
    updateSession(id, { status: 'closed', container_status: 'stopped' });
    log.info('session closed via web', { sessionId: id });
    json(res, 200, { id, status: 'closed' });
    return true;
  }

  return false;
}

