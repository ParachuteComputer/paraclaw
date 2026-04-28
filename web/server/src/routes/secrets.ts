/**
 * /api/secrets — CRUD over paraclaw's local AES-256-GCM secret store.
 *
 * Every endpoint requires `claw:write` for mutation, `claw:read` for the
 * list-metadata view. Plaintext values are accepted on PUT and never
 * returned by any GET — listSecrets() is metadata-only by design. There is
 * no "show value" endpoint; if a human needs the value they should re-mint
 * (or back it out via the original platform's UI).
 */
import http from 'node:http';

import {
  type AssignedMode,
  type SecretKind,
  type SecretRow,
  deleteSecret,
  listSecrets,
  putSecret,
} from '../../../../src/secrets/index.js';

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
  createdAt: string;
  updatedAt: string;
}

function toView(r: SecretRow): SecretView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    agentGroupId: r.agent_group_id,
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
  assigned_mode?: string;
  host_pattern?: string | null;
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
    json(res, 200, { secrets: rows.map(toView) });
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
    const mode = (body.assigned_mode ?? 'all') as AssignedMode;
    if (!ALLOWED_MODES.includes(mode)) {
      error(res, 400, `invalid assigned_mode: ${mode}`);
      return true;
    }

    const agentGroupId = body.agentGroupId ?? body.agent_group_id ?? null;
    const id = putSecret(name, body.value, {
      kind,
      agent_group_id: agentGroupId,
      assigned_mode: mode,
      host_pattern: body.host_pattern ?? null,
    });
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
