/**
 * Shared translator between the storage shape (`messaging_group_agents` row,
 * snake_case + legacy enum names) and the API contract that both `/api/channels`
 * and the MCP `*-channel-wire` tools speak.
 *
 * Background. Both surfaces used to maintain their own copy of these types,
 * constants, translators, and the patch validator. The duplication was a
 * structural drift hazard: paraclaw#94 / PR #122 surfaced exactly that class
 * — the rename of wire-side `'all'` → `'unrestricted'` initially landed only
 * the HTTP-side validator and missed the MCP-side silent-no-op. Extracting
 * here makes the drift class structurally impossible: a future enum change
 * touches one file, both surfaces pick it up. paraclaw#123.
 *
 * API contract: engageMode = mention | pattern | all, senderScope = allowlist
 * | unrestricted, ignoredMessagePolicy = drop | silent.
 *
 * DB shape (still pre-rebuild): engage_mode = mention | pattern |
 * mention-sticky (with engage_pattern='.' as the "match every message"
 * sentinel), sender_scope = all | known, ignored_message_policy = drop |
 * accumulate. The translator collapses pattern + '.' into the API's `all`,
 * lossy on mention-sticky (rendered as `mention` to the wire).
 *
 * The validator returns a discriminated result rather than throwing so each
 * caller can pick its own error idiom: HTTP wraps `{ ok: false }` into a
 * 400 + JSON error; MCP throws on `{ ok: false }`.
 */
import type {
  EngageMode as DbEngageMode,
  IgnoredMessagePolicy as DbIgnoredMessagePolicy,
  MessagingGroupAgent,
  SenderScope as DbSenderScope,
} from '../types.js';

export type ApiEngageMode = 'mention' | 'pattern' | 'all';
export type ApiSenderScope = 'allowlist' | 'unrestricted';
export type ApiIgnoredMessagePolicy = 'drop' | 'silent';

export const ALL_MESSAGES_PATTERN_SENTINEL = '.';

export const VALID_API_ENGAGE_MODES: ApiEngageMode[] = ['mention', 'pattern', 'all'];
export const VALID_API_SENDER_SCOPES: ApiSenderScope[] = ['allowlist', 'unrestricted'];
export const VALID_API_IGNORED_POLICIES: ApiIgnoredMessagePolicy[] = ['drop', 'silent'];

export interface ChannelWireView {
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

export interface WireJoinRow extends MessagingGroupAgent {
  mg_channel_type: string;
  mg_platform_id: string;
  mg_name: string | null;
  ag_folder: string;
  ag_name: string;
}

export interface PatchInput {
  engageMode?: ApiEngageMode;
  engagePattern?: string | null;
  senderScope?: ApiSenderScope;
  ignoredMessagePolicy?: ApiIgnoredMessagePolicy;
  priority?: number;
}

export interface DbPatch {
  engage_mode?: DbEngageMode;
  engage_pattern?: string | null;
  sender_scope?: DbSenderScope;
  ignored_message_policy?: DbIgnoredMessagePolicy;
  priority?: number;
}

export function dbToApiEngage(mode: DbEngageMode, pattern: string | null): ApiEngageMode {
  if (mode === 'pattern') {
    return pattern === ALL_MESSAGES_PATTERN_SENTINEL ? 'all' : 'pattern';
  }
  // mention + mention-sticky both render as 'mention' on the wire today.
  return 'mention';
}

export function dbToApiSenderScope(s: DbSenderScope): ApiSenderScope {
  return s === 'known' ? 'allowlist' : 'unrestricted';
}

export function dbToApiIgnoredPolicy(p: DbIgnoredMessagePolicy): ApiIgnoredMessagePolicy {
  return p === 'accumulate' ? 'silent' : 'drop';
}

export function rowToView(row: WireJoinRow): ChannelWireView {
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

export function apiToDbPatch(input: PatchInput, current: MessagingGroupAgent): DbPatch {
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
      // preserve what's already on the row. validatePatchInput already
      // rejects bare '.' here so the next read can't silently collapse to
      // 'all'.
      if (input.engagePattern !== undefined) {
        out.engage_pattern = input.engagePattern;
      }
    } else if (input.engageMode === 'mention') {
      // Preserve mention-sticky if that's what's currently on the row;
      // collapsing it to plain mention here would silently change router
      // behavior (sticky engagement persists across replies). The wire
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
    // wire 'unrestricted' → DB 'all'. validatePatchInput has already gated
    // the union to the two known values, so the binary mapping is safe.
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

export type ValidatePatchResult = { ok: true; input: PatchInput } | { ok: false; reason: string };

export function validatePatchInput(body: unknown): ValidatePatchResult {
  if (!body || typeof body !== 'object') return { ok: false, reason: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const out: PatchInput = {};
  if ('engageMode' in b) {
    if (!VALID_API_ENGAGE_MODES.includes(b.engageMode as ApiEngageMode)) {
      return { ok: false, reason: `invalid engageMode: ${String(b.engageMode)}` };
    }
    out.engageMode = b.engageMode as ApiEngageMode;
  }
  if ('engagePattern' in b) {
    if (b.engagePattern !== null && typeof b.engagePattern !== 'string') {
      return { ok: false, reason: 'engagePattern must be string or null' };
    }
    // Bare '.' is the wire-format sentinel for engageMode='all' — accepting
    // it as a literal pattern would silently round-trip back as 'all' on the
    // next read and lose the user's intent. Force the caller to disambiguate.
    if (b.engagePattern === ALL_MESSAGES_PATTERN_SENTINEL) {
      return {
        ok: false,
        reason:
          "engagePattern '.' is reserved as the 'all' sentinel — use '\\\\.' (escaped) to match a literal dot, or set engageMode to 'all'",
      };
    }
    out.engagePattern = b.engagePattern as string | null;
  }
  if ('senderScope' in b) {
    if (!VALID_API_SENDER_SCOPES.includes(b.senderScope as ApiSenderScope)) {
      return { ok: false, reason: `invalid senderScope: ${String(b.senderScope)}` };
    }
    out.senderScope = b.senderScope as ApiSenderScope;
  }
  if ('ignoredMessagePolicy' in b) {
    if (!VALID_API_IGNORED_POLICIES.includes(b.ignoredMessagePolicy as ApiIgnoredMessagePolicy)) {
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
