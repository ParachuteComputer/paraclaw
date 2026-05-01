/**
 * Paraclaw web UI server.
 *
 * Same `/api/*` surface that previously lived in the standalone
 * `web/server/src/server.ts` package, now folded into the host process so a
 * single `bun src/index.ts` boots both the orchestrator and the web UI.
 *
 * Auth model: every `/api/*` route requires a hub-issued JWT — operator
 * token (CLI/scripts) or user OAuth (browser) — validated via JWKS against
 * the hub origin. Loopback bind is no longer load-bearing for safety; a
 * compromised browser extension on the same machine can hit 127.0.0.1, so
 * every endpoint auths. See `auth.ts` for the validation seam.
 *
 * Two endpoints stay unauthenticated: `/api/health` (operational probe)
 * and `/api/discovery` (returns hub origin so the SPA can bootstrap its
 * OAuth flow without baking the origin into the bundle).
 *
 * Static-serves the built UI bundle from `<projectRoot>/web/ui/dist` when
 * present; otherwise just exposes `/api/*`. In dev, run vite separately on
 * port 5173 with the proxy in `web/ui/vite.config.ts` pointing back here.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { CENTRAL_DB_PATH, DATA_DIR, GROUPS_DIR } from '../config.js';
import { openDb, type Database } from '../db/connection.js';
import {
  attachVaultToGroup,
  detachVaultFromGroup,
  readVaultAttachment,
  DEFAULT_VAULT_MCP_NAME,
} from '../parachute/vault-mcp.js';
import type { VaultScope } from '../parachute/types.js';
import {
  createParachuteAgentGroup,
  isFolderTaken,
  suggestFolderSlug,
  validateFolderSlug,
} from '../parachute/create-agent.js';
import { getGroupStatus, type GroupStatus } from '../parachute/group-status.js';
import { resolveSession } from '../session-manager.js';
import { wakeContainer } from '../container-runner.js';
import { log } from '../log.js';
import {
  authenticate,
  getHubOrigin,
  SCOPE_CLAW_ADMIN,
  SCOPE_CLAW_READ,
  SCOPE_CLAW_WRITE,
  type AuthResult,
  type ClawScope,
} from './auth.js';
import { handleMcpHttp } from '../mcp/http.js';
import { handleAppsRoute } from './routes/apps.js';
import { handleApprovalsRoute } from './routes/approvals.js';
import { handleChannelsRoute } from './routes/channels.js';
import { handleActivityRoute } from './routes/activity.js';
import { handleOauthProvidersRoute } from './routes/oauth-providers.js';
import { handleSecretsRoute } from './routes/secrets.js';
import { handleSessionsRoute } from './routes/sessions.js';
import { handleSetupStatusRoute } from './routes/setup-status.js';
import { handleVaultsRoute } from './routes/vaults.js';
import { forwardToVault, mintVaultTokenHttp } from './vault-proxy.js';
import { upsertService } from './services-manifest.js';
import { makeServeStatic, normalizeMount } from './static-serve.js';
import { wireDmToAgent } from './wire-channel.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { validateDiscordBotToken } from './discord-validate.js';
import { validateTelegramBotToken } from './telegram-validate.js';

const PROJECT_ROOT = process.cwd();
const UI_DIST = path.resolve(PROJECT_ROOT, 'web/ui/dist');
// Canonical Parachute slot per parachute-patterns/patterns/canonical-ports.md
// (1944, claimed for paraclaw 2026-04-27 via parachute-hub#…). Override
// via PARACLAW_WEB_PORT for tests / non-default deployments.
const PORT = Number(process.env.PARACLAW_WEB_PORT ?? 1944);
const HOST = process.env.PARACLAW_WEB_BIND ?? '127.0.0.1';
// When fronted by `parachute expose tailnet` at a path prefix, set
// PARACLAW_WEB_MOUNT to that prefix (e.g. `/claw`) so static-serve strips
// it before resolving against dist/. The hub-managed lifecycle (parachute-
// hub#83) sets this from `module.json` `paths[0]` automatically. Empty
// string = serve at the origin root (default).
const MOUNT = normalizeMount(process.env.PARACLAW_WEB_MOUNT ?? '');
const SERVICE_VERSION = '0.0.14-rc.7';

interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
}

interface AgentGroupView extends AgentGroupRow {
  vault: ReturnType<typeof readVaultAttachment>;
  status: GroupStatus | null;
}

function getReadonlyDb(): Database {
  if (!fs.existsSync(CENTRAL_DB_PATH)) {
    throw new Error(
      `central db not found at ${CENTRAL_DB_PATH} — has paraclaw been initialized? Run \`bun src/index.ts\` first.`,
    );
  }
  return openDb(CENTRAL_DB_PATH, { readonly: true });
}

function listAgentGroups(): AgentGroupView[] {
  const db = getReadonlyDb();
  try {
    const rows = db
      .prepare('SELECT id, name, folder, agent_provider, created_at FROM agent_groups ORDER BY created_at DESC')
      .all() as AgentGroupRow[];
    return rows.map((r) => ({
      ...r,
      vault: readVaultAttachment(r.folder),
      status: getGroupStatus(r.folder),
    }));
  } finally {
    db.close();
  }
}

function getAgentGroup(folder: string): AgentGroupView | null {
  const db = getReadonlyDb();
  try {
    const row = db
      .prepare('SELECT id, name, folder, agent_provider, created_at FROM agent_groups WHERE folder = ?')
      .get(folder) as AgentGroupRow | undefined;
    if (!row) return null;
    return {
      ...row,
      vault: readVaultAttachment(row.folder),
      status: getGroupStatus(row.folder),
    };
  } finally {
    db.close();
  }
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

const VALID_SCOPES: VaultScope[] = ['vault:read', 'vault:write', 'vault:admin'];

function send401or403(res: http.ServerResponse, fail: Extract<AuthResult, { ok: false }>): void {
  const body: Record<string, unknown> = { error: fail.error };
  if (fail.errorType) body.error_type = fail.errorType;
  if (fail.requiredScope) body.required_scope = fail.requiredScope;
  if (fail.grantedScopes) body.granted_scopes = fail.grantedScopes;
  if (fail.status === 401) {
    res.setHeader('WWW-Authenticate', 'Bearer');
  } else if (fail.errorType === 'insufficient_scope' && fail.requiredScope) {
    res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${fail.requiredScope}"`);
  }
  json(res, fail.status, body);
}

async function gate(req: http.IncomingMessage, res: http.ServerResponse, required: ClawScope): Promise<boolean> {
  const result = await authenticate(req.headers.authorization, required);
  if (result.ok) return true;
  send401or403(res, result);
  return false;
}

async function handleApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  pathname: string = url.pathname,
): Promise<void> {
  const method = req.method ?? 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    json(res, 200, {
      service: 'paraclaw-web-server',
      version: SERVICE_VERSION,
      data_dir: DATA_DIR,
      groups_dir: GROUPS_DIR,
    });
    return;
  }

  if (pathname === '/api/discovery' && method === 'GET') {
    json(res, 200, { hubOrigin: getHubOrigin() });
    return;
  }

  if (pathname === '/api/setup/status' && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    try {
      const handled = await handleSetupStatusRoute({ pathname, method, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/approvals' || pathname.startsWith('/api/approvals/')) {
    const required: ClawScope = method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_WRITE;
    const auth = await authenticate(req.headers.authorization, required);
    if (!auth.ok) {
      send401or403(res, auth);
      return;
    }
    try {
      const handled = await handleApprovalsRoute({ pathname, method, req, res, claims: auth.claims });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Token validation — pre-install, no DB writes, the wizard hits this from
  // /channels/new before persisting anything. claw:write is enough; the
  // /api/channels/* CRUD block below is admin-gated and would over-reject.
  //
  // We remap a validator status of 401 ("bot token rejected by upstream")
  // to HTTP 400 so the SPA's auth wrapper doesn't mistake an upstream
  // identity rejection for our hub-JWT being expired and trigger a
  // re-auth loop. Body still carries the precise validator status field.
  if (method === 'POST' && /^\/api\/channels\/[^/]+\/test$/.test(pathname)) {
    if (!(await gate(req, res, SCOPE_CLAW_WRITE))) return;
    const adapter = pathname.split('/')[3];
    if (adapter !== 'discord' && adapter !== 'telegram') {
      // Without this branch, slack/whatsapp/etc fall through to the
      // /api/channels/:id CRUD block and the operator sees a misleading
      // "channel wire not found" instead of a clean unknown-adapter 404.
      error(res, 404, `unknown adapter: ${adapter}`);
      return;
    }
    try {
      const body = await readJsonBody<{ token?: string }>(req);
      const token = body.token ?? '';
      const result =
        adapter === 'discord'
          ? await validateDiscordBotToken(token)
          : await validateTelegramBotToken(token);
      const httpStatus = result.ok ? 200 : result.status === 401 ? 400 : result.status;
      json(res, httpStatus, result);
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (pathname === '/api/channels' || pathname.startsWith('/api/channels/')) {
    const required: ClawScope = method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_ADMIN;
    if (!(await gate(req, res, required))) return;
    try {
      const handled = await handleChannelsRoute({ pathname, method, req, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Activity feed must dispatch BEFORE the sessions/groups blocks below —
  // those handlers 405 on unknown sub-paths and would shadow /activity.
  if (
    method === 'GET' &&
    (/^\/api\/groups\/[^/]+\/activity$/.test(pathname) || /^\/api\/sessions\/[^/]+\/activity$/.test(pathname))
  ) {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    try {
      const handled = await handleActivityRoute({ pathname, method, url, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
    const required: ClawScope = method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_WRITE;
    if (!(await gate(req, res, required))) return;
    try {
      const handled = await handleSessionsRoute({ pathname, method, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Read-only provider registry — data-drives the SPA's "add integration"
  // picker so new providers don't require a UI bundle change.
  if (pathname === '/api/oauth/providers' && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    try {
      const handled = handleOauthProvidersRoute({ pathname, method, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // OAuth callback redirects come from the provider's authorization
  // server with no Authorization header — the unguessable `state` token
  // (single-use, 10-min TTL, see oauth/state-store.ts) is the auth.
  // Everything else under /api/apps requires a JWT.
  if (pathname === '/api/apps' || pathname.startsWith('/api/apps/')) {
    const isCallback = /^\/api\/apps\/[^/]+\/callback$/.test(pathname) && method === 'GET';
    if (!isCallback) {
      const required: ClawScope = method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_ADMIN;
      if (!(await gate(req, res, required))) return;
    }
    try {
      const handled = await handleAppsRoute({ pathname, method, url, req, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // ADMIN-gated for put/delete on the secret store: a write-only token
  // would otherwise be enough to swap any vault credential and silently
  // MITM downstream API calls. Plaintext values are never returned by GET.
  if (pathname === '/api/secrets' || pathname.startsWith('/api/secrets/')) {
    const required: ClawScope = method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_ADMIN;
    if (!(await gate(req, res, required))) return;
    try {
      const handled = await handleSecretsRoute({ pathname, method, url, req, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/groups' && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    try {
      const groups = listAgentGroups();
      json(res, 200, { groups });
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (pathname === '/api/vaults' || pathname.startsWith('/api/vaults/')) {
    // /tokens and /tokens/:id forward to the vault — admin-gated. Refresh
    // and detail views are claw:read. Refer to § API surface in
    // docs/design/2026-04-29-vault-management-ui.md for the full table.
    const isTokenPath = /\/tokens(\/[^/]+)?$/.test(pathname);
    const required: ClawScope = isTokenPath ? SCOPE_CLAW_ADMIN : SCOPE_CLAW_READ;
    if (!(await gate(req, res, required))) return;
    try {
      const handled = await handleVaultsRoute({
        pathname,
        method,
        url,
        req,
        res,
        authHeader: req.headers.authorization ?? '',
      });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/groups' && method === 'POST') {
    if (!(await gate(req, res, SCOPE_CLAW_WRITE))) return;
    try {
      const body = await readJsonBody<{
        name?: string;
        folder?: string;
        instructions?: string;
        vault?: {
          scope?: string;
          vaultBaseUrl?: string;
          tokenLabel?: string;
          token?: string;
          mcpName?: string;
        };
      }>(req);

      const name = (body.name ?? '').trim();
      const folder = (body.folder ?? '').trim();
      if (!name) {
        error(res, 400, 'name is required');
        return;
      }
      const folderCheck = validateFolderSlug(folder);
      if (!folderCheck.ok) {
        error(res, 400, folderCheck.reason);
        return;
      }
      if (isFolderTaken(folder)) {
        error(res, 409, `agent group folder already exists: ${folder}`);
        return;
      }

      let vaultArg: Parameters<typeof createParachuteAgentGroup>[0]['vault'] | undefined;
      let mintedVaultToken = false;
      if (body.vault) {
        const scope = (body.vault.scope ?? 'vault:read') as VaultScope;
        if (!VALID_SCOPES.includes(scope)) {
          error(res, 400, `invalid vault.scope: ${scope}`);
          return;
        }
        const tokenLabel = body.vault.tokenLabel ?? `claw-${folder}`;
        const vaultBaseUrl = body.vault.vaultBaseUrl ?? 'http://127.0.0.1:1940/vault/default';
        let token = body.vault.token;
        if (!token) {
          // Implicit mint: forward operator's JWT to the vault. The shell-out
          // path that used to live here (`mintVaultToken`) is gone — see
          // docs/design/2026-04-29-vault-management-ui.md § Admin auth model.
          // Defense-in-depth — gate() ahead of this should have rejected an
          // unauth'd request, but if the header is somehow empty, fail loud
          // here rather than forwarding `Authorization: ` to vault.
          const authHeader = req.headers.authorization ?? '';
          if (!authHeader) {
            error(res, 401, 'auto-mint requires Authorization header');
            return;
          }
          const minted = await mintVaultTokenHttp({
            vaultBaseUrl,
            authHeader,
            label: tokenLabel,
            scopes: [scope],
          });
          if (minted.status >= 400) {
            const msg =
              (minted.body as { error?: string; message?: string }).message ??
              (minted.body as { error?: string }).error ??
              `vault returned ${minted.status}`;
            error(res, minted.status, `vault token mint failed: ${msg}`);
            return;
          }
          token = (minted.body as { token?: string }).token;
          if (!token) {
            error(res, 502, 'vault mint response missing token');
            return;
          }
          mintedVaultToken = true;
        }
        vaultArg = {
          scope,
          vaultBaseUrl,
          tokenLabel,
          token,
          mcpName: body.vault.mcpName,
        };
      }

      const created = createParachuteAgentGroup({
        name,
        folder,
        instructions: body.instructions?.trim() || undefined,
        vault: vaultArg,
      });

      const view = getAgentGroup(created.group.folder);
      json(res, 201, { group: view, mintedVaultToken });
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  const folderAvail = pathname.match(/^\/api\/folder-availability\/([^/]+)$/);
  if (folderAvail && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    const slug = decodeURIComponent(folderAvail[1]);
    const v = validateFolderSlug(slug);
    if (!v.ok) {
      json(res, 200, { slug, valid: false, available: false, reason: v.reason });
      return;
    }
    json(res, 200, { slug, valid: true, available: !isFolderTaken(slug) });
    return;
  }

  if (pathname === '/api/folder-suggestion' && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    const name = url.searchParams.get('name') ?? '';
    json(res, 200, { name, slug: suggestFolderSlug(name) });
    return;
  }

  const groupRoute = pathname.match(/^\/api\/groups\/([^/]+)(\/.*)?$/);
  if (groupRoute) {
    const folder = decodeURIComponent(groupRoute[1]);
    const sub = groupRoute[2] ?? '';

    const requiredScope: ClawScope = sub === '' && method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_WRITE;
    if (!(await gate(req, res, requiredScope))) return;

    const group = getAgentGroup(folder);
    if (!group) {
      error(res, 404, `agent group not found: ${folder}`);
      return;
    }

    if (sub === '' && method === 'GET') {
      json(res, 200, { group });
      return;
    }

    if (sub === '/attach-vault' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          scope?: string;
          vaultBaseUrl?: string;
          tokenLabel?: string;
          mcpName?: string;
          token?: string;
        }>(req);
        const scope = (body.scope ?? 'vault:read') as VaultScope;
        if (!VALID_SCOPES.includes(scope)) {
          error(res, 400, `invalid scope: ${scope}`);
          return;
        }
        const vaultBaseUrl = body.vaultBaseUrl ?? 'http://127.0.0.1:1940/vault/default';
        const tokenLabel = body.tokenLabel ?? `claw-${folder}`;

        let token = body.token;
        if (!token) {
          const authHeader = req.headers.authorization ?? '';
          if (!authHeader) {
            error(res, 401, 'auto-mint requires Authorization header');
            return;
          }
          const minted = await mintVaultTokenHttp({
            vaultBaseUrl,
            authHeader,
            label: tokenLabel,
            scopes: [scope],
          });
          if (minted.status >= 400) {
            const msg =
              (minted.body as { error?: string; message?: string }).message ??
              (minted.body as { error?: string }).error ??
              `vault returned ${minted.status}`;
            error(res, minted.status, `vault token mint failed: ${msg}`);
            return;
          }
          token = (minted.body as { token?: string }).token;
          if (!token) {
            error(res, 502, 'vault mint response missing token');
            return;
          }
        }

        attachVaultToGroup({
          folder,
          vaultBaseUrl,
          vaultToken: token,
          scope,
          tokenLabel,
          mcpName: body.mcpName,
        });

        const updated = getAgentGroup(folder);
        json(res, 200, { group: updated, mintedToken: !body.token });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Spawn (or wake) the agent-shared session for this group. Returns
    // 202 immediately; container boot is fire-and-forget. The UI polls
    // /api/groups/:folder for live status.
    if (sub === '/sessions' && method === 'POST') {
      try {
        const { session, created } = resolveSession(group.id, null, null, 'agent-shared');
        void wakeContainer(session).catch((err) => {
          log.error('paraclaw: wakeContainer failed', { sessionId: session.id, err });
        });
        json(res, 202, { sessionId: session.id, created });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (sub === '/wire-channel' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          channelType?: 'discord' | 'telegram';
          botUserId?: string;
          displayName?: string;
        }>(req);
        if (!body.channelType || (body.channelType !== 'discord' && body.channelType !== 'telegram')) {
          error(res, 400, `channelType must be "discord" or "telegram"`);
          return;
        }
        if (!body.botUserId || !body.botUserId.trim()) {
          error(res, 400, `botUserId is required`);
          return;
        }
        // Read the bot id from the active adapter so the v2 platform_id
        // matches what the bridge will emit on inbound. If the adapter
        // hasn't started (missing token, getMe failed), refuse to wire —
        // a wire that disagrees with the eventual inbound encoding would
        // silently drop messages once the adapter does come up.
        const activeAdapter = getChannelAdapter(body.channelType);
        if (!activeAdapter || !activeAdapter.botId) {
          error(
            res,
            409,
            `cannot wire ${body.channelType}: adapter is not active (missing or unhealthy bot credentials)`,
          );
          return;
        }
        const result = wireDmToAgent({
          channelType: body.channelType,
          agentGroup: { id: group.id, name: group.name, folder: group.folder } as never,
          botId: activeAdapter.botId,
          botUserId: body.botUserId,
          displayName: body.displayName,
        });
        json(res, 200, result);
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    if (sub === '/detach-vault' && method === 'POST') {
      try {
        const body = await readJsonBody<{ mcpName?: string; revokeToken?: boolean }>(req);
        const mcpName = body.mcpName ?? DEFAULT_VAULT_MCP_NAME;

        // Optional revoke-on-detach: forward operator's JWT to vault. Read
        // the attachment record before detaching so we still have its
        // tokenLabel/vaultBaseUrl. We do NOT cross-resolve the vault name
        // from the hub's well-known — the attachment carries the canonical
        // base URL already, so we forward directly.
        let revokedTokenId: string | null = null;
        let revokeError: string | null = null;
        if (body.revokeToken) {
          const attachment = readVaultAttachment(folder, mcpName);
          if (!attachment) {
            error(res, 409, `cannot revoke: no vault attachment found for group ${folder}`);
            return;
          }
          // Look up the token id by label — vault revoke is by id, not label.
          const list = await forwardToVault({
            method: 'GET',
            vaultBaseUrl: attachment.vaultBaseUrl,
            subpath: '/tokens',
            authHeader: req.headers.authorization ?? '',
          });
          if (list.status >= 400) {
            const msg =
              (list.body as { error?: string; message?: string }).message ??
              (list.body as { error?: string }).error ??
              `vault returned ${list.status}`;
            error(res, list.status, `vault token list failed: ${msg}`);
            return;
          }
          const tokens = (list.body as { tokens?: { id: string; label: string }[] }).tokens ?? [];
          const matches = tokens.filter((t) => t.label === attachment.tokenLabel);
          // Vault labels are not unique at the protocol level. If two tokens
          // share this label, picking the first is deterministic but silent —
          // log so the operator has signal on the host side.
          if (matches.length > 1) {
            log.warn('vault detach: ambiguous token label, revoking first match', {
              folder,
              tokenLabel: attachment.tokenLabel,
              matchCount: matches.length,
              ids: matches.map((m) => m.id),
            });
          }
          const match = matches[0] ?? null;
          if (!match) {
            // Label has no matching token — already revoked or never minted.
            // Continue with detach but report the discrepancy in the response.
            revokeError = `no vault token matched label ${attachment.tokenLabel}`;
          } else {
            const del = await forwardToVault({
              method: 'DELETE',
              vaultBaseUrl: attachment.vaultBaseUrl,
              subpath: `/tokens/${encodeURIComponent(match.id)}`,
              authHeader: req.headers.authorization ?? '',
            });
            if (del.status >= 400) {
              const msg =
                (del.body as { error?: string; message?: string }).message ??
                (del.body as { error?: string }).error ??
                `vault returned ${del.status}`;
              error(res, del.status, `vault revoke failed: ${msg}`);
              return;
            }
            revokedTokenId = match.id;
          }
        }

        detachVaultFromGroup(folder, mcpName);
        const updated = getAgentGroup(folder);
        json(res, 200, { group: updated, revokedTokenId, revokeError });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    error(res, 405, `method not allowed: ${method} ${pathname}`);
    return;
  }

  error(res, 404, `not found: ${pathname}`);
}

/**
 * Boot the web server. Returns the http.Server so the caller can stop it
 * during shutdown. The central DB is assumed to be initialized already by
 * the host process — this fn does NOT call initDb / runMigrations.
 */
export function startWebServer(): http.Server {
  const serveStatic = makeServeStatic({ distDir: UI_DIST, mount: MOUNT });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      // Strip MOUNT (e.g. `/claw`) once, here, before dispatch — Tailscale
      // serve / the hub's reverse proxy preserve the prefix when forwarding.
      // Without this, `/claw/api/health` falls through `/api/`-startsWith
      // and gets SPA-shelled as text/html.
      const dispatchPath =
        MOUNT && (url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`))
          ? url.pathname.slice(MOUNT.length) || '/'
          : url.pathname;
      if (dispatchPath.startsWith('/api/')) {
        await handleApi(req, res, url, dispatchPath);
        return;
      }
      // MCP transport — same auth seam as /api/* routes (hub JWT, claw:read
      // minimum). Mount-aware: hits `/mcp` whether the install lives at
      // origin root or behind PARACLAW_WEB_MOUNT.
      if (dispatchPath === '/mcp' || dispatchPath.startsWith('/mcp/')) {
        await handleMcpHttp(req, res);
        return;
      }
      // Capability card per parachute-patterns/well-known-discovery-rfc.
      // Lives at the origin root regardless of MOUNT — peer modules and the
      // hub's services catalog hit `/.well-known/parachute.json` directly.
      // Sourced from .parachute/module.json so the manifest stays the single
      // source of truth.
      if (url.pathname === '/.well-known/parachute.json' && req.method === 'GET') {
        try {
          const manifestPath = path.resolve(PROJECT_ROOT, '.parachute/module.json');
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              name: manifest.manifestName ?? manifest.name,
              displayName: manifest.displayName,
              version: SERVICE_VERSION,
              kind: manifest.kind,
              paths: manifest.paths,
              health: manifest.health,
              scopes: manifest.scopes,
              mcp: { http: '/mcp', stdio: true },
            }),
          );
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: `module manifest unavailable: ${err instanceof Error ? err.message : String(err)}`,
            }),
          );
        }
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
        return;
      }
      error(res, 405, `method not allowed: ${req.method} ${url.pathname}`);
    } catch (err) {
      if (!res.headersSent) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      } else {
        res.end();
      }
    }
  });

  server.listen(PORT, HOST, () => {
    log.info('Web server listening', {
      url: `http://${HOST}:${PORT}`,
      uiDist: fs.existsSync(UI_DIST) ? UI_DIST : null,
      mount: MOUNT || null,
    });
    // Self-register so `parachute status` + `parachute expose` see paraclaw.
    // Best-effort: a manifest write failure (perms / disk / race) doesn't
    // block the server from doing its job locally.
    try {
      upsertService({
        name: 'claw',
        port: PORT,
        paths: ['/claw'],
        health: '/api/health',
        version: SERVICE_VERSION,
        displayName: 'Paraclaw',
        tagline: 'Manage your Parachute agent groups + vault attachments.',
      });
    } catch (err) {
      log.warn('Skipped services manifest update', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return server;
}
