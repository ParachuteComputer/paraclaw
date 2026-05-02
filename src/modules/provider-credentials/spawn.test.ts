import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-provider-credentials' };
});

const TEST_DIR = '/tmp/paraclaw-test-provider-credentials';

describe('getProviderCredentialsForSpawn', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.resetModules();
    const { initTestDb, runMigrations } = await import('../../db/index.js');
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns empty envelope when no row exists', async () => {
    const { getProviderCredentialsForSpawn } = await import('./spawn.js');
    const env = getProviderCredentialsForSpawn('ag-1');
    expect(env.source).toBeNull();
    expect(env.env).toEqual({});
    expect(env.files).toEqual({});
    expect(env.suppressSecretEnvKeys.size).toBe(0);
  });

  it('claude_setup_token → injects CLAUDE_CODE_OAUTH_TOKEN env, suppresses ANTHROPIC_API_KEY + ANTHROPIC_AUTH_TOKEN', async () => {
    const { putProviderCredentials } = await import('./db.js');
    putProviderCredentials({ source: 'claude_setup_token', apiKey: 'sk-ant-oat01-paste' });

    const { getProviderCredentialsForSpawn } = await import('./spawn.js');
    const env = getProviderCredentialsForSpawn('ag-1');
    expect(env.source).toBe('claude_setup_token');
    expect(env.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-paste' });
    expect(env.files).toEqual({});
    expect(env.suppressSecretEnvKeys.has('ANTHROPIC_API_KEY')).toBe(true);
    expect(env.suppressSecretEnvKeys.has('ANTHROPIC_AUTH_TOKEN')).toBe(true);
  });

  it('claude_setup_token → empty env when token missing', async () => {
    const { putProviderCredentials } = await import('./db.js');
    putProviderCredentials({ source: 'claude_setup_token', apiKey: null });

    const { getProviderCredentialsForSpawn } = await import('./spawn.js');
    const env = getProviderCredentialsForSpawn('ag-1');
    expect(env.source).toBe('claude_setup_token');
    expect(env.env).toEqual({});
  });

  it('anthropic_api_key → injects ANTHROPIC_API_KEY env, no files, no suppress', async () => {
    const { putProviderCredentials } = await import('./db.js');
    putProviderCredentials({ source: 'anthropic_api_key', apiKey: 'sk-ant-api03-test' });

    const { getProviderCredentialsForSpawn } = await import('./spawn.js');
    const env = getProviderCredentialsForSpawn('ag-1');
    expect(env.source).toBe('anthropic_api_key');
    expect(env.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-api03-test' });
    expect(env.files).toEqual({});
    expect(env.suppressSecretEnvKeys.size).toBe(0);
  });

  it('external_server → injects ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL', async () => {
    const { putProviderCredentials } = await import('./db.js');
    putProviderCredentials({
      source: 'external_server',
      apiKey: 'or-key',
      serverUrl: 'https://openrouter.ai/api/v1',
    });

    const { getProviderCredentialsForSpawn } = await import('./spawn.js');
    const env = getProviderCredentialsForSpawn('ag-1');
    expect(env.source).toBe('external_server');
    expect(env.env).toEqual({
      ANTHROPIC_API_KEY: 'or-key',
      ANTHROPIC_BASE_URL: 'https://openrouter.ai/api/v1',
    });
  });

  it('external_server → empty env when key or url missing', async () => {
    const { putProviderCredentials } = await import('./db.js');
    putProviderCredentials({ source: 'external_server', apiKey: 'or-key', serverUrl: null });

    const { getProviderCredentialsForSpawn } = await import('./spawn.js');
    const env = getProviderCredentialsForSpawn('ag-1');
    expect(env.source).toBe('external_server');
    expect(env.env).toEqual({});
  });
});

describe('provider_credentials db round-trip', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    vi.resetModules();
    const { initTestDb, runMigrations } = await import('../../db/index.js');
    const db = initTestDb();
    runMigrations(db);
  });

  it('encrypts api_key at rest, decrypts on read', async () => {
    const { putProviderCredentials, readProviderCredentials, getProviderCredentialsRow } = await import('./db.js');
    putProviderCredentials({
      source: 'anthropic_api_key',
      apiKey: 'sk-ant-api03-secret',
    });

    const raw = getProviderCredentialsRow();
    expect(raw?.api_key_encrypted).not.toBe('sk-ant-api03-secret');
    expect(raw?.api_key_encrypted).toBeTruthy();

    const plain = readProviderCredentials();
    expect(plain?.apiKey).toBe('sk-ant-api03-secret');
  });

  it('upsert preserves unspecified fields (undefined = no-op, null = clear)', async () => {
    const { putProviderCredentials, readProviderCredentials } = await import('./db.js');
    putProviderCredentials({ source: 'external_server', apiKey: 'k1', serverUrl: 'https://a.test' });
    putProviderCredentials({ source: 'external_server', serverUrl: 'https://b.test' });

    const plain = readProviderCredentials();
    expect(plain?.apiKey).toBe('k1');
    expect(plain?.serverUrl).toBe('https://b.test');

    putProviderCredentials({ source: 'external_server', apiKey: null });
    const cleared = readProviderCredentials();
    expect(cleared?.apiKey).toBeNull();
    expect(cleared?.serverUrl).toBe('https://b.test');
  });
});
