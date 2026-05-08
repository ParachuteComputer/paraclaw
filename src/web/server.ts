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

// Sourced from package.json so `/api/health` and the hub-registered
// manifest reflect the actual built version. Pre-paraclaw#101 this was a
// hardcoded string that drifted across rc bumps; vault uses the same
// pattern (see parachute-vault src/routing.ts).
import pkg from '../../package.json' with { type: 'json' };

import { CENTRAL_DB_PATH, DATA_DIR, GROUPS_DIR, PROJECT_ROOT } from '../config.js';
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
  SCOPE_AGENT_ADMIN,
  SCOPE_AGENT_READ,
  SCOPE_AGENT_WRITE,
  type AuthResult,
  type AgentScope,
} from './auth.js';
import { handleMcpHttp } from '../mcp/http.js';
import { handleAppsRoute } from './routes/apps.js';
import { handleApprovalsRoute } from './routes/approvals.js';
import { handleChannelsRoute } from './routes/channels.js';
import { handleActivityRoute } from './routes/activity.js';
import { handleOauthProvidersRoute } from './routes/oauth-providers.js';
import { handleSecretsRoute, listInjectableSecretsForGroupView } from './routes/secrets.js';
import { handleSessionsRoute } from './routes/sessions.js';
import { handleSettingsRoute } from './routes/settings.js';
import { handleAgentProviderRoute, handleGroupAgentProviderRoute } from './routes/agent-provider.js';
import { handleSetupStatusRoute } from './routes/setup-status.js';
import { handleVaultsRoute } from './routes/vaults.js';
import { forwardToVault, mintVaultTokenHttp } from './vault-proxy.js';
import { readService, upsertService } from './services-manifest.js';
import { makeServeStatic, normalizeMount } from './static-serve.js';
import { wireDmToAgent } from './wire-channel.js';
import { getChannelAdapterByBotId, registerBotAdapter } from '../channels/channel-registry.js';
import { recordTrustHint } from '../channels/trust-hint.js';
import { validateDiscordBotToken } from './discord-validate.js';
import { validateTelegramBotToken } from './telegram-validate.js';
import { getSecret, putSecret } from '../secrets/index.js';
import { channelTokenSecretName } from '../startup-bootstrap.js';
import { readEnvWithLegacy } from '../env.js';

const UI_DIST = path.resolve(PROJECT_ROOT, 'web/ui/dist');
// Canonical Parachute slot per parachute-patterns/patterns/canonical-ports.md
// (1944, claimed for parachute-agent 2026-04-27 via parachute-hub#…). The port
// the server actually binds is resolved at boot (see `resolvePort` below) —
// services.json existing entry > env override > this default. Legacy
// `PARACLAW_WEB_PORT` is accepted through 0.1.x with a one-shot warning.
const DEFAULT_PORT = 1944;
const HOST = readEnvWithLegacy('PARACHUTE_AGENT_WEB_BIND', 'PARACLAW_WEB_BIND') ?? '127.0.0.1';

/**
 * Boot-time port resolution. Reads (in order):
 *   1. The agent entry in `~/.parachute/services.json`, if it has a port.
 *   2. `PARACHUTE_AGENT_WEB_PORT` env var (or legacy `PARACLAW_WEB_PORT`).
 *   3. `PORT` env var (PaaS back-compat / hub's port-assigner).
 *   4. The default canonical slot (1944).
 *
 * Why services.json wins over env (mirrors parachute-scribe#41): hub's
 * port-assigner walked the canonical slot once and stamped `PORT=1944`
 * (or `PARACHUTE_AGENT_PORT=1944`) into a service-managed env file. With
 * env winning over services.json, that stale stamp would silently revert
 * an operator-set manifest value on every boot — exactly the bug class
 * paraclaw#145 was opened against. With services.json winning over env,
 * an operator can correct the port via manifest edit and have it persist
 * across restarts even when the hub-stamped env var is still present.
 * Symmetric with scribe so operators who learn the pattern from one
 * service don't get surprised by the other.
 *
 * Why a specific env tier above bare `PORT`: `PARACHUTE_AGENT_WEB_PORT`
 * is the precise, agent-targeted override; bare `PORT` is the generic
 * PaaS / hub-injection path written into the service-managed `.env` by
 * `parachute install parachute-agent`. The specific name wins so an
 * operator who sets `PARACHUTE_AGENT_WEB_PORT` in their shell isn't
 * silently overridden by a stale `PORT=…` line in `.env`. Same shape as
 * scribe (`SCRIBE_PORT > PORT`). The 4-tier ladder is documented in
 * `parachute-patterns/patterns/cli-as-port-authority.md` (patterns#45).
 *
 * Whichever wins, we *do not* stamp it back into services.json on every
 * boot — `upsertService` below only writes the port on first-run (when no
 * existing entry exists). After that, agent reads but doesn't write the
 * port field, so an operator who set agent.port = 1947 in services.json
 * stays at 1947 across restarts. (paraclaw#145.)
 *
 * `source` is returned so the caller can decide whether to stamp port on
 * the next manifest write; `existingEntry` is returned so the manifest
 * write can preserve fields the existing row carries (paths, health,
 * displayName) that we don't actively re-set per boot.
 */
export function resolvePort(manifestPath?: string): {
  port: number;
  source: 'env' | 'port' | 'manifest' | 'default';
  existingEntry: ReturnType<typeof readService>;
} {
  // readService is best-effort — log + fall through to the env / default
  // path if it throws (corrupt manifest); the boot path shouldn't be
  // blocked by an unrelated manifest read failure.
  let existingEntry: ReturnType<typeof readService> = null;
  try {
    existingEntry = manifestPath ? readService('agent', manifestPath) : readService('agent');
  } catch (err) {
    log.warn('services manifest read failed during port resolution', {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 1. services.json — operator-set / persisted state wins (see preamble
  //    above + scribe#41 for the rationale).
  if (existingEntry && typeof existingEntry.port === 'number' && existingEntry.port > 0) {
    return { port: existingEntry.port, source: 'manifest', existingEntry };
  }

  // 2. PARACHUTE_AGENT_WEB_PORT (or legacy PARACLAW_WEB_PORT) — explicit
  //    process-scope override, beats bare PORT. `Number.isInteger` here
  //    (not just `Number.isFinite`) so fractional strings like `1.5` are
  //    rejected — matches scribe's `parsePort` strictness
  //    (`parachute-scribe/src/port-resolve.ts`), which uses an integer
  //    regex `/^[1-9]\d{0,4}$/` for string input. Reviewer fold on
  //    paraclaw#148: the original `isFinite`-only guard let `1.5`
  //    coerce to a non-integer that would then crash later in the
  //    `server.listen()` path, where the error wouldn't name the env var.
  const envRaw = readEnvWithLegacy('PARACHUTE_AGENT_WEB_PORT', 'PARACLAW_WEB_PORT');
  if (envRaw !== undefined && envRaw !== '') {
    const n = Number(envRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`PARACHUTE_AGENT_WEB_PORT is not a valid port number: ${envRaw}`);
    }
    return { port: n, source: 'env', existingEntry };
  }

  // 3. PORT — PaaS back-compat / what hub's port-assigner writes into the
  //    service-managed `.env`. Same parsing strictness as the specific
  //    env tier (integer-only, see comment above) so a bad value
  //    surfaces loudly instead of degrading to the canonical default
  //    and masking the misconfig.
  const portRaw = process.env.PORT;
  if (portRaw !== undefined && portRaw !== '') {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      throw new Error(`PORT is not a valid port number: ${portRaw}`);
    }
    return { port: n, source: 'port', existingEntry };
  }

  // 4. Canonical default.
  return { port: DEFAULT_PORT, source: 'default', existingEntry };
}
// When fronted by `parachute expose tailnet` at a path prefix, set
// PARACHUTE_AGENT_WEB_MOUNT to that prefix (e.g. `/agent`) so static-serve
// strips it before resolving against dist/. The hub-managed lifecycle
// (parachute-hub#83) sets this from `module.json` `paths[0]` automatically.
// Empty string = serve at the origin root (default). Legacy
// `PARACLAW_WEB_MOUNT` accepted through 0.1.x with a one-shot warning;
// drop in 0.2.0.
const MOUNT = normalizeMount(readEnvWithLegacy('PARACHUTE_AGENT_WEB_MOUNT', 'PARACLAW_WEB_MOUNT') ?? '');
/** Exported for tests; serves as the value reported by `/api/health` and registered with hub. */
export const SERVICE_VERSION: string = pkg.version;

interface AgentGroupRow {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  // Per-group injection policy for secrets — the GroupDetail "Secrets" panel
  // (paraclaw#104) renders this so an empty list under `selective` reads as
  // "by design" rather than "broken". Already a column on agent_groups
  // (migration 023); just surface it on the wire.
  secret_mode: 'all' | 'selective';
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
      .prepare(
        'SELECT id, name, folder, agent_provider, secret_mode, created_at FROM agent_groups ORDER BY created_at DESC',
      )
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
      .prepare('SELECT id, name, folder, agent_provider, secret_mode, created_at FROM agent_groups WHERE folder = ?')
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

async function gate(req: http.IncomingMessage, res: http.ServerResponse, required: AgentScope): Promise<boolean> {
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
      service: 'parachute-agent-web-server',
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
    if (!(await gate(req, res, SCOPE_AGENT_READ))) return;
    try {
      const handled = await handleSetupStatusRoute({ pathname, method, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/approvals' || pathname.startsWith('/api/approvals/')) {
    const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_WRITE;
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

  if (pathname === '/api/settings/approval-routing' || pathname === '/api/settings/operator-identity') {
    // approval-routing write touches DM cache + cold-resolves through an
    // adapter; gate writes at admin. operator-identity is read-only — the
    // /channels/new form pre-fills from it.
    const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_ADMIN;
    if (!(await gate(req, res, required))) return;
    try {
      const handled = await handleSettingsRoute({ pathname, method, req, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/settings/agent-provider') {
    // Reads return only "is this slot populated?" booleans (no secret
    // material crosses HTTP). Writes accept and store API keys, so admin.
    const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_ADMIN;
    const auth = await authenticate(req.headers.authorization, required);
    if (!auth.ok) {
      send401or403(res, auth);
      return;
    }
    try {
      const handled = await handleAgentProviderRoute({
        pathname,
        method,
        req,
        res,
        actorSubject: auth.claims.sub ?? null,
      });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  // Token validation — pre-install, no DB writes, the wizard hits this from
  // /channels/new before persisting anything. agent:write is enough; the
  // /api/channels/* CRUD block below is admin-gated and would over-reject.
  //
  // We remap a validator status of 401 ("bot token rejected by upstream")
  // to HTTP 400 so the SPA's auth wrapper doesn't mistake an upstream
  // identity rejection for our hub-JWT being expired and trigger a
  // re-auth loop. Body still carries the precise validator status field.
  if (method === 'POST' && /^\/api\/channels\/[^/]+\/test$/.test(pathname)) {
    if (!(await gate(req, res, SCOPE_AGENT_WRITE))) return;
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
        adapter === 'discord' ? await validateDiscordBotToken(token) : await validateTelegramBotToken(token);
      const httpStatus = result.ok ? 200 : result.status === 401 ? 400 : result.status;
      json(res, httpStatus, result);
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // Validate a bot token + persist it to the secrets table. This DOES NOT
  // bring the adapter up — adapter spawn is deferred to /wire-channel so
  // the bot can't start polling before the operator has actually wired it
  // to an agent group. (The polling loop is what receives messages and,
  // pre-wire, races into the unwired-channel approval flow that surprised
  // operators wiring a second bot.) Idempotent: re-posting the same
  // (channelType, botId) just refreshes the stored ciphertext.
  if (method === 'POST' && /^\/api\/channels\/[^/]+\/register-bot$/.test(pathname)) {
    if (!(await gate(req, res, SCOPE_AGENT_ADMIN))) return;
    const adapter = pathname.split('/')[3];
    if (adapter !== 'discord' && adapter !== 'telegram') {
      error(res, 404, `unknown adapter: ${adapter}`);
      return;
    }
    try {
      const body = await readJsonBody<{ token?: string }>(req);
      const token = (body.token ?? '').trim();
      if (!token) {
        error(res, 400, 'token is required');
        return;
      }
      const validation =
        adapter === 'discord' ? await validateDiscordBotToken(token) : await validateTelegramBotToken(token);
      if (!validation.ok) {
        const httpStatus = validation.status === 401 ? 400 : validation.status;
        error(res, httpStatus, validation.error);
        return;
      }
      const botId = String(validation.identity.id);
      const username = validation.identity.username;
      const secretName = channelTokenSecretName(adapter, botId);
      const existing = getSecret(secretName);
      const isRotation = existing !== undefined && existing !== token;
      putSecret(secretName, token, { kind: 'channel-token', agent_group_id: null });
      log.info(isRotation ? 'Channel bot token rotated' : 'Channel bot registered', { adapter, botId });
      json(res, 200, { ok: true, botId, username });
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  if (pathname === '/api/channels' || pathname.startsWith('/api/channels/')) {
    const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_ADMIN;
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
    if (!(await gate(req, res, SCOPE_AGENT_READ))) return;
    try {
      const handled = await handleActivityRoute({ pathname, method, url, res });
      if (handled) return;
    } catch (err) {
      error(res, 500, err instanceof Error ? err.message : String(err));
      return;
    }
  }

  if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
    const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_WRITE;
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
    if (!(await gate(req, res, SCOPE_AGENT_READ))) return;
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
      const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_ADMIN;
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
    const required: AgentScope = method === 'GET' ? SCOPE_AGENT_READ : SCOPE_AGENT_ADMIN;
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
    if (!(await gate(req, res, SCOPE_AGENT_READ))) return;
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
    // and detail views are agent:read. Refer to § API surface in
    // docs/design/2026-04-29-vault-management-ui.md for the full table.
    const isTokenPath = /\/tokens(\/[^/]+)?$/.test(pathname);
    const required: AgentScope = isTokenPath ? SCOPE_AGENT_ADMIN : SCOPE_AGENT_READ;
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
    if (!(await gate(req, res, SCOPE_AGENT_WRITE))) return;
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
        // Default vault-token label tracks the paraclaw → parachute-agent
        // rename: fresh mints from this UI use `agent-<folder>`. Existing
        // operator-typed `claw-<folder>` labels keep working — the label is
        // opaque to the vault, so prior tokens are unaffected. Operators
        // can rename labels at-will via the vault token UI; the divergent-
        // labels concern from parachute-agent#108 §2 was reweighed at
        // 0.1.0-stable cut and the rename was preferred for consistency
        // with the rest of the brand sweep.
        const tokenLabel = body.vault.tokenLabel ?? `agent-${folder}`;
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
    if (!(await gate(req, res, SCOPE_AGENT_READ))) return;
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
    if (!(await gate(req, res, SCOPE_AGENT_READ))) return;
    const name = url.searchParams.get('name') ?? '';
    json(res, 200, { name, slug: suggestFolderSlug(name) });
    return;
  }

  const groupRoute = pathname.match(/^\/api\/groups\/([^/]+)(\/.*)?$/);
  if (groupRoute) {
    const folder = decodeURIComponent(groupRoute[1]);
    const sub = groupRoute[2] ?? '';

    // Reads at the group root + the agent-provider subroute + the
    // injectable-secrets panel (paraclaw#104) go through agent:read; writes
    // default to agent:write; agent-provider writes (paraclaw#86) bump to
    // agent:admin since they store API keys.
    const isAgentProviderSub = sub === '/agent-provider';
    const isReadSub = sub === '' || isAgentProviderSub || sub === '/secrets';
    const requiredScope: AgentScope =
      method === 'GET' && isReadSub ? SCOPE_AGENT_READ : isAgentProviderSub ? SCOPE_AGENT_ADMIN : SCOPE_AGENT_WRITE;
    // Authenticate once; capture sub so the agent-provider sub-route's
    // audit log doesn't have to re-decode the JWT.
    const auth = await authenticate(req.headers.authorization, requiredScope);
    if (!auth.ok) {
      send401or403(res, auth);
      return;
    }
    const actorSubject = auth.claims.sub ?? null;

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
        // Same default-rename as the attach-vault path above; see the
        // comment block there for the parachute-agent#108 §2 reweigh.
        const tokenLabel = body.tokenLabel ?? `agent-${folder}`;

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
          botId?: string;
          botUserId?: string;
          operatorUserId?: string;
          displayName?: string;
        }>(req);
        if (!body.channelType || (body.channelType !== 'discord' && body.channelType !== 'telegram')) {
          error(res, 400, `channelType must be "discord" or "telegram"`);
          return;
        }
        const botId = (body.botId ?? '').trim();
        if (!botId) {
          error(res, 400, `botId is required`);
          return;
        }
        if (!body.botUserId || !body.botUserId.trim()) {
          error(res, 400, `botUserId is required`);
          return;
        }
        // The bot must either be already-live (the .env-seeded primary
        // adapter the host spawned at boot) OR have a persisted token via
        // /register-bot. Without one of those, the post-wire spawn step
        // would have nothing to spawn from, and the operator would face
        // a silently dead bot on the next host restart.
        const secretName = channelTokenSecretName(body.channelType, botId);
        const tokenValue = getSecret(secretName);
        const liveAdapter = getChannelAdapterByBotId(body.channelType, botId);
        if (!tokenValue && !liveAdapter) {
          error(
            res,
            409,
            `cannot wire ${body.channelType}: bot ${botId} has no persisted token and no live adapter (call /register-bot first)`,
          );
          return;
        }
        const result = wireDmToAgent({
          channelType: body.channelType,
          agentGroup: { id: group.id, name: group.name, folder: group.folder } as never,
          botId,
          botUserId: body.botUserId,
          displayName: body.displayName,
        });
        // Bring the adapter up after the MGA exists so the polling loop's
        // first inbound lands on a wired channel instead of racing into the
        // unwired-channel approval flow. registerBotAdapter is idempotent
        // on (channelType, botId) — re-wiring the same bot to a second
        // group leaves the existing live adapter in place. Skip when
        // there's no token to spawn from but the adapter is already
        // live (.env-seeded primary).
        if (tokenValue) {
          try {
            await registerBotAdapter(body.channelType, secretName, tokenValue);
          } catch (err) {
            log.error('Failed to spawn adapter after wire', {
              channel: body.channelType,
              botId,
              err,
            });
          }
        }
        // Record the operator-self-wire trust hint so the operator's first
        // DM to a freshly-wired Telegram bot bypasses any backlog-driven
        // approval cascade. No-op for Discord (no operator user id captured).
        recordTrustHint(body.channelType, botId, (body.operatorUserId ?? '').trim());
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

    if (sub === '/agent-provider') {
      // Group existence (folder → agent_group) was validated by `getAgentGroup`
      // upstream — by the time we get here `group` is non-null, so the
      // sub-route handler can assume the agent group id is real and 404
      // semantics for unknown folders are already handled.
      try {
        await handleGroupAgentProviderRoute({
          method,
          req,
          res,
          agentGroupId: group.id,
          actorSubject,
        });
      } catch (err) {
        error(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // Read-only mirror of resolveInjectableSecrets() for the GroupDetail
    // "Secrets" panel — what env vars this group will see at next session
    // spawn, with scope badges (paraclaw#104). Metadata only; values stay
    // encrypted at rest and only decrypt at container spawn time.
    if (sub === '/secrets' && method === 'GET') {
      try {
        json(res, 200, { secrets: listInjectableSecretsForGroupView(group.id) });
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
  const { port: PORT, source: portSource, existingEntry: existingServiceEntry } = resolvePort();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      // Strip MOUNT (e.g. `/agent`) once, here, before dispatch — Tailscale
      // serve / the hub's reverse proxy preserve the prefix when forwarding.
      // Without this, `/agent/api/health` falls through `/api/`-startsWith
      // and gets SPA-shelled as text/html.
      const dispatchPath =
        MOUNT && (url.pathname === MOUNT || url.pathname.startsWith(`${MOUNT}/`))
          ? url.pathname.slice(MOUNT.length) || '/'
          : url.pathname;
      if (dispatchPath.startsWith('/api/')) {
        await handleApi(req, res, url, dispatchPath);
        return;
      }
      // MCP transport — same auth seam as /api/* routes (hub JWT, agent:read
      // minimum). Mount-aware: hits `/mcp` whether the install lives at
      // origin root or behind PARACHUTE_AGENT_WEB_MOUNT.
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

  // Bind-error handler MUST be wired BEFORE listen() — once `error` fires
  // synchronously inside listen() (the EADDRINUSE path on macOS), an
  // un-handled `error` on the http.Server crashes the process with an
  // unhelpful node-internal stack. We surface a named conflict instead so
  // operators see *which* port is taken (paraclaw#145 — silent boot failures
  // when scribe and agent both raced for 1944 was the original symptom).
  // Then we exit non-zero so the supervisor (launchd / systemd / hub) sees
  // the failure, rather than leaving a half-booted host process running.
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log.error('Web server failed to bind — port in use', {
        port: PORT,
        host: HOST,
        portSource,
        hint:
          portSource === 'manifest'
            ? `another service holds ${HOST}:${PORT}; check ~/.parachute/services.json or run \`lsof -i :${PORT}\``
            : portSource === 'env'
              ? `PARACHUTE_AGENT_WEB_PORT=${PORT} but ${HOST}:${PORT} is already taken`
              : portSource === 'port'
                ? `PORT=${PORT} (likely from \`parachute install\`-managed .env) but ${HOST}:${PORT} is already taken; set PARACHUTE_AGENT_WEB_PORT or edit ~/.parachute/services.json to override`
                : `default canonical slot ${PORT} is held by another process; set PARACHUTE_AGENT_WEB_PORT or edit ~/.parachute/services.json`,
      });
    } else {
      log.error('Web server error', { err: err.message, code: err.code });
    }
    // Fail loudly. Don't trap-and-continue on bind errors — leaves the
    // host process running without a web surface, which is exactly the
    // silent failure mode #145 surfaced.
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    log.info('Web server listening', {
      url: `http://${HOST}:${PORT}`,
      uiDist: fs.existsSync(UI_DIST) ? UI_DIST : null,
      mount: MOUNT || null,
      portSource,
    });
    // Self-register so `parachute status` + `parachute expose` see the agent.
    // Best-effort: a manifest write failure (perms / disk / race) doesn't
    // block the server from doing its job locally.
    //
    // Port-write rule (paraclaw#145): only stamp `port` when there's no
    // existing entry yet (first run). After that, we still refresh the
    // metadata fields the agent owns (version, paths, health, displayName,
    // installDir) but leave `port` alone so an operator who set
    // agent.port = 1947 in services.json stays at 1947 across restarts —
    // even if the env var that pointed agent at 1947 is later unset.
    try {
      // When there's an existing entry, write back its `port` value
      // unchanged — re-stamping the same number is a no-op vs. the file
      // and preserves operator-set values across restarts. When this is a
      // first run, stamp the resolved port (env override or default).
      const portToWrite = existingServiceEntry?.port ?? PORT;
      upsertService({
        name: 'agent',
        port: portToWrite,
        paths: ['/agent'],
        health: '/api/health',
        version: SERVICE_VERSION,
        displayName: 'Parachute Agent',
        tagline: 'Manage your Parachute agent groups + vault attachments.',
        // Lets hub resolve `parachute restart agent` back to the checkout
        // it should drive without a vendored fallback (paraclaw#115,
        // third-party-module hook from parachute-hub#84).
        installDir: PROJECT_ROOT,
      });
    } catch (err) {
      log.warn('Skipped services manifest update', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  });

  return server;
}
