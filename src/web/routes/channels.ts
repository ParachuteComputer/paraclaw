/**
 * /api/channels — channel-wire CRUD for the /channels page.
 *
 * A "channel wire" in the night/arch terminology = a row in the legacy
 * `messaging_group_agents` table joined with its messaging_groups +
 * agent_groups parents. We translate the storage shape (snake_case +
 * legacy enum names) to the camelCase API shape declared in
 * web/ui/src/lib/api.ts:ChannelWireView.
 *
 * Enum translation: night/arch's API contract uses `engageMode = mention |
 * pattern | all`, `senderScope = allowlist | all`, `ignoredMessagePolicy =
 * drop | silent`. The DB still stores the pre-rebuild values: engage_mode
 * = pattern | mention | mention-sticky (with engage_pattern='.' as the
 * sentinel for "match every message"), sender_scope = all | known,
 * ignored_message_policy = drop | accumulate. The translator collapses the
 * pattern + '.' sentinel into the API's `all` mode, lossy on the
 * mention-sticky distinction (rendered as `mention` to the UI). When the
 * DB schema migrates to the new shape, this translator becomes a no-op.
 *
 * PATCH translates the inverse direction. DELETE is a straight pass-through
 * to deleteMessagingGroupAgent — the agent_destinations row created at wire
 * time is left in place; deleting destinations is a separate concern.
 */
import http from 'node:http';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  deleteMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgent,
  updateMessagingGroup,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type {
  EngageMode as DbEngageMode,
  IgnoredMessagePolicy as DbIgnoredMessagePolicy,
  MessagingGroup,
  SenderScope as DbSenderScope,
  MessagingGroupAgent,
  UnknownSenderPolicy,
} from '../../types.js';

type ApiEngageMode = 'mention' | 'pattern' | 'all';
type ApiSenderScope = 'allowlist' | 'all';
type ApiIgnoredMessagePolicy = 'drop' | 'silent';

interface ChannelWireView {
  id: string;
  channelType: string;
  messagingGroupId: string;
  platformId: string;
  displayName: string | null;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  engageMode: ApiEngageMode;
  engagePattern: string | null;
  senderScope: ApiSenderScope;
  ignoredMessagePolicy: ApiIgnoredMessagePolicy;
  priority: number;
  createdAt: string;
}

const ALL_MESSAGES_PATTERN_SENTINEL = '.';

function dbToApiEngage(mode: DbEngageMode, pattern: string | null): ApiEngageMode {
  if (mode === 'pattern') {
    return pattern === ALL_MESSAGES_PATTERN_SENTINEL ? 'all' : 'pattern';
  }
  // mention + mention-sticky both render as 'mention' on the UI today.
  return 'mention';
}

function dbToApiSenderScope(s: DbSenderScope): ApiSenderScope {
  return s === 'known' ? 'allowlist' : 'all';
}

function dbToApiIgnoredPolicy(p: DbIgnoredMessagePolicy): ApiIgnoredMessagePolicy {
  return p === 'accumulate' ? 'silent' : 'drop';
}

interface PatchInput {
  engageMode?: ApiEngageMode;
  engagePattern?: string | null;
  senderScope?: ApiSenderScope;
  ignoredMessagePolicy?: ApiIgnoredMessagePolicy;
  priority?: number;
}

interface DbPatch {
  engage_mode?: DbEngageMode;
  engage_pattern?: string | null;
  sender_scope?: DbSenderScope;
  ignored_message_policy?: DbIgnoredMessagePolicy;
  priority?: number;
}

function apiToDbPatch(input: PatchInput, current: MessagingGroupAgent): DbPatch {
  const out: DbPatch = {};

  // engageMode is paired with engagePattern: 'all' encodes as
  // mode='pattern' + pattern='.', which the router treats as match-every.
  if (input.engageMode !== undefined) {
    if (input.engageMode === 'all') {
      out.engage_mode = 'pattern';
      out.engage_pattern = ALL_MESSAGES_PATTERN_SENTINEL;
    } else if (input.engageMode === 'pattern') {
      out.engage_mode = 'pattern';
      // Pattern body comes from input.engagePattern when present; otherwise
      // preserve what's already on the row. We never write '.' here — that
      // would silently re-collapse to 'all' on the next read.
      if (input.engagePattern !== undefined) {
        out.engage_pattern =
          input.engagePattern === ALL_MESSAGES_PATTERN_SENTINEL ? current.engage_pattern : input.engagePattern;
      }
    } else if (input.engageMode === 'mention') {
      // Preserve mention-sticky if that's what's currently on the row;
      // collapsing it to plain mention here would silently change router
      // behavior (sticky engagement persists across replies). The UI
      // doesn't expose sticky → it sees `mention` for both, but a PATCH
      // that doesn't touch the sticky distinction shouldn't lose it.
      out.engage_mode = current.engage_mode === 'mention-sticky' ? 'mention-sticky' : 'mention';
      out.engage_pattern = null;
    }
  } else if (input.engagePattern !== undefined) {
    // pattern body changed without changing the mode.
    out.engage_pattern = input.engagePattern;
  }

  if (input.senderScope !== undefined) {
    out.sender_scope = input.senderScope === 'allowlist' ? 'known' : 'all';
  }
  if (input.ignoredMessagePolicy !== undefined) {
    out.ignored_message_policy = input.ignoredMessagePolicy === 'silent' ? 'accumulate' : 'drop';
  }
  if (input.priority !== undefined) {
    out.priority = input.priority;
  }
  return out;
}

interface WireJoinRow extends MessagingGroupAgent {
  mg_channel_type: string;
  mg_platform_id: string;
  mg_name: string | null;
  ag_folder: string;
  ag_name: string;
}

function listAllWires(): ChannelWireView[] {
  const rows = getDb()
    .prepare<WireJoinRow>(
      `SELECT mga.*,
              mg.channel_type AS mg_channel_type,
              mg.platform_id  AS mg_platform_id,
              mg.name         AS mg_name,
              ag.folder       AS ag_folder,
              ag.name         AS ag_name
         FROM messaging_group_agents mga
         JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
         JOIN agent_groups ag     ON ag.id = mga.agent_group_id
        ORDER BY mga.created_at DESC`,
    )
    .all();
  return rows.map(rowToView);
}

function rowToView(row: WireJoinRow): ChannelWireView {
  return {
    id: row.id,
    channelType: row.mg_channel_type,
    messagingGroupId: row.messaging_group_id,
    platformId: row.mg_platform_id,
    displayName: row.mg_name,
    agentGroupId: row.agent_group_id,
    agentGroupFolder: row.ag_folder,
    agentGroupName: row.ag_name,
    engageMode: dbToApiEngage(row.engage_mode, row.engage_pattern),
    engagePattern:
      row.engage_mode === 'pattern' && row.engage_pattern !== ALL_MESSAGES_PATTERN_SENTINEL ? row.engage_pattern : null,
    senderScope: dbToApiSenderScope(row.sender_scope),
    ignoredMessagePolicy: dbToApiIgnoredPolicy(row.ignored_message_policy),
    priority: row.priority,
    createdAt: row.created_at,
  };
}

function getOneWireView(id: string): ChannelWireView | null {
  const mga = getMessagingGroupAgent(id);
  if (!mga) return null;
  const mg = getMessagingGroup(mga.messaging_group_id);
  const ag = getAgentGroup(mga.agent_group_id);
  if (!mg || !ag) return null;
  return rowToView({
    ...mga,
    mg_channel_type: mg.channel_type,
    mg_platform_id: mg.platform_id,
    mg_name: mg.name,
    ag_folder: ag.folder,
    ag_name: ag.name,
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

const VALID_ENGAGE_MODES: ApiEngageMode[] = ['mention', 'pattern', 'all'];
const VALID_SENDER_SCOPES: ApiSenderScope[] = ['allowlist', 'all'];
const VALID_IGNORED_POLICIES: ApiIgnoredMessagePolicy[] = ['drop', 'silent'];

function validatePatchInput(body: unknown): { ok: true; input: PatchInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: PatchInput = {};
  if ('engageMode' in b) {
    if (!VALID_ENGAGE_MODES.includes(b.engageMode as ApiEngageMode)) {
      return { ok: false, reason: `invalid engageMode: ${String(b.engageMode)}` };
    }
    out.engageMode = b.engageMode as ApiEngageMode;
  }
  if ('engagePattern' in b) {
    if (b.engagePattern !== null && typeof b.engagePattern !== 'string') {
      return { ok: false, reason: 'engagePattern must be string or null' };
    }
    out.engagePattern = b.engagePattern as string | null;
  }
  if ('senderScope' in b) {
    if (!VALID_SENDER_SCOPES.includes(b.senderScope as ApiSenderScope)) {
      return { ok: false, reason: `invalid senderScope: ${String(b.senderScope)}` };
    }
    out.senderScope = b.senderScope as ApiSenderScope;
  }
  if ('ignoredMessagePolicy' in b) {
    if (!VALID_IGNORED_POLICIES.includes(b.ignoredMessagePolicy as ApiIgnoredMessagePolicy)) {
      return { ok: false, reason: `invalid ignoredMessagePolicy: ${String(b.ignoredMessagePolicy)}` };
    }
    out.ignoredMessagePolicy = b.ignoredMessagePolicy as ApiIgnoredMessagePolicy;
  }
  if ('priority' in b) {
    if (typeof b.priority !== 'number' || !Number.isFinite(b.priority)) {
      return { ok: false, reason: 'priority must be a finite number' };
    }
    out.priority = b.priority;
  }
  return { ok: true, input: out };
}

// ─── /api/channels/mg/:id — per-MG detail + policy editor ──────────────
//
// Path is namespaced under `mg/` so it can't collide with `/api/channels/:mga-id`
// when an mg-id and an mga-id happen to share a prefix or shape (both are
// uuids today, but the disambiguation is a contract for future schemas).
// Each MGA wire row already carries its parent `messagingGroupId`, so the
// list page links the detail with the value it already has — no extra
// resolve step.

export interface WiredAgentSummary {
  /** mga.id — primary key for the per-MGA detail page in PR3. */
  messagingGroupAgentId: string;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  /** Snapshot of MGA fields useful for the read-only summary on the detail page. */
  engageMode: ApiEngageMode;
  engagePattern: string | null;
  senderScope: ApiSenderScope;
  ignoredMessagePolicy: ApiIgnoredMessagePolicy;
  priority: number;
  createdAt: string;
}

export interface MessagingGroupDetailView {
  id: string;
  channelType: string;
  platformId: string;
  /** MG's `name` column — null when the operator hasn't set one. */
  displayName: string | null;
  isGroup: boolean;
  unknownSenderPolicy: UnknownSenderPolicy;
  /** ISO when the owner explicitly denied this channel; null otherwise. */
  deniedAt: string | null;
  createdAt: string;
  wiredAgents: WiredAgentSummary[];
}

interface AgentJoinRow extends MessagingGroupAgent {
  ag_folder: string;
  ag_name: string;
}

export function getMessagingGroupDetail(id: string): MessagingGroupDetailView | null {
  const mg = getMessagingGroup(id);
  if (!mg) return null;
  const rows = getDb()
    .prepare<AgentJoinRow>(
      `SELECT mga.*, ag.folder AS ag_folder, ag.name AS ag_name
         FROM messaging_group_agents mga
         JOIN agent_groups ag ON ag.id = mga.agent_group_id
        WHERE mga.messaging_group_id = ?
        ORDER BY mga.priority DESC, mga.created_at ASC`,
    )
    .all(id);
  return mgToDetailView(
    mg,
    rows.map((row) => ({
      messagingGroupAgentId: row.id,
      agentGroupId: row.agent_group_id,
      agentGroupFolder: row.ag_folder,
      agentGroupName: row.ag_name,
      engageMode: dbToApiEngage(row.engage_mode, row.engage_pattern),
      engagePattern:
        row.engage_mode === 'pattern' && row.engage_pattern !== ALL_MESSAGES_PATTERN_SENTINEL
          ? row.engage_pattern
          : null,
      senderScope: dbToApiSenderScope(row.sender_scope),
      ignoredMessagePolicy: dbToApiIgnoredPolicy(row.ignored_message_policy),
      priority: row.priority,
      createdAt: row.created_at,
    })),
  );
}

function mgToDetailView(mg: MessagingGroup, wiredAgents: WiredAgentSummary[]): MessagingGroupDetailView {
  return {
    id: mg.id,
    channelType: mg.channel_type,
    platformId: mg.platform_id,
    displayName: mg.name,
    isGroup: mg.is_group === 1,
    unknownSenderPolicy: mg.unknown_sender_policy,
    deniedAt: mg.denied_at ?? null,
    createdAt: mg.created_at,
    wiredAgents,
  };
}

const VALID_UNKNOWN_SENDER_POLICIES: UnknownSenderPolicy[] = ['strict', 'request_approval', 'public'];

interface MgPatchInput {
  unknownSenderPolicy: UnknownSenderPolicy;
}

function validateMgPatchInput(body: unknown): { ok: true; input: MgPatchInput } | { ok: false; reason: string } {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (!('unknownSenderPolicy' in b)) {
    return { ok: false, reason: 'unknownSenderPolicy is required' };
  }
  if (!VALID_UNKNOWN_SENDER_POLICIES.includes(b.unknownSenderPolicy as UnknownSenderPolicy)) {
    return { ok: false, reason: `invalid unknownSenderPolicy: ${String(b.unknownSenderPolicy)}` };
  }
  return { ok: true, input: { unknownSenderPolicy: b.unknownSenderPolicy as UnknownSenderPolicy } };
}

export interface ChannelsRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

export async function handleChannelsRoute(ctx: ChannelsRouteContext): Promise<boolean> {
  const { pathname, method, req, res } = ctx;

  if (pathname === '/api/channels' && method === 'GET') {
    json(res, 200, { wires: listAllWires() });
    return true;
  }

  // /api/channels/mg/:id — GET (detail) or PATCH (policy edit). Must dispatch
  // ahead of /api/channels/:id so the literal `mg` segment doesn't get
  // mis-parsed as an mga-id.
  const mgMatch = pathname.match(/^\/api\/channels\/mg\/([^/]+)$/);
  if (mgMatch) {
    const id = decodeURIComponent(mgMatch[1]);
    const detail = getMessagingGroupDetail(id);
    if (!detail) {
      error(res, 404, `messaging group not found: ${id}`);
      return true;
    }
    if (method === 'GET') {
      json(res, 200, { messagingGroup: detail });
      return true;
    }
    if (method === 'PATCH') {
      let body: unknown;
      try {
        body = await readJsonBody<unknown>(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      const validated = validateMgPatchInput(body);
      if (!validated.ok) {
        error(res, 400, validated.reason);
        return true;
      }
      updateMessagingGroup(id, { unknown_sender_policy: validated.input.unknownSenderPolicy });
      log.info('messaging group policy updated via web', {
        id,
        unknownSenderPolicy: validated.input.unknownSenderPolicy,
      });
      // Same connection, same tx, same row — the post-update re-fetch can't
      // return null without the row being concurrently deleted, which is not
      // a state this surface needs to guard against.
      json(res, 200, { messagingGroup: getMessagingGroupDetail(id)! });
      return true;
    }
    error(res, 405, `method not allowed on ${pathname}: ${method}`);
    return true;
  }

  // /api/channels/mga/:id — GET (wire detail), PATCH (routing rules edit),
  // or DELETE (unwire). The `mga/` segment matches the `mg/` convention from
  // the messaging-group detail block above; `mga` = messaging_group_agent =
  // one wire row.
  const mgaMatch = pathname.match(/^\/api\/channels\/mga\/([^/]+)$/);
  if (mgaMatch) {
    const id = decodeURIComponent(mgaMatch[1]);
    const current = getMessagingGroupAgent(id);
    if (!current) {
      error(res, 404, `channel wire not found: ${id}`);
      return true;
    }

    if (method === 'GET') {
      json(res, 200, { wire: getOneWireView(id)! });
      return true;
    }

    if (method === 'PATCH') {
      let body: unknown;
      try {
        body = await readJsonBody<unknown>(req);
      } catch {
        error(res, 400, 'invalid JSON body');
        return true;
      }
      const validated = validatePatchInput(body);
      if (!validated.ok) {
        error(res, 400, validated.reason);
        return true;
      }
      const dbPatch = apiToDbPatch(validated.input, current);
      updateMessagingGroupAgent(id, dbPatch);
      log.info('channel wire updated via web', { id, fields: Object.keys(dbPatch) });
      // Same connection, same row — see channels.ts mg/:id PATCH for the
      // non-null-assertion rationale.
      json(res, 200, { wire: getOneWireView(id)! });
      return true;
    }

    if (method === 'DELETE') {
      deleteMessagingGroupAgent(id);
      log.info('channel wire deleted via web', { id });
      json(res, 200, { id, deleted: true });
      return true;
    }

    error(res, 405, `method not allowed on ${pathname}: ${method}`);
    return true;
  }

  return false;
}
