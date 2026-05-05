/**
 * Three domain-separated HKDF-derived keys for OAuth secrets:
 *
 *   - paraclaw.oauth.client.v1   → app_configs.client_secret_encrypted
 *   - paraclaw.oauth.access.v1   → app_connections.access_token_encrypted
 *   - paraclaw.oauth.refresh.v1  → app_connections.refresh_token_encrypted
 *
 * Three subkeys instead of one because compromise of one rotation surface
 * (e.g. refresh tokens accidentally surfaced in a log) shouldn't yield
 * decryption power on the others. Bumping any `v<n>` suffix is a
 * per-domain key rotation.
 *
 * ⚠ The `paraclaw.` prefix is a cryptographic domain separator and is
 * intentionally retained across the paraclaw → parachute-agent rename.
 * The HKDF info string is mixed into key derivation; renaming it would
 * derive a different key and render every existing OAuth ciphertext row
 * (client secrets, access tokens, refresh tokens) undecryptable. The
 * brand sweep is operator-visible only — these bytes are forever.
 */
import { deriveKey, encryptSecret, decryptSecret } from '../secrets/crypto.js';
import { loadOrCreateMasterKey } from '../secrets/master-key.js';

const CLIENT_INFO = 'paraclaw.oauth.client.v1';
const ACCESS_INFO = 'paraclaw.oauth.access.v1';
const REFRESH_INFO = 'paraclaw.oauth.refresh.v1';

function clientKey(): Buffer {
  return deriveKey(loadOrCreateMasterKey(), CLIENT_INFO);
}
function accessKey(): Buffer {
  return deriveKey(loadOrCreateMasterKey(), ACCESS_INFO);
}
function refreshKey(): Buffer {
  return deriveKey(loadOrCreateMasterKey(), REFRESH_INFO);
}

export function encryptOauthClient(plaintext: string): string {
  return encryptSecret(plaintext, clientKey());
}
export function decryptOauthClient(ciphertext: string): string {
  return decryptSecret(ciphertext, clientKey());
}

export function encryptOauthAccess(plaintext: string): string {
  return encryptSecret(plaintext, accessKey());
}
export function decryptOauthAccess(ciphertext: string): string {
  return decryptSecret(ciphertext, accessKey());
}

export function encryptOauthRefresh(plaintext: string): string {
  return encryptSecret(plaintext, refreshKey());
}
export function decryptOauthRefresh(ciphertext: string): string {
  return decryptSecret(ciphertext, refreshKey());
}
