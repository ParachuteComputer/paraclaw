import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/paraclaw-test-auto-detect' };
});

const TEST_DIR = '/tmp/paraclaw-test-auto-detect';

describe('autoDetectClaudeCodeOAuth', () => {
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

  it('returns "no-host-file" when host has no OAuth file', async () => {
    const hostMod = await import('./host-claude-code.js');
    vi.spyOn(hostMod, 'readClaudeCodeOAuth').mockReturnValue(null);

    const { autoDetectClaudeCodeOAuth } = await import('./auto-detect.js');
    expect(autoDetectClaudeCodeOAuth()).toBe('no-host-file');

    const { readProviderCredentials } = await import('./db.js');
    expect(readProviderCredentials()).toBeFalsy();
  });

  it('returns "detected", stores the snapshot, and emits the audit line when host file is present and no row exists', async () => {
    const hostMod = await import('./host-claude-code.js');
    vi.spyOn(hostMod, 'readClaudeCodeOAuth').mockReturnValue('{"oauth":"snapshot"}');

    const { log } = await import('../../log.js');
    const infoSpy = vi.spyOn(log, 'info').mockImplementation(() => {});

    const { autoDetectClaudeCodeOAuth } = await import('./auto-detect.js');
    expect(autoDetectClaudeCodeOAuth()).toBe('detected');

    const { readProviderCredentials } = await import('./db.js');
    const row = readProviderCredentials();
    expect(row?.source).toBe('claude_code_oauth');
    expect(row?.credentialsJson).toBe('{"oauth":"snapshot"}');

    const auditCalls = infoSpy.mock.calls.filter(
      (c) => (c[1] as { audit?: string } | undefined)?.audit === 'agent_provider_source_changed',
    );
    expect(auditCalls).toHaveLength(1);
    const [, payload] = auditCalls[0]!;
    expect(payload).toMatchObject({
      audit: 'agent_provider_source_changed',
      fromSource: null,
      toSource: 'claude_code_oauth',
      actor: 'auto-detect',
    });
  });

  it('returns "already-configured" and never overwrites when a row already exists', async () => {
    const { putProviderCredentials, readProviderCredentials } = await import('./db.js');
    putProviderCredentials({ source: 'anthropic_api_key', apiKey: 'pre-existing' });

    const hostMod = await import('./host-claude-code.js');
    vi.spyOn(hostMod, 'readClaudeCodeOAuth').mockReturnValue('{"oauth":"snapshot"}');

    const { autoDetectClaudeCodeOAuth } = await import('./auto-detect.js');
    expect(autoDetectClaudeCodeOAuth()).toBe('already-configured');

    const row = readProviderCredentials();
    expect(row?.source).toBe('anthropic_api_key');
    expect(row?.apiKey).toBe('pre-existing');
    expect(row?.credentialsJson).toBeNull();
  });
});
