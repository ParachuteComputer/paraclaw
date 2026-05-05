/**
 * /api/groups/:folder/activity and /api/sessions/:id/activity — read-only
 * tool-invocation feed. Rows are merged into central agent_activity by the
 * delivery loop in src/delivery.ts; this route just paginates them out.
 *
 * Auth: agent:read. Listing tool calls leaks no plaintext (target is the
 * tool name, summary is null today), but it does expose what the agent has
 * been doing — operator-only by design.
 */
import http from 'node:http';

import { listActivityByAgentGroup, listActivityBySession } from '../../db/agent-activity.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

interface ActivityView {
  id: string;
  agentGroupId: string;
  sessionId: string;
  kind: string;
  target: string | null;
  summary: string | null;
  createdAt: string;
}

function toView(r: {
  id: string;
  agent_group_id: string;
  session_id: string;
  kind: string;
  target: string | null;
  summary: string | null;
  created_at: string;
}): ActivityView {
  return {
    id: r.id,
    agentGroupId: r.agent_group_id,
    sessionId: r.session_id,
    kind: r.kind,
    target: r.target,
    summary: r.summary,
    createdAt: r.created_at,
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const error = (res: http.ServerResponse, status: number, message: string): void =>
  json(res, status, { error: message });

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_LIMIT;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

export interface ActivityRouteContext {
  pathname: string;
  method: string;
  url: URL;
  res: http.ServerResponse;
}

export async function handleActivityRoute(ctx: ActivityRouteContext): Promise<boolean> {
  const { pathname, method, url, res } = ctx;
  if (method !== 'GET') return false;

  const groupMatch = pathname.match(/^\/api\/groups\/([^/]+)\/activity$/);
  if (groupMatch) {
    const folder = decodeURIComponent(groupMatch[1]);
    const group = getAgentGroupByFolder(folder);
    if (!group) {
      error(res, 404, `agent group not found: ${folder}`);
      return true;
    }
    const since = url.searchParams.get('since') ?? undefined;
    const limit = parseLimit(url.searchParams.get('limit'));
    const rows = listActivityByAgentGroup(group.id, { since, limit });
    json(res, 200, { activity: rows.map(toView) });
    return true;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/activity$/);
  if (sessionMatch) {
    const id = decodeURIComponent(sessionMatch[1]);
    const session = getSession(id);
    if (!session) {
      error(res, 404, `session not found: ${id}`);
      return true;
    }
    const since = url.searchParams.get('since') ?? undefined;
    const limit = parseLimit(url.searchParams.get('limit'));
    const rows = listActivityBySession(id, { since, limit });
    json(res, 200, { activity: rows.map(toView) });
    return true;
  }

  return false;
}
