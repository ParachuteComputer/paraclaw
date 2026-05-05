/**
 * Activity-log MCP tool. Mirrors `/api/groups/:folder/activity` and
 * `/api/sessions/:id/activity` — read-only feed of tool invocations from
 * the central `agent_activity` table. Same auth scope (`agent:read`) and
 * the same default/max limits the HTTP route enforces.
 *
 * One of `agentGroupId` or `sessionId` is required; if both are given the
 * session filter wins (it's a strict subset of the group). Targets are
 * canonical ids — not folders — because the MCP surface is id-keyed
 * elsewhere (sessions, secrets, approvals).
 */
import { listActivityByAgentGroup, listActivityBySession } from '../../db/agent-activity.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getSession } from '../../db/sessions.js';
import type { ToolDef } from '../types.js';

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

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(raw), MAX_LIMIT);
}

export const activityTools: ToolDef[] = [
  {
    name: 'get-activity',
    description:
      'List recent agent tool invocations from agent_activity. Requires either agentGroupId or sessionId; if both, sessionId wins. Optional `since` (ISO 8601) returns only newer rows. Default limit 100, hard-capped at 500.',
    scope: 'agent:read',
    inputSchema: {
      type: 'object',
      properties: {
        agentGroupId: { type: 'string', description: 'Agent group id (canonical, not folder).' },
        sessionId: { type: 'string', description: 'Session id. Wins over agentGroupId if both given.' },
        since: { type: 'string', description: 'Only return rows with created_at > this ISO 8601 timestamp.' },
        limit: { type: 'number', description: 'Max rows. Defaults to 100, capped at 500.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const sessionId = typeof args.sessionId === 'string' && args.sessionId.length ? args.sessionId : null;
      const agentGroupId = typeof args.agentGroupId === 'string' && args.agentGroupId.length ? args.agentGroupId : null;
      if (!sessionId && !agentGroupId) {
        throw new Error('one of agentGroupId or sessionId is required');
      }
      const since = typeof args.since === 'string' && args.since.length ? args.since : undefined;
      const limit = clampLimit(args.limit);

      if (sessionId) {
        if (!getSession(sessionId)) throw new Error(`session not found: ${sessionId}`);
        return { activity: listActivityBySession(sessionId, { since, limit }).map(toView) };
      }
      if (!getAgentGroup(agentGroupId!)) throw new Error(`agent group not found: ${agentGroupId}`);
      return { activity: listActivityByAgentGroup(agentGroupId!, { since, limit }).map(toView) };
    },
  },
];
