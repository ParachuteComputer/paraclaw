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

export async function listGroups(): Promise<AgentGroupView[]> {
  const r = await request<{ groups: AgentGroupView[] }>('/groups');
  return r.groups;
}

export interface VaultListing {
  /** Vault display name from the hub's well-known discovery doc, e.g. `default`. */
  name: string;
  /** Public-routable URL the agent will reach the vault at, e.g. `https://parachute.taildf9ce2.ts.net/vault/default`. */
  url: string;
  /** Vault version the hub reports for this entry. */
  version: string;
}

export async function listVaults(): Promise<VaultListing[]> {
  const r = await request<{ vaults: VaultListing[] }>('/vaults');
  return r.vaults;
}

export async function getGroup(folder: string): Promise<AgentGroupView> {
  const r = await request<{ group: AgentGroupView }>(`/groups/${encodeURIComponent(folder)}`);
  return r.group;
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

export interface SpawnSessionResult {
  sessionId: string;
  created: boolean;
}

export async function spawnSession(folder: string): Promise<SpawnSessionResult> {
  return request<SpawnSessionResult>(`/groups/${encodeURIComponent(folder)}/sessions`, {
    method: "POST",
    json: {},
  });
}

export async function detachVault(folder: string, mcpName?: string): Promise<AgentGroupView> {
  const r = await request<{ group: AgentGroupView }>(`/groups/${encodeURIComponent(folder)}/detach-vault`, {
    method: 'POST',
    json: { mcpName },
  });
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

// --- Setup wizard endpoints (paraclaw#27 PR A backend) ---

export interface SetupCheck {
  ok: boolean;
  detail: string;
  fix: string | null;
}
export interface SetupStatus {
  onecli: SetupCheck;
  hub: SetupCheck;
  vaultAttached: SetupCheck;
  channels: {
    discord: { installed: boolean };
    telegram: { installed: boolean };
  };
  ready: boolean;
}

export type ChannelKind = 'discord' | 'telegram';

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

export async function listOnecliSecrets(): Promise<{ secrets: { name: string }[] }> {
  return request<{ secrets: { name: string }[] }>(`/onecli/secrets`);
}

export async function putOnecliSecret(name: string, value: string): Promise<{ name: string }> {
  return request<{ name: string }>(`/onecli/secrets`, {
    method: 'POST',
    json: { name, value },
  });
}

export interface WireChannelResult {
  messagingGroupId: string;
  messagingGroupAgentId: string;
  platformId: string;
  created: { messagingGroup: boolean; wiring: boolean };
}

/**
 * Wire a DM channel to an agent group.
 *
 * `botUserId` semantics differ by channel — see web/server/src/wire-channel.ts:40-78:
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
