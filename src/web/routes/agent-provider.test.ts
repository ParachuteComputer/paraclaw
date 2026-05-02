/**
 * Tests for the `/api/settings/agent-provider` route helpers.
 * Exercises `readAgentProviderView` and `setAgentProvider` against
 * a real in-memory DB so the encrypted upsert + audit log + view
 * shape stay in sync end-to-end.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-agent-provider-route' };
});

const TEST_DIR = '/tmp/paraclaw-test-agent-provider-route';

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

describe('readAgentProviderView', () => {
  it('returns a fresh-install view with everything null/false when no row exists', async () => {
    const { readAgentProviderView } = await import('./agent-provider.js');
    expect(readAgentProviderView()).toEqual({
      source: null,
      hasApiKey: false,
      serverUrl: null,
      updatedAt: null,
    });
  });

  it('exposes only booleans for stored secrets — never the plaintext', async () => {
    const { putProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    putProviderCredentials({
      source: 'anthropic_api_key',
      apiKey: 'sk-ant-api03-secret-do-not-leak',
    });

    const { readAgentProviderView } = await import('./agent-provider.js');
    const view = readAgentProviderView();
    expect(view.source).toBe('anthropic_api_key');
    expect(view.hasApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-ant-api03-secret-do-not-leak');
  });

  it('exposes setup-token presence as hasApiKey: true (single secret slot)', async () => {
    const { putProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    putProviderCredentials({ source: 'claude_setup_token', apiKey: 'sk-ant-oat01-secret' });

    const { readAgentProviderView } = await import('./agent-provider.js');
    const view = readAgentProviderView();
    expect(view.source).toBe('claude_setup_token');
    expect(view.hasApiKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-ant-oat01-secret');
  });
});

describe('setAgentProvider', () => {
  it('rejects unknown source with 400', async () => {
    const { setAgentProvider } = await import('./agent-provider.js');
    const result = setAgentProvider({ source: 'something-else' as never }, 'telegram:1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.message).toContain('source must be one of');
    }
  });

  it('claude_setup_token → requires apiKey, then stores it (trimmed)', async () => {
    const { setAgentProvider } = await import('./agent-provider.js');

    const missing = setAgentProvider({ source: 'claude_setup_token' }, 'telegram:1');
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.status).toBe(400);
      expect(missing.message).toContain('apiKey is required');
    }

    const ok = setAgentProvider({ source: 'claude_setup_token', apiKey: '  sk-ant-oat01-paste  ' }, 'telegram:1');
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.view.source).toBe('claude_setup_token');
      expect(ok.view.hasApiKey).toBe(true);
    }

    const { readProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    expect(readProviderCredentials()?.apiKey).toBe('sk-ant-oat01-paste');
  });

  it('anthropic_api_key → requires apiKey, then stores it', async () => {
    const { setAgentProvider } = await import('./agent-provider.js');
    const missing = setAgentProvider({ source: 'anthropic_api_key' }, 'telegram:1');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.status).toBe(400);

    const ok = setAgentProvider({ source: 'anthropic_api_key', apiKey: '  sk-ant-test  ' }, 'telegram:1');
    expect(ok.ok).toBe(true);

    const { readProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    expect(readProviderCredentials()?.apiKey).toBe('sk-ant-test');
  });

  it('external_server → requires apiKey + valid serverUrl', async () => {
    const { setAgentProvider } = await import('./agent-provider.js');

    const noKey = setAgentProvider(
      { source: 'external_server', serverUrl: 'https://openrouter.ai/api/v1' },
      'telegram:1',
    );
    expect(noKey.ok).toBe(false);

    const noUrl = setAgentProvider({ source: 'external_server', apiKey: 'k' }, 'telegram:1');
    expect(noUrl.ok).toBe(false);

    const badUrl = setAgentProvider({ source: 'external_server', apiKey: 'k', serverUrl: 'not a url' }, 'telegram:1');
    expect(badUrl.ok).toBe(false);
    if (!badUrl.ok) expect(badUrl.message).toContain('valid URL');

    const ok = setAgentProvider(
      { source: 'external_server', apiKey: 'or-key', serverUrl: 'https://openrouter.ai/api/v1' },
      'telegram:1',
    );
    expect(ok.ok).toBe(true);

    const { readProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    const row = readProviderCredentials();
    expect(row?.apiKey).toBe('or-key');
    expect(row?.serverUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('emits agent_provider_source_changed audit on every successful change', async () => {
    const { log } = await import('../../log.js');
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

    const { setAgentProvider } = await import('./agent-provider.js');
    const ok = setAgentProvider({ source: 'claude_setup_token', apiKey: 'sk-ant-oat01-x' }, 'telegram:42');
    expect(ok.ok).toBe(true);

    const auditCalls = infoSpy.mock.calls.filter(
      (c) => (c[1] as { audit?: string } | undefined)?.audit === 'agent_provider_source_changed',
    );
    expect(auditCalls).toHaveLength(1);
    const [, payload] = auditCalls[0]!;
    expect(payload).toMatchObject({
      audit: 'agent_provider_source_changed',
      fromSource: null,
      toSource: 'claude_setup_token',
      actor: 'telegram:42',
    });
    expect(payload).toHaveProperty('hasServerUrl');
  });

  it('switching sources clears the previous source-specific fields', async () => {
    const { setAgentProvider } = await import('./agent-provider.js');
    setAgentProvider(
      { source: 'external_server', apiKey: 'or-key', serverUrl: 'https://openrouter.ai/api/v1' },
      'telegram:1',
    );

    setAgentProvider({ source: 'claude_setup_token', apiKey: 'sk-ant-oat01-new' }, 'telegram:1');

    const { readProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    const row = readProviderCredentials();
    expect(row?.source).toBe('claude_setup_token');
    expect(row?.apiKey).toBe('sk-ant-oat01-new');
    expect(row?.serverUrl).toBeNull();
  });
});
