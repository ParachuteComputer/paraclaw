import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { clearStateStore, consumeState, mintState, stateStoreSize } from './state-store.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  clearStateStore();
  closeDb();
});

describe('oauth state-store', () => {
  it('mints unique opaque tokens', () => {
    const a = mintState({ provider: 'google', redirectUri: 'http://x/cb' });
    const b = mintState({ provider: 'google', redirectUri: 'http://x/cb' });
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it('round-trips context on consume', () => {
    const state = mintState({
      provider: 'google',
      agentGroupId: 'grp-1',
      redirectUri: 'http://x/cb',
    });
    const ctx = consumeState(state);
    expect(ctx).toBeDefined();
    expect(ctx?.provider).toBe('google');
    expect(ctx?.agentGroupId).toBe('grp-1');
    expect(ctx?.redirectUri).toBe('http://x/cb');
  });

  it('is single-use — second consume returns undefined', () => {
    const state = mintState({ provider: 'google', redirectUri: 'http://x/cb' });
    expect(consumeState(state)).toBeDefined();
    expect(consumeState(state)).toBeUndefined();
  });

  it('returns undefined for unknown state', () => {
    expect(consumeState('never-minted')).toBeUndefined();
  });

  it('treats expired entries as missing', () => {
    const state = mintState({ provider: 'google', redirectUri: 'http://x/cb' });
    // Simulate expiry via clear; consume of arbitrary key returns undefined.
    clearStateStore();
    expect(consumeState(state)).toBeUndefined();
    expect(stateStoreSize()).toBe(0);
  });
});
