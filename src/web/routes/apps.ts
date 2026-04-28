/**
 * /api/apps — OAuth integrations surface.
 *
 *   GET / PUT / DELETE /api/apps/:provider/config       BYOC client config
 *   POST            /api/apps/:provider/authorize       mint redirect URL
 *   GET             /api/apps/:provider/callback        token exchange
 *   GET             /api/apps                            list connections
 *   DELETE          /api/apps/:id                        revoke + delete
 *   GET / PUT       /api/apps/:id/agents                 manage allowlist
 *
 * Encrypted columns (`client_secret`, `access_token`, `refresh_token`)
 * are NEVER returned through any of these endpoints. The view shapes
 * below shape DB rows into camelCase JSON without the secret fields.
 *
 * Operator setup: register `${origin}/api/apps/<provider>/callback` as
 * an authorized redirect URI in the provider's OAuth client console.
 * The origin is derived from `req.headers.host` (or
 * `PARACLAW_WEB_ORIGIN` if set, for tunneled deployments).
 */
import http from 'node:http';

import {
  type AgentForConnection,
  listAgentsForConnection,
  setAgentsForConnection,
} from '../../oauth/agent-app-connections.js';
import {
  type AppConfigRow,
  deleteAppConfig,
  getAppConfig,
  getAppConfigWithSecret,
  listAppConfigs,
  putAppConfig,
} from '../../oauth/app-configs.js';
import {
  type AppConnectionRow,
  deleteAppConnection,
  getAppConnection,
  getAppConnectionWithTokens,
  listAppConnections,
  upsertAppConnection,
} from '../../oauth/app-connections.js';
import { buildAuthorizeUrl, exchangeCode, fetchUserinfo, revokeToken } from '../../oauth/flow.js';
import { getProvider } from '../../oauth/providers/index.js';
import { consumeState, mintState } from '../../oauth/state-store.js';
import { log } from '../../log.js';

interface AppConfigView {
  id: string;
  provider: string;
  clientId: string;
  scopesDefault: string;
  hasSecret: true;
  createdAt: string;
  updatedAt: string;
}

interface AppConnectionView {
  id: string;
  provider: string;
  appConfigId: string;
  accountEmail: string | null;
  accountId: string;
  scopesGranted: string;
  expiresAt: string | null;
  label: string;
  createdAt: string;
  updatedAt: string;
}

interface AgentAssignmentView {
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  createdAt: string;
}

function configToView(r: AppConfigRow): AppConfigView {
  return {
    id: r.id,
    provider: r.provider,
    clientId: r.client_id,
    scopesDefault: r.scopes_default,
    hasSecret: true,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function connectionToView(r: AppConnectionRow, provider: string): AppConnectionView {
  return {
    id: r.id,
    provider,
    appConfigId: r.app_config_id,
    accountEmail: r.account_email,
    accountId: r.account_id,
    scopesGranted: r.scopes_granted,
    expiresAt: r.expires_at,
    label: r.label,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function agentToView(r: AgentForConnection): AgentAssignmentView {
  return {
    agentGroupId: r.agent_group_id,
    agentGroupFolder: r.agent_group_folder,
    agentGroupName: r.agent_group_name,
    createdAt: r.created_at,
  };
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const error = (res: http.ServerResponse, status: number, message: string): void =>
  json(res, status, { error: message });

const redirect = (res: http.ServerResponse, location: string): void => {
  res.writeHead(302, { location });
  res.end();
};

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

function originFromReq(req: http.IncomingMessage): string {
  const env = process.env.PARACLAW_WEB_ORIGIN;
  if (env) return env.replace(/\/$/, '');
  const host = req.headers.host ?? 'localhost:1944';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? 'http';
  return `${proto}://${host}`;
}

function callbackUri(req: http.IncomingMessage, providerSlug: string): string {
  return `${originFromReq(req)}/api/apps/${providerSlug}/callback`;
}

/** Resolve a connection by id. Returns the resolved provider slug too. */
function resolveConnectionWithProvider(id: string): { row: AppConnectionRow; providerSlug: string } | undefined {
  const row = getAppConnection(id);
  if (!row) return undefined;
  // Cheap lookup back to the provider slug via the config row.
  const cfg = getAppConfigViaId(row.app_config_id);
  if (!cfg) return undefined;
  return { row, providerSlug: cfg.provider };
}

function getAppConfigViaId(id: string): AppConfigRow | undefined {
  // app_configs is provider-keyed at the lookup layer; we walk the
  // small list to find the row by id. Practical at <20 providers.
  for (const row of listAppConfigs()) {
    if (row.id === id) return row;
  }
  return undefined;
}

export interface AppsRouteContext {
  pathname: string;
  method: string;
  url: URL;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

const CONFIG_RE = /^\/api\/apps\/([^/]+)\/config$/;
const AUTHORIZE_RE = /^\/api\/apps\/([^/]+)\/authorize$/;
const CALLBACK_RE = /^\/api\/apps\/([^/]+)\/callback$/;
const AGENTS_RE = /^\/api\/apps\/([^/]+)\/agents$/;
const ID_RE = /^\/api\/apps\/([^/]+)$/;

export async function handleAppsRoute(ctx: AppsRouteContext): Promise<boolean> {
  const { pathname, method, url, req, res } = ctx;

  // List connections (no tokens, no secrets).
  if (pathname === '/api/apps' && method === 'GET') {
    const rows = listAppConnections();
    const providers = new Map<string, string>();
    for (const cfg of listAppConfigs()) providers.set(cfg.id, cfg.provider);
    json(res, 200, {
      connections: rows.map((r) => connectionToView(r, providers.get(r.app_config_id) ?? 'unknown')),
    });
    return true;
  }

  const cfgMatch = pathname.match(CONFIG_RE);
  if (cfgMatch) {
    const provider = decodeURIComponent(cfgMatch[1]);
    if (!getProvider(provider)) {
      error(res, 404, `unknown provider: ${provider}`);
      return true;
    }
    if (method === 'GET') {
      const row = getAppConfig(provider);
      if (!row) {
        error(res, 404, `no config for provider: ${provider}`);
        return true;
      }
      json(res, 200, { config: configToView(row) });
      return true;
    }
    if (method === 'PUT') {
      let body: { clientId?: string; clientSecret?: string; scopesDefault?: string };
      try {
        body = await readJsonBody(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      const clientId = (body.clientId ?? '').trim();
      const clientSecret = body.clientSecret ?? '';
      if (!clientId) {
        error(res, 400, 'clientId is required');
        return true;
      }
      if (!clientSecret) {
        error(res, 400, 'clientSecret is required');
        return true;
      }
      putAppConfig(provider, {
        client_id: clientId,
        client_secret: clientSecret,
        scopes_default: body.scopesDefault ?? '',
      });
      const row = getAppConfig(provider);
      if (!row) {
        error(res, 500, 'config disappeared between write and read');
        return true;
      }
      json(res, 200, { config: configToView(row) });
      return true;
    }
    if (method === 'DELETE') {
      const ok = deleteAppConfig(provider);
      if (!ok) {
        error(res, 404, `no config for provider: ${provider}`);
        return true;
      }
      json(res, 200, { provider, deleted: true });
      return true;
    }
  }

  const authMatch = pathname.match(AUTHORIZE_RE);
  if (authMatch && method === 'POST') {
    const providerSlug = decodeURIComponent(authMatch[1]);
    const provider = getProvider(providerSlug);
    if (!provider) {
      error(res, 404, `unknown provider: ${providerSlug}`);
      return true;
    }
    const cfg = getAppConfig(providerSlug);
    if (!cfg) {
      error(res, 409, `provider ${providerSlug} has no client config — PUT /api/apps/${providerSlug}/config first`);
      return true;
    }
    let body: { agentGroupId?: string | null; scopes?: string };
    try {
      body = await readJsonBody(req);
    } catch {
      error(res, 400, 'invalid JSON body');
      return true;
    }
    const redirectUri = callbackUri(req, providerSlug);
    const state = mintState({
      provider: providerSlug,
      agentGroupId: body.agentGroupId ?? null,
      redirectUri,
    });
    const authorizeUrl = buildAuthorizeUrl({
      provider,
      clientId: cfg.client_id,
      scopes: body.scopes || cfg.scopes_default || provider.defaultScopes,
      state,
      redirectUri,
    });
    json(res, 200, { authorizeUrl, state });
    return true;
  }

  const cbMatch = pathname.match(CALLBACK_RE);
  if (cbMatch && method === 'GET') {
    const providerSlug = decodeURIComponent(cbMatch[1]);
    const provider = getProvider(providerSlug);
    if (!provider) {
      error(res, 404, `unknown provider: ${providerSlug}`);
      return true;
    }
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    if (oauthError) {
      error(res, 400, `provider returned error: ${oauthError}`);
      return true;
    }
    if (!code || !state) {
      error(res, 400, 'missing code or state');
      return true;
    }
    const stateCtx = consumeState(state);
    if (!stateCtx) {
      error(res, 400, 'invalid or expired state');
      return true;
    }
    if (stateCtx.provider !== providerSlug) {
      error(res, 400, 'state/provider mismatch');
      return true;
    }
    const cfg = getAppConfigWithSecret(providerSlug);
    if (!cfg) {
      error(res, 409, `provider ${providerSlug} has no client config`);
      return true;
    }
    let tokens;
    try {
      tokens = await exchangeCode({
        provider,
        clientId: cfg.client_id,
        clientSecret: cfg.client_secret,
        code,
        redirectUri: stateCtx.redirectUri,
      });
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
      return true;
    }
    let userinfo: unknown;
    try {
      userinfo = await fetchUserinfo({ provider, accessToken: tokens.access_token });
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
      return true;
    }
    let extracted;
    try {
      extracted = provider.extractAccount(userinfo);
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
      return true;
    }
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : null;
    const connectionId = upsertAppConnection({
      app_config_id: cfg.id,
      account_id: extracted.accountId,
      account_email: extracted.accountEmail,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      scopes_granted: tokens.scope ?? '',
      expires_at: expiresAt,
      label: extracted.label,
      metadata_json: tokens.id_token ? JSON.stringify({ id_token: tokens.id_token }) : null,
    });
    if (stateCtx.agentGroupId) {
      try {
        const existing = listAgentsForConnection(connectionId).map((a) => a.agent_group_id);
        if (!existing.includes(stateCtx.agentGroupId)) {
          setAgentsForConnection(connectionId, [...existing, stateCtx.agentGroupId]);
        }
      } catch (err) {
        log.warn('oauth callback: failed to attach agent', {
          connectionId,
          agentGroupId: stateCtx.agentGroupId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Redirect back to the SPA. We don't know the SPA's deep-link;
    // the operator's UI handles `/apps?connected=<id>`. Fall back to
    // root if the mount-prefix env isn't set.
    const mount = (process.env.PARACLAW_WEB_MOUNT ?? '').replace(/\/$/, '');
    redirect(res, `${originFromReq(req)}${mount}/apps?connected=${connectionId}`);
    return true;
  }

  const agentsMatch = pathname.match(AGENTS_RE);
  if (agentsMatch) {
    const id = decodeURIComponent(agentsMatch[1]);
    if (!getAppConnection(id)) {
      error(res, 404, `connection not found: ${id}`);
      return true;
    }
    if (method === 'GET') {
      json(res, 200, { agents: listAgentsForConnection(id).map(agentToView) });
      return true;
    }
    if (method === 'PUT') {
      let body: { agentGroupIds?: string[] };
      try {
        body = await readJsonBody(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      if (!Array.isArray(body.agentGroupIds)) {
        error(res, 400, 'agentGroupIds must be a string[]');
        return true;
      }
      setAgentsForConnection(id, body.agentGroupIds);
      json(res, 200, { agents: listAgentsForConnection(id).map(agentToView) });
      return true;
    }
  }

  const idMatch = pathname.match(ID_RE);
  if (idMatch && method === 'DELETE') {
    const id = decodeURIComponent(idMatch[1]);
    const resolved = resolveConnectionWithProvider(id);
    if (!resolved) {
      error(res, 404, `connection not found: ${id}`);
      return true;
    }
    const provider = getProvider(resolved.providerSlug);
    if (provider) {
      const withTokens = getAppConnectionWithTokens(id);
      if (withTokens) {
        // Best-effort revocation; never blocks local delete.
        await revokeToken({ provider, accessToken: withTokens.access_token });
      }
    }
    deleteAppConnection(id);
    json(res, 200, { id, deleted: true });
    return true;
  }

  return false;
}
