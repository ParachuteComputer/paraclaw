/**
 * `/agent/apps` — OAuth integrations management.
 *
 * Two stacked sections per the audit-refined brief:
 *   1. **App configs** — per-provider OAuth client (paste client_id + client_secret).
 *      One row per *supported* provider, regardless of whether it's been
 *      configured yet. The CTA flips between "Add" and "Replace secret".
 *   2. **Connections** — the user grants. Each row shows account_email +
 *      label + scopes_granted + status + agentGroupCount + delete.
 *
 * Add-flow: clicking "Connect with X" on a provider that has no app_config
 * yet routes through the App-config form first; once saved, the same button
 * proceeds to authorize.
 *
 * Callback handling: the server's OAuth callback redirects back to
 * `?connected=<id>`. We read that on mount, refetch, and highlight the
 * matching row briefly. The query param is then stripped from the URL so a
 * page refresh doesn't re-trigger the highlight.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { formatRelative } from '../components/StatusDot.tsx';
import {
  type AppConfigView,
  type AppConnectionView,
  type PutAppConfigInput,
  authorizeApp,
  deleteAppConnection,
  getAppConfig,
  listAppConnections,
  putAppConfig,
} from '../lib/api.ts';

/**
 * Providers the UI knows about. Keep this list small — adding a provider is
 * an explicit decision (the OAuth scopes, the userinfo shape, the icon, all
 * vary). PR3 ships with Google as the seed; subsequent PRs add more.
 */
const SUPPORTED_PROVIDERS: ProviderMeta[] = [
  {
    id: 'google',
    label: 'Google',
    description: 'Gmail, Calendar, Drive — depending on the scopes you grant.',
    defaultScopes: ['openid', 'email', 'profile'],
    docsUrl: 'https://console.cloud.google.com/apis/credentials',
  },
];

interface ProviderMeta {
  id: string;
  label: string;
  description: string;
  defaultScopes: string[];
  /** Where the human goes to register an OAuth app for this provider. */
  docsUrl: string;
}

export function Apps() {
  const [searchParams, setSearchParams] = useSearchParams();
  const justConnectedId = searchParams.get('connected');

  // Configs are keyed by provider id; null = explicitly "no config yet"
  // (404 from server), undefined = not yet loaded.
  const [configs, setConfigs] = useState<Record<string, AppConfigView | null | undefined>>({});
  const [connections, setConnections] = useState<AppConnectionView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  // Tracks the provider the user clicked Connect on when no config existed yet.
  // After they save the config, we auto-resume the OAuth handoff for that
  // provider so they don't have to re-click Connect.
  const [pendingConnectProvider, setPendingConnectProvider] = useState<string | null>(null);

  const reload = useCallback(async (signal: { cancelled: boolean }) => {
    try {
      const [conns, ...cfgs] = await Promise.all([
        listAppConnections(),
        ...SUPPORTED_PROVIDERS.map((p) => getAppConfig(p.id)),
      ]);
      if (signal.cancelled) return;
      const cfgMap: Record<string, AppConfigView | null> = {};
      SUPPORTED_PROVIDERS.forEach((p, i) => {
        cfgMap[p.id] = cfgs[i];
      });
      setConfigs(cfgMap);
      setConnections(conns);
      setError(null);
    } catch (err) {
      if (signal.cancelled) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void reload(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [reload]);

  // Convenience for the Retry button — same call shape, throwaway signal.
  const reloadNow = useCallback(() => {
    void reload({ cancelled: false });
  }, [reload]);

  // Strip the `?connected=` param after we've consumed it for the highlight,
  // so a refresh doesn't re-trigger the green flash. Kept replace:true to
  // avoid leaving a redundant entry in the back-stack.
  useEffect(() => {
    if (!justConnectedId) return;
    const t = setTimeout(() => {
      setSearchParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          p.delete('connected');
          return p;
        },
        { replace: true },
      );
    }, 4_000);
    return () => clearTimeout(t);
  }, [justConnectedId, setSearchParams]);

  const authorizeAndRedirect = async (provider: string) => {
    setFlash(null);
    try {
      const { redirectUrl } = await authorizeApp(provider);
      window.location.href = redirectUrl;
    } catch (err) {
      setFlash({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  const onConnect = async (provider: string) => {
    const cfg = configs[provider];
    if (!cfg) {
      // No app_config yet — record the user's intent so we can auto-resume
      // the OAuth handoff after they save the config (handled in onSaved).
      setPendingConnectProvider(provider);
      setEditingProvider(provider);
      setFlash({ kind: 'ok', text: `Configure ${providerLabel(provider)} OAuth client first.` });
      return;
    }
    await authorizeAndRedirect(provider);
  };

  const onDeleteConnection = async (conn: AppConnectionView) => {
    if (
      !window.confirm(
        `Remove connection ${conn.label}? The agent groups it's assigned to (${conn.agentGroupCount}) will lose access immediately.`,
      )
    ) {
      return;
    }
    setFlash(null);
    try {
      await deleteAppConnection(conn.id);
      setFlash({ kind: 'ok', text: `Removed ${conn.label}.` });
      reloadNow();
    } catch (err) {
      setFlash({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  };

  if (loading && connections === null) {
    return (
      <div>
        <h2>Apps</h2>
        <div className="section">
          <div className="skeleton skeleton-line" style={{ width: '40%' }} />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" style={{ width: '70%' }} />
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2>Apps</h2>
      <p className="muted" style={{ marginTop: '-0.5rem' }}>
        OAuth integrations — configure a provider once, then grant the agent access via "Connect".
      </p>

      {error && (
        <div className="error-banner">
          {error}
          <button className="secondary" onClick={reloadNow} style={{ marginLeft: '0.6rem' }}>
            Retry
          </button>
        </div>
      )}
      {flash && <div className={flash.kind === 'ok' ? 'status-banner' : 'error-banner'}>{flash.text}</div>}

      <div className="section">
        <h3>App configs</h3>
        <p className="muted" style={{ marginTop: 0 }}>
          One OAuth client per provider, shared across all your agent groups. Paste the client_id and
          client_secret you registered with the provider.
        </p>
        <ul className="app-config-list">
          {SUPPORTED_PROVIDERS.map((provider) => (
            <AppConfigRow
              key={provider.id}
              provider={provider}
              config={configs[provider.id] ?? null}
              loading={configs[provider.id] === undefined}
              editing={editingProvider === provider.id}
              onEdit={() => setEditingProvider(provider.id)}
              onCancel={() => {
                setEditingProvider(null);
                setPendingConnectProvider(null);
              }}
              onSaved={async (saved) => {
                setConfigs((prev) => ({ ...prev, [provider.id]: saved }));
                setEditingProvider(null);
                if (pendingConnectProvider === provider.id && saved.hasSecret) {
                  // The user clicked Connect first; resume the OAuth handoff
                  // automatically now that the config is in place.
                  setPendingConnectProvider(null);
                  await authorizeAndRedirect(provider.id);
                } else {
                  setPendingConnectProvider(null);
                  setFlash({ kind: 'ok', text: `${provider.label} OAuth client saved.` });
                }
              }}
            />
          ))}
        </ul>
      </div>

      <div className="section">
        <h3>Connections</h3>
        {connections && connections.length > 0 ? (
          <ConnectionsTable
            connections={connections}
            justConnectedId={justConnectedId}
            onConnect={onConnect}
            onDelete={onDeleteConnection}
            configs={configs}
          />
        ) : (
          <ConnectionsEmpty
            providers={SUPPORTED_PROVIDERS}
            configs={configs}
            onConnect={onConnect}
          />
        )}
      </div>
    </div>
  );
}

// --- App config row ---

function AppConfigRow({
  provider,
  config,
  loading,
  editing,
  onEdit,
  onCancel,
  onSaved,
}: {
  provider: ProviderMeta;
  config: AppConfigView | null;
  loading: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSaved: (saved: AppConfigView) => Promise<void>;
}) {
  if (editing) {
    return (
      <li className="app-config-row app-config-row-editing">
        <AppConfigForm
          provider={provider}
          existing={config}
          onCancel={onCancel}
          onSaved={onSaved}
        />
      </li>
    );
  }
  return (
    <li className="app-config-row">
      <div className="app-config-head">
        <div>
          <strong>{provider.label}</strong>
          {loading ? (
            <span className="dim"> · loading…</span>
          ) : config ? (
            <span className="tag" style={{ marginLeft: '0.5rem' }}>
              configured
            </span>
          ) : (
            <span className="tag muted" style={{ marginLeft: '0.5rem' }}>
              not configured
            </span>
          )}
        </div>
        <button className="secondary" onClick={onEdit} disabled={loading}>
          {config ? 'Replace secret' : 'Add config'}
        </button>
      </div>
      <p className="dim app-config-blurb">{provider.description}</p>
      {config && (
        <div className="kv app-config-kv">
          <div>client_id</div>
          <div>
            <code className="app-config-clientid">{config.client_id}</code>
          </div>
          <div>scopes</div>
          <div>
            {config.scopes_default.length > 0
              ? config.scopes_default.map((s) => (
                  <code key={s} className="app-scope-tag">
                    {s}
                  </code>
                ))
              : <em className="dim">none</em>}
          </div>
          <div>secret</div>
          <div>
            {config.hasSecret ? (
              <span className="tag muted">stored</span>
            ) : (
              <span className="tag warn">missing — add a secret to enable Connect</span>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

function AppConfigForm({
  provider,
  existing,
  onCancel,
  onSaved,
}: {
  provider: ProviderMeta;
  existing: AppConfigView | null;
  onCancel: () => void;
  onSaved: (saved: AppConfigView) => Promise<void>;
}) {
  const [clientId, setClientId] = useState(existing?.client_id ?? '');
  const [clientSecret, setClientSecret] = useState('');
  const [scopesText, setScopesText] = useState(
    (existing?.scopes_default ?? provider.defaultScopes).join(' '),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clientId.trim() || !clientSecret.trim()) {
      setErr('Both client_id and client_secret are required.');
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const input: PutAppConfigInput = {
        client_id: clientId.trim(),
        client_secret: clientSecret,
        scopes_default: scopesText.split(/\s+/).filter(Boolean),
      };
      const saved = await putAppConfig(provider.id, input);
      await onSaved(saved);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : String(e2));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="app-config-form">
      <div className="app-config-head">
        <strong>{provider.label} OAuth client</strong>
        <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="dim">
          Where do I get this? ↗
        </a>
      </div>
      {err && <div className="error-banner">{err}</div>}
      <div className="row">
        <label htmlFor={`cid-${provider.id}`}>client_id</label>
        <input
          id={`cid-${provider.id}`}
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          disabled={submitting}
          autoComplete="off"
        />
      </div>
      <div className="row">
        <label htmlFor={`cs-${provider.id}`}>
          client_secret {existing?.hasSecret && <span className="dim">(replacing existing)</span>}
        </label>
        <input
          id={`cs-${provider.id}`}
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          disabled={submitting}
          autoComplete="new-password"
          placeholder={existing?.hasSecret ? 'paste new secret to rotate' : 'paste from provider'}
        />
      </div>
      <div className="row">
        <label htmlFor={`scopes-${provider.id}`}>default scopes</label>
        <input
          id={`scopes-${provider.id}`}
          type="text"
          value={scopesText}
          onChange={(e) => setScopesText(e.target.value)}
          disabled={submitting}
          placeholder={provider.defaultScopes.join(' ')}
        />
        <p className="dim">Space-separated. Each Connect can later add more, but never less.</p>
      </div>
      <div className="actions">
        <button type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save'}
        </button>
        <button type="button" className="secondary" onClick={onCancel} disabled={submitting}>
          Cancel
        </button>
      </div>
    </form>
  );
}

// --- Connections ---

function ConnectionsTable({
  connections,
  justConnectedId,
  onConnect,
  onDelete,
  configs,
}: {
  connections: AppConnectionView[];
  justConnectedId: string | null;
  onConnect: (provider: string) => void | Promise<void>;
  onDelete: (conn: AppConnectionView) => void | Promise<void>;
  configs: Record<string, AppConfigView | null | undefined>;
}) {
  // Group by provider so each block has a "+ Connect another <provider>"
  // row at the bottom — UX is clearer than a flat list when the user has
  // multiple Google accounts (which is the common case for power users).
  const byProvider = useMemo(() => {
    const m = new Map<string, AppConnectionView[]>();
    for (const c of connections) {
      const arr = m.get(c.provider) ?? [];
      arr.push(c);
      m.set(c.provider, arr);
    }
    return m;
  }, [connections]);

  return (
    <div className="connections-list">
      {Array.from(byProvider.entries()).map(([provider, items]) => {
        const cfg = configs[provider];
        const canConnect = cfg && cfg.hasSecret;
        return (
          <div key={provider} className="connections-group">
            <div className="connections-group-head">
              <strong>{providerLabel(provider)}</strong>
              <button
                className="secondary"
                onClick={() => void onConnect(provider)}
                disabled={!canConnect}
                title={canConnect ? undefined : 'Add a config + secret first'}
              >
                + Connect another
              </button>
            </div>
            <ul className="connections-rows">
              {items.map((conn) => (
                <ConnectionRow
                  key={conn.id}
                  conn={conn}
                  highlighted={conn.id === justConnectedId}
                  onDelete={() => void onDelete(conn)}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function ConnectionRow({
  conn,
  highlighted,
  onDelete,
}: {
  conn: AppConnectionView;
  highlighted: boolean;
  onDelete: () => void;
}) {
  // Briefly scroll the highlighted row into view so the user lands on it
  // after the OAuth round-trip without having to hunt.
  const ref = useRef<HTMLLIElement | null>(null);
  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlighted]);

  return (
    <li ref={ref} className={`connection-row${highlighted ? ' connection-row-flash' : ''}`}>
      <div className="connection-row-main">
        <div className="connection-label">
          {conn.label}
          <ConnectionStatusTag status={conn.status} />
        </div>
        <div className="dim connection-meta">
          {conn.account_email && <span>{conn.account_email}</span>}
          {conn.account_email && <span> · </span>}
          {conn.expires_at ? (
            <span title={new Date(conn.expires_at).toLocaleString()}>
              expires {formatRelative(conn.expires_at)}
            </span>
          ) : (
            <span>no expiry</span>
          )}
          <span> · </span>
          <span>
            {conn.agentGroupCount === 0
              ? 'unassigned'
              : `assigned to ${conn.agentGroupCount} agent${conn.agentGroupCount === 1 ? '' : 's'}`}
          </span>
        </div>
        {conn.scopes_granted.length > 0 && (
          <div className="connection-scopes">
            {conn.scopes_granted.map((s) => (
              <code key={s} className="app-scope-tag">
                {s}
              </code>
            ))}
          </div>
        )}
      </div>
      <button className="danger" onClick={onDelete}>
        Remove
      </button>
    </li>
  );
}

function ConnectionStatusTag({ status }: { status: AppConnectionView['status'] }) {
  switch (status) {
    case 'active':
      return <span className="tag" style={{ marginLeft: '0.5rem' }}>active</span>;
    case 'expired':
      return <span className="tag warn" style={{ marginLeft: '0.5rem' }}>expired</span>;
    case 'revoked':
      return <span className="tag error" style={{ marginLeft: '0.5rem' }}>revoked</span>;
  }
}

function ConnectionsEmpty({
  providers,
  configs,
  onConnect,
}: {
  providers: ProviderMeta[];
  configs: Record<string, AppConfigView | null | undefined>;
  onConnect: (provider: string) => void | Promise<void>;
}) {
  return (
    <div className="empty-rich">
      <p className="empty-headline">No connections yet.</p>
      <p className="muted" style={{ marginTop: 0 }}>
        Configure a provider above, then click Connect to grant the agent access via OAuth.
      </p>
      <div className="connect-cta-row">
        {providers.map((p) => {
          const cfg = configs[p.id];
          const ready = cfg && cfg.hasSecret;
          return (
            <button
              key={p.id}
              onClick={() => void onConnect(p.id)}
              disabled={!ready}
              title={ready ? undefined : 'Add this provider in App configs first'}
            >
              Connect with {p.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function providerLabel(id: string): string {
  const known = SUPPORTED_PROVIDERS.find((p) => p.id === id);
  return known?.label ?? id;
}
