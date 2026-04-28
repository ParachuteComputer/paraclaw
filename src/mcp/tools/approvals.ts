/**
 * MCP tools for the approval queue. `decide-approval` flows through the
 * same `handleApprovalsResponse` dispatcher the chat-card path uses, so
 * the row-update + module-action + agent-notify behaviour is identical
 * regardless of whether the operator decides via DM or via this tool.
 *
 * Caller identity: `decide-approval` records the decider as the JWT `sub`
 * for HTTP transport, or `mcp:stdio` for stdio. Approval factory pattern
 * lets us thread the subject in at server-build time without leaking
 * transport details to individual handlers.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { handleApprovalsResponse } from '../../modules/approvals/response-handler.js';
import type { ToolDef } from '../types.js';

interface ApprovalRow {
  approval_id: string;
  session_id: string | null;
  action: string;
  payload: string;
  created_at: string;
  agent_group_id: string | null;
  status: string;
}

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

function rowToView(row: ApprovalRow): ApprovalView | null {
  let agentGroupId = row.agent_group_id ?? '';
  if (!agentGroupId && row.session_id) {
    const session = getSession(row.session_id);
    if (session) agentGroupId = session.agent_group_id;
  }
  if (!agentGroupId) return null;
  let agentGroupName: string | null = null;
  try {
    const group = getAgentGroup(agentGroupId);
    if (group) agentGroupName = group.name;
  } catch {
    // tolerate FK miss
  }
  let actionPayload: Record<string, unknown> = {};
  try {
    actionPayload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    actionPayload = { _raw: row.payload };
  }
  const status = (['pending', 'approved', 'rejected', 'expired'] as const).find((s) => s === row.status) ?? 'pending';
  return {
    id: row.approval_id,
    agentGroupId,
    agentGroupName,
    kind: row.action,
    actionPayload,
    status,
    requestedAt: row.created_at,
    decidedAt: null,
    requestedBy: row.session_id ?? '',
  };
}

function listPending(): ApprovalView[] {
  const rows = getDb()
    .prepare<ApprovalRow>(
      `SELECT approval_id, session_id, action, payload, created_at, agent_group_id, status
         FROM pending_approvals
        WHERE status = 'pending'
        ORDER BY created_at DESC`,
    )
    .all() as ApprovalRow[];
  return rows.flatMap((r) => {
    const v = rowToView(r);
    return v ? [v] : [];
  });
}

function getOne(approvalId: string): ApprovalView | null {
  const row = getDb()
    .prepare<ApprovalRow>(
      `SELECT approval_id, session_id, action, payload, created_at, agent_group_id, status
         FROM pending_approvals
        WHERE approval_id = @id`,
    )
    .get({ id: approvalId }) as ApprovalRow | undefined;
  if (!row) return null;
  return rowToView(row);
}

export function buildApprovalTools(getCallerSubject: () => string): ToolDef[] {
  return [
    {
      name: 'list-approvals',
      description:
        'List pending approvals — agent-requested actions awaiting human consent (install_packages, add_mcp_server, …).',
      scope: 'claw:read',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => ({ approvals: listPending() }),
    },
    {
      name: 'decide-approval',
      description:
        "Decide a pending approval. Routes through the same dispatcher the chat-card path uses, so the side effects (row delete, module-action run, agent notify) are identical. The deciding userId is recorded as the caller's JWT sub (or 'mcp:stdio' for stdio).",
      scope: 'claw:admin',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Approval id.' },
          decision: { type: 'string', enum: ['approve', 'reject'] },
        },
        required: ['id', 'decision'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const id = String(args.id ?? '');
        const decision = args.decision === 'approve' || args.decision === 'reject' ? args.decision : null;
        if (!id) throw new Error('id is required');
        if (!decision) throw new Error("decision must be 'approve' or 'reject'");
        const before = getOne(id);
        if (!before) throw new Error(`approval not found: ${id}`);
        if (before.status !== 'pending') throw new Error(`approval already ${before.status}`);
        const handled = await handleApprovalsResponse({
          questionId: id,
          value: decision,
          userId: getCallerSubject(),
          channelType: 'mcp',
          platformId: 'paraclaw-mcp',
          threadId: null,
        });
        if (!handled) throw new Error('approval was decided by another path before our update landed');
        return {
          approval: {
            ...before,
            status: decision === 'approve' ? 'approved' : 'rejected',
            decidedAt: new Date().toISOString(),
          },
        };
      },
    },
  ];
}
