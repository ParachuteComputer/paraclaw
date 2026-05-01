/**
 * Discord token validator covers the four outcomes the wizard cares about:
 *   1. Valid bot token → identity returned.
 *   2. 401 from Discord → friendly "rejected token" error.
 *   3. 200 from Discord but `bot=false` → reject (we require bots).
 *   4. Network error → 502 surfacing the underlying message.
 */
import { describe, expect, it, vi } from 'vitest';

import { validateDiscordBotToken } from './discord-validate.js';

function makeFetchStub(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 401);
  return vi.fn().mockResolvedValue({
    ok,
    status,
    statusText: ok ? 'OK' : 'Unauthorized',
    json: async () => body,
  } as Response) as unknown as typeof fetch;
}

describe('validateDiscordBotToken', () => {
  it('returns identity for a valid bot token', async () => {
    const stub = makeFetchStub({ id: '1491573333382523708', username: 'parabot', discriminator: '0', bot: true });
    const result = await validateDiscordBotToken('test-token', stub);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity.id).toBe('1491573333382523708');
      expect(result.identity.username).toBe('parabot');
      expect(result.identity.bot).toBe(true);
    }
    expect(stub).toHaveBeenCalledWith(
      'https://discord.com/api/v10/users/@me',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bot test-token' }),
      }),
    );
  });

  it('rejects 401 from Discord with an actionable message', async () => {
    const stub = makeFetchStub({}, { ok: false, status: 401 });
    const result = await validateDiscordBotToken('bad', stub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toMatch(/discord rejected/i);
    }
  });

  it('rejects user tokens (bot=false)', async () => {
    const stub = makeFetchStub({ id: '123', username: 'human', bot: false });
    const result = await validateDiscordBotToken('user-token', stub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toMatch(/not a bot/i);
    }
  });

  it('returns 502 on network error', async () => {
    const stub = vi.fn().mockRejectedValue(new Error('ENOTFOUND')) as unknown as typeof fetch;
    const result = await validateDiscordBotToken('whatever', stub);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toMatch(/ENOTFOUND/);
    }
  });

  it('rejects empty token without calling Discord', async () => {
    const stub = vi.fn();
    const result = await validateDiscordBotToken('   ', stub as unknown as typeof fetch);
    expect(result.ok).toBe(false);
    expect(stub).not.toHaveBeenCalled();
  });
});
