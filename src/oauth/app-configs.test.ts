import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { _setMasterKeyForTest } from '../secrets/master-key.js';
import {
  deleteAppConfig,
  getAppConfig,
  getAppConfigWithSecret,
  listAppConfigs,
  putAppConfig,
} from './app-configs.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _setMasterKeyForTest(crypto.randomBytes(32));
});

afterEach(() => closeDb());

describe('app_configs DB layer', () => {
  it('inserts a config and returns its id', () => {
    const id = putAppConfig('google', {
      client_id: 'abc.apps.googleusercontent.com',
      client_secret: 'super-secret',
      scopes_default: 'openid email',
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('round-trips client_secret via getAppConfigWithSecret', () => {
    putAppConfig('google', {
      client_id: 'abc',
      client_secret: 'shhh',
    });
    const got = getAppConfigWithSecret('google');
    expect(got?.client_secret).toBe('shhh');
    expect(got?.client_id).toBe('abc');
  });

  it('hides client_secret from public reads', () => {
    putAppConfig('google', { client_id: 'abc', client_secret: 'shhh' });
    const row = getAppConfig('google') as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('client_secret');
    expect(row).not.toHaveProperty('client_secret_encrypted');
  });

  it('updates an existing provider in place', () => {
    const id1 = putAppConfig('google', { client_id: 'v1', client_secret: 's1' });
    const id2 = putAppConfig('google', { client_id: 'v2', client_secret: 's2' });
    expect(id1).toBe(id2);
    expect(getAppConfig('google')?.client_id).toBe('v2');
    expect(getAppConfigWithSecret('google')?.client_secret).toBe('s2');
  });

  it('lists configs alphabetically by provider', () => {
    putAppConfig('zeta', { client_id: 'z', client_secret: 'sz' });
    putAppConfig('alpha', { client_id: 'a', client_secret: 'sa' });
    expect(listAppConfigs().map((r) => r.provider)).toEqual(['alpha', 'zeta']);
  });

  it('deletes by provider', () => {
    putAppConfig('google', { client_id: 'abc', client_secret: 'shhh' });
    expect(deleteAppConfig('google')).toBe(true);
    expect(getAppConfig('google')).toBeUndefined();
    expect(deleteAppConfig('google')).toBe(false);
  });
});
