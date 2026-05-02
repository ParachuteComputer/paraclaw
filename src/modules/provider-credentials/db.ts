/**
 * `provider_credentials` row helpers.
 *
 * The PK column doubles as a sentinel slot — id `'__default__'` is the
 * install-wide row; Phase 2 will add real `agent_group_id` rows alongside.
 *
 * Encryption: `api_key_encrypted` is AES-GCM ciphertext (HKDF-derived
 * key, info `paraclaw.provider-credentials.v1`). Plaintext only crosses
 * this module's boundary at put/get time.
 */
import { getDb } from '../../db/connection.js';
import { decryptSecret, deriveKey, encryptSecret } from '../../secrets/crypto.js';
import { loadOrCreateMasterKey } from '../../secrets/master-key.js';

export const DEFAULT_SCOPE_ID = '__default__';
const PROVIDER_CREDS_INFO = 'paraclaw.provider-credentials.v1';

export type ProviderSource = 'claude_setup_token' | 'anthropic_api_key' | 'external_server';

export interface ProviderCredentialsRow {
  agent_group_id: string;
  source: ProviderSource;
  api_key_encrypted: string | null;
  server_url: string | null;
  updated_at: string;
}

export interface ProviderCredentialsPlaintext {
  agent_group_id: string;
  source: ProviderSource;
  /**
   * Plaintext secret. For `claude_setup_token` this is the OAuth token
   * (`sk-ant-oat01-...`). For `anthropic_api_key` and `external_server`
   * it's the API key. Null when unset.
   */
  apiKey: string | null;
  serverUrl: string | null;
  updatedAt: string;
}

function key(): Buffer {
  return deriveKey(loadOrCreateMasterKey(), PROVIDER_CREDS_INFO);
}

export function getProviderCredentialsRow(scopeId: string = DEFAULT_SCOPE_ID): ProviderCredentialsRow | undefined {
  return getDb()
    .prepare<ProviderCredentialsRow>('SELECT * FROM provider_credentials WHERE agent_group_id = ?')
    .get(scopeId);
}

export function readProviderCredentials(scopeId: string = DEFAULT_SCOPE_ID): ProviderCredentialsPlaintext | undefined {
  const row = getProviderCredentialsRow(scopeId);
  if (!row) return undefined;
  const k = key();
  return {
    agent_group_id: row.agent_group_id,
    source: row.source,
    apiKey: row.api_key_encrypted ? decryptSecret(row.api_key_encrypted, k) : null,
    serverUrl: row.server_url,
    updatedAt: row.updated_at,
  };
}

export interface PutProviderCredentialsInput {
  scopeId?: string;
  source: ProviderSource;
  apiKey?: string | null;
  serverUrl?: string | null;
}

/**
 * Upsert the row for the given scope. Plaintext fields are encrypted
 * here. Pass `null` to clear a field; pass `undefined` to leave it
 * unchanged (caller-side merge — we read-modify-write).
 */
export function putProviderCredentials(input: PutProviderCredentialsInput): void {
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;
  const existing = getProviderCredentialsRow(scopeId);
  const k = key();
  const api_key_encrypted =
    input.apiKey === undefined
      ? (existing?.api_key_encrypted ?? null)
      : input.apiKey === null
        ? null
        : encryptSecret(input.apiKey, k);
  const server_url = input.serverUrl === undefined ? (existing?.server_url ?? null) : input.serverUrl;
  const updated_at = new Date().toISOString();

  getDb()
    .prepare(
      `INSERT INTO provider_credentials
         (agent_group_id, source, api_key_encrypted, server_url, updated_at)
       VALUES
         (@agent_group_id, @source, @api_key_encrypted, @server_url, @updated_at)
       ON CONFLICT (agent_group_id) DO UPDATE SET
         source = excluded.source,
         api_key_encrypted = excluded.api_key_encrypted,
         server_url = excluded.server_url,
         updated_at = excluded.updated_at`,
    )
    .run({
      agent_group_id: scopeId,
      source: input.source,
      api_key_encrypted,
      server_url,
      updated_at,
    });
}

export function deleteProviderCredentials(scopeId: string = DEFAULT_SCOPE_ID): boolean {
  const r = getDb().prepare('DELETE FROM provider_credentials WHERE agent_group_id = ?').run(scopeId);
  return r.changes > 0;
}
