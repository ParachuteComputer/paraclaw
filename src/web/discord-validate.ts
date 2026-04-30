/**
 * Validate a Discord bot token by calling Discord's `/users/@me`.
 *
 * The setup wizard captures a bot token from the operator and needs to verify
 * three things before persisting it: the token authenticates, the account is
 * a bot, and we know the bot's user id (which becomes the basis of
 * `discord:@me:<userId>` for the proactive DM-channel wiring).
 *
 * Discord returns 401 for an invalid token; on 200 the body contains
 * `{ id, username, discriminator?, bot, ... }` per the v10 reference. We do
 * not require any extra OAuth scopes — bot tokens carry implicit identity.
 *
 * The fetch is injectable for tests; in production it shells through the
 * default global `fetch`. Errors are returned, not thrown — the caller
 * surfaces them as 4xx to the wizard step UI.
 */
const DISCORD_API = 'https://discord.com/api/v10';

export interface DiscordIdentity {
  id: string;
  username: string;
  discriminator: string | null;
  bot: boolean;
}

export type DiscordValidateResult =
  | { ok: true; identity: DiscordIdentity }
  | { ok: false; status: number; error: string };

interface DiscordUserBody {
  id?: unknown;
  username?: unknown;
  discriminator?: unknown;
  bot?: unknown;
}

export async function validateDiscordBotToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscordValidateResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, status: 400, error: 'token is empty' };

  let res: Response;
  try {
    res = await fetchImpl(`${DISCORD_API}/users/@me`, {
      headers: {
        Authorization: `Bot ${trimmed}`,
        Accept: 'application/json',
      },
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `discord unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status === 401) {
    return { ok: false, status: 401, error: 'discord rejected token (401 Unauthorized)' };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: `discord ${res.status} ${res.statusText}`,
    };
  }

  const body = (await res.json()) as DiscordUserBody;
  if (typeof body.id !== 'string' || typeof body.username !== 'string') {
    return { ok: false, status: 502, error: 'discord returned malformed user body' };
  }
  if (body.bot !== true) {
    return { ok: false, status: 400, error: 'token is not a bot token (user.bot=false)' };
  }

  return {
    ok: true,
    identity: {
      id: body.id,
      username: body.username,
      discriminator: typeof body.discriminator === 'string' ? body.discriminator : null,
      bot: true,
    },
  };
}
