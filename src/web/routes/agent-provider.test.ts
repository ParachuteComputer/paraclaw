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
    const { putProviderCredentials, DEFAULT_SCOPE_ID } = await import('../../modules/provider-credentials/db.js');
    putProviderCredentials({
      scopeId: DEFAULT_SCOPE_ID,
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
    const { putProviderCredentials, DEFAULT_SCOPE_ID } = await import('../../modules/provider-credentials/db.js');
    putProviderCredentials({ scopeId: DEFAULT_SCOPE_ID, source: 'claude_setup_token', apiKey: 'sk-ant-oat01-secret' });

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

describe('per-group agent provider (paraclaw#86)', () => {
  it('readGroupAgentProviderView reports unoverridden + effective from default', async () => {
    const { putProviderCredentials, DEFAULT_SCOPE_ID } = await import('../../modules/provider-credentials/db.js');
    putProviderCredentials({ scopeId: DEFAULT_SCOPE_ID, source: 'anthropic_api_key', apiKey: 'install-default-key' });

    const { readGroupAgentProviderView } = await import('./agent-provider.js');
    const view = readGroupAgentProviderView('ag-no-override');
    expect(view.overridden).toBe(false);
    expect(view.override.source).toBeNull();
    expect(view.override.hasApiKey).toBe(false);
    expect(view.effective.source).toBe('anthropic_api_key');
    expect(view.effective.hasApiKey).toBe(true);
  });

  it('setGroupAgentProvider stores under the group id, not the default sentinel', async () => {
    const { setGroupAgentProvider } = await import('./agent-provider.js');
    const result = setGroupAgentProvider(
      { source: 'claude_setup_token', apiKey: '  sk-ant-oat01-group  ' },
      'ag-special',
      'telegram:7',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.overridden).toBe(true);
    expect(result.view.override.source).toBe('claude_setup_token');
    expect(result.view.override.hasApiKey).toBe(true);
    expect(result.view.effective.source).toBe('claude_setup_token');

    const { readProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    const groupRow = readProviderCredentials('ag-special');
    expect(groupRow?.apiKey).toBe('sk-ant-oat01-group');
    const defaultRow = readProviderCredentials();
    expect(defaultRow).toBeUndefined();
  });

  it('per-group audit emits agentGroupId and never the secret', async () => {
    const { log } = await import('../../log.js');
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

    const { setGroupAgentProvider } = await import('./agent-provider.js');
    const ok = setGroupAgentProvider(
      { source: 'external_server', apiKey: 'or-key', serverUrl: 'https://openrouter.ai/api/v1' },
      'ag-9',
      'telegram:9',
    );
    expect(ok.ok).toBe(true);

    const auditCalls = infoSpy.mock.calls.filter(
      (c) => (c[1] as { audit?: string } | undefined)?.audit === 'agent_provider_source_changed',
    );
    expect(auditCalls).toHaveLength(1);
    const [, payload] = auditCalls[0]!;
    expect(payload).toMatchObject({
      audit: 'agent_provider_source_changed',
      agentGroupId: 'ag-9',
      toSource: 'external_server',
      actor: 'telegram:9',
    });
    expect(JSON.stringify(payload)).not.toContain('or-key');
  });

  it('clearGroupAgentProvider deletes the override row + emits override_cleared audit', async () => {
    const { putProviderCredentials, DEFAULT_SCOPE_ID } = await import('../../modules/provider-credentials/db.js');
    putProviderCredentials({ scopeId: DEFAULT_SCOPE_ID, source: 'anthropic_api_key', apiKey: 'install-default-key' });
    putProviderCredentials({ scopeId: 'ag-x', source: 'claude_setup_token', apiKey: 'sk-ant-oat01-x' });

    const { log } = await import('../../log.js');
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

    const { clearGroupAgentProvider } = await import('./agent-provider.js');
    const result = clearGroupAgentProvider('ag-x', 'telegram:1');
    expect(result.cleared).toBe(true);
    expect(result.view.overridden).toBe(false);
    expect(result.view.effective.source).toBe('anthropic_api_key');

    const { readProviderCredentials } = await import('../../modules/provider-credentials/db.js');
    expect(readProviderCredentials('ag-x')).toBeUndefined();

    const auditCalls = infoSpy.mock.calls.filter(
      (c) => (c[1] as { audit?: string } | undefined)?.audit === 'agent_provider_override_cleared',
    );
    expect(auditCalls).toHaveLength(1);
    expect(auditCalls[0]![1]).toMatchObject({
      audit: 'agent_provider_override_cleared',
      agentGroupId: 'ag-x',
      fromSource: 'claude_setup_token',
      actor: 'telegram:1',
    });
  });

  it('clearGroupAgentProvider on unset row is idempotent — no audit, cleared:false', async () => {
    const { log } = await import('../../log.js');
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

    const { clearGroupAgentProvider } = await import('./agent-provider.js');
    const result = clearGroupAgentProvider('ag-nope', 'telegram:1');
    expect(result.cleared).toBe(false);
    const auditCalls = infoSpy.mock.calls.filter(
      (c) => (c[1] as { audit?: string } | undefined)?.audit === 'agent_provider_override_cleared',
    );
    expect(auditCalls).toHaveLength(0);
  });
});
