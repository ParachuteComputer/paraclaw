import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from './crypto.js';

describe('secret crypto', () => {
  const key = crypto.randomBytes(32);

  it('round-trips a plaintext value', () => {
    const ct = encryptSecret('xoxb-1234-secret', key);
    expect(decryptSecret(ct, key)).toBe('xoxb-1234-secret');
  });

  it('produces a different ciphertext each call (random IV)', () => {
    const a = encryptSecret('same-value', key);
    const b = encryptSecret('same-value', key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe('same-value');
    expect(decryptSecret(b, key)).toBe('same-value');
  });

  it('rejects tampered ciphertext', () => {
    const ct = encryptSecret('original', key);
    const buf = Buffer.from(ct, 'base64');
    buf[buf.length - 1] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decryptSecret(tampered, key)).toThrow();
  });

  it('rejects ciphertext encrypted under a different key', () => {
    const otherKey = crypto.randomBytes(32);
    const ct = encryptSecret('only-original-key', key);
    expect(() => decryptSecret(ct, otherKey)).toThrow();
  });

  it('handles empty strings', () => {
    const ct = encryptSecret('', key);
    expect(decryptSecret(ct, key)).toBe('');
  });

  it('handles unicode', () => {
    const v = '🔐 résumé — 秘密';
    expect(decryptSecret(encryptSecret(v, key), key)).toBe(v);
  });
});
