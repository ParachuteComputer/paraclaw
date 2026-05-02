/**
 * Three paste-only agent-provider cards reused at install-wide
 * (`/settings/agent-provider`) and per-group (`/groups/<folder>`)
 * scopes. Each card consumes the same `AgentProviderView` shape and
 * fires `onSubmit` with the matching `SetAgentProviderInput` slice.
 *
 * The card never displays the secret — it accepts a paste and
 * forwards it to the caller, which writes through the encrypted
 * provider-credentials store. `view.hasApiKey` is a boolean only.
 */
import { useState } from 'react';

import type { AgentProviderSource, AgentProviderView } from '../lib/api.ts';

interface CardProps {
  active: boolean;
  title: string;
  children: React.ReactNode;
}

function Card({ active, title, children }: CardProps) {
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

interface SubmitInput {
  source: AgentProviderSource;
  apiKey?: string;
  serverUrl?: string;
}

interface AgentProviderCardsProps {
  view: AgentProviderView;
  busy: boolean;
  onSubmit: (input: SubmitInput) => void;
}

export function AgentProviderCards({ view, busy, onSubmit }: AgentProviderCardsProps) {
  return (
    <>
      <ClaudeSetupTokenCard
        view={view}
        busy={busy}
        onSubmit={(apiKey) => onSubmit({ source: 'claude_setup_token', apiKey })}
      />
      <ApiKeyCard view={view} busy={busy} onSubmit={(apiKey) => onSubmit({ source: 'anthropic_api_key', apiKey })} />
      <ExternalServerCard
        view={view}
        busy={busy}
        onSubmit={(apiKey, serverUrl) => onSubmit({ source: 'external_server', apiKey, serverUrl })}
      />
    </>
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
