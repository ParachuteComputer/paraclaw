/**
 * HTTP client to the Paraclaw web server.
 *
 * In dev: Vite proxies /api/* to localhost:1944.
 * In prod: server serves the built UI under /claw/, /api/* on the same origin.
 *
 * Auth: every /api/* request gets `Authorization: Bearer <jwt>` from the
 * hub-OAuth flow in `./auth.ts`. On a 401 we refresh once; if the refresh
 * fails the wrapper hard-redirects to login. /api/discovery is the one
 * exception — it's the bootstrap and is fetched directly by auth.ts.
 *
 * Endpoint surface follows /tmp/paraclaw-night/PRIMITIVES.md — the night
 * rebirth replaces OneCLI proxying with paraclaw-native /api/secrets,
 * /api/approvals, /api/sessions, /api/channels.
 */
import { beginLogin, clearTokens, getAccessToken, refreshAccessToken } from './auth.ts';

// Mount-aware: when paraclaw is served at /claw/ (under hub on tailnet), API
// calls must go to /claw/api/* — the bare /api/* path goes to the hub origin's
// root, where it 404s. BASE_URL has the trailing slash already; the trim keeps
// us from emitting //api when BASE_URL is /.
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;

export type VaultScope = 'vault:read' | 'vault:write' | 'vault:admin';

export interface VaultAttachment {
  vaultBaseUrl: string;
  scope: VaultScope;
  tokenLabel: string;
  attachedAt: string;
}

export interface SessionStatus {
  sessionId: string;
  status: 'active' | 'closed';
  containerStatus: 'running' | 'idle' | 'stopped';
  alive: boolean;
  lastHeartbeatAt: string | null;
  lastMessageInAt: string | null;
  lastMessageOutAt: string | null;
  createdAt: string;
  lastActiveAt: string | null;
}

export interface GroupStatus {
  containerRunning: boolean;
  activeSessionCount: number;
  sessionCount: number;
  lastHeartbeatAt: string | null;
  lastMessageInAt: string | null;
  lastMessageOutAt: string | null;
  sessions: SessionStatus[];
}

export interface AgentGroupView {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  created_at: string;
  vault: VaultAttachment | null;
  status: GroupStatus | null;
}

async function doFetch(
  path: string,
  init: (RequestInit & { json?: unknown }) | undefined,
  bearer: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  let body: BodyInit | undefined = init?.body as BodyInit | undefined;
  if (init?.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  return fetch(`${API_BASE}${path}`, { ...init, headers, body });
}

// Hub's scope-validation 403 (cli#71) responds with a body like
// `{"error":"This endpoint requires the claw:admin scope"}`; the vault
// uses single-quoted scope names: `requires the 'vault:work:admin' scope
// (or 'vault:work:admin')`. We match either quoting so paraclaw#56's
// vault path doesn't slip past the gate. Reads via .clone() so
// readError() can still consume the original body if the caller falls
// through to throw.
async function isScopeMismatch(res: Response): Promise<boolean> {
  try {
    const text = await res.clone().text();
    return /requires the ['"]?[\w:]+['"]? scope/.test(text);
  } catch {
    return false;
  }
}

async function readError(res: Response): Promise<string> {
  let message = `${res.status} ${res.statusText}`;
  try {
    const text = await res.text();
    const parsed = JSON.parse(text) as { error?: string };
    if (parsed.error) message = parsed.error;
    else if (text) message = text;
  } catch {
    // not JSON, use status
  }
  return message;
}

/**
 * Error thrown for non-2xx responses. Carries the HTTP status so callers can
 * branch on it numerically instead of regex-matching the message string —
 * less brittle when servers reword their error bodies.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * `authExtraScopes` is forwarded to `beginLogin` if this call triggers a
 * re-auth (401-after-refresh-failure or 403 scope-mismatch). Use it on
 * endpoints that gate on a per-resource narrow scope the broad
 * REQUESTED_SCOPES set doesn't carry — e.g. vault token mgmt requires
 * `vault:<name>:admin` on top of `claw:admin`. Without this hint the
 * re-auth would loop with the same broad-only JWT (paraclaw#56).
 */
export interface RequestInitWithAuth extends RequestInit {
  json?: unknown;
  authExtraScopes?: string[];
}

export async function request<T>(path: string, init?: RequestInitWithAuth): Promise<T> {
  const extraScopes = init?.authExtraScopes;
  let bearer = getAccessToken();
  if (!bearer) {
    // No token at all — kick off the OAuth dance. beginLogin() never returns.
    await beginLogin(extraScopes);
  }
  let res = await doFetch(path, init, bearer);
  if (res.status === 401) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      bearer = refreshed;
      res = await doFetch(path, init, bearer);
    }
    if (res.status === 401) {
      // Refresh failed or post-refresh still 401 — drop tokens and re-auth.
      clearTokens();
      await beginLogin(extraScopes);
    }
  }
  // 403 with a scope-mismatch body means the cached token was minted before
  // a newly-required scope was added (paraclaw#33). Without this, existing
  // users were stuck behind a manual `localStorage.clear()` after the Phase 1
  // wizard bumped REQUESTED_SCOPES to include claw:admin. Refresh won't help
  // (refresh tokens carry the original scope set), so drop straight to
  // re-auth — beginLogin() will request the new scope set, plus any
  // narrow per-resource scope the caller threaded via authExtraScopes
  // (paraclaw#56).
  if (res.status === 403 && (await isScopeMismatch(res))) {
    clearTokens();
    await beginLogin(extraScopes);
  }
  if (!res.ok) {
    throw new HttpError(res.status, await readError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// --- Agent groups ---

export async function listGroups(): Promise<AgentGroupView[]> {
  const r = await request<{ groups: AgentGroupView[] }>('/groups');
  return r.groups;
}

export async function getGroup(folder: string): Promise<AgentGroupView> {
  const r = await request<{ group: AgentGroupView }>(`/groups/${encodeURIComponent(folder)}`);
  return r.group;
}

export interface FolderAvailability {
  slug: string;
  valid: boolean;
  available: boolean;
  reason?: string;
}

export async function checkFolderAvailability(slug: string): Promise<FolderAvailability> {
  return request<FolderAvailability>(`/folder-availability/${encodeURIComponent(slug)}`);
}

export async function fetchFolderSuggestion(name: string): Promise<string> {
  const r = await request<{ name: string; slug: string }>(`/folder-suggestion?name=${encodeURIComponent(name)}`);
  return r.slug;
}

export interface CreateGroupInput {
  name: string;
  folder: string;
  instructions?: string;
  vault?: {
    scope: VaultScope;
    vaultBaseUrl?: string;
    tokenLabel?: string;
    token?: string;
    mcpName?: string;
  };
}

export async function createGroup(
  input: CreateGroupInput,
  // Same scope-threading rationale as `attachVault`: when `input.vault` is
  // set, the create handler runs the implicit-mint via the operator's JWT
  // and 403s if it lacks `vault:<name>:admin`. NewGroupWizard knows the
  // picked vault name and threads it; an attach-less create can omit it.
  options: { authExtraScopes?: string[] } = {},
): Promise<{
  group: AgentGroupView;
  mintedVaultToken: boolean;
}> {
  return request<{ group: AgentGroupView; mintedVaultToken: boolean }>(`/groups`, {
    method: 'POST',
    json: input,
    authExtraScopes: options.authExtraScopes,
  });
}

// --- Vaults ---

export interface VaultListing {
  /** Vault display name from the hub's well-known discovery doc, e.g. `default`. */
  name: string;
  /** Public-routable URL the agent will reach the vault at. */
  url: string;
  /** Vault version the hub reports for this entry. */
  version: string;
}

export async function listVaults(): Promise<VaultListing[]> {
  const r = await request<{ vaults: VaultListing[] }>('/vaults');
  return r.vaults;
}

/**
 * POST /api/vaults/refresh — clears the 30s discovery cache and re-fetches
 * the well-known list. The Refresh button on `/vaults` calls this when the
 * operator just installed a new vault and doesn't want to wait out the cache.
 */
export async function refreshVaults(): Promise<VaultListing[]> {
  const r = await request<{ vaults: VaultListing[] }>('/vaults/refresh', { method: 'POST' });
  return r.vaults;
}

export interface VaultAttachedGroup {
  folder: string;
  mcpName: string;
  scope: string;
  tokenLabel: string;
  attachedAt: string;
}

export interface VaultDetail {
  vault: VaultListing;
  attachedGroups: VaultAttachedGroup[];
}

/** GET /api/vaults/:name — listing entry + attached-group derivation. claw:read. */
export async function getVaultDetail(name: string): Promise<VaultDetail> {
  return request<VaultDetail>(`/vaults/${encodeURIComponent(name)}`);
}

/**
 * Discriminated result of a tolerant token-count probe — distinguishes
 * "operator hasn't consented to vault:<name>:admin yet" (the case we want
 * to render as a row-level "—" with a Manage hint) from "vault is down or
 * the request blew up" (a generic error sentinel). Without the split, a
 * 500 would label as `unauthorized` and lie to the operator about why
 * the count is missing.
 */
export type TokenCountProbe = { kind: 'count'; value: number } | { kind: 'unauthorized' } | { kind: 'error' };

/**
 * Tolerant token-count probe for the index page. Bypasses `request<T>` on
 * purpose — a 401/403 here means the session JWT is missing the per-vault
 * narrow scope, not that the session itself is dead, and we don't want to
 * trap the operator in a re-auth loop before they can even see what
 * vaults exist. Consent prompt fires on the detail page (Phase 3).
 *
 * Do not reuse this helper for endpoints that should surface auth errors.
 */
export async function tryListVaultTokenCount(name: string): Promise<TokenCountProbe> {
  const bearer = getAccessToken();
  if (!bearer) return { kind: 'error' };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/vaults/${encodeURIComponent(name)}/tokens`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${bearer}` },
    });
  } catch {
    return { kind: 'error' };
  }
  if (res.status === 401 || res.status === 403) return { kind: 'unauthorized' };
  if (!res.ok) return { kind: 'error' };
  try {
    const body = (await res.json()) as { tokens?: unknown[] };
    return { kind: 'count', value: Array.isArray(body.tokens) ? body.tokens.length : 0 };
  } catch {
    return { kind: 'error' };
  }
}

export async function attachVault(
  folder: string,
  input: {
    scope: VaultScope;
    vaultBaseUrl?: string;
    tokenLabel?: string;
    token?: string;
    mcpName?: string;
  },
  // The server-side `/attach-vault` handler forwards the operator's JWT to
  // the vault for the implicit-mint step. If the JWT is missing
  // `vault:<name>:admin`, the vault 403s — and a re-auth without the narrow
  // scope just loops (paraclaw#56). Callers that know the picked vault name
  // (GroupDetail, NewGroupWizard) thread it here so consent grants the
  // right scope.
  options: { authExtraScopes?: string[] } = {},
): Promise<{ group: AgentGroupView; mintedToken: boolean }> {
  return request<{ group: AgentGroupView; mintedToken: boolean }>(
    `/groups/${encodeURIComponent(folder)}/attach-vault`,
    { method: 'POST', json: input, authExtraScopes: options.authExtraScopes },
  );
}

/**
 * Result of a detach call. `revokedTokenId` is non-null when the caller
 * passed `revokeToken: true` AND the vault delete succeeded; `revokeError`
 * is non-null when revoke was requested but the matching token couldn't
 * be located (already revoked, never minted via this label) — the detach
 * still proceeded paraclaw-side. Mirrors the shape returned by
 * `src/web/server.ts` at the `/detach-vault` handler.
 */
export interface DetachVaultResult {
  group: AgentGroupView;
  revokedTokenId: string | null;
  revokeError: string | null;
}

export async function detachVault(
  folder: string,
  options: { mcpName?: string; revokeToken?: boolean; authExtraScopes?: string[] } = {},
): Promise<DetachVaultResult> {
  // `authExtraScopes` is opt-in: the route key is the agent-group folder, so
  // the helper itself doesn't know the target vault. Callers on a vault-scoped
  // page (VaultDetail) pass `[\`vault:\${name}:admin\`]` so a 403 from the
  // server-side revoke step triggers a narrow-scoped re-auth (paraclaw#56).
  return request<DetachVaultResult>(`/groups/${encodeURIComponent(folder)}/detach-vault`, {
    method: 'POST',
    json: { mcpName: options.mcpName, revokeToken: options.revokeToken === true },
    authExtraScopes: options.authExtraScopes,
  });
}

// --- Vault tokens (admin-gated, requires vault:<name>:admin via JWT forward) ---

/**
 * Per-token row returned by `GET /api/vaults/:name/tokens`. paraclaw merges
 * `attachedTo` paraclaw-side from the parachute.json walk; the rest is the
 * vault's verbatim row. `scopes` and `permission` are mutually-exclusive in
 * practice (legacy tokens carry `permission`, current tokens carry
 * `scopes`) — the UI handles both via `legacyPermissionToScopes` rules.
 */
export interface VaultTokenAttachment {
  folder: string;
  scope: string;
}

export interface VaultToken {
  id: string;
  label: string;
  scopes?: string[];
  permission?: string;
  expires_at?: string | null;
  created_at?: string;
  last_used_at?: string | null;
  attachedTo: VaultTokenAttachment[];
}

/**
 * GET /api/vaults/:name/tokens — listing + attached-to merge. paraclaw-side
 * scope is `claw:admin`; vault-side `vault:<name>:admin` is enforced by the
 * vault itself and a 401/403 from the vault is mirrored verbatim. Callers
 * use `HttpError.status` to detect the vault-narrow-scope-missing case and
 * trigger a consent prompt (Phase 3 detail page only).
 */
export async function listVaultTokens(name: string): Promise<VaultToken[]> {
  const r = await request<{ tokens: VaultToken[] }>(`/vaults/${encodeURIComponent(name)}/tokens`);
  return r.tokens;
}

export interface MintVaultTokenInput {
  label: string;
  scopes: string[];
  /** ISO8601, optional. Vault interprets null/missing as "never". */
  expires_at?: string | null;
}

/**
 * Plaintext `pvt_…` token returned exactly once on mint. paraclaw passes it
 * through from the vault unmodified; the UI must hold it in component
 * state, render it once with a copy button, and never persist it.
 */
export interface MintedVaultToken {
  /** The raw `pvt_…` plaintext — only present on the mint response, never re-fetched. */
  token: string;
  id: string;
  label: string;
  scopes?: string[];
  permission?: string;
  created_at?: string;
  expires_at?: string | null;
}

export async function mintVaultToken(name: string, input: MintVaultTokenInput): Promise<MintedVaultToken> {
  // Vault enforces `vault:<name>:admin` on this endpoint; thread it through
  // so a 403 scope-mismatch triggers re-auth with the narrow scope appended,
  // not just the broad REQUESTED_SCOPES set (paraclaw#56).
  return request<MintedVaultToken>(`/vaults/${encodeURIComponent(name)}/tokens`, {
    method: 'POST',
    json: input,
    authExtraScopes: [`vault:${name}:admin`],
  });
}

export async function revokeVaultToken(name: string, id: string): Promise<void> {
  return request<void>(`/vaults/${encodeURIComponent(name)}/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    authExtraScopes: [`vault:${name}:admin`],
  });
}

// --- Sessions ---

export interface SpawnSessionResult {
  sessionId: string;
  created: boolean;
}

export async function spawnSession(folder: string): Promise<SpawnSessionResult> {
  return request<SpawnSessionResult>(`/groups/${encodeURIComponent(folder)}/sessions`, {
    method: 'POST',
    json: {},
  });
}

/**
 * Top-level session listing — flat across all agent groups. Per
 * PRIMITIVES.md §"API surface": GET /api/sessions returns the global view
 * the /sessions page surfaces (vs. the per-group view embedded in
 * GroupStatus.sessions).
 */
export interface SessionView {
  id: string;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  messagingGroupId: string | null;
  status: 'active' | 'closed';
  containerStatus: 'running' | 'idle' | 'stopped';
  alive: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  lastHeartbeatAt: string | null;
}

export async function listSessions(): Promise<SessionView[]> {
  const r = await request<{ sessions: SessionView[] }>('/sessions');
  return r.sessions;
}

export async function closeSession(sessionId: string): Promise<{ id: string; status: 'closed' }> {
  return request<{ id: string; status: 'closed' }>(`/sessions/${encodeURIComponent(sessionId)}/close`, {
    method: 'POST',
    json: {},
  });
}

// --- Agent activity log ---

/**
 * Activity entry surfaced from `/api/agent-groups/:folder/activity`.
 * `kind` is open-ended (the server adds new ones over time), but the UI
 * has special rendering for the three documented in the PR2 brief:
 * `secret_use`, `mcp_call`, `cmd_exec`. Anything else falls through to a
 * generic row.
 *
 * `target` is whatever-the-kind-points-at: secret name, tool name, or
 * the command string. `summary` is the human-readable detail line — the
 * server is responsible for keeping it short and quotable.
 */
export type ActivityKind = 'secret_use' | 'mcp_call' | 'cmd_exec' | string;

export interface ActivityEntry {
  id: string;
  agentGroupId: string;
  /** Null when the event isn't tied to a specific session (rare — most are). */
  sessionId: string | null;
  kind: ActivityKind;
  target: string;
  summary: string;
  createdAt: string;
}

export interface ListActivityOptions {
  /** ISO8601 — only return entries strictly newer than this. Used for incremental polling. */
  since?: string;
  /** Server caps at ~500; default is 100. */
  limit?: number;
}

export async function listGroupActivity(folder: string, options: ListActivityOptions = {}): Promise<ActivityEntry[]> {
  const params = new URLSearchParams();
  if (options.since) params.set('since', options.since);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  const path = `/agent-groups/${encodeURIComponent(folder)}/activity${qs ? `?${qs}` : ''}`;
  const r = await request<{ activity: ActivityEntry[] }>(path);
  return r.activity;
}

// --- Apps (OAuth integrations: per-provider OAuth configs + user grants) ---

/**
 * Three-table OneCLI model surfaced through `/api/apps/*`:
 *   1. app_configs      — per-provider OAuth client (paste client_id/secret)
 *   2. app_connections  — user grants (the rows GET /api/apps returns)
 *   3. assignments      — which agent groups see which connection (drawer; not yet wired in this PR)
 *
 * The brief locks the wire to one config per (paraclaw-instance, provider).
 * A connection's `agentGroupCount` is the only assignment hint surfaced in
 * this PR; full per-connection assignment editing comes with the cross-page
 * pivot follow-up.
 */
export type AppConnectionStatus = 'active' | 'expired' | 'revoked';

/**
 * Per-connection scope: `all` injects into every agent group; `selective`
 * consults the join table. Mirrors the secrets shape from PR1.
 */
export type AssignedMode = 'all' | 'selective';

export interface AppConnectionView {
  id: string;
  provider: string;
  /** From userinfo at OAuth completion. May be null for providers that don't expose it. */
  account_email: string | null;
  /** Auto-populated label (typically `<email> @ <provider>`). User-overridable in a future PR. */
  label: string;
  scopes_granted: string[];
  /** ISO8601 — null when refresh tokens never expire (some providers). */
  expires_at: string | null;
  status: AppConnectionStatus;
  /** Count only — the assignment list isn't returned here. */
  agentGroupCount: number;
  /**
   * Forward-compat: nullable in v1; mandatory once the cross-page-pivot
   * follow-up lands the per-connection assignment editor. UI is not yet
   * bound to this field — leaving the slot in the type so the next PR
   * doesn't have to retrofit.
   */
  assignedMode: AssignedMode | null;
}

export interface AppConfigView {
  provider: string;
  client_id: string;
  scopes_default: string[];
  /**
   * The server NEVER returns the secret; only an existence flag. The UI uses
   * this to choose between "Add config" and "Replace secret" in the form.
   */
  hasSecret: boolean;
}

export async function listAppConnections(): Promise<AppConnectionView[]> {
  // Server returns the list directly per the brief (no envelope), but we
  // accept either shape so a future envelope migration doesn't break here.
  // assignedMode is forward-compat (see type comment) — default to null
  // when the v1 server omits it.
  type Wire = Omit<AppConnectionView, 'assignedMode'> & { assignedMode?: AssignedMode | null };
  const r = await request<Wire[] | { apps: Wire[] }>('/apps');
  const list = Array.isArray(r) ? r : r.apps;
  return list.map((c) => ({ ...c, assignedMode: c.assignedMode ?? null }));
}

export async function getAppConfig(provider: string): Promise<AppConfigView | null> {
  // 404 is the documented "no config yet" signal — distinguish that from a
  // real error so the UI can render the "Add config" CTA instead of a banner.
  try {
    return await request<AppConfigView>(`/apps/${encodeURIComponent(provider)}/config`);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

export interface PutAppConfigInput {
  client_id: string;
  client_secret: string;
  scopes_default?: string[];
}

export async function putAppConfig(provider: string, input: PutAppConfigInput): Promise<AppConfigView> {
  // Canonical wire shape: PUT (idempotent upsert) per the team-lead's brief.
  // Server-side handler keys on (paraclaw-instance, provider) and replaces.
  return request<AppConfigView>(`/apps/${encodeURIComponent(provider)}/config`, {
    method: 'PUT',
    json: input,
  });
}

export interface AuthorizeAppOptions {
  /** Bind the resulting connection to a specific agent group on creation. */
  agentGroupId?: string;
}

export interface AuthorizeAppResult {
  redirectUrl: string;
  state: string;
}

/**
 * Kick off the OAuth dance — the caller is expected to navigate the browser
 * to `redirectUrl`. The server completes the exchange on its callback and
 * redirects back to `/claw/apps?connected=:id`.
 */
export async function authorizeApp(provider: string, options: AuthorizeAppOptions = {}): Promise<AuthorizeAppResult> {
  return request<AuthorizeAppResult>(`/apps/${encodeURIComponent(provider)}/authorize`, {
    method: 'POST',
    json: options,
  });
}

export async function deleteAppConnection(id: string): Promise<void> {
  return request<void>(`/apps/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// --- Secrets (paraclaw-native, replaces OneCLI proxy) ---

/** Per PRIMITIVES.md §"Secret": kinds keyed by purpose. */
export type SecretKind = 'channel-token' | 'api-key' | 'generic';

/**
 * `all` — inject into every agent container (subject to scoped-vs-global
 *   resolution per `src/secrets/index.ts:resolveInjectableSecrets`).
 * `selective` — inject only into the agent groups explicitly assigned via
 *   /api/secrets/:id/assignments.
 *
 * The `AssignedMode` type itself is declared in the Apps section above; both
 * surfaces share the same allow-list semantics so we reuse the alias.
 */

export interface SecretView {
  id: string;
  name: string;
  kind: SecretKind;
  /** null when the secret is global (not bound to a single agent group). */
  agentGroupId: string | null;
  assignedMode: AssignedMode;
  createdAt: string;
  updatedAt: string;
  // Values are NEVER returned — they exist only to be injected into
  // session containers at spawn time. The list page only ever shows names.
}

export async function listSecrets(): Promise<SecretView[]> {
  // The list-secrets endpoint may not yet surface `assignedMode` (it lands in
  // a separate paraclaw-server PR). Default missing values to 'all' so the UI
  // renders correctly until the field is wired through.
  const r = await request<{ secrets: Array<Omit<SecretView, 'assignedMode'> & { assignedMode?: AssignedMode }> }>(
    '/secrets',
  );
  return r.secrets.map((s) => ({ ...s, assignedMode: s.assignedMode ?? 'all' }));
}

export interface PutSecretInput {
  name: string;
  value: string;
  kind?: SecretKind;
  /** Bind to a specific agent group. Omit for a global secret. */
  agentGroupId?: string | null;
  assignedMode?: AssignedMode;
}

/**
 * Create or replace a secret. The server upserts on `name` (+ agentGroupId
 * scope) and returns the public view — no value, just the metadata. The
 * raw value is dropped from memory the moment the request resolves.
 */
export async function putSecret(input: PutSecretInput): Promise<SecretView> {
  const body: Record<string, unknown> = {
    name: input.name,
    value: input.value,
  };
  if (input.kind !== undefined) body.kind = input.kind;
  if (input.agentGroupId !== undefined) body.agentGroupId = input.agentGroupId;
  // Server reads snake_case for assigned_mode (src/web/routes/secrets.ts);
  // send both so the wire is robust to a future camelCase migration.
  if (input.assignedMode !== undefined) {
    body.assignedMode = input.assignedMode;
    body.assigned_mode = input.assignedMode;
  }
  const r = await request<{
    secret: Omit<SecretView, 'assignedMode'> & { assignedMode?: AssignedMode };
  }>('/secrets', { method: 'POST', json: body });
  // Same fallback as listSecrets — until paraclaw-server surfaces the field,
  // assume the just-written value (or 'all' if we didn't send one).
  return { ...r.secret, assignedMode: r.secret.assignedMode ?? input.assignedMode ?? 'all' };
}

export async function deleteSecret(id: string): Promise<void> {
  return request<void>(`/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Per-secret assignment endpoints (selective-mode only). The server returns
 * just IDs; the UI denormalizes against listGroups() for display.
 * See migrations/016 + src/web/routes/secrets.ts.
 */
export async function listSecretAssignments(secretId: string): Promise<string[]> {
  const r = await request<{ secretId: string; agentGroupIds: string[] }>(
    `/secrets/${encodeURIComponent(secretId)}/assignments`,
  );
  return r.agentGroupIds;
}

export async function setSecretAssignments(secretId: string, agentGroupIds: string[]): Promise<string[]> {
  const r = await request<{ secretId: string; agentGroupIds: string[] }>(
    `/secrets/${encodeURIComponent(secretId)}/assignments`,
    { method: 'PUT', json: { agentGroupIds } },
  );
  return r.agentGroupIds;
}

// --- Approvals ---

export type ApprovalKind = 'install_packages' | 'add_mcp_server' | 'access-new-credential' | string;
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface ApprovalView {
  id: string;
  agentGroupId: string;
  agentGroupName: string | null;
  kind: ApprovalKind;
  /** Free-form payload — UI renders kind-specific summaries; falls back to JSON. */
  actionPayload: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  /** Session id that triggered the request, for traceability. */
  requestedBy: string;
}

export async function listApprovals(): Promise<ApprovalView[]> {
  const r = await request<{ approvals: ApprovalView[] }>('/approvals');
  return r.approvals;
}

export type ApprovalDecision = 'approve' | 'reject';

export async function decideApproval(id: string, decision: ApprovalDecision): Promise<ApprovalView> {
  const r = await request<{ approval: ApprovalView }>(`/approvals/${encodeURIComponent(id)}/decide`, {
    method: 'POST',
    json: { decision },
  });
  return r.approval;
}

// --- Settings: approval routing ---

export interface ApprovalRoutingBot {
  botId: string;
  label: string;
}

export interface ApprovalRoutingRow {
  userId: string;
  channelType: string;
  /**
   * Bot id sitting in the channel-default `bot_id=''` slot. Null when
   * no default has been resolved yet — the operator hasn't been DMed
   * on that channel and `pickApprovalDelivery` has nothing to fall
   * back to.
   */
  currentBotId: string | null;
  availableBots: ApprovalRoutingBot[];
}

export async function listApprovalRouting(): Promise<ApprovalRoutingRow[]> {
  const r = await request<{ rows: ApprovalRoutingRow[] }>('/settings/approval-routing');
  return r.rows;
}

export async function setApprovalRoutingDefault(
  userId: string,
  channelType: string,
  botId: string,
): Promise<ApprovalRoutingRow> {
  const r = await request<{ row: ApprovalRoutingRow }>('/settings/approval-routing', {
    method: 'POST',
    json: { userId, channelType, botId },
  });
  return r.row;
}

// --- Settings: agent provider ---

export type AgentProviderSource = 'claude_setup_token' | 'anthropic_api_key' | 'external_server';

export interface AgentProviderView {
  source: AgentProviderSource | null;
  hasApiKey: boolean;
  serverUrl: string | null;
  updatedAt: string | null;
}

export interface SetAgentProviderInput {
  source: AgentProviderSource;
  apiKey?: string;
  serverUrl?: string;
}

export async function getAgentProvider(): Promise<AgentProviderView> {
  return request<AgentProviderView>('/settings/agent-provider');
}

export async function setAgentProvider(input: SetAgentProviderInput): Promise<AgentProviderView> {
  return request<AgentProviderView>('/settings/agent-provider', {
    method: 'POST',
    json: input,
  });
}

// --- Settings: per-agent-group agent provider override (paraclaw#86) ---

/**
 * Per-group view: `override` is the row keyed on this agent_group_id (all
 * fields null when no override exists). `effective` is what the next
 * spawn would actually use — the override when present, otherwise the
 * install-wide default. `overridden` is the trigger for the UI's
 * inherit/override branching.
 */
export interface GroupAgentProviderView {
  agentGroupId: string;
  overridden: boolean;
  override: AgentProviderView;
  effective: AgentProviderView;
}

export async function getGroupAgentProvider(folder: string): Promise<GroupAgentProviderView> {
  return request<GroupAgentProviderView>(`/groups/${encodeURIComponent(folder)}/agent-provider`);
}

export async function setGroupAgentProvider(
  folder: string,
  input: SetAgentProviderInput,
): Promise<GroupAgentProviderView> {
  return request<GroupAgentProviderView>(`/groups/${encodeURIComponent(folder)}/agent-provider`, {
    method: 'POST',
    json: input,
  });
}

export async function clearGroupAgentProvider(folder: string): Promise<GroupAgentProviderView> {
  return request<GroupAgentProviderView>(`/groups/${encodeURIComponent(folder)}/agent-provider`, {
    method: 'DELETE',
  });
}

/**
 * Per-channel native id of the install's primary operator (oldest global
 * owner). Used to pre-fill the "bot admin user" field on /channels/new so
 * the operator doesn't re-enter their own user id every time. Empty record
 * on a fresh install with no owner yet.
 */
export async function listOperatorIdentities(): Promise<Record<string, string>> {
  const r = await request<{ byChannel: Record<string, string> }>('/settings/operator-identity');
  return r.byChannel;
}

// --- Per-MG (messaging-group) detail page ---

/**
 * The three policies the router applies to messages from senders the
 * messaging group hasn't seen / approved before. Exact wire mirror of
 * `UnknownSenderPolicy` in `src/types.ts` — no translator; values cross
 * the wire as-is. Keep this union in lock-step with the server side.
 * `public` is the value the DB uses; `open` is NOT a valid value (we
 * surface only the canonical names).
 *
 * - `request_approval` — pause the message and DM the operator with an
 *   approve/reject card. Default for auto-created MGs.
 * - `strict` — drop silently. Used on MGs the operator has explicitly locked
 *   down.
 * - `public` — admit and route normally. The MG behaves as if every sender
 *   is known.
 */
export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface WiredAgentSummary {
  /** mga.id — primary key for the per-MGA detail page (lands in PR3). */
  messagingGroupAgentId: string;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  engageMode: EngageMode;
  engagePattern: string | null;
  senderScope: SenderScope;
  ignoredMessagePolicy: IgnoredMessagePolicy;
  priority: number;
  createdAt: string;
}

export interface MessagingGroupDetailView {
  id: string;
  channelType: string;
  platformId: string;
  /** Operator-assigned name; null when unset (most auto-created DMs are unnamed). */
  displayName: string | null;
  isGroup: boolean;
  unknownSenderPolicy: UnknownSenderPolicy;
  /** ISO when the owner explicitly denied this channel; null otherwise. */
  deniedAt: string | null;
  createdAt: string;
  wiredAgents: WiredAgentSummary[];
}

export async function getMessagingGroupDetail(id: string): Promise<MessagingGroupDetailView> {
  const r = await request<{ messagingGroup: MessagingGroupDetailView }>(`/channels/mg/${encodeURIComponent(id)}`);
  return r.messagingGroup;
}

export async function updateMessagingGroupPolicy(
  id: string,
  unknownSenderPolicy: UnknownSenderPolicy,
): Promise<MessagingGroupDetailView> {
  const r = await request<{ messagingGroup: MessagingGroupDetailView }>(`/channels/mg/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: { unknownSenderPolicy },
  });
  return r.messagingGroup;
}

// --- Channel wirings (global view) ---

export type ChannelKind = 'discord' | 'telegram' | 'cli';

// Wire vocabulary. See dbToApi* in src/web/routes/channels.ts for DB equivalents in src/types.ts.
export type EngageMode = 'mention' | 'pattern' | 'all';
// Wire vocabulary. See dbToApi* in src/web/routes/channels.ts for DB equivalents in src/types.ts.
export type SenderScope = 'allowlist' | 'all';
// Wire vocabulary. See dbToApi* in src/web/routes/channels.ts for DB equivalents in src/types.ts.
export type IgnoredMessagePolicy = 'drop' | 'silent';

export interface ChannelWireView {
  id: string;
  channelType: ChannelKind;
  /** paraclaw-internal id for the platform thread (DM, channel, etc.). */
  messagingGroupId: string;
  /** Platform-side id (snowflake / chat id / etc.) — for display. */
  platformId: string;
  /** Human-friendly hint shown alongside platformId; can be null. */
  displayName: string | null;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  engageMode: EngageMode;
  engagePattern: string | null;
  senderScope: SenderScope;
  ignoredMessagePolicy: IgnoredMessagePolicy;
  priority: number;
  createdAt: string;
}

export async function listChannelWires(): Promise<ChannelWireView[]> {
  const r = await request<{ wires: ChannelWireView[] }>('/channels');
  return r.wires;
}

export async function getChannelWireDetail(id: string): Promise<ChannelWireView> {
  const r = await request<{ wire: ChannelWireView }>(`/channels/mga/${encodeURIComponent(id)}`);
  return r.wire;
}

export async function deleteChannelWire(id: string): Promise<void> {
  return request<void>(`/channels/mga/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface UpdateChannelWireInput {
  engageMode?: EngageMode;
  engagePattern?: string | null;
  senderScope?: SenderScope;
  ignoredMessagePolicy?: IgnoredMessagePolicy;
  priority?: number;
}

export async function updateChannelWire(id: string, input: UpdateChannelWireInput): Promise<ChannelWireView> {
  const r = await request<{ wire: ChannelWireView }>(`/channels/mga/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    json: input,
  });
  return r.wire;
}

// --- Setup wizard endpoints (status + adapter install) ---

export interface SetupCheck {
  ok: boolean;
  detail: string;
  fix: string | null;
}
export interface SetupStatus {
  /** Native paraclaw secrets backend; replaces the OneCLI gateway probe. */
  secrets: SetupCheck;
  hub: SetupCheck;
  vaultAttached: SetupCheck;
  channels: {
    discord: { installed: boolean };
    telegram: { installed: boolean };
  };
  ready: boolean;
}

export async function getSetupStatus(): Promise<SetupStatus> {
  return request<SetupStatus>(`/setup/status`);
}

export type TaskStepStatus = 'pending' | 'running' | 'completed' | 'failed';
export interface TaskStep {
  name: string;
  status: TaskStepStatus;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}
export interface TaskRecord {
  id: string;
  kind: string;
  status: TaskStepStatus;
  steps: TaskStep[];
  result: unknown;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartInstallChannelResult {
  taskId: string;
  kind: string;
}

export async function startInstallChannel(channel: ChannelKind): Promise<StartInstallChannelResult> {
  return request<StartInstallChannelResult>(`/setup/install-channel`, {
    method: 'POST',
    json: { channel },
  });
}

export async function getTask(id: string): Promise<TaskRecord> {
  return request<TaskRecord>(`/tasks/${encodeURIComponent(id)}`);
}

// --- Channel credential validators (used by both wizard + /secrets form) ---

export interface DiscordIdentity {
  id: string;
  username: string;
  discriminator: string;
  bot: boolean;
}
export async function testDiscordToken(token: string): Promise<{ identity: DiscordIdentity }> {
  return request<{ identity: DiscordIdentity }>(`/channels/discord/test`, {
    method: 'POST',
    json: { token },
  });
}

export interface TelegramIdentity {
  id: number;
  username: string;
  firstName: string;
  isBot: boolean;
}
export async function testTelegramToken(token: string): Promise<{ identity: TelegramIdentity }> {
  return request<{ identity: TelegramIdentity }>(`/channels/telegram/test`, {
    method: 'POST',
    json: { token },
  });
}

// --- Dynamic bot registration (used after token validate, before wire) ---

export interface RegisterChannelBotResult {
  ok: true;
  botId: string;
  username: string;
}

/**
 * Persist the validated bot token to /secrets and bring up its adapter at
 * runtime. Idempotent on `(channel, botId)` — re-posting the same token
 * refreshes the ciphertext and returns the already-active adapter.
 *
 * Run this AFTER `testDiscordToken` / `testTelegramToken` succeeds so the
 * server can fail fast on bad tokens before any DB write. The returned
 * `botId` is what the next `wireChannelToGroup` call should pass as
 * `botUserId` for Discord (where botId == bot's snowflake), and as the
 * basis of the operator-id for Telegram.
 */
export async function registerChannelBot(channel: ChannelKind, token: string): Promise<RegisterChannelBotResult> {
  return request<RegisterChannelBotResult>(`/channels/${encodeURIComponent(channel)}/register-bot`, {
    method: 'POST',
    json: { token },
  });
}

// --- Channel wiring (per-group, used by wizard step 7) ---

export interface WireChannelResult {
  messagingGroupId: string;
  messagingGroupAgentId: string;
  platformId: string;
  created: { messagingGroup: boolean; wiring: boolean };
}

/**
 * Wire a DM channel to an agent group.
 *
 * `botId` is the bot's own identity (returned by /register-bot); it forms
 * the second segment of the v2 platform_id and keys the dynamic adapter
 * the server brings up after the wire commits.
 *
 * `botUserId` semantics differ by channel — see src/web/wire-channel.ts:
 *   - discord  : the BOT's snowflake (DMs are addressee-routed; ANY DM lands on the bot's @me)
 *   - telegram : the OPERATOR's user id (DMs are chat-routed; only that user's DMs match)
 *
 * `operatorUserId` is the operator's user id captured by the form (Telegram
 * only). It seeds the in-memory trust hint that lets the operator's first
 * post-wire DM bypass the unwired-channel approval cascade. Empty string
 * is fine for adapters that don't capture an operator id.
 */
export async function wireChannelToGroup(
  folder: string,
  input: {
    channel: ChannelKind;
    botId: string;
    botUserId: string;
    operatorUserId?: string;
    displayName?: string;
  },
): Promise<WireChannelResult> {
  // Server's body parser keys on `channelType` (matches the DB column
  // and the wire-channel.ts WireDmInput interface). The helper accepts
  // `channel` for caller ergonomics — translate at the wire boundary.
  return request<WireChannelResult>(`/groups/${encodeURIComponent(folder)}/wire-channel`, {
    method: 'POST',
    json: {
      channelType: input.channel,
      botId: input.botId,
      botUserId: input.botUserId,
      operatorUserId: input.operatorUserId,
      displayName: input.displayName,
    },
  });
}
