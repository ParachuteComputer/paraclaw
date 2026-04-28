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
import { spawn } from 'node:child_process';

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
import { fetchHubVaults } from './hub-discovery.js';
import { handleApprovalsRoute } from './routes/approvals.js';
import { handleChannelsRoute } from './routes/channels.js';
import { handleActivityRoute } from './routes/activity.js';
import { handleSecretsRoute } from './routes/secrets.js';
import { handleSessionsRoute } from './routes/sessions.js';
import { handleSetupStatusRoute } from './routes/setup-status.js';
import { upsertService } from './services-manifest.js';
import { makeServeStatic, normalizeMount } from './static-serve.js';
import { wireDmToAgent } from './wire-channel.js';

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
const SERVICE_VERSION = '0.0.14-rc.4';

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

/**
 * Shell out to `parachute vault tokens create`. Captures stdout, parses the
 * `pvt_…` line. Used by the attach flow so the user never types/pastes a
 * raw token through the UI.
 */
function mintVaultToken(opts: { scope: VaultScope; label: string }): Promise<{ token: string; label: string }> {
  return new Promise((resolve, reject) => {
    const args = ['vault', 'tokens', 'create', '--scope', opts.scope, '--label', opts.label];
    const proc = spawn('parachute', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`parachute vault tokens create exited ${code}: ${stderr.trim() || stdout.trim()}`));
        return;
      }
      const m = stdout.match(/Token:\s+(pvt_[A-Za-z0-9_-]+)/);
      if (!m) {
        reject(new Error(`could not parse pvt_… from CLI output:\n${stdout}`));
        return;
      }
      resolve({ token: m[1], label: opts.label });
    });
  });
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
    (/^\/api\/groups\/[^/]+\/activity$/.test(pathname) ||
      /^\/api\/sessions\/[^/]+\/activity$/.test(pathname))
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

  if (pathname === '/api/vaults' && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    try {
      const vaults = await fetchHubVaults();
      json(res, 200, { vaults });
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
    }
    return;
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
        let token = body.vault.token;
        if (!token) {
          const minted = await mintVaultToken({ scope, label: tokenLabel });
          token = minted.token;
          mintedVaultToken = true;
        }
        vaultArg = {
          scope,
          vaultBaseUrl: body.vault.vaultBaseUrl,
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
          const minted = await mintVaultToken({ scope, label: tokenLabel });
          token = minted.token;
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
        const result = wireDmToAgent({
          channelType: body.channelType,
          agentGroup: { id: group.id, name: group.name, folder: group.folder } as never,
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
        const body = await readJsonBody<{ mcpName?: string }>(req);
        detachVaultFromGroup(folder, body.mcpName ?? DEFAULT_VAULT_MCP_NAME);
        const updated = getAgentGroup(folder);
        json(res, 200, { group: updated });
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
