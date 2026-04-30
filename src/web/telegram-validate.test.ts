/**
 * Token validation paths for Telegram. Mirror of discord-validate.test.ts so
 * the same wizard surface can render either result with one error shape.
 */
import { describe, expect, it } from 'vitest';

import { validateTelegramBotToken } from './telegram-validate.js';

const VALID_TOKEN = '1234567890:ABCdefGhIJklmnopQRsTUvwxyz0123456789';

function fakeFetch(impl: (url: string) => { status?: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const { status = 200, body } = impl(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('validateTelegramBotToken', () => {
  it('rejects an empty token without fetching', async () => {
    const result = await validateTelegramBotToken(
      '   ',
      (() => {
        throw new Error('fetch should not be called');
      }) as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/empty/);
    }
  });

  it('rejects a malformed token shape without fetching', async () => {
    const result = await validateTelegramBotToken(
      'not-a-real-token',
      (() => {
        throw new Error('fetch should not be called');
      }) as unknown as typeof fetch,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/format invalid/);
    }
  });

  it('returns identity on success', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: {
        ok: true,
        result: { id: 6037840640, username: 'andy_bot', first_name: 'Andy', is_bot: true },
      },
    }));
    const result = await validateTelegramBotToken(VALID_TOKEN, fetchImpl);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.id).toBe(6037840640);
      expect(result.identity.username).toBe('andy_bot');
      expect(result.identity.firstName).toBe('Andy');
      expect(result.identity.isBot).toBe(true);
    }
  });

  it('rejects when telegram returns ok:false', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 401,
      body: { ok: false, error_code: 401, description: 'Unauthorized' },
    }));
    const result = await validateTelegramBotToken(VALID_TOKEN, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/rejected token/i);
    }
  });

  it('rejects a non-bot account', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: {
        ok: true,
        result: { id: 1, username: 'human', first_name: 'Real Person', is_bot: false },
      },
    }));
    const result = await validateTelegramBotToken(VALID_TOKEN, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/not a bot/i);
    }
  });

  it('returns 502 when telegram is unreachable', async () => {
    const fetchImpl = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    const result = await validateTelegramBotToken(VALID_TOKEN, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/unreachable/);
    }
  });

  it('returns 502 on malformed result body', async () => {
    const fetchImpl = fakeFetch(() => ({
      status: 200,
      body: { ok: true, result: {} },
    }));
    const result = await validateTelegramBotToken(VALID_TOKEN, fetchImpl);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/malformed/);
    }
  });
});
