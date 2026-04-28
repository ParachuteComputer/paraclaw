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
// `{"error":"This endpoint requires the claw:admin scope"}`. We match the
// substring rather than the exact phrase so a future copy tweak doesn't
// silently disable re-auth. Reads via .clone() so readError() can still
// consume the original body if the caller falls through to throw.
async function isScopeMismatch(res: Response): Promise<boolean> {
  try {
    const text = await res.clone().text();
    return /requires the [\w:]+ scope/.test(text);
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

export async function request<T>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  let bearer = getAccessToken();
  if (!bearer) {
    // No token at all — kick off the OAuth dance. beginLogin() never returns.
    await beginLogin();
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
      await beginLogin();
    }
  }
  // 403 with a scope-mismatch body means the cached token was minted before
  // a newly-required scope was added (paraclaw#33). Without this, existing
  // users were stuck behind a manual `localStorage.clear()` after the Phase 1
  // wizard bumped REQUESTED_SCOPES to include claw:admin. Refresh won't help
  // (refresh tokens carry the original scope set), so drop straight to
  // re-auth — beginLogin() will request the new scope set.
  if (res.status === 403 && (await isScopeMismatch(res))) {
    clearTokens();
    await beginLogin();
  }
  if (!res.ok) {
    throw new Error(await readError(res));
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

export async function createGroup(input: CreateGroupInput): Promise<{
  group: AgentGroupView;
  mintedVaultToken: boolean;
}> {
  return request<{ group: AgentGroupView; mintedVaultToken: boolean }>(`/groups`, { method: 'POST', json: input });
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

export async function attachVault(
  folder: string,
  input: {
    scope: VaultScope;
    vaultBaseUrl?: string;
    tokenLabel?: string;
    token?: string;
    mcpName?: string;
  },
): Promise<{ group: AgentGroupView; mintedToken: boolean }> {
  return request<{ group: AgentGroupView; mintedToken: boolean }>(
    `/groups/${encodeURIComponent(folder)}/attach-vault`,
    { method: 'POST', json: input },
  );
}

export async function detachVault(folder: string, mcpName?: string): Promise<AgentGroupView> {
  const r = await request<{ group: AgentGroupView }>(`/groups/${encodeURIComponent(folder)}/detach-vault`, {
    method: 'POST',
    json: { mcpName },
  });
  return r.group;
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

export async function listGroupActivity(
  folder: string,
  options: ListActivityOptions = {},
): Promise<ActivityEntry[]> {
  const params = new URLSearchParams();
  if (options.since) params.set('since', options.since);
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  const path = `/agent-groups/${encodeURIComponent(folder)}/activity${qs ? `?${qs}` : ''}`;
  const r = await request<{ activity: ActivityEntry[] }>(path);
  return r.activity;
}

// --- Secrets (paraclaw-native, replaces OneCLI proxy) ---

/** Per PRIMITIVES.md §"Secret": kinds keyed by purpose. */
export type SecretKind = 'channel-token' | 'api-key' | 'generic';

export interface SecretView {
  id: string;
  name: string;
  kind: SecretKind;
  /** null when the secret is global (not bound to a single agent group). */
  agentGroupId: string | null;
  createdAt: string;
  updatedAt: string;
  // Values are NEVER returned — they exist only to be injected into
  // session containers at spawn time. The list page only ever shows names.
}

export async function listSecrets(): Promise<SecretView[]> {
  const r = await request<{ secrets: SecretView[] }>('/secrets');
  return r.secrets;
}

export interface PutSecretInput {
  name: string;
  value: string;
  kind?: SecretKind;
  /** Bind to a specific agent group. Omit for a global secret. */
  agentGroupId?: string | null;
}

/**
 * Create or replace a secret. The server upserts on `name` (+ agentGroupId
 * scope) and returns the public view — no value, just the metadata. The
 * raw value is dropped from memory the moment the request resolves.
 */
export async function putSecret(input: PutSecretInput): Promise<SecretView> {
  const r = await request<{ secret: SecretView }>('/secrets', {
    method: 'POST',
    json: input,
  });
  return r.secret;
}

export async function deleteSecret(id: string): Promise<void> {
  return request<void>(`/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

// --- Channel wirings (global view) ---

export type ChannelKind = 'discord' | 'telegram' | 'cli';

export type EngageMode = 'mention' | 'pattern' | 'all';
export type SenderScope = 'allowlist' | 'all';
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

export async function deleteChannelWire(id: string): Promise<void> {
  return request<void>(`/channels/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface UpdateChannelWireInput {
  engageMode?: EngageMode;
  engagePattern?: string | null;
  senderScope?: SenderScope;
  ignoredMessagePolicy?: IgnoredMessagePolicy;
  priority?: number;
}

export async function updateChannelWire(id: string, input: UpdateChannelWireInput): Promise<ChannelWireView> {
  const r = await request<{ wire: ChannelWireView }>(`/channels/${encodeURIComponent(id)}`, {
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
 * `botUserId` semantics differ by channel — see web/server/src/wire-channel.ts:
 *   - discord  : the BOT's snowflake (DMs are addressee-routed; ANY DM lands on the bot's @me)
 *   - telegram : the OPERATOR's user id (DMs are chat-routed; only that user's DMs match)
 */
export async function wireChannelToGroup(
  folder: string,
  input: { channel: ChannelKind; botUserId: string; displayName?: string },
): Promise<WireChannelResult> {
  return request<WireChannelResult>(`/groups/${encodeURIComponent(folder)}/wire-channel`, {
    method: 'POST',
    json: input,
  });
}
