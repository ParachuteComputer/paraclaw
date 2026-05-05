import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup, createSession, closeDb, getDb, initTestDb, runMigrations } from './index.js';
import {
  getActivitySyncedSeq,
  listActivityByAgentGroup,
  listActivityBySession,
  mergeActivityBatch,
} from './agent-activity.js';
import type { OutboundActivityRow } from './session-db.js';

function now(): string {
  return new Date().toISOString();
}

function seedAgentAndSession(): { agentGroupId: string; sessionId: string } {
  createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  return { agentGroupId: 'ag-1', sessionId: 'sess-1' };
}

function row(seq: number, kind: string, target: string | null, summary: string | null = null): OutboundActivityRow {
  return { seq, ts: new Date(2026, 0, seq).toISOString(), kind, target, summary };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('agent_activity merge', () => {
  it('initial cursor is 0 and merging a batch advances it', () => {
    const { agentGroupId, sessionId } = seedAgentAndSession();
    expect(getActivitySyncedSeq(sessionId)).toBe(0);

    const newCursor = mergeActivityBatch(agentGroupId, sessionId, [
      row(1, 'tool_call', 'Read'),
      row(2, 'cmd_exec', 'Bash'),
      row(3, 'mcp_call', 'mcp__parachute_agent__schedule_task'),
    ]);
    expect(newCursor).toBe(3);
    expect(getActivitySyncedSeq(sessionId)).toBe(3);

    const rows = listActivityBySession(sessionId);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.kind).sort()).toEqual(['cmd_exec', 'mcp_call', 'tool_call']);
  });

  it('empty batch is a no-op and returns the existing cursor', () => {
    const { agentGroupId, sessionId } = seedAgentAndSession();
    mergeActivityBatch(agentGroupId, sessionId, [row(1, 'tool_call', 'Read')]);
    expect(getActivitySyncedSeq(sessionId)).toBe(1);

    const c = mergeActivityBatch(agentGroupId, sessionId, []);
    expect(c).toBe(1);
    expect(listActivityBySession(sessionId)).toHaveLength(1);
  });

  it('cursor advance is monotonic — re-merging an older batch leaves it unchanged', () => {
    const { agentGroupId, sessionId } = seedAgentAndSession();
    mergeActivityBatch(agentGroupId, sessionId, [row(5, 'tool_call', 'Read'), row(6, 'tool_call', 'Glob')]);
    expect(getActivitySyncedSeq(sessionId)).toBe(6);

    // The delivery loop guards against this with `seq > cursor`, but if a
    // caller passes older rows, the cursor should NOT regress.
    mergeActivityBatch(agentGroupId, sessionId, [row(2, 'tool_call', 'Read')]);
    expect(getActivitySyncedSeq(sessionId)).toBe(6);
  });

  it('listActivityByAgentGroup returns rows for a single group, newest first', () => {
    const { agentGroupId, sessionId } = seedAgentAndSession();
    createAgentGroup({
      id: 'ag-2',
      name: 'Other',
      folder: 'other',
      agent_provider: null,
      created_at: now(),
    });
    createSession({
      id: 'sess-2',
      agent_group_id: 'ag-2',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });

    mergeActivityBatch(agentGroupId, sessionId, [row(1, 'tool_call', 'Read'), row(2, 'cmd_exec', 'Bash')]);
    mergeActivityBatch('ag-2', 'sess-2', [row(1, 'tool_call', 'Glob')]);

    const ag1 = listActivityByAgentGroup(agentGroupId);
    expect(ag1).toHaveLength(2);
    expect(ag1.every((r) => r.agent_group_id === agentGroupId)).toBe(true);
    // DESC by created_at — row(2) was minted later (Jan 2 > Jan 1).
    expect(ag1[0].target).toBe('Bash');
    expect(ag1[1].target).toBe('Read');

    const ag2 = listActivityByAgentGroup('ag-2');
    expect(ag2).toHaveLength(1);
    expect(ag2[0].target).toBe('Glob');
  });

  it('honors `since` and `limit`', () => {
    const { agentGroupId, sessionId } = seedAgentAndSession();
    mergeActivityBatch(agentGroupId, sessionId, [
      row(1, 'tool_call', 'A'),
      row(2, 'tool_call', 'B'),
      row(3, 'tool_call', 'C'),
      row(4, 'tool_call', 'D'),
    ]);

    const limited = listActivityBySession(sessionId, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].target).toBe('D'); // newest first
    expect(limited[1].target).toBe('C');

    // since = ts of seq=2 (Jan 2). Should include C (Jan 3) and D (Jan 4).
    const since = new Date(2026, 0, 2).toISOString();
    const sinceRows = listActivityBySession(sessionId, { since });
    expect(sinceRows.map((r) => r.target)).toEqual(['D', 'C']);
  });

  it('cascades on session delete', () => {
    const { agentGroupId, sessionId } = seedAgentAndSession();
    mergeActivityBatch(agentGroupId, sessionId, [row(1, 'tool_call', 'Read')]);
    expect(listActivityBySession(sessionId)).toHaveLength(1);

    getDb().prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    expect(listActivityBySession(sessionId)).toHaveLength(0);
    expect(listActivityByAgentGroup(agentGroupId)).toHaveLength(0);
  });
});
