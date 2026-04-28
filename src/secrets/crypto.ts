/**
 * AES-256-GCM encryption for secret values.
 *
 * Wire format (base64-encoded):
 *   12-byte IV || ciphertext || 16-byte auth tag
 *
 * Each call generates a fresh random IV — never reuse an IV with the same
 * key (catastrophic for GCM). The auth tag is appended so decryption fails
 * loudly on tampering.
 *
 * Domain separation: encryptSecret/decryptSecret accept a 32-byte key. Callers
 * MUST NOT pass the raw master key — they pass a per-domain HKDF derivation
 * (see `deriveKey` below). That way if a future subsystem (e.g. an outbox
 * cookie signer) needs symmetric crypto from the same master, its key is
 * cryptographically separated and a bug in one domain can't decrypt the other.
 */
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;

/**
 * HKDF-SHA256 with an empty salt and a domain-specific `info` string. The
 * empty salt is fine — the master key is already 256 bits of CSPRNG output,
 * so HKDF degenerates to HKDF-Expand and the domain-tag in `info` does the
 * real work. Use `paraclaw.<subsystem>.v<n>`; bumping `v` is a key rotation
 * for that subsystem only.
 */
export function deriveKey(masterKey: Buffer, info: string): Buffer {
  if (masterKey.length !== KEY_LEN) {
    throw new Error(`master key must be ${KEY_LEN} bytes, got ${masterKey.length}`);
  }
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), info, KEY_LEN));
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString('base64');
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const buf = Buffer.from(encoded, 'base64');
  if (buf.length < IV_LEN + TAG_LEN) throw new Error('ciphertext too short');
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
