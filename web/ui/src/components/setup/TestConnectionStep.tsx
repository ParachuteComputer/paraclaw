/**
 * Step 5 — Test connection.
 *
 * Re-validates the bot token (in case OneCLI's stored token has rotated)
 * by hitting POST /channels/<adapter>/test. We need the operator to paste
 * the token again here — we never read it back from OneCLI (its API is
 * write-only by design). If they kept the token in their clipboard from
 * the credentials step, this is a 5-second copy-paste-confirm.
 *
 * If we already captured a botUserId from the credentials step's
 * validation, surface it here so the operator sees we know which bot
 * we're talking to before they re-test.
 */
import { useState } from 'react';
import { testDiscordToken, testTelegramToken } from '../../lib/api.ts';
import { ADAPTER_LABELS, type StepProps } from './types.ts';

export function TestConnectionStep({ state, patchState, next, back }: StepProps) {
  const adapter = state.adapter;
  const [token, setToken] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; username: string } | null>(
    state.botUserId && state.botUsername ? { id: state.botUserId, username: state.botUsername } : null,
  );

  if (!adapter) {
    return (
      <>
        <h3>Test connection</h3>
        <div className="error-banner">No channel selected — go back to step 2.</div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="secondary" onClick={back}>Back</button>
        </div>
      </>
    );
  }

  const onTest = async () => {
    if (!token.trim()) return;
    setTesting(true);
    setError(null);
    try {
      if (adapter === 'discord') {
        const r = await testDiscordToken(token.trim());
        setResult({ id: r.identity.id, username: r.identity.username });
        patchState({ botUserId: r.identity.id, botUsername: r.identity.username });
      } else {
        const r = await testTelegramToken(token.trim());
        const id = String(r.identity.id);
        setResult({ id, username: r.identity.username });
        patchState({ botUserId: id, botUsername: r.identity.username });
      }
      setToken('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
    }
  };

  const adapterLabel = ADAPTER_LABELS[adapter];
  const apiPath = adapter === 'discord' ? '/users/@me' : '/getMe';

  return (
    <>
      <h3>Test connection</h3>
      <p className="muted">
        Confirm {adapterLabel} accepts the token by hitting <code>{apiPath}</code>. Paste the token again — we don't
        read it back from OneCLI.
      </p>

      {result && (
        <div className="empty empty-rich" style={{ marginTop: '0.5rem' }}>
          <p className="empty-headline" style={{ margin: 0 }}>
            Bot identified: <code>@{result.username}</code> <span className="dim">(id <code>{result.id}</code>)</span>
          </p>
          <p className="muted" style={{ marginTop: '0.4rem' }}>
            You can re-test below, or move on.
          </p>
        </div>
      )}

      <div className="row" style={{ marginTop: '0.75rem' }}>
        <label htmlFor="recheckToken">Bot token</label>
        <input
          id="recheckToken"
          type="password"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="paste again to re-test"
        />
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>Back</button>
        <button className="secondary" onClick={onTest} disabled={!token.trim() || testing}>
          {testing ? 'Testing…' : 'Test'}
        </button>
        <button onClick={next} disabled={!result}>Next: agent group</button>
      </div>
    </>
  );
}
