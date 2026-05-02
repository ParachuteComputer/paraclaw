/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import { openDb } from './connection.js';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { ensureSchema, insertMessage, migrateMessagesInTable } from './session-db.js';

const TEST_DIR = '/tmp/paraclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = openDb(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });
});

describe('insertMessage', () => {
  it('returns inserted=true on first write, inserted=false on duplicate id (paraclaw#92)', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    ensureSchema(DB_PATH, 'inbound');
    const db = openDb(DB_PATH);

    const args = {
      id: 'msg-dup-1:ag-1',
      kind: 'chat' as const,
      timestamp: new Date().toISOString(),
      platformId: 'telegram:bot:chat',
      channelType: 'telegram',
      threadId: null,
      content: '{"text":"hi"}',
      processAfter: null,
      recurrence: null,
    };

    const first = insertMessage(db, args);
    expect(first.inserted).toBe(true);

    // Duplicate dispatch — same id arrives again (sender-approval replay
    // racing with re-emitted chat-sdk event, or platform getUpdates retry).
    const second = insertMessage(db, args);
    expect(second.inserted).toBe(false);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM messages_in WHERE id = ?').get(args.id) as { n: number }).n;
    expect(count).toBe(1);

    db.close();
  });
});
