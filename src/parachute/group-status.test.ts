/**
 * Tests for getGroupStatus — the helper the web server uses to compute
 * "is this agent group's container alive?" without depending on
 * container-runner.ts's in-memory map (different process from web server).
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../config.js', async () => {
  const actual = await vi.importActual('../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-group-status-test' };
});

const TEST_DIR = '/tmp/paraclaw-group-status-test';

let initTestDb: typeof import('../db/index.js').initTestDb;
let closeDb: typeof import('../db/index.js').closeDb;
let runMigrations: typeof import('../db/index.js').runMigrations;
let createAgentGroup: typeof import('../db/index.js').createAgentGroup;
let createSession: typeof import('../db/sessions.js').createSession;
let getGroupStatus: typeof import('./group-status.js').getGroupStatus;
let inboundDbPath: typeof import('../session-manager.js').inboundDbPath;
let outboundDbPath: typeof import('../session-manager.js').outboundDbPath;
let heartbeatPath: typeof import('../session-manager.js').heartbeatPath;
let INBOUND_SCHEMA: string;
let OUTBOUND_SCHEMA: string;

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });

  // Imported lazily so the config.js mock is in effect when modules cache it.
  ({ initTestDb, closeDb, runMigrations, createAgentGroup } = await import('../db/index.js'));
  ({ createSession } = await import('../db/sessions.js'));
  ({ getGroupStatus } = await import('./group-status.js'));
  ({ inboundDbPath, outboundDbPath, heartbeatPath } = await import('../session-manager.js'));
  ({ INBOUND_SCHEMA, OUTBOUND_SCHEMA } = await import('../db/schema.js'));

  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({
    id: 'ag-1',
    name: 'Forge',
    folder: 'forge',
    agent_provider: null,
    created_at: '2026-04-27T00:00:00.000Z',
  });
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

function makeSession(id: string) {
  createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: '2026-04-27T00:00:00.000Z',
    created_at: '2026-04-27T00:00:00.000Z',
  });
  fs.mkdirSync(path.dirname(heartbeatPath('ag-1', id)), { recursive: true });
}

function writeHeartbeat(sessionId: string, mtimeMs: number) {
  const p = heartbeatPath('ag-1', sessionId);
  fs.writeFileSync(p, '');
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

function seedInboundDb(sessionId: string, lastTimestamp: string) {
  const dbPath = inboundDbPath('ag-1', sessionId);
  const db = new Database(dbPath);
  db.exec(INBOUND_SCHEMA);
  db.prepare("INSERT INTO messages_in (id, kind, timestamp, content) VALUES ('m1', 'msg', ?, '{}')").run(lastTimestamp);
  db.close();
}

function seedOutboundDb(sessionId: string, lastTimestamp: string) {
  const dbPath = outboundDbPath('ag-1', sessionId);
  const db = new Database(dbPath);
  db.exec(OUTBOUND_SCHEMA);
  db.prepare("INSERT INTO messages_out (id, kind, timestamp, content) VALUES ('o1', 'msg', ?, '{}')").run(
    lastTimestamp,
  );
  db.close();
}

describe('getGroupStatus', () => {
  it('returns null for unknown folder', () => {
    expect(getGroupStatus('does-not-exist')).toBeNull();
  });

  it('returns empty status for a group with no sessions', () => {
    const status = getGroupStatus('forge');
    expect(status).not.toBeNull();
    expect(status!.containerRunning).toBe(false);
    expect(status!.activeSessionCount).toBe(0);
    expect(status!.sessionCount).toBe(0);
    expect(status!.sessions).toEqual([]);
  });

  it('marks a session alive when its heartbeat is fresh', () => {
    const now = Date.parse('2026-04-27T12:00:00.000Z');
    makeSession('s-fresh');
    writeHeartbeat('s-fresh', now - 30_000); // 30s ago — well under 90s threshold

    const status = getGroupStatus('forge', { nowMs: now });
    expect(status!.containerRunning).toBe(true);
    expect(status!.activeSessionCount).toBe(1);
    expect(status!.sessions[0].alive).toBe(true);
    expect(status!.sessions[0].lastHeartbeatAt).toBe(new Date(now - 30_000).toISOString());
  });

  it('marks a session dead when heartbeat is older than the threshold', () => {
    const now = Date.parse('2026-04-27T12:00:00.000Z');
    makeSession('s-stale');
    writeHeartbeat('s-stale', now - 120_000); // 2 min ago

    const status = getGroupStatus('forge', { nowMs: now });
    expect(status!.containerRunning).toBe(false);
    expect(status!.activeSessionCount).toBe(0);
    expect(status!.sessions[0].alive).toBe(false);
  });

  it('aggregates last-message timestamps across sessions', () => {
    const now = Date.parse('2026-04-27T12:00:00.000Z');

    makeSession('s-a');
    writeHeartbeat('s-a', now - 5_000);
    seedInboundDb('s-a', '2026-04-27T11:55:00.000Z');
    seedOutboundDb('s-a', '2026-04-27T11:56:00.000Z');

    makeSession('s-b');
    writeHeartbeat('s-b', now - 10_000);
    seedInboundDb('s-b', '2026-04-27T11:58:00.000Z'); // newer
    seedOutboundDb('s-b', '2026-04-27T11:50:00.000Z'); // older

    const status = getGroupStatus('forge', { nowMs: now });
    expect(status!.activeSessionCount).toBe(2);
    expect(status!.lastMessageInAt).toBe('2026-04-27T11:58:00.000Z');
    expect(status!.lastMessageOutAt).toBe('2026-04-27T11:56:00.000Z');
  });

  it('tolerates missing session dirs and DBs', () => {
    const now = Date.parse('2026-04-27T12:00:00.000Z');
    // Session row exists but no heartbeat / DB files have been created yet.
    makeSession('s-empty');

    const status = getGroupStatus('forge', { nowMs: now });
    expect(status!.containerRunning).toBe(false);
    expect(status!.sessions[0].alive).toBe(false);
    expect(status!.sessions[0].lastMessageInAt).toBeNull();
    expect(status!.sessions[0].lastMessageOutAt).toBeNull();
  });
});
