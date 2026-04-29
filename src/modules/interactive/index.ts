/**
 * Interactive module — generic ask_user_question flow.
 *
 * Container-side `ask_user_question` writes a chat-sdk card to outbound.db +
 * polls inbound.db for a `question_response` system message. On the host side
 * this module handles the button-click response: look up the `approvals` row
 * (kind='question'), write the response into the session's inbound.db, wake
 * the container.
 *
 * The `createApproval` call in `deliverMessage` (delivery.ts) stays inline in
 * core — it's 15 lines guarded by `hasTable('approvals')`, modularizing it
 * adds more registry surface than it saves.
 */
import { getDb, hasTable } from '../../db/connection.js';
import { deleteApproval, getApproval, getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { QuestionApprovalBody } from '../../types.js';

async function handleInteractiveResponse(payload: ResponsePayload): Promise<boolean> {
  if (!hasTable(getDb(), 'approvals')) return false;

  const approval = getApproval(payload.questionId);
  if (!approval || approval.kind !== 'question') return false;

  if (!approval.session_id) {
    deleteApproval(payload.questionId);
    return true;
  }
  const session = getSession(approval.session_id);
  if (!session) {
    log.warn('Session not found for pending question', {
      questionId: payload.questionId,
      sessionId: approval.session_id,
    });
    deleteApproval(payload.questionId);
    return true; // claimed — we owned this questionId even though the session is gone
  }

  const body = approval.body as QuestionApprovalBody;
  writeSessionMessage(session.agent_group_id, session.id, {
    id: `qr-${payload.questionId}-${Date.now()}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: body.platform_id,
    channelType: body.channel_type,
    threadId: body.thread_id,
    content: JSON.stringify({
      type: 'question_response',
      questionId: payload.questionId,
      selectedOption: payload.value,
      userId: payload.userId ?? '',
    }),
  });

  deleteApproval(payload.questionId);
  log.info('Question response routed', {
    questionId: payload.questionId,
    selectedOption: payload.value,
    sessionId: session.id,
  });

  await wakeContainer(session);
  return true;
}

registerResponseHandler(handleInteractiveResponse);
