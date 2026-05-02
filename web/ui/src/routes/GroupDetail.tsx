import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ActivityFeed } from '../components/ActivityFeed.tsx';
import { AgentProviderCards } from '../components/AgentProviderCards.tsx';
import { ScopeGrants, SCOPE_OPTIONS } from '../components/ScopeGrants.tsx';
import { StatusDot, formatRelative } from '../components/StatusDot.tsx';
import { VaultPicker } from '../components/VaultPicker.tsx';
import {
  attachVault,
  clearGroupAgentProvider,
  detachVault,
  getGroup,
  getGroupAgentProvider,
  setGroupAgentProvider,
  spawnSession,
  type AgentGroupView,
  type AgentProviderSource,
  type GroupAgentProviderView,
  type GroupStatus,
  type VaultScope,
} from '../lib/api.ts';

const POLL_MS = 7_000;

type DetailTab = 'overview' | 'activity';

function parseTab(raw: string | null): DetailTab {
  return raw === 'activity' ? 'activity' : 'overview';
}

export function GroupDetail() {
  const { folder } = useParams<{ folder: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTab(searchParams.get('tab'));
  const [group, setGroup] = useState<AgentGroupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Attach form state. vaultBaseUrl starts empty — VaultPicker fills it in
  // with the first registered vault's URL once /api/vaults resolves, or
  // surfaces a free-text input when discovery is empty / errors.
  const [scope, setScope] = useState<VaultScope>('vault:read');
  const [vaultBaseUrl, setVaultBaseUrl] = useState('');
  const [pickedVaultName, setPickedVaultName] = useState<string | null>(null);
  const [pasteToken, setPasteToken] = useState('');
  const [tokenLabel, setTokenLabel] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [spawning, setSpawning] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async () => {
    if (!folder) return;
    try {
      setLoading(true);
      const g = await getGroup(folder);
      setGroup(g);
      setError(null);
      // Default the token-label field to claw-<folder> when not set.
      if (!tokenLabel) setTokenLabel(`claw-${folder}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Background poll for live status — silent on failure.
  useEffect(() => {
    if (!folder || !group) return;
    const t = setInterval(() => {
      getGroup(folder)
        .then((g) => setGroup(g))
        .catch(() => {});
    }, POLL_MS);
    return () => clearInterval(t);
  }, [folder, group]);

  const onAttach = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!folder) return;
    setSubmitting(true);
    setFlash(null);
    try {
      // Thread the picked vault name into re-auth on 403. The server's
      // implicit-mint forwards our JWT to the vault, which 403s on missing
      // `vault:<name>:admin` — without this hint, beginLogin would re-auth
      // with broad scopes only, the new JWT would still lack the narrow
      // scope, and we'd loop. (Detach below intentionally omits this — the
      // detach path doesn't know its target vault from the call site.)
      const result = await attachVault(
        folder,
        {
          scope,
          vaultBaseUrl: vaultBaseUrl.trim().replace(/\/+$/, ''),
          tokenLabel: tokenLabel.trim() || undefined,
          token: pasteToken.trim() || undefined,
        },
        {
          authExtraScopes: pickedVaultName ? [`vault:${pickedVaultName}:admin`] : undefined,
        },
      );
      setGroup(result.group);
      setFlash({
        kind: 'ok',
        text: result.mintedToken
          ? `Vault attached (server minted a fresh ${scope} token via parachute CLI).`
          : `Vault attached using your pasted token.`,
      });
      setPasteToken('');
    } catch (err) {
      setFlash({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const onSpawn = async () => {
    if (!folder) return;
    setSpawning(true);
    setFlash(null);
    try {
      const result = await spawnSession(folder);
      // Reload immediately so the new session shows up in the live-status
      // list before the next 7s poll tick. Container `running` flips on a
      // later tick once the heartbeat lands.
      await reload();
      setFlash({
        kind: 'ok',
        text: result.created
          ? `Session ${result.sessionId} created — container starting…`
          : `Session ${result.sessionId} already exists — waking container…`,
      });
    } catch (err) {
      setFlash({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSpawning(false);
    }
  };

  const onDetach = async () => {
    if (!folder) return;
    if (!window.confirm("Detach vault from this agent group? Token is NOT revoked — that's a separate action.")) {
      return;
    }
    setSubmitting(true);
    setFlash(null);
    try {
      // No `authExtraScopes` here on purpose — this surface isn't vault-
      // scoped (the agent group may be attached to any vault) so we can't
      // cleanly thread `vault:<name>:admin`. A 403 falls back to the broad
      // re-auth set, which is the pre-paraclaw#56 behavior. The narrow-
      // scope path lives on the per-vault detail page (VaultDetail.tsx),
      // where the vault name is known at the call site.
      const result = await detachVault(folder);
      setGroup(result.group);
      setFlash({
        kind: 'ok',
        text: 'Vault detached. To revoke the token: parachute vault tokens revoke <label> (or use the Vault detail page)',
      });
    } catch (err) {
      setFlash({
        kind: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading && !group) {
    return (
      <div>
        <Link to="/" className="muted">
          ← All groups
        </Link>
        <div className="skeleton skeleton-heading" style={{ marginTop: '1rem' }} />
        <div className="section">
          <div className="skeleton skeleton-line" style={{ width: '30%' }} />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" style={{ width: '70%' }} />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link to="/" className="muted">
          ← All groups
        </Link>
        <div className="error-banner" style={{ marginTop: '1rem' }}>
          {error}
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload} disabled={loading}>
            {loading ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      </div>
    );
  }

  if (!group) {
    return (
      <div>
        <Link to="/" className="muted">
          ← All groups
        </Link>
        <div className="empty">Group not found.</div>
      </div>
    );
  }

  return (
    <div>
      <Link to="/" className="muted">
        ← All groups
      </Link>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <StatusDot status={group.status} />
        {group.name}
        {group.vault ? (
          <span className="tag">{group.vault.scope}</span>
        ) : (
          <span className="tag muted">no vault attached</span>
        )}
      </h2>

      {flash && <div className={flash.kind === 'ok' ? 'status-banner' : 'error-banner'}>{flash.text}</div>}

      <DetailTabs
        tab={tab}
        onChange={(next) => {
          // Preserve any other search params (none today, but future-proof).
          // The replace param keeps the tab toggle out of browser-history
          // back-stack noise — flipping tabs shouldn't make Back unintuitive.
          setSearchParams(
            (prev) => {
              const p = new URLSearchParams(prev);
              if (next === 'overview') p.delete('tab');
              else p.set('tab', next);
              return p;
            },
            { replace: true },
          );
        }}
      />

      {tab === 'activity' && folder && <ActivityFeed folder={folder} />}

      {tab === 'overview' && (
        <>
          <div className="section">
            <h3>Agent group</h3>
            <div className="kv">
              <div>name</div>
              <div>{group.name}</div>
              <div>folder</div>
              <div>
                <code>{group.folder}</code>
              </div>
              <div>id</div>
              <div>
                <code>{group.id}</code>
              </div>
              <div>provider</div>
              <div>{group.agent_provider ?? <em className="dim">default</em>}</div>
              <div>created</div>
              <div>{new Date(group.created_at).toLocaleString()}</div>
            </div>
          </div>

          {group.status && <StatusSection status={group.status} onSpawn={onSpawn} spawning={spawning} />}

          {folder && <AgentProviderSection folder={folder} />}

          {group.vault ? (
            <div className="section">
              <h3>Vault attachment</h3>
              <div className="kv">
                <div>vault url</div>
                <div>
                  <code>{group.vault.vaultBaseUrl}</code>
                </div>
                <div>scope</div>
                <div>
                  <span className="tag">{group.vault.scope}</span>
                </div>
                <div>token label</div>
                <div>
                  <code>{group.vault.tokenLabel}</code>
                </div>
                <div>attached</div>
                <div>{new Date(group.vault.attachedAt).toLocaleString()}</div>
              </div>
              <hr className="sep" />
              <div className="dim" style={{ marginBottom: '0.75rem' }}>
                The agent's container.json has a <code>parachute-vault</code> MCP entry pointing at this URL with a
                Bearer token. Detach removes the entry; the token stays valid until you revoke it via{' '}
                <code>parachute vault tokens revoke {group.vault.tokenLabel}</code>.
              </div>
              <button className="danger" onClick={onDetach} disabled={submitting}>
                {submitting ? 'Working…' : 'Detach vault'}
              </button>
            </div>
          ) : (
            <div className="section">
              <h3>Attach {pickedVaultName ? <code>{pickedVaultName}</code> : null} vault</h3>
              <form onSubmit={onAttach}>
                <div className="row">
                  <label htmlFor="vaultBaseUrl">Vault</label>
                  <VaultPicker
                    inputId="vaultBaseUrl"
                    value={vaultBaseUrl}
                    onChange={setVaultBaseUrl}
                    onPickedName={setPickedVaultName}
                    disabled={submitting}
                  />
                </div>

                <div className="row">
                  <label htmlFor="scope">Scope</label>
                  <select
                    id="scope"
                    value={scope}
                    onChange={(e) => setScope(e.target.value as VaultScope)}
                    disabled={submitting}
                  >
                    {SCOPE_OPTIONS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <p className="dim">
                    Token capability — the agent literally cannot exceed this. Default <code>vault:read</code>.
                  </p>
                  <ScopeGrants scope={scope} />
                </div>

                <div className="row">
                  <label htmlFor="tokenLabel">Token label</label>
                  <input
                    id="tokenLabel"
                    type="text"
                    value={tokenLabel}
                    onChange={(e) => setTokenLabel(e.target.value)}
                    disabled={submitting}
                    placeholder={`claw-${folder}`}
                  />
                  <p className="dim">
                    Used for revocation. Default: <code>claw-{folder}</code>.
                  </p>
                </div>

                <div className="row">
                  <label htmlFor="pasteToken">Paste an existing token (optional)</label>
                  <input
                    id="pasteToken"
                    type="text"
                    value={pasteToken}
                    onChange={(e) => setPasteToken(e.target.value)}
                    disabled={submitting}
                    placeholder="pvt_…  (leave blank to mint a fresh one via the parachute CLI)"
                  />
                  <p className="dim">
                    When blank: the server runs{' '}
                    <code>
                      parachute vault tokens create --scope {scope} --label {tokenLabel || `claw-${folder}`}
                    </code>{' '}
                    for you. (Until vault OAuth is wired in Phase B; then you'll never see <code>pvt_…</code> tokens at
                    all.)
                  </p>
                </div>

                <div className="actions">
                  <button type="submit" disabled={submitting}>
                    {submitting ? 'Attaching…' : 'Attach vault'}
                  </button>
                </div>
              </form>
            </div>
          )}

          <div className="section">
            <h3>What the agent gets</h3>
            <p className="muted">
              When attached, the agent's container has a <code>parachute-vault</code> MCP server available with the nine
              vault tools: <code>query-notes</code>, <code>create-note</code>, <code>update-note</code>,{' '}
              <code>delete-note</code>, <code>list-tags</code>, <code>update-tag</code>, <code>delete-tag</code>,{' '}
              <code>find-path</code>, <code>vault-info</code>. Constrained by the scope you chose.
            </p>
            <p className="muted">
              Paraclaw doesn't impose a vault-note layout on the agent — the claw decides how to use vault access. (See{' '}
              <a
                href="https://github.com/ParachuteComputer/paraclaw/blob/main/docs/parachute-integration.md"
                target="_blank"
                rel="noreferrer"
              >
                docs/parachute-integration.md
              </a>
              .)
            </p>
          </div>
        </>
      )}
    </div>
  );
}

function describeSource(source: AgentProviderSource | null, serverUrl: string | null): string {
  switch (source) {
    case 'claude_setup_token':
      return 'Claude setup token';
    case 'anthropic_api_key':
      return 'Anthropic API key';
    case 'external_server':
      return serverUrl ? `External server (${serverUrl})` : 'External server';
    case null:
      return 'not configured';
  }
}

function AgentProviderSection({ folder }: { folder: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; view: GroupAgentProviderView } | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const reload = useCallback(async () => {
    try {
      setState({ kind: 'loading' });
      const view = await getGroupAgentProvider(folder);
      setState({ kind: 'ok', view });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }, [folder]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const submit = async (input: { source: AgentProviderSource; apiKey?: string; serverUrl?: string }) => {
    setBusy(true);
    setFlash(null);
    try {
      const view = await setGroupAgentProvider(folder, input);
      setState({ kind: 'ok', view });
      setShowForm(false);
      setFlash({ kind: 'ok', text: 'Override saved — takes effect on the next session spawn.' });
    } catch (err) {
      setFlash({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  const onClear = async () => {
    if (!window.confirm("Clear this group's override and inherit the install-wide default?")) return;
    setBusy(true);
    setFlash(null);
    try {
      const view = await clearGroupAgentProvider(folder);
      setState({ kind: 'ok', view });
      setShowForm(false);
      setFlash({
        kind: 'ok',
        text: 'Override cleared. Group will inherit the install-wide default on the next spawn.',
      });
    } catch (err) {
      setFlash({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div className="section">
        <h3>Agent provider</h3>
        <div className="skeleton skeleton-line" style={{ width: '60%' }} />
      </div>
    );
  }
  if (state.kind === 'error') {
    return (
      <div className="section">
        <h3>Agent provider</h3>
        <div className="error-banner">
          Couldn't load: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '0.75rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  const { view } = state;
  const effectiveSummary = describeSource(view.effective.source, view.effective.serverUrl);
  const overrideSummary = describeSource(view.override.source, view.override.serverUrl);

  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <h3 style={{ margin: 0 }}>Agent provider</h3>
        {view.overridden ? <span className="tag">override</span> : <span className="tag muted">inheriting</span>}
      </div>
      <p className="muted" style={{ marginTop: '0.75rem' }}>
        {view.overridden ? (
          <>
            This group uses its own credential source: <strong>{overrideSummary}</strong>. Clear the override to inherit
            the install-wide default again.
          </>
        ) : (
          <>
            This group inherits the install-wide default — currently <strong>{effectiveSummary}</strong>. Set an
            override below to give this group its own credentials. Change at{' '}
            <Link to="/settings/agent-provider">Settings · Agent provider</Link> for the install-wide default.
          </>
        )}
      </p>

      {flash && (
        <div className={flash.kind === 'ok' ? 'status-banner' : 'error-banner'} style={{ marginBottom: '0.75rem' }}>
          {flash.text}
        </div>
      )}

      {!view.overridden && !showForm && (
        <div className="actions">
          <button onClick={() => setShowForm(true)}>Override default</button>
        </div>
      )}

      {(view.overridden || showForm) && (
        <>
          <AgentProviderCards view={view.override} busy={busy} onSubmit={submit} />
          <div className="actions" style={{ display: 'flex', gap: '0.5rem' }}>
            {view.overridden && (
              <button className="danger" onClick={onClear} disabled={busy}>
                {busy ? 'Working…' : 'Clear override'}
              </button>
            )}
            {!view.overridden && showForm && (
              <button className="secondary" onClick={() => setShowForm(false)} disabled={busy}>
                Cancel
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function DetailTabs({ tab, onChange }: { tab: DetailTab; onChange: (next: DetailTab) => void }) {
  return (
    <ol className="detail-tabs">
      <li className={`detail-tab${tab === 'overview' ? ' active' : ''}`}>
        <button type="button" onClick={() => onChange('overview')}>
          Overview
        </button>
      </li>
      <li className={`detail-tab${tab === 'activity' ? ' active' : ''}`}>
        <button type="button" onClick={() => onChange('activity')}>
          Activity
        </button>
      </li>
    </ol>
  );
}

function StatusSection({ status, onSpawn, spawning }: { status: GroupStatus; onSpawn: () => void; spawning: boolean }) {
  return (
    <div className="section">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
        <h3 style={{ margin: 0 }}>Live status</h3>
        <button onClick={onSpawn} disabled={spawning}>
          {spawning ? 'Spawning…' : '+ New session'}
        </button>
      </div>
      <div className="kv" style={{ marginTop: '1rem' }}>
        <div>container</div>
        <div>
          {status.containerRunning ? (
            <span className="status-text alive">running</span>
          ) : (
            <span className="status-text idle">idle</span>
          )}
        </div>
        <div>active sessions</div>
        <div>
          {status.activeSessionCount} of {status.sessionCount}
        </div>
        <div>last heartbeat</div>
        <div>
          {status.lastHeartbeatAt ? (
            <>
              {formatRelative(status.lastHeartbeatAt)}{' '}
              <span className="dim">({new Date(status.lastHeartbeatAt).toLocaleString()})</span>
            </>
          ) : (
            <span className="dim">never</span>
          )}
        </div>
        <div>last message in</div>
        <div>
          {status.lastMessageInAt ? (
            <>
              {formatRelative(status.lastMessageInAt)}{' '}
              <span className="dim">({new Date(status.lastMessageInAt).toLocaleString()})</span>
            </>
          ) : (
            <span className="dim">none</span>
          )}
        </div>
        <div>last message out</div>
        <div>
          {status.lastMessageOutAt ? (
            <>
              {formatRelative(status.lastMessageOutAt)}{' '}
              <span className="dim">({new Date(status.lastMessageOutAt).toLocaleString()})</span>
            </>
          ) : (
            <span className="dim">none</span>
          )}
        </div>
      </div>
      <hr className="sep" />
      {status.sessions.length === 0 ? (
        <p className="dim" style={{ marginBottom: 0 }}>
          No sessions yet — spawn one with the button above to start the agent's container.
        </p>
      ) : (
        <>
          <div className="dim" style={{ marginBottom: '0.5rem' }}>
            Sessions ({status.sessions.length}):
          </div>
          <ul className="session-list">
            {status.sessions.map((s) => (
              <li key={s.sessionId}>
                <code>{s.sessionId}</code>{' '}
                {s.alive ? (
                  <span className="status-text alive">alive</span>
                ) : (
                  <span className="status-text idle">{s.containerStatus}</span>
                )}{' '}
                <span className="dim">— {s.status}</span>
                {s.lastHeartbeatAt && (
                  <>
                    {' '}
                    <span className="dim">· hb {formatRelative(s.lastHeartbeatAt)}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
