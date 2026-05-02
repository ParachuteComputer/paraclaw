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
 * boolean only.
 */
import { useCallback, useEffect, useState } from 'react';

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
        Where the agent gets its Claude credentials. One source per install — applies to every agent group. Changing the
        source takes effect on the next session spawn.
      </p>

      {save.kind === 'error' && (
        <div className="error-banner" style={{ marginBottom: '1rem' }}>
          {save.message}
        </div>
      )}

      <ClaudeSetupTokenCard
        view={view}
        busy={save.kind === 'saving'}
        onSubmit={(apiKey) => submit({ source: 'claude_setup_token', apiKey })}
      />
      <ApiKeyCard
        view={view}
        busy={save.kind === 'saving'}
        onSubmit={(apiKey) => submit({ source: 'anthropic_api_key', apiKey })}
      />
      <ExternalServerCard
        view={view}
        busy={save.kind === 'saving'}
        onSubmit={(apiKey, serverUrl) => submit({ source: 'external_server', apiKey, serverUrl })}
      />
    </div>
  );
}

function Card({ active, title, children }: { active: boolean; title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'white',
        border: active ? '2px solid var(--accent, #2563eb)' : '1px solid var(--border)',
        borderRadius: '8px',
        padding: '1rem 1.25rem',
        marginBottom: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>{title}</strong>
        {active && <span className="tag">active</span>}
      </div>
      <div style={{ marginTop: '0.5rem' }}>{children}</div>
    </div>
  );
}

function ClaudeSetupTokenCard({
  view,
  busy,
  onSubmit,
}: {
  view: AgentProviderView;
  busy: boolean;
  onSubmit: (apiKey: string) => void;
}) {
  const active = view.source === 'claude_setup_token';
  const [token, setToken] = useState('');
  return (
    <Card active={active} title="Claude setup token (recommended)">
      <p className="muted" style={{ margin: '0 0 0.5rem' }}>
        Generate a Claude setup token with <code>claude setup-token</code> on a host where you've authenticated to your
        Pro / Max / Team / Enterprise subscription. The command walks you through OAuth and prints a one-year token (
        <code>sk-ant-oat01-…</code>). Inference-only — paste it here.
        {active && view.hasApiKey && ' A token is currently stored.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (token.trim()) {
            onSubmit(token.trim());
            setToken('');
          }
        }}
        style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
      >
        <input
          type="password"
          autoComplete="off"
          placeholder="sk-ant-oat01-…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          disabled={busy}
          style={{ flex: '1 1 24rem', minWidth: '16rem' }}
        />
        <button type="submit" disabled={busy || !token.trim()}>
          {active ? 'Replace token' : 'Use setup token'}
        </button>
      </form>
    </Card>
  );
}

function ApiKeyCard({
  view,
  busy,
  onSubmit,
}: {
  view: AgentProviderView;
  busy: boolean;
  onSubmit: (apiKey: string) => void;
}) {
  const active = view.source === 'anthropic_api_key';
  const [apiKey, setApiKey] = useState('');
  return (
    <Card active={active} title="Anthropic API key">
      <p className="muted" style={{ margin: '0 0 0.5rem' }}>
        Paste an API key from console.anthropic.com. Per-token billing.
        {active && view.hasApiKey && ' A key is currently stored.'}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (apiKey.trim()) {
            onSubmit(apiKey.trim());
            setApiKey('');
          }
        }}
        style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
      >
        <input
          type="password"
          autoComplete="off"
          placeholder="sk-ant-api03-…"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={busy}
          style={{ flex: '1 1 24rem', minWidth: '16rem' }}
        />
        <button type="submit" disabled={busy || !apiKey.trim()}>
          {active ? 'Replace key' : 'Use API key'}
        </button>
      </form>
    </Card>
  );
}

function ExternalServerCard({
  view,
  busy,
  onSubmit,
}: {
  view: AgentProviderView;
  busy: boolean;
  onSubmit: (apiKey: string, serverUrl: string) => void;
}) {
  const active = view.source === 'external_server';
  const [serverUrl, setServerUrl] = useState(active ? (view.serverUrl ?? '') : '');
  const [apiKey, setApiKey] = useState('');
  const ready = serverUrl.trim() && apiKey.trim();
  return (
    <Card active={active} title="External provider server">
      <p className="muted" style={{ margin: '0 0 0.5rem' }}>
        A self-hosted Claude proxy or a vendor that speaks the Anthropic API (e.g. OpenRouter). Sets{' '}
        <code>ANTHROPIC_BASE_URL</code> + API key inside the container.
        {active && view.serverUrl && (
          <>
            {' '}
            Pointed at <code>{view.serverUrl}</code>.
          </>
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) {
            onSubmit(apiKey.trim(), serverUrl.trim());
            setApiKey('');
            setServerUrl('');
          }
        }}
        style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}
      >
        <input
          type="url"
          placeholder="https://openrouter.ai/api/v1"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          disabled={busy}
        />
        <input
          type="password"
          autoComplete="off"
          placeholder="API key"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          disabled={busy}
        />
        <div>
          <button type="submit" disabled={busy || !ready}>
            {active ? 'Replace' : 'Use external server'}
          </button>
        </div>
      </form>
    </Card>
  );
}
