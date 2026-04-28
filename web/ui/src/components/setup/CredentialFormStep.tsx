/**
 * Step 3 — Credential capture.
 *
 * Per-channel form, dispatched on `state.adapter`:
 *   - Discord  : bot token only. The bot's snowflake comes back from
 *     /channels/discord/test and is used directly to wire discord:@me:<id>.
 *   - Telegram : bot token + the OPERATOR's user id (from @userinfobot).
 *     The bot's getMe.id is NOT what we want here — Telegram routes DMs
 *     by chat_id (which equals the sender's user_id in DMs), so wiring is
 *     per-operator. The bot username is captured separately for the
 *     "DM @<botUsername>" copy on the test-message step.
 *
 * The token never reaches localStorage. We hold it in component state long
 * enough to validate (POST /channels/<adapter>/test) and submit (POST
 * /onecli/secrets), then drop it. Bot username + operatorUserId ARE
 * persisted (not secrets) so later steps can render copy + wire.
 *
 * Why we validate before submitting to OneCLI: a 401 from the chat API is
 * way easier to surface in this form ("token rejected") than as a
 * mysterious "first inbound never arrived" failure four steps later.
 */
import { useEffect, useState } from 'react';
import { listOnecliSecrets, putOnecliSecret, testDiscordToken, testTelegramToken } from '../../lib/api.ts';
import type { StepProps } from './types.ts';

const SECRET_NAME = {
  discord: 'DISCORD_TOKEN',
  telegram: 'TELEGRAM_BOT_TOKEN',
} as const;

type ExistingState =
  | { kind: 'unknown' }
  | { kind: 'present' }
  | { kind: 'absent' }
  | { kind: 'unreachable'; reason: string };

export function CredentialFormStep({ state, patchState, next, back }: StepProps) {
  const adapter = state.adapter;
  const [token, setToken] = useState('');
  const [operatorUserId, setOperatorUserId] = useState(state.operatorUserId ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<ExistingState>({ kind: 'unknown' });

  const secretName = adapter ? SECRET_NAME[adapter] : null;

  useEffect(() => {
    if (!secretName) return;
    let cancelled = false;
    setExisting({ kind: 'unknown' });
    listOnecliSecrets()
      .then((r) => {
        if (cancelled) return;
        const present = r.secrets.some((s) => s.name === secretName);
        setExisting({ kind: present ? 'present' : 'absent' });
      })
      .catch((err) => {
        if (cancelled) return;
        setExisting({ kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [secretName]);

  if (!adapter || !secretName) {
    return (
      <>
        <h3>Credentials</h3>
        <div className="error-banner">No channel selected — go back to step 2.</div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="secondary" onClick={back}>Back</button>
        </div>
      </>
    );
  }

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;
    if (adapter === 'telegram' && !operatorUserId.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      if (adapter === 'discord') {
        const validation = await testDiscordToken(token.trim());
        patchState({ botUserId: validation.identity.id, botUsername: validation.identity.username });
      } else {
        const validation = await testTelegramToken(token.trim());
        patchState({
          botUserId: String(validation.identity.id),
          botUsername: validation.identity.username,
          operatorUserId: operatorUserId.trim(),
        });
      }
      await putOnecliSecret(secretName, token.trim());
      setToken('');
      next();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <h3>{adapter === 'discord' ? 'Discord' : 'Telegram'} credentials</h3>
      <p className="muted">
        Paste your bot token. We validate it against {adapter === 'discord' ? 'Discord' : 'Telegram'}, then store it
        in OneCLI under <code>{secretName}</code>. The token is never written to your browser's storage.
      </p>
      {adapter === 'discord' ? (
        <p className="dim">
          Don't have a bot yet? Create one at{' '}
          <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">discord.com/developers/applications</a>
          {' '}— New Application → Bot → Copy token. Make sure <strong>Message Content Intent</strong> is enabled if you
          want the bot to read message bodies in servers; DMs work without it.
        </p>
      ) : (
        <p className="dim">
          Don't have a bot yet? Open Telegram → message{' '}
          <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>{' '}
          → <code>/newbot</code> → name + handle → copy the token (looks like
          <code> 123456789:ABCdef…</code>). Then message{' '}
          <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer">@userinfobot</a>{' '}
          to get YOUR user id (a number). Paste both below.
        </p>
      )}

      {existing.kind === 'present' && (
        <div className="empty empty-rich" style={{ marginTop: '0.75rem' }}>
          <p className="empty-headline" style={{ margin: 0 }}>OneCLI already has a <code>{secretName}</code>.</p>
          <p className="muted" style={{ marginTop: '0.4rem' }}>
            Paste a new token to replace it, or skip this step if it's already correct.
          </p>
        </div>
      )}
      {existing.kind === 'unreachable' && (
        <div className="error-banner" style={{ marginTop: '0.75rem' }}>
          Couldn't list OneCLI secrets: <code>{existing.reason}</code>.{' '}
          You can still paste a token below — submitting will surface the same error.
        </div>
      )}

      <form onSubmit={onSubmit}>
        <div className="row">
          <label htmlFor="botToken">Bot token</label>
          <input
            id="botToken"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={adapter === 'discord' ? 'MT…  (looks like a long opaque string)' : '123456789:ABCdef…'}
          />
        </div>

        {adapter === 'telegram' && (
          <div className="row">
            <label htmlFor="operatorUserId">Your Telegram user id</label>
            <input
              id="operatorUserId"
              type="text"
              inputMode="numeric"
              pattern="[0-9]+"
              value={operatorUserId}
              onChange={(e) => setOperatorUserId(e.target.value)}
              placeholder="123456789  (from @userinfobot)"
            />
            <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
              Telegram routes DMs by chat id (= your user id). Without this, the wiring step has nothing to bind to.
            </p>
          </div>
        )}

        {error && <div className="error-banner">{error}</div>}

        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="secondary" onClick={back} type="button" disabled={submitting}>Back</button>
          {existing.kind === 'present' && (
            <button
              type="button"
              className="secondary"
              onClick={next}
              disabled={submitting || (adapter === 'telegram' && !state.operatorUserId)}
              title={adapter === 'telegram' && !state.operatorUserId ? 'Enter your Telegram user id first' : undefined}
            >
              Skip — keep existing token
            </button>
          )}
          <button
            type="submit"
            disabled={!token.trim() || submitting || (adapter === 'telegram' && !operatorUserId.trim())}
          >
            {submitting ? 'Validating…' : 'Validate + save'}
          </button>
        </div>
      </form>
    </>
  );
}
