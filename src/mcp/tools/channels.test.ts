/**
 * MCP-path coverage for `update-channel-wire`. The MCP SDK does not enforce
 * a tool's `inputSchema` against `tools/call` arguments before dispatching
 * to the handler (see comment on `ToolDef.inputSchema` in src/mcp/types.ts),
 * so the handler must defensively gate enum-typed fields itself. Without
 * the gate, a stale-schema client (cached pre-rc.6 senderScope vocabulary,
 * or a hand-rolled call) would fall through the if/else patch-construction
 * and silently no-op the column update — exactly the silent-coerce class
 * paraclaw#94 set out to close.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import type { ToolHandlerContext } from '../types.js';
import { channelTools } from './channels.js';

const updateTool = channelTools.find((t) => t.name === 'update-channel-wire')!;

const ctx: ToolHandlerContext = { effectiveScope: 'agent:admin', callerSubject: 'mcp:stdio' };

const now = (): string => new Date().toISOString();

function seedWire(over: { sender_scope?: 'all' | 'known' } = {}): void {
  createAgentGroup({
    id: 'ag_mcp',
    name: 'MCP test',
    folder: 'mcp-test',
    agent_provider: null,
    secret_mode: 'all',
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg_mcp',
    channel_type: 'telegram',
    platform_id: 'telegram:99:88',
    name: null,
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
  createMessagingGroupAgent({
    id: 'mga_mcp',
    messaging_group_id: 'mg_mcp',
    agent_group_id: 'ag_mcp',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: over.sender_scope ?? 'known',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('mcp update-channel-wire — paraclaw#94 senderScope vocabulary', () => {
  it("round-trips senderScope='unrestricted' → DB sender_scope='all' → response 'unrestricted'", async () => {
    seedWire({ sender_scope: 'known' });

    const result = (await updateTool.handler({ id: 'mga_mcp', senderScope: 'unrestricted' }, ctx)) as {
      wire: { senderScope: string };
    };

    expect(result.wire.senderScope).toBe('unrestricted');
    expect(getMessagingGroupAgent('mga_mcp')!.sender_scope).toBe('all');
  });

  it("rejects the legacy wire literal senderScope='all' instead of silent no-op", async () => {
    // The bug shape: pre-fix, the handler's if/else pair only matched
    // 'allowlist' and 'unrestricted'; legacy 'all' fell through and
    // `patch.sender_scope` was never assigned, so updateMessagingGroupAgent
    // ran with no sender_scope key and the column kept its previous value
    // — server returned success, client believed the field changed,
    // operator saw no error. Pin that the gate now refuses it.
    seedWire({ sender_scope: 'known' });

    await expect(updateTool.handler({ id: 'mga_mcp', senderScope: 'all' }, ctx)).rejects.toThrow(
      /invalid senderScope: all/,
    );

    // And critically — the column was NOT silently mutated.
    expect(getMessagingGroupAgent('mga_mcp')!.sender_scope).toBe('known');
  });

  it("rejects the legacy DB-side literal ignoredMessagePolicy='accumulate'", async () => {
    // Same silent-coerce class on a sibling field — the DB stores
    // 'accumulate' but the wire vocabulary is 'silent'. Pre-gate, sending
    // 'accumulate' on the wire fell through both if-branches.
    seedWire();

    await expect(
      updateTool.handler({ id: 'mga_mcp', ignoredMessagePolicy: 'accumulate' }, ctx),
    ).rejects.toThrow(/invalid ignoredMessagePolicy: accumulate/);

    expect(getMessagingGroupAgent('mga_mcp')!.ignored_message_policy).toBe('drop');
  });

  it('rejects an unknown engageMode instead of silent no-op via the engagePattern fallback', async () => {
    // engageMode's if/else chain has a fourth branch that fires when the
    // mode is unrecognized but engagePattern is present — so a typo'd
    // engageMode used to silently update only the pattern. Pin the gate.
    seedWire();

    await expect(
      updateTool.handler({ id: 'mga_mcp', engageMode: 'wave-hands', engagePattern: 'whatever' }, ctx),
    ).rejects.toThrow(/invalid engageMode: wave-hands/);

    const persisted = getMessagingGroupAgent('mga_mcp')!;
    expect(persisted.engage_mode).toBe('mention');
    expect(persisted.engage_pattern).toBeNull();
  });
});
