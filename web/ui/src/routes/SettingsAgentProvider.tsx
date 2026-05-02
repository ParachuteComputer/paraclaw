/**
 * /settings/agent-provider — install-wide agent provider source.
 *
 * Three options, all paste-only:
 *   - Claude setup token (`claude setup-token` on a subscription host).
 *   - Anthropic API key (Console).
 *   - External provider server (self-hosted proxy or vendor speaking the
 *     Anthropic API).
 *
 * The page never displays plaintext secrets — the API returns a `hasApiKey`
 * boolean only. Per-agent-group overrides live on each group's detail page
 * (paraclaw#86).
 */
import { useCallback, useEffect, useState } from 'react';

import { AgentProviderCards } from '../components/AgentProviderCards.tsx';
import { getAgentProvider, setAgentProvider, type AgentProviderSource, type AgentProviderView } from '../lib/api.ts';

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'error'; message: string };

export function SettingsAgentProvider() {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; view: AgentProviderView } | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    getAgentProvider()
      .then((view) => !cancelled && setState({ kind: 'ok', view }))
      .catch((err) => {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const submit = async (input: { source: AgentProviderSource; apiKey?: string; serverUrl?: string }) => {
    setSave({ kind: 'saving' });
    try {
      const view = await setAgentProvider(input);
      setState({ kind: 'ok', view });
      setSave({ kind: 'idle' });
    } catch (err) {
      setSave({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (state.kind === 'loading') {
    return (
      <div>
        <h2>Settings · Agent provider</h2>
        <ul className="skeleton-list" aria-busy="true">
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
        </ul>
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div>
        <h2>Settings · Agent provider</h2>
        <div className="error-banner">
          Couldn't load settings: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  const { view } = state;
  return (
    <div>
      <div className="list-header">
        <h2>Settings · Agent provider</h2>
        <button className="secondary" onClick={reload}>
          Refresh
        </button>
      </div>
      <nav className="muted" style={{ marginBottom: '0.75rem' }}>
        <a href="approvals">Approval routing</a>
        {' · '}
        <a href="agent-provider">Agent provider</a>
      </nav>
      <p className="muted">
        Where the agent gets its Claude credentials. One source per install — applies to every agent group unless a
        specific group sets an override on its detail page. Changing the source takes effect on the next session spawn.
      </p>

      {save.kind === 'error' && (
        <div className="error-banner" style={{ marginBottom: '1rem' }}>
          {save.message}
        </div>
      )}

      <AgentProviderCards view={view} busy={save.kind === 'saving'} onSubmit={submit} />
    </div>
  );
}
