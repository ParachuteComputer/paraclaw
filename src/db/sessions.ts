import type { Approval, ApprovalBody, ApprovalKind, ApprovalStatus, Session } from '../types.js';
import { getDb, hasTable } from './connection.js';

// ── Sessions ──

export function createSession(session: Session): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
       VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider, @status, @container_status, @last_active, @created_at)`,
    )
    .run(session);
}

export function getSession(id: string): Session | undefined {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Session | undefined;
}

export function findSession(messagingGroupId: string, threadId: string | null): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id = ? AND status = ?')
      .get(messagingGroupId, threadId, 'active') as Session | undefined;
  }
  return getDb()
    .prepare('SELECT * FROM sessions WHERE messaging_group_id = ? AND thread_id IS NULL AND status = ?')
    .get(messagingGroupId, 'active') as Session | undefined;
}

/**
 * Session lookup scoped to a specific agent group. Needed when multiple
 * agents are wired to the same messaging group + thread (fan-out) — the
 * plain `findSession` would return whichever agent's session happened to
 * be first and route to the wrong container.
 */
export function findSessionForAgent(
  agentGroupId: string,
  messagingGroupId: string,
  threadId: string | null,
): Session | undefined {
  if (threadId) {
    return getDb()
      .prepare(
        "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id = ? AND status = 'active'",
      )
      .get(agentGroupId, messagingGroupId, threadId) as Session | undefined;
  }
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND messaging_group_id = ? AND thread_id IS NULL AND status = 'active'",
    )
    .get(agentGroupId, messagingGroupId) as Session | undefined;
}

/** Find an active session scoped to an agent group (ignoring messaging group). */
export function findSessionByAgentGroup(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE agent_group_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1")
    .get(agentGroupId) as Session | undefined;
}

export function getSessionsByAgentGroup(agentGroupId: string): Session[] {
  return getDb().prepare('SELECT * FROM sessions WHERE agent_group_id = ?').all(agentGroupId) as Session[];
}

export function getActiveSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE status = 'active'").all() as Session[];
}

export function getRunningSessions(): Session[] {
  return getDb().prepare("SELECT * FROM sessions WHERE container_status IN ('running', 'idle')").all() as Session[];
}

export function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'container_status' | 'last_active' | 'agent_provider'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE sessions SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteSession(id: string): void {
  getDb().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

// ── Approvals ──
// Unified table for both inline UX prompts (`kind='question'`) and
// admin-gating actions (`kind='install_packages'` etc.), collapsed in
// migration 024 (paraclaw#11). The kind discriminator is open-string —
// new module actions don't require a schema bump.

interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  agent_group_id: string;
  session_id: string | null;
  body: string;
  status: ApprovalStatus;
  approver_user_id: string | null;
  decided_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface CreateApprovalInput {
  id: string;
  kind: ApprovalKind;
  agent_group_id: string;
  session_id?: string | null;
  body: ApprovalBody;
  status?: ApprovalStatus;
  created_at: string;
  expires_at?: string | null;
}

function rowToApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    kind: row.kind,
    agent_group_id: row.agent_group_id,
    session_id: row.session_id,
    body: JSON.parse(row.body) as ApprovalBody,
    status: row.status,
    approver_user_id: row.approver_user_id,
    decided_at: row.decided_at,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/**
 * Insert an approval row. Idempotent: delivery retries with the same id must
 * not fail on UNIQUE before the send step gets a chance to succeed. Returns
 * true if a new row was inserted.
 */
export function createApproval(input: CreateApprovalInput): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO approvals
         (id, kind, agent_group_id, session_id, body, status, created_at, expires_at)
       VALUES
         (@id, @kind, @agent_group_id, @session_id, @body, @status, @created_at, @expires_at)`,
    )
    .run({
      id: input.id,
      kind: input.kind,
      agent_group_id: input.agent_group_id,
      session_id: input.session_id ?? null,
      body: JSON.stringify(input.body),
      status: input.status ?? 'pending',
      created_at: input.created_at,
      expires_at: input.expires_at ?? null,
    });
  return result.changes > 0;
}

export function getApproval(id: string): Approval | undefined {
  const row = getDb().prepare('SELECT * FROM approvals WHERE id = ?').get(id) as ApprovalRow | undefined;
  return row ? rowToApproval(row) : undefined;
}

export function deleteApproval(id: string): void {
  getDb().prepare('DELETE FROM approvals WHERE id = ?').run(id);
}

/**
 * List pending approvals, optionally filtered by `kind`. Pass an array to
 * include only those kinds; pass `{ exclude }` to omit kinds (e.g. exclude
 * `'question'` for the admin-gating UI surface).
 */
export function listPendingApprovals(filter?: { kinds?: ApprovalKind[]; excludeKinds?: ApprovalKind[] }): Approval[] {
  const clauses = ["status = 'pending'"];
  const params: Record<string, unknown> = {};
  if (filter?.kinds && filter.kinds.length > 0) {
    const placeholders = filter.kinds.map((_, i) => `@kind_${i}`).join(', ');
    clauses.push(`kind IN (${placeholders})`);
    filter.kinds.forEach((k, i) => {
      params[`kind_${i}`] = k;
    });
  }
  if (filter?.excludeKinds && filter.excludeKinds.length > 0) {
    const placeholders = filter.excludeKinds.map((_, i) => `@xkind_${i}`).join(', ');
    clauses.push(`kind NOT IN (${placeholders})`);
    filter.excludeKinds.forEach((k, i) => {
      params[`xkind_${i}`] = k;
    });
  }
  const rows = getDb()
    .prepare(`SELECT * FROM approvals WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`)
    .all(params) as ApprovalRow[];
  return rows.map(rowToApproval);
}

/**
 * Resolve ask_question render metadata (title + normalized options) for any
 * card, regardless of whether it lives in `approvals` (kind question or
 * action) or one of the permissions-module side tables.
 */
export function getAskQuestionRender(
  id: string,
): { title: string; options: import('../channels/ask-question.js').NormalizedOption[] } | undefined {
  if (hasTable(getDb(), 'approvals')) {
    const a = getApproval(id);
    if (a) {
      const body = a.body as { title?: string; options?: import('../channels/ask-question.js').NormalizedOption[] };
      if (body.title && Array.isArray(body.options)) {
        return { title: body.title, options: body.options };
      }
    }
  }

  // Channel-registration + unknown-sender approvals persist title/options_json
  // in their own tables — just SELECT and return.
  if (hasTable(getDb(), 'pending_channel_approvals')) {
    const c = getDb()
      .prepare('SELECT title, options_json FROM pending_channel_approvals WHERE messaging_group_id = ?')
      .get(id) as { title: string; options_json: string } | undefined;
    if (c?.title) return { title: c.title, options: JSON.parse(c.options_json) };
  }

  if (hasTable(getDb(), 'pending_sender_approvals')) {
    const s = getDb().prepare('SELECT title, options_json FROM pending_sender_approvals WHERE id = ?').get(id) as
      | { title: string; options_json: string }
      | undefined;
    if (s?.title) return { title: s.title, options: JSON.parse(s.options_json) };
  }

  return undefined;
}
