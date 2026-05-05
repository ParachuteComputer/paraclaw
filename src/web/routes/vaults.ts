/**
 * /api/vaults — vault management surface for `/agent/vaults`.
 *
 * Five endpoints, plus a list endpoint that lived inline in `server.ts`
 * before this module landed. All admin operations forward the operator's
 * hub-issued session JWT to the vault unmodified — see
 * `docs/design/2026-04-29-vault-management-ui.md` § Admin auth model and
 * `src/web/vault-proxy.ts` for the rationale.
 *
 * Scope at the paraclaw boundary is checked by `server.ts` via
 * `pickVaultScope()` before dispatch reaches this handler. The vault
 * validates `vault:<name>:admin` independently — paraclaw doesn't downgrade
 * or re-issue. A 401/403 from the vault is mirrored verbatim so the
 * browser can trigger an OAuth consent flow for the missing narrow scope.
 */
import http from 'node:http';

import { CENTRAL_DB_PATH } from '../../config.js';
import { openDb } from '../../db/connection.js';
import { listVaultAttachments } from '../../parachute/vault-mcp.js';
import { clearHubDiscoveryCache, fetchHubVaults, type VaultListing } from '../hub-discovery.js';
import { forwardToVault, resolveVaultBaseUrl } from '../vault-proxy.js';

interface VaultTokenRecord {
  id: string;
  label: string;
  scopes?: string[];
  permission?: string;
  expires_at?: string | null;
  created_at?: string;
  last_used_at?: string | null;
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

function listGroupFolders(): string[] {
  const db = openDb(CENTRAL_DB_PATH, { readonly: true });
  try {
    return db
      .prepare<{ folder: string }>('SELECT folder FROM agent_groups')
      .all()
      .map((r) => r.folder);
  } finally {
    db.close();
  }
}

/**
 * Build the "attached to" map for a vault: which agent groups currently
 * have a parachute.json record pointing at this vault, keyed by tokenLabel
 * for cheap merge into the tokens listing.
 *
 * Match by `vaultBaseUrl` (canonical, hub-published form, trailing slashes
 * already trimmed at write time in `attachVaultToGroup`). Tokens without a
 * matching group are still surfaced — they show as orphans in the UI.
 */
function buildAttachedByLabel(vaultBaseUrl: string): Map<string, { folder: string; scope: string }[]> {
  const target = vaultBaseUrl.replace(/\/+$/, '');
  const folders = listGroupFolders();
  const entries = listVaultAttachments(folders);
  const byLabel = new Map<string, { folder: string; scope: string }[]>();
  for (const e of entries) {
    if (e.attachment.vaultBaseUrl.replace(/\/+$/, '') !== target) continue;
    const list = byLabel.get(e.attachment.tokenLabel) ?? [];
    list.push({ folder: e.folder, scope: e.attachment.scope });
    byLabel.set(e.attachment.tokenLabel, list);
  }
  return byLabel;
}

export interface VaultsRouteContext {
  pathname: string;
  method: string;
  url: URL;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** Operator's full `Authorization` header value, forwarded to vault. */
  authHeader: string;
}

export async function handleVaultsRoute(ctx: VaultsRouteContext): Promise<boolean> {
  const { pathname, method, req, res, authHeader } = ctx;

  if (pathname === '/api/vaults' && method === 'GET') {
    try {
      const vaults = await fetchHubVaults();
      json(res, 200, { vaults });
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  if (pathname === '/api/vaults/refresh' && method === 'POST') {
    clearHubDiscoveryCache();
    try {
      const vaults = await fetchHubVaults();
      json(res, 200, { vaults });
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
    }
    return true;
  }

  // Token-id-bound routes — match before the parent /tokens path so the
  // more-specific match wins.
  const tokenById = pathname.match(/^\/api\/vaults\/([^/]+)\/tokens\/([^/]+)$/);
  if (tokenById && method === 'DELETE') {
    const name = decodeURIComponent(tokenById[1]);
    const id = decodeURIComponent(tokenById[2]);
    const baseUrl = await resolveVaultBaseUrl(name);
    if (!baseUrl) {
      error(res, 404, `vault not found: ${name}`);
      return true;
    }
    const result = await forwardToVault({
      method: 'DELETE',
      vaultBaseUrl: baseUrl,
      subpath: `/tokens/${encodeURIComponent(id)}`,
      authHeader,
    });
    json(res, result.status, result.body);
    return true;
  }

  const tokensList = pathname.match(/^\/api\/vaults\/([^/]+)\/tokens$/);
  if (tokensList) {
    const name = decodeURIComponent(tokensList[1]);
    const baseUrl = await resolveVaultBaseUrl(name);
    if (!baseUrl) {
      error(res, 404, `vault not found: ${name}`);
      return true;
    }
    if (method === 'GET') {
      const result = await forwardToVault({
        method: 'GET',
        vaultBaseUrl: baseUrl,
        subpath: '/tokens',
        authHeader,
      });
      if (result.status >= 400) {
        json(res, result.status, result.body);
        return true;
      }
      // Merge attached-to-group derivation by tokenLabel. Vault returns
      // `{tokens: [{id, label, ...}]}`; we add `attachedTo: [{folder, scope}]`
      // to each row so the UI doesn't need a separate fetch.
      const tokens = (result.body as { tokens?: VaultTokenRecord[] }).tokens ?? [];
      const byLabel = buildAttachedByLabel(baseUrl);
      const enriched = tokens.map((t) => ({
        ...t,
        attachedTo: byLabel.get(t.label) ?? [],
      }));
      json(res, 200, { tokens: enriched });
      return true;
    }
    if (method === 'POST') {
      let body: { label?: string; scopes?: unknown; expires_at?: string | null };
      try {
        body = await readJsonBody(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      const result = await forwardToVault({
        method: 'POST',
        vaultBaseUrl: baseUrl,
        subpath: '/tokens',
        authHeader,
        body,
      });
      json(res, result.status, result.body);
      return true;
    }
    error(res, 405, `method not allowed: ${method} ${pathname}`);
    return true;
  }

  const detail = pathname.match(/^\/api\/vaults\/([^/]+)$/);
  if (detail && method === 'GET') {
    const name = decodeURIComponent(detail[1]);
    let vaults: VaultListing[];
    try {
      vaults = await fetchHubVaults();
    } catch (err) {
      error(res, 502, err instanceof Error ? err.message : String(err));
      return true;
    }
    const hit = vaults.find((v) => v.name === name);
    if (!hit) {
      error(res, 404, `vault not found: ${name}`);
      return true;
    }
    const folders = listGroupFolders();
    const entries = listVaultAttachments(folders).filter(
      (e) => e.attachment.vaultBaseUrl.replace(/\/+$/, '') === hit.url.replace(/\/+$/, ''),
    );
    json(res, 200, {
      vault: hit,
      attachedGroups: entries.map((e) => ({
        folder: e.folder,
        mcpName: e.mcpName,
        scope: e.attachment.scope,
        tokenLabel: e.attachment.tokenLabel,
        attachedAt: e.attachment.attachedAt,
      })),
    });
    return true;
  }

  return false;
}
