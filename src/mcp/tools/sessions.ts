/**
 * MCP tools for the per-session surface — list / get / close. Mirrors
 * `/api/sessions` (and uses the same heartbeat-mtime liveness computation
 * via DEFAULT_ALIVE_THRESHOLD_MS) but calls the internal helpers directly
 * rather than HTTP-round-tripping.
 *
 * `close-session` calls `killContainer` to actually stop the running
 * container. Idempotent: calling again on an already-closed session is
 * a no-op that returns the current view.
 */
import fs from 'node:fs';

import { getAllAgentGroups } from '../../db/agent-groups.js';
import { getSession, getSessionsByAgentGroup, updateSession } from '../../db/sessions.js';
import { killContainer } from '../../container-runner.js';
import { DEFAULT_ALIVE_THRESHOLD_MS } from '../../parachute/group-status.js';
import { heartbeatPath } from '../../session-manager.js';
import type { ToolDef } from '../types.js';

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

function listAllSessions(opts: { folder?: string; status?: 'active' | 'closed' } = {}): SessionView[] {
  const nowMs = Date.now();
  const out: SessionView[] = [];
  for (const group of getAllAgentGroups()) {
    if (opts.folder && group.folder !== opts.folder) continue;
    for (const s of getSessionsByAgentGroup(group.id)) {
      if (opts.status && s.status !== opts.status) continue;
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
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export const sessionTools: ToolDef[] = [
  {
    name: 'list-sessions',
    description:
      'List sessions across the install. Optional filters: folder (one agent group only) and status (active|closed). Liveness uses the heartbeat mtime.',
    scope: 'claw:read',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Optional agent-group folder filter.' },
        status: { type: 'string', enum: ['active', 'closed'], description: 'Optional status filter.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const folder = typeof args.folder === 'string' && args.folder.length ? args.folder : undefined;
      const status = args.status === 'active' || args.status === 'closed' ? args.status : undefined;
      return { sessions: listAllSessions({ folder, status }) };
    },
  },
  {
    name: 'get-session',
    description: 'Look up a single session by id. Throws when the id is unknown.',
    scope: 'claw:read',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Session id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const session = getSession(id);
      if (!session) throw new Error(`session not found: ${id}`);
      const all = listAllSessions();
      const view = all.find((v) => v.id === id);
      if (!view) throw new Error(`session not found in listing: ${id}`);
      return view;
    },
  },
  {
    name: 'close-session',
    description:
      "Close a session: mark the row status='closed' and call killContainer to actually stop the container. Idempotent — already-closed sessions return the current view without re-killing.",
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Session id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const session = getSession(id);
      if (!session) throw new Error(`session not found: ${id}`);
      if (session.status === 'closed') {
        return { id, status: 'closed', alreadyClosed: true };
      }
      updateSession(id, { status: 'closed', container_status: 'stopped' });
      killContainer(id, 'closed via mcp');
      return { id, status: 'closed' };
    },
  },
];
