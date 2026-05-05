/**
 * Regression coverage for paraclaw#96 — silent file clobber on mutated
 * replays. After paraclaw#92 / #95 made duplicate-dispatch
 * (sender-approval replay etc.) a warm path, the attachment-extraction
 * step in writeSessionMessage must run only AFTER the row commits, or a
 * mutated replay rewrites the on-disk file under the original
 * messages_in.id while the DB row stays unchanged.
 *
 * Real session DBs (no execSync mock) — file-clobber-class hazards are
 * easy to fake green with mocked filesystem state.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { openDb } from './db/connection.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { initSessionFolder, inboundDbPath, sessionDir, writeSessionMessage } from './session-manager.js';

vi.mock('./config.js', async () => {
  const actual = await vi.importActual('./config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-attachments' };
});

const TEST_DIR = '/tmp/paraclaw-test-attachments';
const AG = 'ag-1';
const SESS = 'sess-attachments';

function nowIso(): string {
  return new Date().toISOString();
}

function readRowContent(): string {
  const db = openDb(inboundDbPath(AG, SESS));
  const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get('msg-1') as { content: string };
  db.close();
  return row.content;
}

function inboxFilePath(filename: string): string {
  return path.join(sessionDir(AG, SESS), 'inbox', 'msg-1', filename);
}

function makeMessageWithAttachment(dataB64: string) {
  return {
    id: 'msg-1',
    kind: 'chat',
    timestamp: nowIso(),
    platformId: 'chan-1',
    channelType: 'discord',
    threadId: null as string | null,
    content: JSON.stringify({
      text: 'see attachment',
      attachments: [{ name: 'photo.jpg', type: 'image', size: 9, data: dataB64 }],
    }),
  };
}

const ORIGINAL_BYTES = Buffer.from('first-pic');
const MUTATED_BYTES = Buffer.from('CLOBBERED');

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
  // Fresh-start a session manually — we don't need a messaging group for
  // these tests, just the session folder + DBs.
  const sessRow = {
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: null,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider,
       status, container_status, last_active, created_at)
     VALUES (@id, @agent_group_id, @messaging_group_id, @thread_id, @agent_provider,
       @status, @container_status, @last_active, @created_at)`,
  ).run(sessRow);
  initSessionFolder(AG, SESS);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('writeSessionMessage — attachment extraction order (paraclaw#96)', () => {
  it('fresh insert with attachment: row content has localPath, file written to inbox', () => {
    writeSessionMessage(AG, SESS, makeMessageWithAttachment(ORIGINAL_BYTES.toString('base64')));

    const parsed = JSON.parse(readRowContent());
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].localPath).toBe('inbox/msg-1/photo.jpg');
    expect(parsed.attachments[0].data).toBeUndefined();

    const onDisk = fs.readFileSync(inboxFilePath('photo.jpg'));
    expect(onDisk.equals(ORIGINAL_BYTES)).toBe(true);
  });

  it('fresh insert without attachments: row content unchanged, no inbox dir created', () => {
    writeSessionMessage(AG, SESS, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: nowIso(),
      content: JSON.stringify({ text: 'no attachments here' }),
    });

    expect(JSON.parse(readRowContent()).text).toBe('no attachments here');
    expect(fs.existsSync(path.join(sessionDir(AG, SESS), 'inbox'))).toBe(false);
  });

  it('duplicate dispatch with identical bytes: silently absorbed, file untouched', () => {
    const msg = makeMessageWithAttachment(ORIGINAL_BYTES.toString('base64'));

    writeSessionMessage(AG, SESS, msg);
    const firstMtime = fs.statSync(inboxFilePath('photo.jpg')).mtimeMs;

    // Sleep just enough to make a re-write detectable in mtime resolution.
    const wait = Date.now() + 20;
    while (Date.now() < wait) {
      /* spin */
    }

    writeSessionMessage(AG, SESS, msg);

    // File was NOT re-written — mtime unchanged.
    expect(fs.statSync(inboxFilePath('photo.jpg')).mtimeMs).toBe(firstMtime);
    expect(fs.readFileSync(inboxFilePath('photo.jpg')).equals(ORIGINAL_BYTES)).toBe(true);
  });

  it('duplicate dispatch with MUTATED bytes (replay hazard): on-disk file preserved byte-for-byte', () => {
    // The exact failure shape paraclaw#96 calls out: a replay that re-uses
    // the same messages_in.id but carries different attachment bytes. Pre-fix,
    // the second call's extractAttachmentFiles ran before the dup-check and
    // would have overwritten photo.jpg with MUTATED_BYTES while the DB row
    // still pointed at the original commit.
    writeSessionMessage(AG, SESS, makeMessageWithAttachment(ORIGINAL_BYTES.toString('base64')));
    const rowAfterFirst = readRowContent();

    writeSessionMessage(AG, SESS, makeMessageWithAttachment(MUTATED_BYTES.toString('base64')));

    // 1. On-disk file is byte-for-byte the original — NO clobber.
    const onDisk = fs.readFileSync(inboxFilePath('photo.jpg'));
    expect(onDisk.equals(ORIGINAL_BYTES)).toBe(true);
    expect(onDisk.equals(MUTATED_BYTES)).toBe(false);

    // 2. Only the original row exists; the replay didn't slip a new row in.
    const db = openDb(inboundDbPath(AG, SESS));
    const rows = db.prepare('SELECT id, content FROM messages_in').all() as Array<{ id: string; content: string }>;
    db.close();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(rowAfterFirst);
  });
});
