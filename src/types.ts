// ── Central DB entities ──

export type SecretMode = 'all' | 'selective';

export interface AgentGroup {
  id: string;
  name: string;
  folder: string;
  agent_provider: string | null;
  /**
   * Per-group injection policy for secrets in this group's scope (its own
   * scoped secrets + globals): `all` injects every in-scope secret;
   * `selective` injects only those with an explicit `secret_assignments`
   * row pointing to this group. Defaults to `selective` (migration 023).
   */
  secret_mode: SecretMode;
  created_at: string;
}

/**
 * Exact wire mirror — `UnknownSenderPolicy` in `web/ui/src/lib/api.ts` MUST
 * stay in lock-step with this union. No translator; the values cross the
 * wire as-is. If you add or rename a value here, update the client too.
 */
export type UnknownSenderPolicy = 'strict' | 'request_approval' | 'public';

export interface MessagingGroup {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  is_group: number; // 0 | 1
  unknown_sender_policy: UnknownSenderPolicy;
  /**
   * When set, the owner explicitly denied registering this channel — the
   * router drops silently and does not re-escalate. Cleared by any explicit
   * wiring mutation (admin command). See migration 012.
   *
   * Optional on the TS type so pre-migration-012 callers that build
   * MessagingGroup objects in code (fixtures, etc.) don't need to update;
   * the column itself defaults to NULL in SQLite.
   */
  denied_at?: string | null;
  created_at: string;
}

// ── Identity & privilege ──

/**
 * User = a messaging-platform identifier. Namespaced so distinct channels
 * with numeric IDs don't collide: "phone:+1555...", "tg:123", "discord:456",
 * "email:a@x.com". A single human with a phone AND a telegram handle has
 * two separate users — no cross-channel linking (yet).
 */
export interface User {
  id: string;
  kind: string; // 'phone' | 'email' | 'discord' | 'telegram' | 'matrix' | ...
  display_name: string | null;
  created_at: string;
}

export type UserRoleKind = 'owner' | 'admin';

/**
 * Role grant. Owner is always global. Admin is either global
 * (agent_group_id = null) or scoped to a specific agent group.
 * Admin @ A implicitly makes the user a member of A — we do not require
 * a separate agent_group_members row for admins.
 */
export interface UserRole {
  user_id: string;
  role: UserRoleKind;
  agent_group_id: string | null;
  granted_by: string | null;
  granted_at: string;
}

/** "Known" membership in an agent group — required for unprivileged users. */
export interface AgentGroupMember {
  user_id: string;
  agent_group_id: string;
  added_by: string | null;
  added_at: string;
}

/**
 * Cached DM channel for a user on a specific `(channel_type, bot_id)` pair.
 *
 * `bot_id = ''` (empty string) is the configurable channel-default slot —
 * the operator points it at whichever bot they want approvals to fall
 * back to when a `(user, channel, originBotId)` exact-bot lookup misses
 * AND the cold-DM resolve also fails. Migration 026 added the column;
 * pre-multi-bot installs land every row at `bot_id = ''`.
 */
export interface UserDm {
  user_id: string;
  channel_type: string;
  bot_id: string;
  messaging_group_id: string;
  resolved_at: string;
}

/**
 * DB-side vocabulary. The wire/API uses a different (post-rebuild) shape —
 * see `EngageMode` / `SenderScope` / `IgnoredMessagePolicy` in
 * `web/ui/src/lib/api.ts`. Translation between the two lives in
 * `src/web/routes/channels.ts` (`dbToApi*` + the patch-input mapper). If
 * you add or rename a value here, update the translator AND the wire
 * union — they are NOT meant to drift independently.
 */
export type EngageMode = 'pattern' | 'mention' | 'mention-sticky';
export type SenderScope = 'all' | 'known';
export type IgnoredMessagePolicy = 'drop' | 'accumulate';

export interface MessagingGroupAgent {
  id: string;
  messaging_group_id: string;
  agent_group_id: string;
  engage_mode: EngageMode;
  /**
   * Regex source string used when engage_mode='pattern'. `'.'` is the sentinel
   * for "match every message" (the "always" flavor). Ignored for 'mention' /
   * 'mention-sticky' modes.
   */
  engage_pattern: string | null;
  sender_scope: SenderScope;
  ignored_message_policy: IgnoredMessagePolicy;
  session_mode: 'shared' | 'per-thread' | 'agent-shared';
  priority: number;
  created_at: string;
}

export interface Session {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  agent_provider: string | null;
  status: 'active' | 'closed';
  container_status: 'running' | 'idle' | 'stopped';
  last_active: string | null;
  created_at: string;
}

// ── Session DB entities ──

export type MessageInKind = 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system';
export type MessageInStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface MessageIn {
  id: string;
  kind: MessageInKind;
  timestamp: string;
  status: MessageInStatus;
  status_changed: string | null;
  process_after: string | null;
  recurrence: string | null;
  tries: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

export interface MessageOut {
  id: string;
  in_reply_to: string | null;
  timestamp: string;
  delivered: number; // 0 | 1
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string; // JSON blob
}

// ── Approvals (central DB) ──

/**
 * Open-string discriminator. The host knows two well-known values
 * (`'question'` for inline UX prompts; module-action strings like
 * `'install_packages'` / `'add_mcp_server'` / `'credential'` for admin
 * gating), but third-party modules can register their own action strings
 * via `registerApprovalHandler`, so this is intentionally not a closed
 * union.
 */
export type ApprovalKind = string;
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface QuestionApprovalBody {
  title: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
}

export interface ActionApprovalBody {
  title: string;
  options: import('./channels/ask-question.js').NormalizedOption[];
  request_id: string;
  payload: Record<string, unknown>;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  platform_message_id: string | null;
}

export type ApprovalBody = QuestionApprovalBody | ActionApprovalBody | Record<string, unknown>;

export interface Approval {
  id: string;
  kind: ApprovalKind;
  agent_group_id: string;
  session_id: string | null;
  body: ApprovalBody;
  status: ApprovalStatus;
  approver_user_id: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string | null;
}

// ── Agent destinations (central DB) ──

export interface AgentDestination {
  agent_group_id: string;
  local_name: string;
  target_type: 'channel' | 'agent';
  target_id: string;
  created_at: string;
}
