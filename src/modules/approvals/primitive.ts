/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the row in `approvals` (paraclaw#11). Used
 *     by any module that needs admin confirmation before doing something
 *     sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too — it used to sit in src/access.ts and got
 * folded in with the PR #7 re-tier. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional (see REFACTOR_PLAN open q #3).
 */
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { createApproval, getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { wakeContainer } from '../../container-runner.js';
import { log } from '../../log.js';
import { decodePlatformIdAs } from '../../platform-id.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { ensureUserDm } from '../permissions/user-dm.js';

/** Two-button approval UI — the only options the primitive supports today. */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => void;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void>;

const approvalHandlers = new Map<string, ApprovalHandler>();

export function registerApprovalHandler(action: string, handler: ApprovalHandler): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export function pickApprover(agentGroupId: string | null): string[] {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of getGlobalAdmins()) add(r.user_id);
  for (const r of getOwners()) add(r.user_id);

  return approvers;
}

/**
 * Walk the approver list and return the first reachable
 * (approverId, messagingGroup, viaFallbackBot) tuple. Returns null if
 * nobody is reachable.
 *
 * Resolution order, when both `originChannelType` and `originBotId` are set:
 *
 *   1. Same-channel approver, exact `(channel, originBotId)` match —
 *      best case, the card delivers via the same bot the inbound
 *      came in on.
 *   2. Same-channel approver, channel-default DM (`bot_id = ''` slot
 *      in `user_dms`, configured via `/claw/settings/approvals`) —
 *      `viaFallbackBot: true`, so callers can name the origin bot in
 *      the card body to avoid confusion.
 *   3. Cross-channel approver, channel-default DM — same-channel
 *      delivery wasn't possible at all (no approver on this channel,
 *      or none of them have any DM cached).
 *   4. None — null.
 *
 * When only `originChannelType` is provided (single-bot install,
 * legacy callers), step 1 collapses into step 2: the bot id is
 * effectively `''` and the channel-default row is the cache.
 *
 * Cold-resolve at step 1 hits the adapter registered for
 * `(channel, originBotId)` directly — see `ensureUserDm` — so a
 * cache miss for an active secondary bot triggers `openDM` on that
 * bot, not on whichever bot happens to be first in the registry.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
  originBotId: string | null = null,
): Promise<{ userId: string; messagingGroup: MessagingGroup; viaFallbackBot: boolean } | null> {
  // Step 1 — same channel, exact bot match.
  if (originChannelType && originBotId) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId, { botId: originBotId });
      if (mg) return { userId, messagingGroup: mg, viaFallbackBot: false };
    }
  }
  // Step 2 — same channel, channel-default DM. `viaFallbackBot` is true
  // only when an originBotId was requested but didn't resolve.
  if (originChannelType) {
    for (const userId of approvers) {
      if (channelTypeOf(userId) !== originChannelType) continue;
      const mg = await ensureUserDm(userId);
      if (mg) return { userId, messagingGroup: mg, viaFallbackBot: !!originBotId };
    }
  }
  // Step 3 — cross-channel any.
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg, viaFallbackBot: !!originBotId };
  }
  return null;
}

function channelTypeOf(userId: string): string {
  const idx = userId.indexOf(':');
  return idx < 0 ? '' : userId.slice(0, idx);
}

// ── Request API ──

/** Send a system chat to the agent's session. Used by callers and by the response handler. */
export function notifyAgent(session: Session, text: string): void {
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = getSession(session.id);
  if (fresh) {
    wakeContainer(fresh).catch((err) => log.error('Failed to wake container after notification', { err }));
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** JSON-serializable opaque payload. Carried in the approvals row body, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
}

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the row in `approvals` (kind = action). Fire-and-forget
 * from the caller's perspective — the admin's response kicks off the
 * registered approval handler for this action via the response dispatcher.
 */
export async function requestApproval(opts: RequestApprovalOptions): Promise<void> {
  const { session, action, payload, title, question, agentName } = opts;

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
    return;
  }

  const originMg = session.messaging_group_id ? (getMessagingGroup(session.messaging_group_id) ?? null) : null;
  const originChannelType = originMg?.channel_type ?? '';
  // The session's MG is paraclaw-managed and gets v2-shaped on creation
  // (or backfilled by startup-bootstrap), so slot1 of the platform_id is
  // the bot id. v1 rows return botId=null and we route by channel only —
  // same path as a single-bot install.
  const originBotId = originMg ? decodePlatformIdAs(originMg.platform_id, 'v2').botId : null;

  const target = await pickApprovalDelivery(approvers, originChannelType, originBotId);
  if (!target) {
    const hint = originBotId ? ` Ask them to DM ${originBotId} once so the bot can reach them, then retry.` : '';
    notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.${hint}`);
    return;
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(APPROVAL_OPTIONS);
  createApproval({
    id: approvalId,
    kind: action,
    agent_group_id: session.agent_group_id,
    session_id: session.id,
    body: {
      title,
      options: normalizedOptions,
      request_id: approvalId,
      payload,
      platform_id: target.messagingGroup.platform_id,
      channel_type: target.messagingGroup.channel_type,
      thread_id: null,
      platform_message_id: null,
    },
    created_at: new Date().toISOString(),
  });

  const adapter = getDeliveryAdapter();
  if (adapter) {
    try {
      await adapter.deliver(
        target.messagingGroup.channel_type,
        target.messagingGroup.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: approvalId,
          title,
          question: appendFallbackNotice(question, target.viaFallbackBot, originBotId),
          options: APPROVAL_OPTIONS,
        }),
      );
    } catch (err) {
      log.error('Failed to deliver approval card', { action, approvalId, err });
      notifyAgent(session, `${action} failed: could not deliver approval request to ${target.userId}.`);
      return;
    }
  }

  log.info('Approval requested', { action, approvalId, agentName, approver: target.userId });
}

/**
 * When `pickApprovalDelivery` falls back to the channel-default bot
 * (because the inbound bot can't DM this approver), append a one-line
 * notice to the card body. Surfaces the mismatch at the moment the
 * approver is making a decision, with a pointer to where they can
 * change the default if they want cards on the originating bot.
 */
export function appendFallbackNotice(question: string, viaFallbackBot: boolean, originBotId: string | null): string {
  if (!viaFallbackBot) return question;
  const hint = originBotId ? ` (inbound bot ${originBotId})` : '';
  return `${question}\n\n_Routed via your default approval bot${hint}. Change in /claw/settings/approvals._`;
}
