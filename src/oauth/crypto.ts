/**
 * Domain-separated key for the OAuth subsystem. Same master key as the
 * secrets store; different HKDF info string so a bug in the secrets
 * subsystem can't decrypt OAuth tokens (and vice versa).
 *
 * Bumping `paraclaw.oauth.v1` → `v2` would force re-encryption of every
 * `client_secret_encrypted`, `access_token_encrypted`, and
 * `refresh_token_encrypted` row. Treat the version as a key-rotation
 * trigger, not casual versioning.
 */
import { deriveKey, encryptSecret, decryptSecret } from '../secrets/crypto.js';
import { loadOrCreateMasterKey } from '../secrets/master-key.js';

const OAUTH_INFO = 'paraclaw.oauth.v1';

function oauthKey(): Buffer {
  return deriveKey(loadOrCreateMasterKey(), OAUTH_INFO);
}

export function encryptOauth(plaintext: string): string {
  return encryptSecret(plaintext, oauthKey());
}

export function decryptOauth(ciphertext: string): string {
  return decryptSecret(ciphertext, oauthKey());
}
