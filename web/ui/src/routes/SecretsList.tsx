/**
 * /secrets — paraclaw-native secrets list.
 *
 * Replaces the old OneCLI proxy page. Backend is the AES-256-GCM secrets
 * store at ~/.parachute/claw/secrets.db; values are NEVER returned over
 * the wire (write-only by design). The list shows names + kinds + scope
 * only; create/delete are the only mutating actions.
 *
 * Scope binding: a secret can be either global (agentGroupId = null,
 * available to every spawned container whose host pattern matches) or
 * scoped to a specific agent group. The list groups rows by scope so the
 * operator can see at a glance which secrets are isolated.
 *
 * The create form is the shared CredentialForm component in `free` mode —
 * same code path as the wizard's channel mode, just without the platform
 * pre-flight validation. When the user adds a name that overlaps with an
 * existing one in the same scope the server upserts (per PRIMITIVES.md);
 * the UI reflects that by reloading after onCreated.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CredentialForm } from '../components/CredentialForm.tsx';
import { deleteSecret, listGroups, listSecrets, type AgentGroupView, type SecretView } from '../lib/api.ts';

export function SecretsList() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; secrets: SecretView[]; groups: AgentGroupView[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSecrets(), listGroups()])
      .then(([secrets, groups]) => {
        if (!cancelled) setState({ kind: 'ok', secrets, groups });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            kind: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const onDelete = async (s: SecretView) => {
    if (!confirm(`Delete secret "${s.name}"? Containers using it will start failing on next session spawn.`)) return;
    setBusyId(s.id);
    setActionError(null);
    try {
      await deleteSecret(s.id);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div>
        <h2>Secrets</h2>
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
        <h2>Secrets</h2>
        <div className="error-banner">
          Couldn't load secrets: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  const groupName = (id: string | null): string => {
    if (!id) return 'global';
    const g = state.groups.find((x) => x.id === id);
    return g ? g.name : `(unknown group ${id.slice(0, 8)}…)`;
  };

  const global = state.secrets.filter((s) => !s.agentGroupId);
  const scoped = state.secrets.filter((s) => s.agentGroupId);

  return (
    <div>
      <div className="list-header">
        <h2>Secrets ({state.secrets.length})</h2>
        <button onClick={() => setShowCreate((v) => !v)}>
          {showCreate ? 'Cancel' : '+ New secret'}
        </button>
      </div>

      <p className="muted">
        Encrypted at rest under <code>~/.parachute/claw/master.key</code>. Injected into agent containers at session
        spawn — values are never read back over the API. To rotate, just create a new secret with the same name; the
        server upserts.
      </p>

      {showCreate && (
        <div className="section" style={{ marginTop: '1rem' }}>
          <h3>New secret</h3>
          <CredentialForm
            mode="free"
            onCancel={() => setShowCreate(false)}
            onCreated={() => {
              setShowCreate(false);
              reload();
            }}
          />
        </div>
      )}

      {actionError && <div className="error-banner">{actionError}</div>}

      {state.secrets.length === 0 && !showCreate && (
        <div className="empty empty-rich">
          <p className="empty-headline">No secrets yet.</p>
          <p className="muted">
            Add a channel token (Discord, Telegram) or an arbitrary API key. The setup wizard at{' '}
            <Link to="/setup">/setup</Link> walks you through wiring channel tokens.
          </p>
        </div>
      )}

      {global.length > 0 && (
        <SecretGroup label="Global" hint="Available to every agent container whose vault host pattern matches.">
          {global.map((s) => (
            <SecretRow key={s.id} s={s} groupName={groupName} busy={busyId === s.id} onDelete={onDelete} />
          ))}
        </SecretGroup>
      )}

      {scoped.length > 0 && (
        <SecretGroup label="Scoped to an agent group" hint="Only injected into containers for the bound group.">
          {scoped.map((s) => (
            <SecretRow key={s.id} s={s} groupName={groupName} busy={busyId === s.id} onDelete={onDelete} />
          ))}
        </SecretGroup>
      )}
    </div>
  );
}

function SecretGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <h3 style={{ margin: '0 0 0.25rem', fontSize: '0.85rem', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>
        {label}
      </h3>
      <p className="dim" style={{ margin: '0 0 0.5rem' }}>{hint}</p>
      <div>{children}</div>
    </div>
  );
}

function SecretRow({
  s,
  groupName,
  busy,
  onDelete,
}: {
  s: SecretView;
  groupName: (id: string | null) => string;
  busy: boolean;
  onDelete: (s: SecretView) => void;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0.75rem 1rem',
        background: 'white',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        marginBottom: '0.5rem',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <code style={{ fontSize: '0.95em' }}>{s.name}</code>
          <span className="tag muted">{s.kind}</span>
          {s.agentGroupId && <span className="tag">{groupName(s.agentGroupId)}</span>}
        </div>
        <div className="dim" style={{ marginTop: '0.25rem' }}>
          updated {new Date(s.updatedAt).toLocaleString()}
        </div>
      </div>
      <button
        type="button"
        className="secondary danger"
        onClick={() => onDelete(s)}
        disabled={busy}
        style={{ background: 'white', borderColor: 'var(--error)', color: 'var(--error)' }}
      >
        {busy ? 'Deleting…' : 'Delete'}
      </button>
    </div>
  );
}
