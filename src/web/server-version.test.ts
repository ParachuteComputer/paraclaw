/**
 * Regression test for paraclaw#101 — SERVICE_VERSION must read from
 * package.json, not be hardcoded. Without this dynamism, every rc bump
 * silently lies about the running version.
 */
import { describe, expect, test } from 'vitest';

import { SERVICE_VERSION } from './server.js';
import pkg from '../../package.json' with { type: 'json' };

describe('SERVICE_VERSION', () => {
  test('matches package.json version (no hardcoded drift)', () => {
    expect(SERVICE_VERSION).toBe(pkg.version);
    expect(SERVICE_VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z]+\.\d+)?$/);
  });
});
