/**
 * /api/secrets — CRUD over paraclaw's local AES-256-GCM secret store.
 *
 * Auth: `claw:admin` for mutation (POST/PUT/DELETE), `claw:read` for GET.
 * The mutation gate is admin-not-write because a write-only token would
 * otherwise be enough to swap any vault credential and silently MITM
 * downstream API calls. Plaintext values are accepted on POST and never
 * returned by any GET — `listSecrets()` is metadata-only by design. There
 * is no "show value" endpoint; if a human needs the value they should
 * re-mint (or back it out via the original platform's UI).
 */
import http from 'node:http';

import { getAgentGroupSecretMode, getAgentGroupSecretModes, setAgentGroupSecretMode } from '../../db/agent-groups.js';
import {
  type AssignedMode,
  type SecretKind,
  type SecretRow,
  addAssignment,
  deleteSecret,
  findStaleSessionsForSecret,
  getSecretById,
  listAssignments,
  listSecrets,
  putSecret,
  removeAssignment,
  replaceAssignments,
} from '../../secrets/index.js';
import type { SecretMode } from '../../types.js';

const ALLOWED_KINDS: SecretKind[] = ['channel-token', 'api-key', 'generic'];
const ALLOWED_MODES: AssignedMode[] = ['all', 'selective'];

// Camel-cased view shape consumed by `web/ui/src/lib/api.ts:SecretView`.
// The DB layer stores snake_case; we transform at the boundary so the UI
// stays in idiomatic JS and the storage stays in idiomatic SQL.
interface SecretView {
  id: string;
  name: string;
  kind: SecretKind;
  agentGroupId: string | null;
  assignedMode: 'all' | 'selective';
  createdAt: string;
  updatedAt: string;
}

/**
 * Per-secret `assignedMode` is now derived from the recipient agent group's
 * `secret_mode` (paraclaw#9 — modes moved off the per-secret row). For a
 * scoped secret we read its containing group; globals report `'all'` because
 * a global is unconditionally in-scope and the recipient group's mode gates
 * actual injection. Field stays in the response shape for UI continuity.
 *
 * Pass `modes` when projecting a list — callers prefetch one query for all
 * groups touched by the rows, avoiding the per-row SELECT this helper would
 * otherwise issue. Single-row paths can omit it.
 */
function toView(r: SecretRow, modes?: Map<string, SecretMode>): SecretView {
  const assignedMode: AssignedMode = r.agent_group_id
    ? ((modes ? modes.get(r.agent_group_id) : getAgentGroupSecretMode(r.agent_group_id)) ?? 'selective')
    : 'all';
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    agentGroupId: r.agent_group_id,
    assignedMode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

interface PutBody {
  name?: string;
  value?: string;
  kind?: string;
  // Both the snake_case (legacy) and camelCase (UI) forms are accepted on
  // input — saves a coordinated migration, costs one or-fallback line.
  agent_group_id?: string | null;
  agentGroupId?: string | null;
  /**
   * Accepted on POST for backward-compatibility with the existing UI/MCP
   * callers that still send it. Now applies to the recipient agent_group
   * (paraclaw#9): scoped secret + assigned_mode='all' flips the parent
   * group's secret_mode to 'all'. No-op for globals (no parent group).
   */
  assigned_mode?: string;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const error = (res: http.ServerResponse, status: number, message: string): void =>
  json(res, status, { error: message });

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

export interface SecretsRouteContext {
  pathname: string;
  method: string;
  url: URL;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

/**
 * Returns true if the route handled the request, false to fall through.
 */
export async function handleSecretsRoute(ctx: SecretsRouteContext): Promise<boolean> {
  const { pathname, method, url, req, res } = ctx;

  if (pathname === '/api/secrets' && method === 'GET') {
    const groupParam = url.searchParams.get('agent_group_id');
    let scope: string | null | undefined = undefined;
    if (groupParam !== null) scope = groupParam === '' ? null : groupParam;
    const rows = listSecrets(scope);
    const groupIds = [...new Set(rows.map((r) => r.agent_group_id).filter((x): x is string => !!x))];
    const modes = getAgentGroupSecretModes(groupIds);
    json(res, 200, { secrets: rows.map((r) => toView(r, modes)) });
    return true;
  }

  if (pathname === '/api/secrets' && method === 'POST') {
    let body: PutBody;
    try {
      body = await readJsonBody<PutBody>(req);
    } catch {
      error(res, 400, 'invalid JSON body');
      return true;
    }
    const name = (body.name ?? '').trim();
    if (!name) {
      error(res, 400, 'name is required');
      return true;
    }
    if (typeof body.value !== 'string' || body.value.length === 0) {
      error(res, 400, 'value is required');
      return true;
    }
    const kind = (body.kind ?? 'generic') as SecretKind;
    if (!ALLOWED_KINDS.includes(kind)) {
      error(res, 400, `invalid kind: ${kind}`);
      return true;
    }
    const mode = body.assigned_mode === undefined ? undefined : (body.assigned_mode as AssignedMode);
    if (mode !== undefined && !ALLOWED_MODES.includes(mode)) {
      error(res, 400, `invalid assigned_mode: ${mode}`);
      return true;
    }

    const agentGroupId = body.agentGroupId ?? body.agent_group_id ?? null;
    const id = putSecret(name, body.value, {
      kind,
      agent_group_id: agentGroupId,
    });
    if (mode !== undefined && agentGroupId) {
      setAgentGroupSecretMode(agentGroupId, mode);
    }
    // Re-read so the response carries the canonical timestamps the upsert
    // wrote (rather than guessing). Same scope filter — listSecrets returns
    // both global + scoped rows when scope is the agent id, so we narrow
    // by id manually. Fast path: in practice <100 secrets per install.
    const view = listSecrets(agentGroupId).find((r) => r.id === id);
    if (!view) {
      // Should never happen — putSecret just wrote the row. Surfaced as
      // 500 so a regression is loud, not silently masked.
      error(res, 500, `secret ${id} disappeared between write and read`);
      return true;
    }
    json(res, 200, { secret: toView(view) });
    return true;
  }

  // Stale-sessions probe — match before the bare /:id DELETE so the more-specific
  // path wins. Surface for the post-save banner: which running containers were
  // spawned BEFORE this secret's last update AND would inject it on next spawn?
  const staleMatch = pathname.match(/^\/api\/secrets\/([^/]+)\/stale-sessions$/);
  if (staleMatch && method === 'GET') {
    const id = decodeURIComponent(staleMatch[1]);
    const meta = getSecretById(id);
    if (!meta) {
      error(res, 404, `secret not found: ${id}`);
      return true;
    }
    const stale = findStaleSessionsForSecret(id);
    json(res, 200, {
      secretId: id,
      secretUpdatedAt: meta.updated_at,
      staleSessions: stale,
    });
    return true;
  }

  // Assignments — match before the bare /:id DELETE so the more-specific path wins.
  const assignOne = pathname.match(/^\/api\/secrets\/([^/]+)\/assignments\/([^/]+)$/);
  if (assignOne && method === 'DELETE') {
    const secretId = decodeURIComponent(assignOne[1]);
    const groupId = decodeURIComponent(assignOne[2]);
    const ok = removeAssignment(secretId, groupId);
    if (!ok) {
      error(res, 404, `assignment not found: ${secretId} -> ${groupId}`);
      return true;
    }
    json(res, 200, { secretId, agentGroupId: groupId, removed: true });
    return true;
  }

  const assignList = pathname.match(/^\/api\/secrets\/([^/]+)\/assignments$/);
  if (assignList) {
    const secretId = decodeURIComponent(assignList[1]);
    if (method === 'GET') {
      json(res, 200, { secretId, agentGroupIds: listAssignments(secretId) });
      return true;
    }
    if (method === 'PUT') {
      let body: { agentGroupIds?: unknown };
      try {
        body = await readJsonBody<{ agentGroupIds?: unknown }>(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      const ids = body.agentGroupIds;
      if (!Array.isArray(ids) || !ids.every((x) => typeof x === 'string')) {
        error(res, 400, 'agentGroupIds must be a string[]');
        return true;
      }
      try {
        replaceAssignments(secretId, ids as string[]);
      } catch (err) {
        error(res, 404, err instanceof Error ? err.message : String(err));
        return true;
      }
      json(res, 200, { secretId, agentGroupIds: listAssignments(secretId) });
      return true;
    }
    if (method === 'POST') {
      let body: { agentGroupId?: unknown };
      try {
        body = await readJsonBody<{ agentGroupId?: unknown }>(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      if (typeof body.agentGroupId !== 'string' || !body.agentGroupId.trim()) {
        error(res, 400, 'agentGroupId is required');
        return true;
      }
      try {
        addAssignment(secretId, body.agentGroupId);
      } catch (err) {
        // Likely a FK violation (unknown secret_id or agent_group_id).
        // Return 400 rather than 500 so the UI can surface a clean message.
        error(res, 400, err instanceof Error ? err.message : String(err));
        return true;
      }
      json(res, 201, { secretId, agentGroupId: body.agentGroupId, added: true });
      return true;
    }
  }

  const del = pathname.match(/^\/api\/secrets\/([^/]+)$/);
  if (del && method === 'DELETE') {
    const id = decodeURIComponent(del[1]);
    const ok = deleteSecret(id);
    if (!ok) {
      error(res, 404, `secret not found: ${id}`);
      return true;
    }
    json(res, 200, { id, deleted: true });
    return true;
  }

  return false;
}
