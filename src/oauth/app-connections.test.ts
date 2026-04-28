import crypto from 'crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { _setMasterKeyForTest } from '../secrets/master-key.js';
import { putAppConfig } from './app-configs.js';
import {
  deleteAppConnection,
  getAppConnection,
  getAppConnectionWithTokens,
  listAppConnections,
  upsertAppConnection,
} from './app-connections.js';

let configId: string;

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  _setMasterKeyForTest(crypto.randomBytes(32));
  configId = putAppConfig('google', { client_id: 'cid', client_secret: 'csec' });
});

afterEach(() => closeDb());

describe('app_connections DB layer', () => {
  it('inserts and round-trips encrypted tokens', () => {
    const id = upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-1',
      account_email: 'a@example.com',
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      label: 'a@example.com',
    });
    const decrypted = getAppConnectionWithTokens(id);
    expect(decrypted?.access_token).toBe('access-1');
    expect(decrypted?.refresh_token).toBe('refresh-1');
    expect(decrypted?.account_email).toBe('a@example.com');
  });

  it('hides token columns from public reads', () => {
    const id = upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-1',
      access_token: 'access-1',
      label: 'a',
    });
    const row = getAppConnection(id) as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row).not.toHaveProperty('access_token');
    expect(row).not.toHaveProperty('access_token_encrypted');
    expect(row).not.toHaveProperty('refresh_token');
  });

  it('upserts on (app_config_id, account_id) — same id, refreshed tokens', () => {
    const id1 = upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-1',
      access_token: 'old',
      label: 'a',
    });
    const id2 = upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-1',
      access_token: 'new',
      refresh_token: 'rnew',
      label: 'a',
    });
    expect(id1).toBe(id2);
    expect(getAppConnectionWithTokens(id1)?.access_token).toBe('new');
    expect(getAppConnectionWithTokens(id1)?.refresh_token).toBe('rnew');
  });

  it('treats different account_ids as separate connections', () => {
    upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-1',
      access_token: 't1',
      label: 'a',
    });
    upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-2',
      access_token: 't2',
      label: 'b',
    });
    expect(listAppConnections()).toHaveLength(2);
  });

  it('deletes by id', () => {
    const id = upsertAppConnection({
      app_config_id: configId,
      account_id: 'sub-1',
      access_token: 'access',
      label: 'a',
    });
    expect(deleteAppConnection(id)).toBe(true);
    expect(getAppConnection(id)).toBeUndefined();
    expect(deleteAppConnection(id)).toBe(false);
  });
});
