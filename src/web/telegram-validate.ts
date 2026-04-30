/**
 * Validate a Telegram bot token by calling Telegram's `/getMe`.
 *
 * The setup wizard captures a bot token from the operator and needs to verify
 * three things before persisting it: the token authenticates, the account is
 * a bot (`is_bot=true`), and we know the bot's @username for the wizard's
 * "now go DM @<username>" instruction in the test-message step.
 *
 * Telegram returns `{ ok: true, result: { id, username, first_name, is_bot, ... } }`
 * on success; on auth failure the body is `{ ok: false, error_code: 401, description }`.
 * Network failures bubble up as 502 with a clear unreachable message — same
 * shape as discord-validate.ts so the wizard can render either with one
 * surface.
 *
 * We also enforce the BotFather token shape (`<digits>:<35+ chars>`) before
 * calling out: a clearly malformed token wastes a network round-trip and
 * Telegram's 401 response is less useful than a local "token format invalid".
 *
 * The fetch is injectable for tests; in production it shells through the
 * default global `fetch`.
 */
const TELEGRAM_API = 'https://api.telegram.org';
const TOKEN_SHAPE = /^[0-9]+:[A-Za-z0-9_-]{35,}$/;

export interface TelegramIdentity {
  id: number;
  username: string;
  firstName: string;
  isBot: boolean;
}

export type TelegramValidateResult =
  | { ok: true; identity: TelegramIdentity }
  | { ok: false; status: number; error: string };

interface TelegramGetMeBody {
  ok?: unknown;
  result?: {
    id?: unknown;
    username?: unknown;
    first_name?: unknown;
    is_bot?: unknown;
  };
  description?: unknown;
}

export async function validateTelegramBotToken(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramValidateResult> {
  const trimmed = token.trim();
  if (!trimmed) return { ok: false, status: 400, error: 'token is empty' };
  if (!TOKEN_SHAPE.test(trimmed)) {
    return {
      ok: false,
      status: 400,
      error: 'token format invalid (expected <digits>:<35+ chars>, e.g. 123456:ABCdef…)',
    };
  }

  let res: Response;
  try {
    res = await fetchImpl(`${TELEGRAM_API}/bot${trimmed}/getMe`, {
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `telegram unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Telegram returns 401/404 for bad tokens but always with a JSON body.
  // Parse first, then decide.
  let body: TelegramGetMeBody;
  try {
    body = (await res.json()) as TelegramGetMeBody;
  } catch {
    return { ok: false, status: 502, error: `telegram returned non-JSON body (HTTP ${res.status})` };
  }

  if (body.ok !== true) {
    const desc = typeof body.description === 'string' ? body.description : `HTTP ${res.status}`;
    // 401 is the canonical "bad token" — surface as 401 for the wizard step.
    const status = res.status === 401 || res.status === 404 ? 401 : res.status || 400;
    return { ok: false, status, error: `telegram rejected token: ${desc}` };
  }

  const r = body.result;
  if (!r || typeof r.id !== 'number' || typeof r.username !== 'string' || typeof r.first_name !== 'string') {
    return { ok: false, status: 502, error: 'telegram returned malformed getMe body' };
  }
  if (r.is_bot !== true) {
    return { ok: false, status: 400, error: 'token is not a bot token (result.is_bot=false)' };
  }

  return {
    ok: true,
    identity: {
      id: r.id,
      username: r.username,
      firstName: r.first_name,
      isBot: true,
    },
  };
}
