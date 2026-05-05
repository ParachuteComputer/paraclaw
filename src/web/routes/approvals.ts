/**
 * /api/approvals — list + decide on pending agent approvals.
 *
 * Surfaces the queue of human-consent-required actions agents have requested
 * (install_packages, add_mcp_server, …). The same queue today is also drained
 * by chat-card responses that come through the channel adapters; this route
 * is a parallel surface that lets the operator approve from the web UI
 * without waiting on a DM round-trip.
 *
 * Filtering: only `status='pending'` rows are listed, and `kind='question'`
 * (inline UX prompts from the interactive module) is excluded — those land
 * in their own card UI surface, not the admin approvals queue.
 *
 * Decide flow: synthesize the same `ResponsePayload` the chat-card path
 * produces and call `handleApprovalsResponse`. That dispatcher updates the
 * row status, deletes it, runs the registered action handler, and notifies
 * the agent — same code path the chat path uses, no behavioural divergence.
 */
import http from 'node:http';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getApproval, listPendingApprovals as listPendingApprovalsDb } from '../../db/sessions.js';
import { handleApprovalsResponse } from '../../modules/approvals/response-handler.js';
import { log } from '../../log.js';
import type { ActionApprovalBody, Approval } from '../../types.js';
import type { HubJwtClaims } from '../auth.js';

interface ApprovalView {
  id: string;
  agentGroupId: string;
  agentGroupName: string | null;
  kind: string;
  actionPayload: Record<string, unknown>;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  requestedAt: string;
  decidedAt: string | null;
  requestedBy: string;
}

function approvalToView(approval: Approval): ApprovalView | null {
  if (!approval.agent_group_id) return null;
  let agentGroupName: string | null = null;
  try {
    const group = getAgentGroup(approval.agent_group_id);
    if (group) agentGroupName = group.name;
  } catch {
    // getAgentGroup throws on missing FK; tolerate it for a graceful list view.
  }

  const body = approval.body as ActionApprovalBody;
  const actionPayload = (body.payload ?? {}) as Record<string, unknown>;

  const status =
    (['pending', 'approved', 'rejected', 'expired'] as const).find((s) => s === approval.status) ?? 'pending';

  return {
    id: approval.id,
    agentGroupId: approval.agent_group_id,
    agentGroupName,
    kind: approval.kind,
    actionPayload,
    status,
    requestedAt: approval.created_at,
    decidedAt: approval.decided_at,
    requestedBy: approval.session_id ?? '',
  };
}

function listAdminApprovals(): ApprovalView[] {
  const rows = listPendingApprovalsDb({ excludeKinds: ['question'] });
  return rows.flatMap((r) => {
    const view = approvalToView(r);
    return view ? [view] : [];
  });
}

function getOneApprovalView(approvalId: string): ApprovalView | null {
  const approval = getApproval(approvalId);
  if (!approval) return null;
  if (approval.kind === 'question') return null;
  return approvalToView(approval);
}

interface DecideBody {
  decision?: 'approve' | 'reject';
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

export interface ApprovalsRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  /** JWT claims of the requestor — `sub` is recorded as the deciding userId. */
  claims: HubJwtClaims;
}

export async function handleApprovalsRoute(ctx: ApprovalsRouteContext): Promise<boolean> {
  const { pathname, method, req, res, claims } = ctx;

  if (pathname === '/api/approvals' && method === 'GET') {
    const approvals = listAdminApprovals();
    json(res, 200, { approvals });
    return true;
  }

  // POST /api/approvals/:id/decide
  const decideMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (decideMatch && method === 'POST') {
    const approvalId = decodeURIComponent(decideMatch[1]);
    let body: DecideBody;
    try {
      body = await readJsonBody<DecideBody>(req);
    } catch {
      error(res, 400, 'invalid JSON body');
      return true;
    }
    if (body.decision !== 'approve' && body.decision !== 'reject') {
      error(res, 400, `decision must be 'approve' or 'reject', got: ${String(body.decision)}`);
      return true;
    }

    // Check the row exists + is pending before dispatching. handleApprovalsResponse
    // returns false if the row is missing; we want a clearer 404 + a clearer
    // 409 if the operator is acting on a row that someone else already decided.
    const before = getOneApprovalView(approvalId);
    if (!before) {
      error(res, 404, `approval not found: ${approvalId}`);
      return true;
    }
    if (before.status !== 'pending') {
      error(res, 409, `approval already ${before.status}`);
      return true;
    }

    // The chat-card path passes the channel/platform/thread of the card
    // delivery; from the web we synthesize neutral values. The dispatcher
    // doesn't use them for module-action approvals — it only inspects
    // questionId + value (+ userId for audit logging).
    const handled = await handleApprovalsResponse({
      questionId: approvalId,
      value: body.decision,
      userId: claims.sub,
      channelType: 'web',
      platformId: 'parachute-agent-web',
      threadId: null,
    });
    if (!handled) {
      // handleApprovalsResponse only returns false when the row genuinely
      // doesn't exist — but we already verified it does, so this is a
      // race with a chat-card decision. Surface it as a 409 to match the
      // already-decided case.
      error(res, 409, 'approval was decided by another path before our update landed');
      return true;
    }
    log.info('approval decided via web', { approvalId, decision: body.decision, userId: claims.sub });

    // After a decision the row is deleted by the dispatcher — synthesize
    // the post-decision view so the UI can update its list without
    // another round-trip. status reflects the decision; decidedAt is now.
    const after: ApprovalView = {
      ...before,
      status: body.decision === 'approve' ? 'approved' : 'rejected',
      decidedAt: new Date().toISOString(),
    };
    json(res, 200, { approval: after });
    return true;
  }

  return false;
}
