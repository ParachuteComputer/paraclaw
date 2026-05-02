/**
 * Resolve the credentials the host should hand the agent container at
 * spawn time. The container-runner calls `getProviderCredentialsForSpawn`
 * once per spawn and acts on the returned envelope:
 *
 *   - `env`: extra `-e KEY=VALUE` pairs to add to the container args.
 *   - `files`: file-content pairs to write into the per-group `.claude-shared`
 *              dir so they appear inside the container under `/home/node/.claude`.
 *   - `suppressSecretEnvKeys`: paraclaw secrets named here are dropped from
 *              the spawn's secret bag — used so a residual `ANTHROPIC_API_KEY`
 *              secret can't override the operator's chosen `claude_code_oauth`
 *              source. Documented in the settings page.
 *
 * Source-specific behavior:
 *   - claude_code_oauth: re-read host `~/.claude/.credentials.json`; on miss,
 *     fall back to last-stored encrypted copy in the row. Emit warning when
 *     falling back. Resulting JSON lands in `files['.credentials.json']`.
 *   - anthropic_api_key: env `ANTHROPIC_API_KEY=<plaintext>`.
 *   - external_server: env `ANTHROPIC_API_KEY=<plaintext>` + `ANTHROPIC_BASE_URL=<server_url>`.
 *
 * Phase 1 only consults the install-default scope (`__default__`). Phase 2
 * will check the agent_group_id row first and fall back to default.
 */
import { log } from '../../log.js';
import { DEFAULT_SCOPE_ID, readProviderCredentials, type ProviderSource } from './db.js';
import { readClaudeCodeOAuth } from './host-claude-code.js';

export interface ProviderSpawnEnvelope {
  /** Source we resolved. `null` means no row + no auto-fallback — caller emits a warning. */
  source: ProviderSource | null;
  env: Record<string, string>;
  /** Filename → contents. Filenames are joined under the per-group `.claude-shared/` dir. */
  files: Record<string, string>;
  /** Paraclaw-secret env-var names to suppress for this spawn. */
  suppressSecretEnvKeys: Set<string>;
}

/**
 * Resolve the spawn envelope for an agent group. `agentGroupId` is the
 * recipient — Phase 1 ignores it and reads the default scope. Pure of
 * filesystem writes; the container-runner is the one that lays down
 * `files` on disk and threads `env` into spawn args.
 */
export function getProviderCredentialsForSpawn(_agentGroupId: string): ProviderSpawnEnvelope {
  const empty: ProviderSpawnEnvelope = {
    source: null,
    env: {},
    files: {},
    suppressSecretEnvKeys: new Set(),
  };

  const row = readProviderCredentials(DEFAULT_SCOPE_ID);
  if (!row) return empty;

  switch (row.source) {
    case 'claude_code_oauth': {
      // Always prefer the live host file — it carries refreshed tokens.
      // Fall back to the last-stored encrypted snapshot when the host
      // file is missing or unreadable (cloud / file-deleted scenarios).
      const live = readClaudeCodeOAuth();
      const credentials = live ?? row.credentialsJson;
      if (!credentials) {
        log.warn('claude_code_oauth selected but no credentials available (host file + stored copy both empty)', {
          agentGroupId: _agentGroupId,
        });
        return { ...empty, source: 'claude_code_oauth' };
      }
      if (!live) {
        log.warn('Falling back to stored .credentials.json — host file unreadable', {
          agentGroupId: _agentGroupId,
        });
      }
      return {
        source: 'claude_code_oauth',
        env: {},
        files: { '.credentials.json': credentials },
        // Documented precedence: when the operator picks OAuth, residual
        // ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN secrets in paraclaw
        // would otherwise win in Claude Code SDK (it prefers env over
        // OAuth). Suppress them so the chosen source actually applies.
        suppressSecretEnvKeys: new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']),
      };
    }
    case 'anthropic_api_key': {
      if (!row.apiKey) {
        log.warn('anthropic_api_key selected but no key stored', { agentGroupId: _agentGroupId });
        return { ...empty, source: 'anthropic_api_key' };
      }
      return {
        source: 'anthropic_api_key',
        env: { ANTHROPIC_API_KEY: row.apiKey },
        files: {},
        suppressSecretEnvKeys: new Set(),
      };
    }
    case 'external_server': {
      if (!row.apiKey || !row.serverUrl) {
        log.warn('external_server selected but key or url missing', {
          agentGroupId: _agentGroupId,
          hasKey: row.apiKey != null,
          hasUrl: row.serverUrl != null,
        });
        return { ...empty, source: 'external_server' };
      }
      return {
        source: 'external_server',
        env: { ANTHROPIC_API_KEY: row.apiKey, ANTHROPIC_BASE_URL: row.serverUrl },
        files: {},
        suppressSecretEnvKeys: new Set(),
      };
    }
  }
}
