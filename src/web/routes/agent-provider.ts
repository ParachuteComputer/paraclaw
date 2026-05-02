/**
 * `/api/settings/agent-provider` — read + write the install-wide
 * agent-provider credential source (paraclaw#78). Backs the
 * `/claw/settings/agent-provider` page.
 *
 * Security note: `credentialsJson` and `apiKey` are never returned in
 * responses. The GET shape exposes only "is this slot populated?" via
 * boolean flags, so the operator can see what's configured without
 * pulling secrets out of the encrypted store and into a browser.
 *
 * Audit log: source changes emit `audit: 'agent_provider_source_changed'`
 * via structured `log.info`, mirroring the PR4 sender-approval pattern.
 */
import http from 'node:http';

import { log } from '../../log.js';
import {
  DEFAULT_SCOPE_ID,
  hasClaudeCodeOAuth,
  putProviderCredentials,
  readClaudeCodeOAuth,
  readProviderCredentials,
  type ProviderSource,
} from '../../modules/provider-credentials/index.js';

interface AgentProviderView {
  source: ProviderSource | null;
  hasStoredCredentials: boolean;
  hasApiKey: boolean;
  serverUrl: string | null;
  /** Live host file presence — drives the "auto-detected from Claude Code" hint. */
  hostHasClaudeCodeOAuth: boolean;
  updatedAt: string | null;
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

export function readAgentProviderView(): AgentProviderView {
  const row = readProviderCredentials(DEFAULT_SCOPE_ID);
  return {
    source: row?.source ?? null,
    hasStoredCredentials: !!row?.credentialsJson,
    hasApiKey: !!row?.apiKey,
    serverUrl: row?.serverUrl ?? null,
    hostHasClaudeCodeOAuth: hasClaudeCodeOAuth(),
    updatedAt: row?.updatedAt ?? null,
  };
}

interface SetAgentProviderBody {
  source?: ProviderSource;
  apiKey?: string;
  serverUrl?: string;
}

const VALID_SOURCES: ProviderSource[] = ['claude_code_oauth', 'anthropic_api_key', 'external_server'];

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
  const { source, apiKey, serverUrl } = body;
  if (!source || !VALID_SOURCES.includes(source)) {
    return { ok: false, status: 400, message: `source must be one of ${VALID_SOURCES.join(', ')}` };
  }

  const previous = readProviderCredentials(DEFAULT_SCOPE_ID);
  const previousSource = previous?.source ?? null;

  switch (source) {
    case 'claude_code_oauth': {
      // Snapshot the host file at switch-time so the spawn fallback has
      // something to use the moment the host file rotates / disappears.
      // Re-reads at every spawn override this, so the snapshot only
      // matters during fallback windows.
      const live = readClaudeCodeOAuth();
      if (!live) {
        return {
          ok: false,
          status: 422,
          message:
            'Claude Code OAuth not found at ~/.claude/.credentials.json. Run `claude login` first or pick a different source.',
        };
      }
      putProviderCredentials({ source, credentialsJson: live, apiKey: null, serverUrl: null });
      break;
    }
    case 'anthropic_api_key': {
      if (!apiKey || !apiKey.trim()) {
        return { ok: false, status: 400, message: 'apiKey is required for anthropic_api_key' };
      }
      putProviderCredentials({ source, credentialsJson: null, apiKey: apiKey.trim(), serverUrl: null });
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
        source,
        credentialsJson: null,
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
    // Don't log apiKey / credentialsJson — those are secrets.
    hasServerUrl: source === 'external_server' && !!serverUrl,
  });

  return { ok: true, view: readAgentProviderView() };
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
