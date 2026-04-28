import { describe, expect, it } from 'vitest';

import { GoogleProvider } from './google.js';
import { getProvider, listProviderSlugs } from './index.js';

describe('GoogleProvider', () => {
  it('is registered under slug "google"', () => {
    expect(getProvider('google')).toBe(GoogleProvider);
    expect(listProviderSlugs()).toContain('google');
  });

  it('extracts account from a typical userinfo response', () => {
    const got = GoogleProvider.extractAccount({
      sub: '108234567890',
      email: 'alice@example.com',
      name: 'Alice',
    });
    expect(got.accountId).toBe('108234567890');
    expect(got.accountEmail).toBe('alice@example.com');
    expect(got.label).toBe('alice@example.com');
  });

  it('falls back to name then "google:<sub>" when email is missing', () => {
    expect(GoogleProvider.extractAccount({ sub: '1', name: 'Bob' }).label).toBe('Bob');
    expect(GoogleProvider.extractAccount({ sub: '2' }).label).toBe('google:2');
  });

  it('throws when sub is missing', () => {
    expect(() => GoogleProvider.extractAccount({ email: 'no-sub@example.com' })).toThrow(/missing `sub`/);
  });

  it('declares offline access + consent so refresh_token is always issued', () => {
    expect(GoogleProvider.extraAuthParams).toMatchObject({
      access_type: 'offline',
      prompt: 'consent',
    });
  });
});
