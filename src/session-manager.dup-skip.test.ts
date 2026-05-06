/**
 * Integration coverage for paraclaw#97 — writeSessionMessage's dup-skip
 * side effects beyond the SQL-layer assertions in #95.
 *
 * After paraclaw#92 / #95, ON CONFLICT(id) DO NOTHING absorbs the second
 * INSERT, and writeSessionMessage gates two side effects on inserted=true:
 *   1. session.last_active is NOT bumped on the dup
 *   2. extractAttachmentFiles never runs (paraclaw#96 / #120)
 *   3. A debug log fires so drops are observable
 *
 * The session-manager.attachments.test.ts file already covers #2 with
 * sequential pairs. This file adds the integration-level invariants the
 * issue calls out as still untested at the writeSessionMessage layer:
 * last_active discipline, debug log shape, and dup-skip behavior under
 * realistic dispatcher pressure (Promise.all'd same-id calls).
 *
 * Real session DBs + real fs — last_active and file invariants are the
 * kind that mocks can fake green.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openDb } from './db/connection.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, getSession } from './db/index.js';
import { log } from './log.js';
import { initSessionFolder, inboundDbPath, sessionDir, writeSessionMessage } from './session-manager.js';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-dup-skip' };
});

const TEST_DIR = '/tmp/paraclaw-test-dup-skip';
const AG = 'ag-1';
const SESS = 'sess-dup';

function nowIso(): string {
  return new Date().toISOString();
}

function rowsInMessagesIn(): Array<{ id: string }> {
  const db = openDb(inboundDbPath(AG, SESS));
  const rows = db.prepare('SELECT id FROM messages_in').all() as Array<{ id: string }>;
  db.close();
  return rows;
}

function makeMessage(id: string) {
  return {
    id,
    kind: 'chat',
    timestamp: nowIso(),
    platformId: 'chan-1',
    channelType: 'discord',
    threadId: null as string | null,
    content: JSON.stringify({
      text: 'hello',
      attachments: [{ name: 'doc.bin', type: 'file', size: 4, data: Buffer.from('aaaa').toString('base64') }],
    }),
  };
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: AG,
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: nowIso(),
  });
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider,
       status, container_status, last_active, created_at)
     VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider,
       @status, @container_status, @last_active, @created_at)`,
  ).run({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: null,
    created_at: nowIso(),
  });
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  vi.restoreAllMocks();
});

describe('writeSessionMessage — dup-skip side effects (paraclaw#97)', () => {
  it('does NOT bump session.last_active on a duplicate dispatch', async () => {
    writeSessionMessage(AG, SESS, makeMessage('msg-1'));

    const firstActive = getSession(SESS)!.last_active;
    expect(firstActive).not.toBeNull();

    // Sleep enough for any new ISO timestamp to differ from the first.
    await new Promise((r) => setTimeout(r, 25));

    writeSessionMessage(AG, SESS, makeMessage('msg-1'));

    const secondActive = getSession(SESS)!.last_active;
    expect(secondActive).toBe(firstActive);

    expect(rowsInMessagesIn()).toHaveLength(1);
  });

  it('emits a debug log on dup-skip with the expected payload', () => {
    const debugSpy = vi.spyOn(log, 'debug');

    writeSessionMessage(AG, SESS, makeMessage('msg-2'));
    writeSessionMessage(AG, SESS, makeMessage('msg-2'));

    const dupCalls = debugSpy.mock.calls.filter(
      ([msg]) => typeof msg === 'string' && msg.includes('messages_in id already present'),
    );
    expect(dupCalls).toHaveLength(1);

    const [, fields] = dupCalls[0]!;
    expect(fields).toMatchObject({
      agentGroupId: AG,
      sessionId: SESS,
      messageId: 'msg-2',
    });
  });

  it('absorbs N near-concurrent same-id dispatches: one row, one file, no spurious sibling files', async () => {
    // Promise.all-style dispatcher pressure. better-sqlite3 is synchronous so
    // these serialize on the event loop, but the test shape captures what a
    // future async refactor would have to preserve: same-id calls collapse
    // to a single row + a single attachment file regardless of fan-in.
    const calls = Array.from({ length: 6 }, () => writeSessionMessage(AG, SESS, makeMessage('msg-burst')));
    await Promise.all(calls);

    expect(rowsInMessagesIn()).toHaveLength(1);

    const inboxDir = path.join(sessionDir(AG, SESS), 'inbox', 'msg-burst');
    expect(fs.existsSync(inboxDir)).toBe(true);
    const files = fs.readdirSync(inboxDir);
    expect(files).toEqual(['doc.bin']);
  });

  it('different ids in the same burst all land — dup-skip is keyed on id, not on burst', async () => {
    // Sanity check that the dup-skip absorption is NOT overly broad — distinct
    // messages_in.id values still get their own rows + their own inbox dirs.
    await Promise.all([
      writeSessionMessage(AG, SESS, makeMessage('msg-a')),
      writeSessionMessage(AG, SESS, makeMessage('msg-b')),
      writeSessionMessage(AG, SESS, makeMessage('msg-c')),
    ]);

    const ids = rowsInMessagesIn()
      .map((r) => r.id)
      .sort();
    expect(ids).toEqual(['msg-a', 'msg-b', 'msg-c']);

    expect(fs.readdirSync(path.join(sessionDir(AG, SESS), 'inbox')).sort()).toEqual(['msg-a', 'msg-b', 'msg-c']);
  });
});
