/**
 * Collapse `pending_questions` and `pending_approvals` into a single
 * `approvals` table with a `kind` discriminator (paraclaw#11).
 *
 * Both tables persisted "agent needs human consent" — questions are inline
 * UX prompts (kind='question'), approvals are admin-gating for self-mod
 * actions (kind='install_packages' | 'add_mcp_server' | 'credential' | …).
 * Same primitive, two storage shapes was vestigial drag.
 *
 * The new shape lifts the always-needed fields (id, kind, agent_group_id,
 * session_id, status, timestamps) into columns and stuffs everything
 * kind-specific (title, options, routing, request payload) into a single
 * JSON `body` column. Readers parse on the way out.
 *
 * Backfill rules
 * ──────────────
 * Questions → kind='question'. agent_group_id is derived from the row's
 * session (questions never carry it directly; sessions always do). A
 * question row whose session has vanished (legacy orphan) is dropped —
 * the response handler couldn't have routed it anyway.
 *
 * Approvals → kind=`pending_approvals.action`. agent_group_id comes from
 * the row's column when set, falling back to the session's. A row with
 * neither (truly orphaned legacy) is dropped — same reasoning.
 *
 * Indexes match the queries the app runs: list-pending-by-group filters
 * on (status, agent_group_id); session-scoped lookups join on session_id.
 */
import { log } from '../../log.js';
import type { Database } from '../connection.js';
import type { Migration } from './index.js';

interface QuestionRow {
  question_id: string;
  session_id: string;
  message_out_id: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  title: string;
  options_json: string;
  created_at: string;
  agent_group_id: string | null;
}

interface ApprovalRow {
  approval_id: string;
  session_id: string | null;
  request_id: string;
  action: string;
  payload: string;
  created_at: string;
  agent_group_id: string | null;
  channel_type: string | null;
  platform_id: string | null;
  platform_message_id: string | null;
  expires_at: string | null;
  status: string;
  title: string;
  options_json: string;
  session_group_id: string | null;
}

export const migration024: Migration = {
  version: 24,
  name: 'collapse-approvals',
  up(db: Database) {
    db.exec(`
      CREATE TABLE approvals (
        id               TEXT PRIMARY KEY,
        kind             TEXT NOT NULL,
        agent_group_id   TEXT NOT NULL REFERENCES agent_groups(id),
        session_id       TEXT REFERENCES sessions(id),
        body             TEXT NOT NULL,
        status           TEXT NOT NULL DEFAULT 'pending',
        approver_user_id TEXT,
        decided_at       TEXT,
        created_at       TEXT NOT NULL,
        expires_at       TEXT
      );
      CREATE INDEX idx_approvals_status ON approvals(status, agent_group_id);
      CREATE INDEX idx_approvals_session ON approvals(session_id) WHERE session_id IS NOT NULL;
    `);

    const insert = db.prepare(
      `INSERT INTO approvals
         (id, kind, agent_group_id, session_id, body, status, created_at, expires_at)
       VALUES
         (@id, @kind, @agent_group_id, @session_id, @body, @status, @created_at, @expires_at)`,
    );

    let questionsCopied = 0;
    let questionsDropped = 0;
    const questionRows = db
      .prepare<QuestionRow>(
        `SELECT pq.*, s.agent_group_id AS agent_group_id
           FROM pending_questions pq
           LEFT JOIN sessions s ON s.id = pq.session_id`,
      )
      .all();
    for (const r of questionRows) {
      if (!r.agent_group_id) {
        log.warn('Dropping orphan pending_question (session vanished)', { question_id: r.question_id });
        questionsDropped++;
        continue;
      }
      insert.run({
        id: r.question_id,
        kind: 'question',
        agent_group_id: r.agent_group_id,
        session_id: r.session_id,
        body: JSON.stringify({
          title: r.title,
          options: JSON.parse(r.options_json),
          message_out_id: r.message_out_id,
          platform_id: r.platform_id,
          channel_type: r.channel_type,
          thread_id: r.thread_id,
        }),
        status: 'pending',
        created_at: r.created_at,
        expires_at: null,
      });
      questionsCopied++;
    }

    let approvalsCopied = 0;
    let approvalsDropped = 0;
    const approvalRows = db
      .prepare<ApprovalRow>(
        `SELECT pa.*, s.agent_group_id AS session_group_id
           FROM pending_approvals pa
           LEFT JOIN sessions s ON s.id = pa.session_id`,
      )
      .all();
    for (const r of approvalRows) {
      const groupId = r.agent_group_id ?? r.session_group_id;
      if (!groupId) {
        log.warn('Dropping orphan pending_approval (no agent_group_id and no session)', {
          approval_id: r.approval_id,
          action: r.action,
        });
        approvalsDropped++;
        continue;
      }
      insert.run({
        id: r.approval_id,
        kind: r.action,
        agent_group_id: groupId,
        session_id: r.session_id,
        body: JSON.stringify({
          title: r.title,
          options: JSON.parse(r.options_json),
          request_id: r.request_id,
          payload: JSON.parse(r.payload),
          platform_id: r.platform_id,
          channel_type: r.channel_type,
          thread_id: null,
          platform_message_id: r.platform_message_id,
        }),
        status: r.status,
        created_at: r.created_at,
        expires_at: r.expires_at,
      });
      approvalsCopied++;
    }

    db.exec(`
      DROP TABLE pending_questions;
      DROP TABLE pending_approvals;
    `);

    if (questionsCopied + questionsDropped + approvalsCopied + approvalsDropped > 0) {
      log.info('approvals collapse complete', {
        questionsCopied,
        questionsDropped,
        approvalsCopied,
        approvalsDropped,
      });
    }
  },
};
