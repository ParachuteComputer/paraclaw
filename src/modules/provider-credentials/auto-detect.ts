/**
 * One-shot auto-detect: at wire time, if the install has no
 * `provider_credentials` row yet AND the host has a Claude Code OAuth
 * file on disk, snapshot the file as the install-wide source.
 *
 * The intent is to make the common case zero-config: an operator who
 * already ran `claude login` on the host gets a working agent on first
 * wire without touching the settings page.
 *
 * Idempotent — once a row exists (any source), we never overwrite it.
 * The settings page is the only path that changes an existing source.
 */
import { log } from '../../log.js';

import { DEFAULT_SCOPE_ID, putProviderCredentials, readProviderCredentials } from './db.js';
import { readClaudeCodeOAuth } from './host-claude-code.js';

export type AutoDetectOutcome = 'detected' | 'already-configured' | 'no-host-file';

export function autoDetectClaudeCodeOAuth(): AutoDetectOutcome {
  const existing = readProviderCredentials(DEFAULT_SCOPE_ID);
  if (existing) return 'already-configured';

  const live = readClaudeCodeOAuth();
  if (!live) return 'no-host-file';

  putProviderCredentials({
    source: 'claude_code_oauth',
    credentialsJson: live,
    apiKey: null,
    serverUrl: null,
  });
  log.info('Agent-provider auto-detected from Claude Code OAuth', {
    audit: 'agent_provider_source_changed',
    fromSource: null,
    toSource: 'claude_code_oauth',
    actor: 'auto-detect',
    hasServerUrl: false,
  });
  return 'detected';
}
