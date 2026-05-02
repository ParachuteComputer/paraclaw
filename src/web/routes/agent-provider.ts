/**
 * `/api/settings/agent-provider` — read + write the install-wide
 * agent-provider credential source (paraclaw#78).
 * `/api/groups/:folder/agent-provider` — per-agent-group override
 * (paraclaw#86); same shape, scoped to the group's id. Both back the
 * `/claw/settings/agent-provider` and `/claw/groups/<folder>` UIs.
 *
 * Three sources, all paste-only:
 *   - `claude_setup_token` — operator runs `claude setup-token` on a host
 *     where they're authenticated to a Pro/Max/Team/Enterprise subscription
 *     and pastes the printed token. Container gets `CLAUDE_CODE_OAUTH_TOKEN`.
 *   - `anthropic_api_key` — Anthropic Console API key. Container gets
 *     `ANTHROPIC_API_KEY`.
 *   - `external_server` — self-hosted Claude proxy or a vendor that speaks
 *     the Anthropic API. Container gets `ANTHROPIC_API_KEY` + `ANTHROPIC_BASE_URL`.
 *
 * Security note: the secret value (token / key) is never returned in
 * responses. The GET shape exposes only "is this slot populated?" via
 * boolean flags, so the operator can see what's configured without
 * pulling secrets out of the encrypted store and into a browser.
 *
 * Audit log: source changes emit `audit: 'agent_provider_source_changed'`
 * via structured `log.info`, mirroring the PR4 sender-approval pattern.
 * Per-group changes carry an `agentGroupId` field; per-group clear emits
 * `audit: 'agent_provider_override_cleared'`.
 */
import http from 'node:http';

import { log } from '../../log.js';
import {
  DEFAULT_SCOPE_ID,
  deleteProviderCredentials,
  putProviderCredentials,
  readProviderCredentials,
  type ProviderSource,
} from '../../modules/provider-credentials/index.js';

interface AgentProviderView {
  source: ProviderSource | null;
  hasApiKey: boolean;
  serverUrl: string | null;
  updatedAt: string | null;
}

/**
 * Per-group response shape: same fields as the install-wide view, plus
 * `overridden` (true iff a row exists for this agent_group_id) and an
 * `effective` snapshot of what spawn would actually use right now —
 * either the override or the inherited default. The UI uses
 * `overridden` to decide between "Override default" and "Clear
 * override" affordances.
 */
export interface GroupAgentProviderView {
  agentGroupId: string;
  overridden: boolean;
  override: AgentProviderView;
  effective: AgentProviderView;
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

function viewForScope(scopeId: string): AgentProviderView {
  const row = readProviderCredentials(scopeId);
  return {
    source: row?.source ?? null,
    hasApiKey: !!row?.apiKey,
    serverUrl: row?.serverUrl ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

export function readAgentProviderView(): AgentProviderView {
  return viewForScope(DEFAULT_SCOPE_ID);
}

export function readGroupAgentProviderView(agentGroupId: string): GroupAgentProviderView {
  const overrideRow = readProviderCredentials(agentGroupId);
  const override = viewForScope(agentGroupId);
  const effective = overrideRow ? override : viewForScope(DEFAULT_SCOPE_ID);
  return {
    agentGroupId,
    overridden: overrideRow != null,
    override,
    effective,
  };
}

interface SetAgentProviderBody {
  source?: ProviderSource;
  apiKey?: string;
  serverUrl?: string;
}

const VALID_SOURCES: ProviderSource[] = ['claude_setup_token', 'anthropic_api_key', 'external_server'];

export interface SetAgentProviderResult {
  ok: true;
  view: AgentProviderView;
}

export interface SetAgentProviderError {
  ok: false;
  status: number;
  message: string;
}

export function setAgentProvider(
  body: SetAgentProviderBody,
  actor: string | null,
): SetAgentProviderResult | SetAgentProviderError {
  const result = applySetForScope(body, DEFAULT_SCOPE_ID, actor, null);
  if (!result.ok) return result;
  return { ok: true, view: readAgentProviderView() };
}

export interface SetGroupAgentProviderResult {
  ok: true;
  view: GroupAgentProviderView;
}

export function setGroupAgentProvider(
  body: SetAgentProviderBody,
  agentGroupId: string,
  actor: string | null,
): SetGroupAgentProviderResult | SetAgentProviderError {
  const result = applySetForScope(body, agentGroupId, actor, agentGroupId);
  if (!result.ok) return result;
  return { ok: true, view: readGroupAgentProviderView(agentGroupId) };
}

export interface ClearGroupAgentProviderResult {
  ok: true;
  view: GroupAgentProviderView;
  cleared: boolean;
}

export function clearGroupAgentProvider(agentGroupId: string, actor: string | null): ClearGroupAgentProviderResult {
  const previous = readProviderCredentials(agentGroupId);
  const cleared = deleteProviderCredentials(agentGroupId);
  if (cleared) {
    log.info('Agent-provider override cleared', {
      audit: 'agent_provider_override_cleared',
      agentGroupId,
      fromSource: previous?.source ?? null,
      actor,
    });
  }
  return { ok: true, view: readGroupAgentProviderView(agentGroupId), cleared };
}

function applySetForScope(
  body: SetAgentProviderBody,
  scopeId: string,
  actor: string | null,
  agentGroupId: string | null,
): { ok: true } | SetAgentProviderError {
  const { source, apiKey, serverUrl } = body;
  if (!source || !VALID_SOURCES.includes(source)) {
    return { ok: false, status: 400, message: `source must be one of ${VALID_SOURCES.join(', ')}` };
  }

  const previous = readProviderCredentials(scopeId);
  const previousSource = previous?.source ?? null;

  switch (source) {
    case 'claude_setup_token': {
      if (!apiKey || !apiKey.trim()) {
        return { ok: false, status: 400, message: 'apiKey is required for claude_setup_token' };
      }
      putProviderCredentials({ scopeId, source, apiKey: apiKey.trim(), serverUrl: null });
      break;
    }
    case 'anthropic_api_key': {
      if (!apiKey || !apiKey.trim()) {
        return { ok: false, status: 400, message: 'apiKey is required for anthropic_api_key' };
      }
      putProviderCredentials({ scopeId, source, apiKey: apiKey.trim(), serverUrl: null });
      break;
    }
    case 'external_server': {
      if (!apiKey || !apiKey.trim()) {
        return { ok: false, status: 400, message: 'apiKey is required for external_server' };
      }
      if (!serverUrl || !serverUrl.trim()) {
        return { ok: false, status: 400, message: 'serverUrl is required for external_server' };
      }
      try {
        new URL(serverUrl);
      } catch {
        return { ok: false, status: 400, message: 'serverUrl must be a valid URL' };
      }
      putProviderCredentials({
        scopeId,
        source,
        apiKey: apiKey.trim(),
        serverUrl: serverUrl.trim(),
      });
      break;
    }
  }

  log.info('Agent-provider source updated', {
    audit: 'agent_provider_source_changed',
    fromSource: previousSource,
    toSource: source,
    actor,
    agentGroupId,
    // Don't log apiKey — that's the secret.
    hasServerUrl: source === 'external_server' && !!serverUrl,
  });

  return { ok: true };
}

export interface AgentProviderRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** Hub-issued JWT subject for the audit line. */
  actorSubject: string | null;
}

export async function handleAgentProviderRoute(ctx: AgentProviderRouteContext): Promise<boolean> {
  const { pathname, method, req, res, actorSubject } = ctx;
  if (pathname !== '/api/settings/agent-provider') return false;

  if (method === 'GET') {
    json(res, 200, readAgentProviderView());
    return true;
  }
  if (method === 'POST') {
    let body: SetAgentProviderBody;
    try {
      body = await readJsonBody<SetAgentProviderBody>(req);
    } catch {
      error(res, 400, 'invalid JSON body');
      return true;
    }
    const result = setAgentProvider(body, actorSubject);
    if (!result.ok) {
      error(res, result.status, result.message);
      return true;
    }
    json(res, 200, result.view);
    return true;
  }
  error(res, 405, `${method} not allowed`);
  return true;
}

export interface GroupAgentProviderRouteContext {
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  agentGroupId: string;
  actorSubject: string | null;
}

/**
 * Per-group agent-provider sub-route. Mounted under
 * `/api/groups/:folder/agent-provider`; the caller has already resolved
 * folder → agentGroupId and gated on the right `claw:*` scope.
 *
 *   - GET    → `GroupAgentProviderView` (override + effective + flag)
 *   - POST   → set / replace the override
 *   - DELETE → clear the override (idempotent — 200 either way)
 */
export async function handleGroupAgentProviderRoute(ctx: GroupAgentProviderRouteContext): Promise<void> {
  const { method, req, res, agentGroupId, actorSubject } = ctx;
  if (method === 'GET') {
    json(res, 200, readGroupAgentProviderView(agentGroupId));
    return;
  }
  if (method === 'POST') {
    let body: SetAgentProviderBody;
    try {
      body = await readJsonBody<SetAgentProviderBody>(req);
    } catch {
      error(res, 400, 'invalid JSON body');
      return;
    }
    const result = setGroupAgentProvider(body, agentGroupId, actorSubject);
    if (!result.ok) {
      error(res, result.status, result.message);
      return;
    }
    json(res, 200, result.view);
    return;
  }
  if (method === 'DELETE') {
    const result = clearGroupAgentProvider(agentGroupId, actorSubject);
    json(res, 200, result.view);
    return;
  }
  error(res, 405, `${method} not allowed`);
}
