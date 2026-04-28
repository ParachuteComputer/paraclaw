/**
 * /approvals — pending action approvals.
 *
 * Surfaces the queue of human-consent-required actions agents have
 * requested: install_packages, add_mcp_server, access-new-credential
 * (the v1 set per PRIMITIVES.md). Operator approves or rejects; on
 * decision the agent's pending tool call is unblocked or aborted.
 *
 * Polling: light-touch every 7s so newly-arrived approvals appear
 * without a refresh. The server-side queue is small by construction
 * (one pending per session-tool-call), so re-fetching the whole list
 * is cheap.
 *
 * Payload rendering: each approval kind has a known payload shape;
 * we render kind-specific summaries inline (package names, MCP name,
 * credential name) and dump the rest as JSON for transparency. The
 * fallback is meant to age gracefully — when a new approval kind
 * lands server-side the UI still renders something readable instead
 * of a blank row.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  decideApproval,
  listApprovals,
  type ApprovalDecision,
  type ApprovalView,
} from '../lib/api.ts';

const POLL_MS = 7_000;

export function ApprovalsList() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; approvals: ApprovalView[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    listApprovals()
      .then((approvals) => !cancelled && setState({ kind: 'ok', approvals }))
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

  // Light background poll so a freshly-requested approval shows up without
  // the operator having to hit refresh. We don't flip back to loading on
  // poll error — last-good wins.
  useEffect(() => {
    if (state.kind !== 'ok') return;
    let cancelled = false;
    const t = setInterval(() => {
      listApprovals()
        .then((approvals) => !cancelled && setState({ kind: 'ok', approvals }))
        .catch(() => {});
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state.kind]);

  const onDecide = async (a: ApprovalView, decision: ApprovalDecision) => {
    const verb = decision === 'approve' ? 'Approve' : 'Reject';
    if (!confirm(`${verb} ${a.kind} for ${a.agentGroupName ?? 'agent group'}?`)) return;
    setBusyId(a.id);
    setActionError(null);
    try {
      await decideApproval(a.id, decision);
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
        <h2>Approvals</h2>
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
        <h2>Approvals</h2>
        <div className="error-banner">
          Couldn't load approvals: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  const pending = state.approvals.filter((a) => a.status === 'pending');
  const decided = state.approvals.filter((a) => a.status !== 'pending');

  return (
    <div>
      <div className="list-header">
        <h2>Approvals ({pending.length} pending)</h2>
        <button className="secondary" onClick={reload}>Refresh</button>
      </div>

      <p className="muted">
        Agents request approval for sensitive actions (install packages, add an MCP server, use a new credential).
        Approving unblocks the in-flight tool call; rejecting aborts it.
      </p>

      {actionError && <div className="error-banner">{actionError}</div>}

      {pending.length === 0 && (
        <div className="empty empty-rich" style={{ marginTop: '1rem' }}>
          <p className="empty-headline">No pending approvals.</p>
          <p className="muted">When an agent requests a sensitive action, it'll show up here.</p>
        </div>
      )}

      {pending.map((a) => (
        <ApprovalRow key={a.id} a={a} busy={busyId === a.id} onDecide={onDecide} />
      ))}

      {decided.length > 0 && (
        <div style={{ marginTop: '2rem' }}>
          <h3 style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>
            Recently decided
          </h3>
          {decided.slice(0, 10).map((a) => (
            <DecidedRow key={a.id} a={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalRow({
  a,
  busy,
  onDecide,
}: {
  a: ApprovalView;
  busy: boolean;
  onDecide: (a: ApprovalView, decision: ApprovalDecision) => void;
}) {
  return (
    <div
      style={{
        background: 'white',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '1rem 1.25rem',
        marginBottom: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
        <strong>{prettyKind(a.kind)}</strong>
        <span className="tag muted">{a.agentGroupName ?? a.agentGroupId.slice(0, 8) + '…'}</span>
        <span className="dim" style={{ marginLeft: 'auto' }}>
          requested {new Date(a.requestedAt).toLocaleString()}
        </span>
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        <PayloadSummary kind={a.kind} payload={a.actionPayload} />
      </div>

      <div className="actions" style={{ marginTop: '0.75rem' }}>
        <button
          className="secondary"
          onClick={() => onDecide(a, 'reject')}
          disabled={busy}
          style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
        >
          Reject
        </button>
        <button onClick={() => onDecide(a, 'approve')} disabled={busy}>
          {busy ? 'Deciding…' : 'Approve'}
        </button>
      </div>
    </div>
  );
}

function DecidedRow({ a }: { a: ApprovalView }) {
  const color = a.status === 'approved' ? 'var(--accent)' : a.status === 'rejected' ? 'var(--error)' : 'var(--fg-dim)';
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        padding: '0.5rem 0.75rem',
        borderBottom: '1px solid var(--border)',
        fontSize: '0.92rem',
      }}
    >
      <span style={{ color, fontWeight: 500, minWidth: '5rem' }}>{a.status}</span>
      <span>{prettyKind(a.kind)}</span>
      <span className="dim">{a.agentGroupName ?? a.agentGroupId.slice(0, 8) + '…'}</span>
      <span className="dim" style={{ marginLeft: 'auto' }}>
        {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : '—'}
      </span>
    </div>
  );
}

function prettyKind(kind: string): string {
  switch (kind) {
    case 'install_packages':
      return 'Install packages';
    case 'add_mcp_server':
      return 'Add MCP server';
    case 'access-new-credential':
      return 'Access new credential';
    default:
      return kind;
  }
}

function PayloadSummary({ kind, payload }: { kind: string; payload: Record<string, unknown> }) {
  if (kind === 'install_packages') {
    const pkgs = Array.isArray(payload.packages) ? (payload.packages as unknown[]) : null;
    if (pkgs && pkgs.every((p) => typeof p === 'string')) {
      return (
        <p className="muted" style={{ margin: 0 }}>
          Wants to install: {(pkgs as string[]).map((p) => <code key={p} style={{ marginRight: '0.4rem' }}>{p}</code>)}
        </p>
      );
    }
  }
  if (kind === 'add_mcp_server') {
    const name = typeof payload.name === 'string' ? payload.name : null;
    const url = typeof payload.url === 'string' ? payload.url : null;
    if (name) {
      return (
        <p className="muted" style={{ margin: 0 }}>
          Wants to wire MCP server <code>{name}</code>
          {url && <> at <code>{url}</code></>}.
        </p>
      );
    }
  }
  if (kind === 'access-new-credential') {
    const name = typeof payload.name === 'string' ? payload.name : null;
    if (name) {
      return (
        <p className="muted" style={{ margin: 0 }}>
          First-time access to credential <code>{name}</code>.
        </p>
      );
    }
  }
  return (
    <details>
      <summary className="dim" style={{ cursor: 'pointer' }}>action payload</summary>
      <pre
        style={{
          margin: '0.5rem 0 0',
          padding: '0.5rem 0.75rem',
          background: 'var(--bg-soft)',
          borderRadius: '6px',
          fontSize: '0.82rem',
          overflow: 'auto',
        }}
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
    </details>
  );
}
