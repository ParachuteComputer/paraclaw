/**
 * /secrets — paraclaw-native secrets management view.
 *
 * Replaces the previous primitive list with an actual management surface:
 *   - search/filter (name + kind + group scope),
 *   - collapsible groups by kind (channel-token / api-key / generic),
 *   - mode badge (all | selective) with tooltip,
 *   - edit drawer for inject-mode + assignments + value rotation,
 *   - empty states with CTAs,
 *   - relative timestamps with absolute on hover.
 *
 * Wire surface:
 *   GET    /api/secrets
 *   POST   /api/secrets                          (create / rotate / mode-switch)
 *   DELETE /api/secrets/:id
 *   GET    /api/secrets/:id/assignments
 *   PUT    /api/secrets/:id/assignments
 *
 * Selective mode: secret only injects into agent groups listed in
 * secret_assignments (migration 016). Switching mode requires re-pasting
 * the value because the server's POST upsert wire requires `value`.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CredentialForm } from '../components/CredentialForm.tsx';
import { formatRelative } from '../components/StatusDot.tsx';
import {
  closeSession,
  deleteSecret,
  listGroups,
  listSecretAssignments,
  listSecrets,
  listStaleSessionsForSecret,
  putSecret,
  setSecretAssignments,
  type AgentGroupView,
  type AssignedMode,
  type SecretKind,
  type SecretView,
  type StaleSession,
} from '../lib/api.ts';

// Kind display order — channel-tokens first since they're the most common
// reason to open this page in the early-life of an install.
const KIND_ORDER: SecretKind[] = ['channel-token', 'api-key', 'generic'];

const KIND_LABEL: Record<SecretKind, string> = {
  'channel-token': 'Channel tokens',
  'api-key': 'API keys',
  generic: 'Other',
};

const KIND_HINT: Record<SecretKind, string> = {
  'channel-token': 'Bot tokens for chat platforms (Discord, Telegram, …).',
  'api-key': 'Long-lived API keys (OpenAI, Anthropic, vendor APIs).',
  generic: 'Anything else — env-var style key/values.',
};

interface LoadedState {
  kind: 'ok';
  secrets: SecretView[];
  groups: AgentGroupView[];
}

type State =
  | { kind: 'loading' }
  | LoadedState
  | { kind: 'error'; message: string };

export function SecretsList() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<SecretKind>>(new Set());
  const [editing, setEditing] = useState<SecretView | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listSecrets(), listGroups()])
      .then(([secrets, groups]) => {
        if (!cancelled) setState({ kind: 'ok', secrets, groups });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // Deep-link: `/secrets?edit=<id>` opens the editor for a specific secret
  // on mount. Used by GroupDetail's "Secrets" panel to jump straight from a
  // row to its editor (paraclaw#104). Strip the param after consuming it so
  // a manual reload doesn't keep popping the same dialog open.
  useEffect(() => {
    if (state.kind !== 'ok') return;
    const editId = searchParams.get('edit');
    if (!editId) return;
    const target = state.secrets.find((s) => s.id === editId);
    if (target) setEditing(target);
    setSearchParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('edit');
        return p;
      },
      { replace: true },
    );
  }, [state, searchParams, setSearchParams]);

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

  const toggleCollapsed = (k: SecretKind) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

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

  return (
    <LoadedView
      state={state}
      query={query}
      setQuery={setQuery}
      collapsed={collapsed}
      toggleCollapsed={toggleCollapsed}
      showCreate={showCreate}
      setShowCreate={setShowCreate}
      busyId={busyId}
      onDelete={onDelete}
      actionError={actionError}
      onEdit={setEditing}
      editing={editing}
      onCloseEditor={(changed) => {
        setEditing(null);
        if (changed) reload();
      }}
      reload={reload}
    />
  );
}

interface LoadedProps {
  state: LoadedState;
  query: string;
  setQuery: (q: string) => void;
  collapsed: Set<SecretKind>;
  toggleCollapsed: (k: SecretKind) => void;
  showCreate: boolean;
  setShowCreate: (v: boolean) => void;
  busyId: string | null;
  onDelete: (s: SecretView) => void;
  actionError: string | null;
  onEdit: (s: SecretView) => void;
  editing: SecretView | null;
  onCloseEditor: (changed: boolean) => void;
  reload: () => void;
}

function LoadedView(props: LoadedProps) {
  const {
    state,
    query,
    setQuery,
    collapsed,
    toggleCollapsed,
    showCreate,
    setShowCreate,
    busyId,
    onDelete,
    actionError,
    onEdit,
    editing,
    onCloseEditor,
    reload,
  } = props;

  const groupName = (id: string | null): string => {
    if (!id) return 'global';
    const g = state.groups.find((x) => x.id === id);
    return g ? g.name : `(unknown ${id.slice(0, 8)})`;
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return state.secrets;
    return state.secrets.filter((s) => {
      if (s.name.toLowerCase().includes(q)) return true;
      if (s.kind.toLowerCase().includes(q)) return true;
      if (KIND_LABEL[s.kind].toLowerCase().includes(q)) return true;
      const scope = groupName(s.agentGroupId).toLowerCase();
      if (scope.includes(q)) return true;
      if (s.assignedMode.toLowerCase().includes(q)) return true;
      return false;
    });
    // groupName depends on state.groups; lint will see state.secrets/state.groups.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, state.secrets, state.groups]);

  const byKind = useMemo(() => {
    const m = new Map<SecretKind, SecretView[]>();
    for (const k of KIND_ORDER) m.set(k, []);
    for (const s of filtered) {
      const list = m.get(s.kind) ?? [];
      list.push(s);
      m.set(s.kind, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return m;
  }, [filtered]);

  const totalShown = filtered.length;

  return (
    <div>
      <div className="list-header">
        <h2>Secrets ({state.secrets.length})</h2>
        <button onClick={() => setShowCreate(!showCreate)}>{showCreate ? 'Cancel' : '+ New secret'}</button>
      </div>

      <p className="muted">
        Encrypted at rest under <code>~/.parachute/agent/master.key</code>. Injected into agent containers at session
        spawn — values are never read back over the API. To rotate, edit a row.
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
          <div className="actions" style={{ marginTop: '1rem' }}>
            <button onClick={() => setShowCreate(true)}>+ Add your first secret</button>
          </div>
        </div>
      )}

      {state.secrets.length > 0 && (
        <div className="row" style={{ marginTop: '1.25rem' }}>
          <input
            type="search"
            placeholder="Filter by name, kind, or scope…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: '100%' }}
            aria-label="Filter secrets"
          />
        </div>
      )}

      {state.secrets.length > 0 && totalShown === 0 && (
        <div className="empty">No secrets match <code>{query}</code>.</div>
      )}

      {KIND_ORDER.map((k) => {
        const list = byKind.get(k) ?? [];
        if (list.length === 0) return null;
        const isCollapsed = collapsed.has(k);
        return (
          <SecretKindGroup
            key={k}
            kind={k}
            secrets={list}
            collapsed={isCollapsed}
            onToggle={() => toggleCollapsed(k)}
            groupName={groupName}
            busyId={busyId}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        );
      })}

      {editing && <SecretEditor secret={editing} groups={state.groups} onClose={onCloseEditor} />}
    </div>
  );
}

interface KindGroupProps {
  kind: SecretKind;
  secrets: SecretView[];
  collapsed: boolean;
  onToggle: () => void;
  groupName: (id: string | null) => string;
  busyId: string | null;
  onEdit: (s: SecretView) => void;
  onDelete: (s: SecretView) => void;
}

function SecretKindGroup({ kind, secrets, collapsed, onToggle, groupName, busyId, onEdit, onDelete }: KindGroupProps) {
  return (
    <div style={{ marginTop: '1.5rem' }}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        style={{
          background: 'transparent',
          color: 'var(--fg)',
          border: 0,
          padding: 0,
          margin: '0 0 0.25rem',
          fontSize: '0.85rem',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          fontWeight: 500,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          gap: '0.4rem',
        }}
      >
        <span style={{ fontSize: '0.7rem', color: 'var(--fg-muted)' }}>{collapsed ? '▸' : '▾'}</span>
        <span style={{ color: 'var(--fg-muted)' }}>{KIND_LABEL[kind]}</span>
        <span style={{ color: 'var(--fg-dim)', fontSize: '0.78rem', textTransform: 'none', letterSpacing: 0 }}>
          ({secrets.length})
        </span>
      </button>
      {!collapsed && (
        <>
          <p className="dim" style={{ margin: '0 0 0.5rem' }}>{KIND_HINT[kind]}</p>
          <div>
            {secrets.map((s) => (
              <SecretRow
                key={s.id}
                s={s}
                groupName={groupName}
                busy={busyId === s.id}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface RowProps {
  s: SecretView;
  groupName: (id: string | null) => string;
  busy: boolean;
  onEdit: (s: SecretView) => void;
  onDelete: (s: SecretView) => void;
}

function SecretRow({ s, groupName, busy, onEdit, onDelete }: RowProps) {
  const updatedAbs = new Date(s.updatedAt).toLocaleString();
  const modeTitle =
    s.assignedMode === 'all'
      ? 'Mode: all — injected into every agent container that resolves this name (subject to scope).'
      : 'Mode: selective — injected only into agent groups explicitly assigned (see Edit).';
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
          <span className={`tag ${s.assignedMode === 'selective' ? 'warn' : ''}`} title={modeTitle}>
            {s.assignedMode}
          </span>
          {s.agentGroupId ? (
            <span className="tag muted" title={`Scoped to agent group ${groupName(s.agentGroupId)}`}>
              {groupName(s.agentGroupId)}
            </span>
          ) : (
            <span className="tag muted" title="Global — available to every agent group">
              global
            </span>
          )}
        </div>
        <div className="dim" style={{ marginTop: '0.25rem' }} title={updatedAbs}>
          updated {formatRelative(s.updatedAt)}
        </div>
      </div>
      <button type="button" className="secondary" onClick={() => onEdit(s)} disabled={busy}>
        Edit
      </button>
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

interface EditorProps {
  secret: SecretView;
  groups: AgentGroupView[];
  onClose: (changed: boolean) => void;
}

/**
 * Edit drawer rendered as a native <dialog>. Concurrent edits in scope:
 *   1. Per-group accept-mode (only for SCOPED secrets — the radio flips the
 *      parent agent group's `secret_mode`, which gates how that group accepts
 *      every secret routed to it, not just this one).
 *   2. Selective assignments (multi-select agent groups). Always shown for
 *      globals; shown for scoped only when accept-mode is `selective`.
 *   3. Value rotation.
 *
 * Globals do NOT get a per-secret mode toggle: post-migration-023, mode lives
 * on the recipient agent group, so flipping a "mode" on a global has no
 * destination to land in (paraclaw#103 — Bug A: silent-mode-toggle on
 * globals). The assignment grid is the operator's actual handle for
 * scoping a global.
 *
 * Mode flips for SCOPED secrets still require value re-paste because the
 * server's POST upsert wire requires `value` and that's how the parent
 * group's mode change gets persisted today. Assignment-only edits go
 * straight to /assignments PUT and don't touch the secret value at all.
 *
 * Post-save, the editor probes /api/secrets/:id/stale-sessions and surfaces
 * a banner with [Restart] buttons when running containers were spawned
 * before this secret's last update — env vars are spawn-time-only, so a
 * mid-life edit is invisible to a container that's already running
 * (paraclaw#103 — Bug B: stale-container env).
 */
function SecretEditor({ secret, groups, onClose }: EditorProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const isGlobal = secret.agentGroupId === null;
  const groupName = secret.agentGroupId
    ? (groups.find((g) => g.id === secret.agentGroupId)?.name ?? secret.agentGroupId.slice(0, 8))
    : 'global';

  const [mode, setMode] = useState<AssignedMode>(secret.assignedMode);
  const [assignments, setAssignments] = useState<Set<string>>(new Set());
  const [assignmentsLoaded, setAssignmentsLoaded] = useState(false);
  const initialAssignmentsRef = useRef<Set<string> | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleSessions, setStaleSessions] = useState<StaleSession[] | null>(null);
  const [restartingId, setRestartingId] = useState<string | null>(null);
  const saved = staleSessions !== null;

  // Open the dialog on mount, close imperatively on unmount. Native <dialog>
  // gives us focus-trap + ESC-to-close for free.
  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  // Initial assignments fetch — fires once. Snapshot initial set into a ref
  // so assignmentsChanged can compare against the pristine state, not the
  // running edits.
  useEffect(() => {
    let cancelled = false;
    listSecretAssignments(secret.id)
      .then((ids) => {
        if (cancelled) return;
        const set = new Set(ids);
        setAssignments(set);
        initialAssignmentsRef.current = new Set(set);
        setAssignmentsLoaded(true);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`Couldn't load assignments: ${err instanceof Error ? err.message : String(err)}`);
        initialAssignmentsRef.current = new Set();
        setAssignmentsLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [secret.id]);

  const toggleAssignment = (groupId: string) =>
    setAssignments((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });

  // Mode changes only have meaning for SCOPED secrets — for globals there
  // is no parent group to flip, so we never expose a UI for it.
  const modeChanged = !isGlobal && mode !== secret.assignedMode;
  const assignmentsChanged = (() => {
    if (!assignmentsLoaded || !initialAssignmentsRef.current) return false;
    const init = initialAssignmentsRef.current;
    if (init.size !== assignments.size) return true;
    for (const id of assignments) if (!init.has(id)) return true;
    return false;
  })();
  const valueProvided = value.trim().length > 0;

  // Globals: always show the assignment grid (it's the only handle).
  // Scoped: show only when accept-mode is `selective` (else group accepts all).
  const showAssignmentsGrid = isGlobal || mode === 'selective';

  const save = async () => {
    setError(null);
    if (modeChanged && !valueProvided) {
      setError(
        `Changing how ${groupName} accepts secrets requires re-pasting this secret's value (the server upsert wire requires it).`,
      );
      return;
    }
    setBusy(true);
    try {
      if (valueProvided) {
        await putSecret({
          name: secret.name,
          value: value.trim(),
          kind: secret.kind,
          agentGroupId: secret.agentGroupId,
          // Globals have no parent group to land mode on — sending it would
          // silently no-op on the server. Scoped flips the parent group.
          assignedMode: isGlobal ? undefined : mode,
        });
      }
      // Push assignments whenever they changed, OR whenever we just upserted
      // the secret with selective mode (so the join-table reflects intent
      // even on first switch).
      if (showAssignmentsGrid && (assignmentsChanged || (modeChanged && valueProvided))) {
        await setSecretAssignments(secret.id, Array.from(assignments));
      }
      // Probe staleness — running containers spawned before this update
      // won't see the change until next session spawn. Banner stays open
      // so the operator can restart specific sessions inline.
      const stale = await listStaleSessionsForSecret(secret.id);
      setStaleSessions(stale);
      if (stale.length === 0) {
        onClose(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const restartSession = async (sessionId: string) => {
    setError(null);
    setRestartingId(sessionId);
    try {
      await closeSession(sessionId);
      setStaleSessions((prev) => (prev ?? []).filter((s) => s.sessionId !== sessionId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestartingId(null);
    }
  };

  const restartAll = async () => {
    if (!staleSessions || staleSessions.length === 0) return;
    if (
      !window.confirm(
        `Restart ${staleSessions.length} agent session(s)? Each agent's current conversation will end and a fresh container will spawn on next inbound message.`,
      )
    ) {
      return;
    }
    setError(null);
    setBusy(true);
    // Sequential — count is small (one running container per agent group),
    // and serializing keeps the runtime from being hammered with concurrent
    // killContainer calls in the rare large-fanout case. Track successes
    // inside the loop so a mid-run throw on session N doesn't leave the
    // banner showing 1..N-1 as still-stale (they were already closed).
    const closed = new Set<string>();
    try {
      for (const s of staleSessions) {
        await closeSession(s.sessionId);
        closed.add(s.sessionId);
      }
      setStaleSessions([]);
    } catch (err) {
      setStaleSessions((prev) => (prev ?? []).filter((s) => !closed.has(s.sessionId)));
      setError(
        `Restarted ${closed.size}/${staleSessions.length} session(s); ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  };

  const noAssignmentsWarn = !isGlobal && mode === 'selective' && assignmentsLoaded && assignments.size === 0;

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onClose(saved)}
      className="secret-editor"
      style={{
        width: 'min(560px, 92vw)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: 0,
        background: 'white',
      }}
    >
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
              <code>{secret.name}</code>
            </h3>
            <button
              type="button"
              className="secondary"
              onClick={() => onClose(saved)}
              style={{ padding: '0.3rem 0.7rem' }}
              aria-label="Close"
            >
              ✕
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', flexWrap: 'wrap' }}>
            <span className="tag muted">{secret.kind}</span>
            <span className="tag muted">{groupName}</span>
          </div>
          <div className="dim" style={{ marginTop: '0.5rem' }}>
            created <span title={new Date(secret.createdAt).toLocaleString()}>{formatRelative(secret.createdAt)}</span>
            {' • '}updated <span title={new Date(secret.updatedAt).toLocaleString()}>{formatRelative(secret.updatedAt)}</span>
          </div>
        </div>

        <div style={{ padding: '1.25rem 1.5rem' }}>
          {error && <div className="error-banner">{error}</div>}

          {!saved && (
            <>
              {isGlobal ? (
                <p className="dim" style={{ marginBottom: '1rem' }}>
                  <strong>Global secret.</strong> Eligible for every agent group. Inject targets are the groups
                  checked below, plus any group whose own accept-mode is <code>all</code>. Per-group accept-mode
                  lives on the agent group, not the secret.
                </p>
              ) : (
                <div className="row">
                  <label>
                    <strong>{groupName}</strong> accepts
                  </label>
                  <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap' }}>
                    <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 400 }}>
                      <input
                        type="radio"
                        name="mode"
                        value="all"
                        checked={mode === 'all'}
                        onChange={() => setMode('all')}
                        disabled={busy}
                      />
                      <span>all in-scope secrets</span>
                    </label>
                    <label style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center', fontWeight: 400 }}>
                      <input
                        type="radio"
                        name="mode"
                        value="selective"
                        checked={mode === 'selective'}
                        onChange={() => setMode('selective')}
                        disabled={busy}
                      />
                      <span>only assigned secrets</span>
                    </label>
                  </div>
                  <p className="dim" style={{ marginTop: '0.4rem' }}>
                    This setting controls how <strong>{groupName}</strong> accepts secrets from any source — not
                    just this one. Changing it affects every secret destined for this group.
                  </p>
                </div>
              )}

              {showAssignmentsGrid && (
                <div className="row">
                  <p className="dim" style={{ marginTop: 0, marginBottom: '0.5rem' }}>
                    Secrets are injected into agent containers at <strong>session spawn</strong>. Changes apply to new
                    sessions; running containers won't see them until restarted (the post-save banner below flags any
                    affected sessions, with a one-click Restart per session).
                  </p>
                  <label>Assigned to ({assignments.size})</label>
                  {!assignmentsLoaded && <p className="dim">Loading current assignments…</p>}
                  {assignmentsLoaded && groups.length === 0 && (
                    <p className="dim">No agent groups exist yet — create one to assign this secret.</p>
                  )}
                  {assignmentsLoaded && groups.length > 0 && (
                    <div
                      style={{
                        display: 'grid',
                        gap: '0.35rem',
                        maxHeight: '14rem',
                        overflowY: 'auto',
                        border: '1px solid var(--border)',
                        borderRadius: 6,
                        padding: '0.5rem 0.75rem',
                      }}
                    >
                      {groups.map((g) => (
                        <label
                          key={g.id}
                          style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 400 }}
                        >
                          <input
                            type="checkbox"
                            checked={assignments.has(g.id)}
                            onChange={() => toggleAssignment(g.id)}
                            disabled={busy}
                          />
                          <span>{g.name}</span>
                          <code style={{ fontSize: '0.78rem', color: 'var(--fg-dim)' }}>{g.folder}</code>
                        </label>
                      ))}
                    </div>
                  )}
                  {noAssignmentsWarn && (
                    <div className="warn-banner" style={{ marginTop: '0.5rem' }}>
                      Selective mode with zero assignments — this secret will inject into nothing. OK if intentional,
                      but containers that read this name will see it as unset.
                    </div>
                  )}
                </div>
              )}

              <div className="row">
                <label htmlFor="rotateValue">
                  {modeChanged ? 'Value (required to apply accept-mode change)' : 'Rotate value (optional)'}
                </label>
                <input
                  id="rotateValue"
                  type="password"
                  autoComplete="off"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={busy}
                  placeholder={modeChanged ? 'paste current value' : 'leave blank to keep current value'}
                />
                <p className="dim" style={{ marginTop: '0.25rem' }}>
                  Value is never read back over the API; rotating writes a new ciphertext under the same name.
                </p>
              </div>

              <div className="actions" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
                <button type="button" className="secondary" onClick={() => onClose(false)} disabled={busy}>
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={save}
                  disabled={busy || (!modeChanged && !assignmentsChanged && !valueProvided)}
                >
                  {busy ? 'Saving…' : 'Save changes'}
                </button>
              </div>
            </>
          )}

          {saved && (
            <StalenessBanner
              staleSessions={staleSessions ?? []}
              restartingId={restartingId}
              busy={busy}
              onRestart={restartSession}
              onRestartAll={restartAll}
              onDone={() => onClose(true)}
            />
          )}
        </div>
      </form>
    </dialog>
  );
}

interface StalenessBannerProps {
  staleSessions: StaleSession[];
  restartingId: string | null;
  busy: boolean;
  onRestart: (sessionId: string) => void;
  onRestartAll: () => void;
  onDone: () => void;
}

/**
 * Post-save banner. Lists running containers spawned BEFORE the secret's
 * latest update — they won't see the change until next spawn. The operator
 * can restart specific sessions or all at once. "Done" closes the editor
 * regardless of whether any restart happened.
 */
function StalenessBanner({
  staleSessions,
  restartingId,
  busy,
  onRestart,
  onRestartAll,
  onDone,
}: StalenessBannerProps) {
  if (staleSessions.length === 0) {
    return (
      <div className="row">
        <p>Saved. No outstanding stale containers.</p>
        <div className="actions" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
          <button type="button" onClick={onDone}>
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="row">
      <div className="warn-banner" style={{ marginBottom: '1rem' }}>
        <strong>
          {staleSessions.length} running {staleSessions.length === 1 ? 'container was' : 'containers were'} spawned
          before this change.
        </strong>{' '}
        Env vars are baked at spawn time, so the new value won't reach{' '}
        {staleSessions.length === 1 ? 'it' : 'them'} until next session. Restart to apply.
      </div>
      <div
        style={{
          display: 'grid',
          gap: '0.5rem',
          border: '1px solid var(--border)',
          borderRadius: 6,
          padding: '0.5rem 0.75rem',
        }}
      >
        {staleSessions.map((s) => (
          <div
            key={s.sessionId}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}
          >
            <div style={{ minWidth: 0, flex: 1 }}>
              <div>
                <strong>{s.agentGroupName}</strong>{' '}
                <code style={{ fontSize: '0.78rem', color: 'var(--fg-dim)' }}>{s.agentGroupFolder}</code>
              </div>
              <div className="dim" style={{ fontSize: '0.85em' }} title={new Date(s.sessionCreatedAt).toLocaleString()}>
                spawned {formatRelative(s.sessionCreatedAt)}
              </div>
            </div>
            <button
              type="button"
              className="secondary"
              onClick={() => onRestart(s.sessionId)}
              disabled={busy || restartingId === s.sessionId}
            >
              {restartingId === s.sessionId ? 'Restarting…' : 'Restart'}
            </button>
          </div>
        ))}
      </div>
      <div className="actions" style={{ marginTop: '1rem', justifyContent: 'space-between' }}>
        <button type="button" className="secondary" onClick={onRestartAll} disabled={busy}>
          {busy ? 'Restarting all…' : `Restart all ${staleSessions.length}`}
        </button>
        <button type="button" onClick={onDone} disabled={busy}>
          Done
        </button>
      </div>
    </div>
  );
}
