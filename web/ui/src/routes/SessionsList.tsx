/**
 * /sessions — global session listing across every agent group.
 *
 * The per-group view is on /groups/:folder; this is the flat
 * cross-group inventory the operator uses to spot stuck containers,
 * compare activity, and reap idle sessions.
 *
 * "Close" is a hard-stop: the server flips status to closed and signals
 * the container to exit. Re-opening a closed session is a re-spawn (new
 * container, new id) — the button copy reflects that.
 *
 * The list polls every 7s like /groups so heartbeat freshness stays
 * accurate without a manual refresh. Unlike /groups, sessions don't
 * dedupe — each row is its own thing — so we sort by lastActiveAt desc
 * to keep the most recent at the top.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { formatRelative } from '../components/StatusDot.tsx';
import { closeSession, listSessions, type SessionView } from '../lib/api.ts';

const POLL_MS = 7_000;

export function SessionsList() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; sessions: SessionView[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    listSessions()
      .then((sessions) => !cancelled && setState({ kind: 'ok', sessions }))
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

  useEffect(() => {
    if (state.kind !== 'ok') return;
    let cancelled = false;
    const t = setInterval(() => {
      listSessions()
        .then((sessions) => !cancelled && setState({ kind: 'ok', sessions }))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state.kind]);

  const onClose = async (s: SessionView) => {
    if (!confirm(`Close session ${s.id.slice(0, 8)}… for ${s.agentGroupName}? The container will be stopped.`)) {
      return;
    }
    setBusyId(s.id);
    setActionError(null);
    try {
      await closeSession(s.id);
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
        <h2>Sessions</h2>
        <ul className="skeleton-list" aria-busy="true">
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
        </ul>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div>
        <h2>Sessions</h2>
        <div className="error-banner">
          Couldn't load sessions: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  const active = state.sessions.filter((s) => s.status === 'active');
  const closed = state.sessions.filter((s) => s.status !== 'active');
  const sortByActive = (a: SessionView, b: SessionView) => {
    const aT = a.lastActiveAt ? Date.parse(a.lastActiveAt) : 0;
    const bT = b.lastActiveAt ? Date.parse(b.lastActiveAt) : 0;
    return bT - aT;
  };
  active.sort(sortByActive);
  closed.sort(sortByActive);

  return (
    <div>
      <div className="list-header">
        <h2>Sessions ({active.length} active)</h2>
        <button className="secondary" onClick={reload}>Refresh</button>
      </div>

      <p className="muted">
        Per-session containers across every agent group. Stuck containers can be hard-closed here; re-opening is a
        new spawn from the agent group page.
      </p>

      {actionError && <div className="error-banner">{actionError}</div>}

      {state.sessions.length === 0 && (
        <div className="empty empty-rich" style={{ marginTop: '1rem' }}>
          <p className="empty-headline">No sessions yet.</p>
          <p className="muted">
            Sessions are spawned when a wired channel receives an inbound message, or via the spawn button on an{' '}
            <Link to="/">agent group</Link>.
          </p>
        </div>
      )}

      {active.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          {active.map((s) => (
            <SessionRow key={s.id} s={s} busy={busyId === s.id} onClose={onClose} />
          ))}
        </div>
      )}

      {closed.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h3 style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>
            Closed (recent)
          </h3>
          {closed.slice(0, 20).map((s) => (
            <SessionRow key={s.id} s={s} busy={false} onClose={() => {}} closed />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  s,
  busy,
  onClose,
  closed,
}: {
  s: SessionView;
  busy: boolean;
  onClose: (s: SessionView) => void;
  closed?: boolean;
}) {
  const containerColor =
    s.containerStatus === 'running' ? 'var(--accent)' : s.containerStatus === 'idle' ? 'var(--warn)' : 'var(--fg-dim)';
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
        opacity: closed ? 0.7 : 1,
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to={`/groups/${encodeURIComponent(s.agentGroupFolder)}`} style={{ fontWeight: 500 }}>
            {s.agentGroupName}
          </Link>
          <span style={{ color: containerColor, fontSize: '0.85rem' }}>● {s.containerStatus}</span>
          {!s.alive && s.status === 'active' && <span className="tag warn">no heartbeat</span>}
        </div>
        <div className="dim" style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}>
          <code>{s.id.slice(0, 12)}…</code>
          {s.messagingGroupId && <> · channel <code>{s.messagingGroupId.slice(0, 8)}…</code></>}
          {s.lastActiveAt && <> · last active {formatRelative(s.lastActiveAt)}</>}
          {!s.lastActiveAt && <> · created {formatRelative(s.createdAt)}</>}
        </div>
      </div>
      {!closed && (
        <button
          type="button"
          className="secondary"
          onClick={() => onClose(s)}
          disabled={busy}
          style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
        >
          {busy ? 'Closing…' : 'Close'}
        </button>
      )}
    </div>
  );
}
