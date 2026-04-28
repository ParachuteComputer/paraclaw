/**
 * Paraclaw web UI server.
 *
 * Thin Node http surface over:
 *   - NanoClaw's central v2.db (agent_groups table) — read-only
 *   - The Parachute attach helpers in src/parachute/vault-mcp.ts — write
 *   - The `parachute` CLI for token minting (shells out)
 *
 * Static-serves the built UI bundle from ../ui/dist when present; otherwise
 * just exposes /api/*. In dev, run vite separately on port 5173 with the
 * proxy in vite.config.ts pointing back to this server.
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
 */
// MUST be first — chdirs to project root so NanoClaw's config.ts resolves
// DATA_DIR / GROUPS_DIR correctly regardless of where the server was invoked.
import './bootstrap.js';

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, GROUPS_DIR } from '../../../src/config.js';
import { initDb, openDb, type Database } from '../../../src/db/connection.js';
import { runMigrations } from '../../../src/db/migrations/index.js';
import {
  attachVaultToGroup,
  detachVaultFromGroup,
  readVaultAttachment,
  DEFAULT_VAULT_MCP_NAME,
} from '../../../src/parachute/vault-mcp.js';
import type { VaultScope } from '../../../src/parachute/types.js';
import {
  createParachuteAgentGroup,
  isFolderTaken,
  suggestFolderSlug,
  validateFolderSlug,
} from '../../../src/parachute/create-agent.js';
import { getGroupStatus, type GroupStatus } from '../../../src/parachute/group-status.js';
import { resolveSession } from '../../../src/session-manager.js';
import { wakeContainer } from '../../../src/container-runner.js';
import { log } from '../../../src/log.js';
import {
  authenticate,
  getHubOrigin,
  SCOPE_CLAW_READ,
  SCOPE_CLAW_WRITE,
  type AuthResult,
  type ClawScope,
} from './auth.js';
import { fetchHubVaults } from './hub-discovery.js';
import { handleSecretsRoute } from './routes/secrets.js';
import { handleSetupStatusRoute } from './routes/setup-status.js';
import { upsertService } from './services-manifest.js';
import { makeServeStatic, normalizeMount } from './static-serve.js';

const CENTRAL_DB_PATH = path.join(DATA_DIR, 'v2.db');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UI_DIST = path.resolve(__dirname, '../../ui/dist');
// Canonical Parachute slot per parachute-patterns/patterns/canonical-ports.md
// (1944, claimed for paraclaw 2026-04-27 via parachute-hub#…). Override
// via PARACLAW_WEB_PORT for tests / non-default deployments.
const PORT = Number(process.env.PARACLAW_WEB_PORT ?? 1944);
const HOST = process.env.PARACLAW_WEB_BIND ?? '127.0.0.1';
// When fronted by `parachute expose tailnet` at a path prefix, set
// PARACLAW_WEB_MOUNT to that prefix (e.g. `/claw`) so static-serve strips
// it before resolving against dist/. The hub-managed lifecycle (once
// parachute-hub#83 ships) will set this from `module.json` `paths[0]`
// automatically. Empty string = serve at the origin root (default).
const MOUNT = normalizeMount(process.env.PARACLAW_WEB_MOUNT ?? '');
const SERVICE_VERSION = '0.0.13-rc.1';

// NanoClaw's mutating helpers (createAgentGroup, etc.) talk to a
// process-singleton DB connection (`getDb`). Initialize it once at boot so
// the wizard endpoint can write. WAL mode + foreign_keys ON are set inside.
// Concurrent with a running NanoClaw service (also WAL) is fine — SQLite
// handles multiple writers per file. Migrations are idempotent.
const centralDb = initDb(CENTRAL_DB_PATH);
runMigrations(centralDb);

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
      // Output shape (vault 0.3.x):
      //   Created token for vault "<vault>":
      //     Token:      pvt_...
      //     Permission: ...
      //     Scopes:     ...
      const m = stdout.match(/Token:\s+(pvt_[A-Za-z0-9_-]+)/);
      if (!m) {
        reject(new Error(`could not parse pvt_… from CLI output:\n${stdout}`));
        return;
      }
      resolve({ token: m[1], label: opts.label });
    });
  });
}

// --- HTTP plumbing -----------------------------------------------------------

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
  // RFC 6750 challenge for 401; insufficient_scope challenge for 403.
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

  // Unauthenticated probes: liveness check and OAuth-bootstrap discovery.
  // Discovery surfaces the hub origin so the SPA can reach the AS metadata
  // (`/.well-known/oauth-authorization-server`) without hard-coding it.
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

  // /api/setup/status — readiness probe for the setup wizard. Read-gated
  // because the per-check details (which folders, which keys) are
  // operator-private. The endpoint itself is idempotent + side-effect-free
  // EXCEPT for the master-key first-touch (loadOrCreateMasterKey generates
  // ~/.parachute/claw/master.key on first call); that's intentional — the
  // wizard polling drives bootstrap.
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

  // /api/secrets — local AES-GCM secret store. Read-gated for list,
  // write-gated for put/delete. Plaintext values are never returned.
  if (pathname === '/api/secrets' || pathname.startsWith('/api/secrets/')) {
    const required: ClawScope = method === 'GET' ? SCOPE_CLAW_READ : SCOPE_CLAW_WRITE;
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

  // GET /api/vaults — enumerate registered vaults so the attach-vault
  // picker can populate a dropdown. Sourced from the hub's well-known
  // discovery doc (`<hubOrigin>/.well-known/parachute.json`), which
  // returns the public-routable URL — critical because that URL gets
  // baked into the agent container's MCP config and loopback would break
  // any non-host-network agent.
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

  // GET /api/folder-availability/:slug — used by the new-agent wizard for
  // live "is this slug free?" feedback. Read-gated: the slug namespace is
  // operator-private state.
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

  // GET /api/folder-suggestion?name=... — wizard uses this to seed the slug
  // input from the agent name. Pure transform but kept behind read-gate so
  // the auth-required surface is uniform.
  if (pathname === '/api/folder-suggestion' && method === 'GET') {
    if (!(await gate(req, res, SCOPE_CLAW_READ))) return;
    const name = url.searchParams.get('name') ?? '';
    json(res, 200, { name, slug: suggestFolderSlug(name) });
    return;
  }

  // /api/groups/:folder/...
  const groupRoute = pathname.match(/^\/api\/groups\/([^/]+)(\/.*)?$/);
  if (groupRoute) {
    const folder = decodeURIComponent(groupRoute[1]);
    const sub = groupRoute[2] ?? '';

    // Pick the scope for the matching sub-route up front so we can gate
    // before any DB read. GET → read; POST → write.
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

    // POST /api/groups/:folder/attach-vault
    if (sub === '/attach-vault' && method === 'POST') {
      try {
        const body = await readJsonBody<{
          scope?: string;
          vaultBaseUrl?: string;
          tokenLabel?: string;
          mcpName?: string;
          token?: string; // optional — if absent, server mints via CLI
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

        // Re-read so the response reflects the persisted state.
        const updated = getAgentGroup(folder);
        json(res, 200, { group: updated, mintedToken: !body.token });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // POST /api/groups/:folder/sessions — spawn (or wake) the agent-shared
    // session for this group. Returns 202 immediately; container boot is
    // fire-and-forget. The UI polls /api/groups/:folder for live status to
    // see the session appear and the container come up. We choose
    // 'agent-shared' mode because paraclaw-managed groups today are not
    // wired to a messaging group at all (no Discord/Slack channel) — the
    // claw runs in the background under whatever instructions live in
    // its CLAUDE.md. agent-shared collapses to one session per group,
    // which is the right shape for that no-channel case.
    if (sub === '/sessions' && method === 'POST') {
      try {
        const { session, created } = resolveSession(group.id, null, null, 'agent-shared');
        // Fire-and-forget: wakeContainer can take several seconds (image
        // pull, mount setup, OneCLI agent ensure). Holding the request
        // open that long would force the UI into a fake spinner; instead
        // we 202 and let the existing /api/groups/:folder poll surface
        // the live containerRunning state. Errors get logged on the host;
        // the UI sees them as "container never came up" via the same poll.
        void wakeContainer(session).catch((err) => {
          log.error('paraclaw: wakeContainer failed', { sessionId: session.id, err });
        });
        json(res, 202, { sessionId: session.id, created });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // POST /api/groups/:folder/detach-vault
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

// --- Static file serving (built UI) -----------------------------------------

const serveStatic = makeServeStatic({ distDir: UI_DIST, mount: MOUNT });

// --- Server ------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    // Strip MOUNT (e.g. `/claw`) once, here, before dispatch — Tailscale
    // serve / the hub's reverse proxy preserve the prefix when forwarding.
    // Without this, `/claw/api/health` falls through `/api/`-startsWith
    // and gets SPA-shelled as text/html. (parachute-hub/src/notes-serve.ts
    // does the same dance for the notes PWA.) Static-serve does its own
    // internal strip via makeServeStatic, but routing through one
    // canonical strip keeps the two surfaces consistent.
    const dispatchPath =
      MOUNT && (url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`))
        ? url.pathname.slice(MOUNT.length) || '/'
        : url.pathname;
    if (dispatchPath.startsWith('/api/')) {
      await handleApi(req, res, url, dispatchPath);
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
  console.log(`paraclaw-web listening on http://${HOST}:${PORT}`);
  console.log(`  data_dir:   ${DATA_DIR}`);
  console.log(`  groups_dir: ${GROUPS_DIR}`);
  if (fs.existsSync(UI_DIST)) {
    console.log(`  ui:         serving from ${UI_DIST}`);
  } else {
    console.log(`  ui:         (not built — run pnpm --filter @paraclaw/web-ui build, or dev separately on :5173)`);
  }
  if (MOUNT) {
    console.log(`  mount:      ${MOUNT} (PARACLAW_WEB_MOUNT — strips this prefix off static-serve requests)`);
  }
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
    console.warn(`paraclaw: skipped services manifest update: ${err instanceof Error ? err.message : err}`);
  }
});
