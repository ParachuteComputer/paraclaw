import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { recordTrustHint, consumeTrustHint, _resetTrustHintsForTest } from './trust-hint.js';

describe('channel trust hint', () => {
  beforeEach(() => {
    _resetTrustHintsForTest();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    _resetTrustHintsForTest();
  });

  it('returns true once for a recorded triple, then false on second consume', () => {
    recordTrustHint('telegram', 'bot-1', 'op-42');
    expect(consumeTrustHint('telegram', 'bot-1', 'op-42')).toBe(true);
    expect(consumeTrustHint('telegram', 'bot-1', 'op-42')).toBe(false);
  });

  it('returns false for a triple that was never recorded', () => {
    expect(consumeTrustHint('telegram', 'bot-1', 'op-42')).toBe(false);
  });

  it('discriminates by all three key parts', () => {
    recordTrustHint('telegram', 'bot-1', 'op-42');
    expect(consumeTrustHint('discord', 'bot-1', 'op-42')).toBe(false);
    expect(consumeTrustHint('telegram', 'bot-2', 'op-42')).toBe(false);
    expect(consumeTrustHint('telegram', 'bot-1', 'op-43')).toBe(false);
    expect(consumeTrustHint('telegram', 'bot-1', 'op-42')).toBe(true);
  });

  it('expires hints after the TTL', () => {
    recordTrustHint('telegram', 'bot-1', 'op-42');
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(consumeTrustHint('telegram', 'bot-1', 'op-42')).toBe(false);
  });

  it('keeps hints valid up to the TTL boundary', () => {
    recordTrustHint('telegram', 'bot-1', 'op-42');
    vi.advanceTimersByTime(5 * 60 * 1000 - 1);
    expect(consumeTrustHint('telegram', 'bot-1', 'op-42')).toBe(true);
  });

  it('treats empty operatorUserId as a no-op (Discord wires)', () => {
    recordTrustHint('discord', 'bot-app-id', '');
    expect(consumeTrustHint('discord', 'bot-app-id', '')).toBe(false);
  });
});
