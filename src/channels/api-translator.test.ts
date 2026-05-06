/**
 * Round-trip + validator coverage for the shared channel-wire translator
 * (paraclaw#123). The HTTP and MCP surfaces both depend on this module to
 * keep the wire ↔ DB enums in lockstep — paraclaw#94/#122 was the drift
 * incident that motivated extracting these tests behind one file.
 */
import { describe, it, expect } from 'vitest';

import type { MessagingGroupAgent } from '../types.js';
import {
  ALL_MESSAGES_PATTERN_SENTINEL,
  apiToDbPatch,
  dbToApiEngage,
  dbToApiIgnoredPolicy,
  dbToApiSenderScope,
  rowToView,
  validatePatchInput,
  type WireJoinRow,
} from './api-translator.js';

function baseRow(overrides: Partial<WireJoinRow> = {}): WireJoinRow {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: '2026-05-05T00:00:00Z',
    mg_channel_type: 'discord',
    mg_platform_id: 'guild-123',
    mg_name: 'general',
    ag_folder: 'research',
    ag_name: 'Research',
    ...overrides,
  };
}

function baseCurrent(overrides: Partial<MessagingGroupAgent> = {}): MessagingGroupAgent {
  return {
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: '2026-05-05T00:00:00Z',
    ...overrides,
  };
}

describe('dbToApiEngage', () => {
  it('mention + null → mention', () => {
    expect(dbToApiEngage('mention', null)).toBe('mention');
  });

  it('mention-sticky collapses to mention on the wire', () => {
    // The wire deliberately doesn't expose sticky — see api-translator.ts
    // docblock. apiToDbPatch's mention-sticky preservation is what keeps
    // sticky-mode rows from silently flattening on PATCHes that don't
    // touch the engagement fields.
    expect(dbToApiEngage('mention-sticky', null)).toBe('mention');
  });

  it("pattern + '.' sentinel → all", () => {
    expect(dbToApiEngage('pattern', ALL_MESSAGES_PATTERN_SENTINEL)).toBe('all');
  });

  it('pattern + real regex body → pattern', () => {
    expect(dbToApiEngage('pattern', '\\bdeploy\\b')).toBe('pattern');
  });

  it('pattern + null → pattern (defensive — schema disallows but translator must not crash)', () => {
    expect(dbToApiEngage('pattern', null)).toBe('pattern');
  });
});

describe('dbToApiSenderScope', () => {
  it("DB 'known' → wire 'allowlist'", () => {
    expect(dbToApiSenderScope('known')).toBe('allowlist');
  });

  it("DB 'all' → wire 'unrestricted' (paraclaw#94 — disjoint literals)", () => {
    expect(dbToApiSenderScope('all')).toBe('unrestricted');
  });
});

describe('dbToApiIgnoredPolicy', () => {
  it("DB 'accumulate' → wire 'silent'", () => {
    expect(dbToApiIgnoredPolicy('accumulate')).toBe('silent');
  });

  it("DB 'drop' → wire 'drop'", () => {
    expect(dbToApiIgnoredPolicy('drop')).toBe('drop');
  });
});

describe('rowToView', () => {
  it('projects every join column onto the wire view', () => {
    const view = rowToView(
      baseRow({
        engage_mode: 'pattern',
        engage_pattern: '\\bping\\b',
        sender_scope: 'known',
        ignored_message_policy: 'accumulate',
        priority: 5,
      }),
    );
    expect(view).toEqual({
      id: 'mga-1',
      channelType: 'discord',
      messagingGroupId: 'mg-1',
      platformId: 'guild-123',
      displayName: 'general',
      agentGroupId: 'ag-1',
      agentGroupFolder: 'research',
      agentGroupName: 'Research',
      engageMode: 'pattern',
      engagePattern: '\\bping\\b',
      senderScope: 'allowlist',
      ignoredMessagePolicy: 'silent',
      priority: 5,
      createdAt: '2026-05-05T00:00:00Z',
    });
  });

  it("collapses pattern + '.' to engageMode='all' and nulls engagePattern on the wire", () => {
    const view = rowToView(
      baseRow({ engage_mode: 'pattern', engage_pattern: ALL_MESSAGES_PATTERN_SENTINEL }),
    );
    expect(view.engageMode).toBe('all');
    expect(view.engagePattern).toBeNull();
  });

  it('mention mode never leaks the engage_pattern column to the wire', () => {
    // In practice the schema keeps engage_pattern null for mention rows, but
    // the projection must not surface stale pattern bodies if a row drifts.
    const view = rowToView(baseRow({ engage_mode: 'mention', engage_pattern: 'leftover' }));
    expect(view.engageMode).toBe('mention');
    expect(view.engagePattern).toBeNull();
  });
});

describe('apiToDbPatch — engageMode encoding', () => {
  it("engageMode='all' → mode=pattern + pattern='.'", () => {
    const out = apiToDbPatch({ engageMode: 'all' }, baseCurrent());
    expect(out.engage_mode).toBe('pattern');
    expect(out.engage_pattern).toBe(ALL_MESSAGES_PATTERN_SENTINEL);
  });

  it('engageMode=pattern + engagePattern → both written', () => {
    const out = apiToDbPatch(
      { engageMode: 'pattern', engagePattern: '\\bdeploy\\b' },
      baseCurrent(),
    );
    expect(out.engage_mode).toBe('pattern');
    expect(out.engage_pattern).toBe('\\bdeploy\\b');
  });

  it('engageMode=pattern without engagePattern → only mode set, pattern preserved on the row', () => {
    // The PATCH-shape semantic: an undefined field means "leave it alone."
    // The DB-side row already has the prior pattern; we don't overwrite it.
    const out = apiToDbPatch({ engageMode: 'pattern' }, baseCurrent({ engage_pattern: 'old' }));
    expect(out.engage_mode).toBe('pattern');
    expect(out).not.toHaveProperty('engage_pattern');
  });

  it("engageMode='mention' nulls engage_pattern", () => {
    const out = apiToDbPatch({ engageMode: 'mention' }, baseCurrent());
    expect(out.engage_mode).toBe('mention');
    expect(out.engage_pattern).toBeNull();
  });

  it("engageMode='mention' preserves mention-sticky when current row is sticky", () => {
    // Wire doesn't expose sticky → both mention + mention-sticky show as
    // 'mention' on the read side. A PATCH that flips back to 'mention' on
    // the wire shouldn't silently demote the sticky bit on the row.
    const out = apiToDbPatch({ engageMode: 'mention' }, baseCurrent({ engage_mode: 'mention-sticky' }));
    expect(out.engage_mode).toBe('mention-sticky');
    expect(out.engage_pattern).toBeNull();
  });

  it('engagePattern alone (no engageMode) → only pattern body changes', () => {
    const out = apiToDbPatch({ engagePattern: '\\bnew\\b' }, baseCurrent({ engage_mode: 'pattern' }));
    expect(out).not.toHaveProperty('engage_mode');
    expect(out.engage_pattern).toBe('\\bnew\\b');
  });
});

describe('apiToDbPatch — sender scope and ignored policy', () => {
  it("senderScope 'allowlist' → DB 'known'", () => {
    expect(apiToDbPatch({ senderScope: 'allowlist' }, baseCurrent()).sender_scope).toBe('known');
  });

  it("senderScope 'unrestricted' → DB 'all'", () => {
    expect(apiToDbPatch({ senderScope: 'unrestricted' }, baseCurrent()).sender_scope).toBe('all');
  });

  it("ignoredMessagePolicy 'silent' → DB 'accumulate'", () => {
    expect(apiToDbPatch({ ignoredMessagePolicy: 'silent' }, baseCurrent()).ignored_message_policy).toBe(
      'accumulate',
    );
  });

  it("ignoredMessagePolicy 'drop' → DB 'drop'", () => {
    expect(apiToDbPatch({ ignoredMessagePolicy: 'drop' }, baseCurrent()).ignored_message_policy).toBe(
      'drop',
    );
  });

  it('priority passes through unchanged', () => {
    expect(apiToDbPatch({ priority: 7 }, baseCurrent()).priority).toBe(7);
  });

  it('empty input → empty patch', () => {
    expect(apiToDbPatch({}, baseCurrent())).toEqual({});
  });
});

describe('validatePatchInput', () => {
  it('rejects non-object body', () => {
    expect(validatePatchInput(null)).toEqual({ ok: false, reason: 'body must be an object' });
    expect(validatePatchInput('string')).toEqual({ ok: false, reason: 'body must be an object' });
    expect(validatePatchInput(42)).toEqual({ ok: false, reason: 'body must be an object' });
  });

  it('passes a fully-populated valid body', () => {
    const result = validatePatchInput({
      engageMode: 'pattern',
      engagePattern: '\\bping\\b',
      senderScope: 'allowlist',
      ignoredMessagePolicy: 'silent',
      priority: 3,
    });
    expect(result).toEqual({
      ok: true,
      input: {
        engageMode: 'pattern',
        engagePattern: '\\bping\\b',
        senderScope: 'allowlist',
        ignoredMessagePolicy: 'silent',
        priority: 3,
      },
    });
  });

  it("rejects legacy wire-side senderScope='all' (paraclaw#94 rename)", () => {
    // Pre-paraclaw#94 the wire used 'all' on both axes; the rename to
    // 'unrestricted' was specifically to make a grep-refactor unable to
    // conflate the wire and DB unions. The validator must now reject the
    // old literal.
    const result = validatePatchInput({ senderScope: 'all' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('senderScope');
  });

  it("rejects legacy ignoredMessagePolicy='accumulate' on the wire", () => {
    // 'accumulate' is the DB-side spelling. The wire spelling is 'silent'.
    const result = validatePatchInput({ ignoredMessagePolicy: 'accumulate' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('ignoredMessagePolicy');
  });

  it("rejects engageMode='mention-sticky' (DB-only literal)", () => {
    const result = validatePatchInput({ engageMode: 'mention-sticky' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('engageMode');
  });

  it("rejects bare '.' as engagePattern (sentinel reservation)", () => {
    // Storing '.' would silently round-trip back as engageMode='all' on the
    // next read. The fix landed in paraclaw#122 — keep the regression here.
    const result = validatePatchInput({ engagePattern: ALL_MESSAGES_PATTERN_SENTINEL });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/sentinel/);
  });

  it("accepts escaped literal-dot pattern '\\\\.'", () => {
    // The error message above tells the caller to escape; that escaped
    // form must round-trip cleanly.
    const result = validatePatchInput({ engagePattern: '\\.' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.engagePattern).toBe('\\.');
  });

  it('accepts engagePattern=null (clear-the-pattern PATCH)', () => {
    const result = validatePatchInput({ engagePattern: null });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.engagePattern).toBeNull();
  });

  it('rejects non-string non-null engagePattern', () => {
    expect(validatePatchInput({ engagePattern: 5 }).ok).toBe(false);
    expect(validatePatchInput({ engagePattern: {} }).ok).toBe(false);
  });

  it('rejects non-finite priority', () => {
    expect(validatePatchInput({ priority: Infinity }).ok).toBe(false);
    expect(validatePatchInput({ priority: NaN }).ok).toBe(false);
    expect(validatePatchInput({ priority: '5' }).ok).toBe(false);
  });

  it('drops unknown keys silently (forward-compat)', () => {
    // The validator only inspects fields it knows; unknown keys aren't an
    // error, they just don't make it into the typed output.
    const result = validatePatchInput({ engageMode: 'mention', futureField: 'nope' });
    expect(result).toEqual({ ok: true, input: { engageMode: 'mention' } });
  });
});
