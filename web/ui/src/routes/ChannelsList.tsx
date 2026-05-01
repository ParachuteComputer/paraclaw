/**
 * /channels — global view of every channel wiring.
 *
 * A "wiring" binds a messaging-platform thread (a Discord DM, a Telegram
 * chat, a CLI client) to an agent group with routing rules: how the
 * agent decides whether to engage on a given inbound message
 * (engageMode + engagePattern), who's allowed to talk to it
 * (senderScope), what to do with messages it ignores
 * (ignoredMessagePolicy), and a tie-break priority when multiple wirings
 * could match.
 *
 * Per-wire actions:
 *   - Edit  : open an inline editor for the routing fields above.
 *   - Remove: hard-delete the wiring (no confirmation step beyond
 *             native confirm()). The associated messaging_groups +
 *             messaging_group_agents rows are cleaned up server-side.
 *
 * New wirings are created by the setup wizard — there's no "+ new wire"
 * button here, by design. The wizard owns the channel-token-validate +
 * platform-id-capture dance; doing it here would just duplicate that
 * surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  deleteChannelWire,
  listChannelWires,
  updateChannelWire,
  type ChannelWireView,
  type EngageMode,
  type IgnoredMessagePolicy,
  type SenderScope,
  type UpdateChannelWireInput,
} from '../lib/api.ts';

export function ChannelsList() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; wires: ChannelWireView[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    listChannelWires()
      .then((wires) => !cancelled && setState({ kind: 'ok', wires }))
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

  const onDelete = async (w: ChannelWireView) => {
    if (
      !confirm(
        `Remove ${w.channelType} wire to ${w.agentGroupName}? Inbound messages on this thread will fall back to the unwired-channel guard (silently dropped).`,
      )
    ) {
      return;
    }
    setBusyId(w.id);
    setActionError(null);
    try {
      await deleteChannelWire(w.id);
      reload();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const onSave = async (id: string, input: UpdateChannelWireInput) => {
    setBusyId(id);
    setActionError(null);
    try {
      await updateChannelWire(id, input);
      setEditingId(null);
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
        <h2>Channels</h2>
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
        <h2>Channels</h2>
        <div className="error-banner">
          Couldn't load channels: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Channel wirings ({state.wires.length})</h2>
        <Link to="/channels/new">
          <button className="secondary">+ Wire a new channel</button>
        </Link>
      </div>

      <p className="muted">
        Each wire binds a messaging thread (DM, channel, chat) to an agent group with routing rules. New wirings go
        through the <Link to="/channels/new">wire-channel page</Link> so the channel token can be validated and the
        platform id captured.
      </p>

      {actionError && <div className="error-banner">{actionError}</div>}

      {state.wires.length === 0 && (
        <div className="empty empty-rich" style={{ marginTop: '1rem' }}>
          <p className="empty-headline">No channels wired yet.</p>
          <p className="muted">
            <Link to="/channels/new">Wire a new channel</Link> to route Discord or Telegram DMs into an agent group.
          </p>
        </div>
      )}

      {state.wires.map((w) =>
        editingId === w.id ? (
          <ChannelEditor
            key={w.id}
            wire={w}
            saving={busyId === w.id}
            onCancel={() => setEditingId(null)}
            onSave={(input) => onSave(w.id, input)}
          />
        ) : (
          <ChannelRow
            key={w.id}
            wire={w}
            busy={busyId === w.id}
            onEdit={() => setEditingId(w.id)}
            onDelete={() => onDelete(w)}
          />
        ),
      )}
    </div>
  );
}

function ChannelRow({
  wire,
  busy,
  onEdit,
  onDelete,
}: {
  wire: ChannelWireView;
  busy: boolean;
  onEdit: () => void;
  onDelete: () => void;
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
        <strong style={{ textTransform: 'capitalize' }}>{wire.channelType}</strong>
        <span className="dim">→</span>
        <Link to={`/groups/${encodeURIComponent(wire.agentGroupFolder)}`}>{wire.agentGroupName}</Link>
        <span className="tag muted">priority {wire.priority}</span>
      </div>
      <div className="kv" style={{ marginTop: '0.6rem' }}>
        <div>platform id</div>
        <div>
          <code>{wire.platformId}</code>
          {wire.displayName && <span className="dim"> · {wire.displayName}</span>}
        </div>
        <div>engage</div>
        <div>
          {wire.engageMode}
          {wire.engagePattern && <> · pattern <code>{wire.engagePattern}</code></>}
        </div>
        <div>senders</div>
        <div>{wire.senderScope}</div>
        <div>ignored</div>
        <div>{wire.ignoredMessagePolicy}</div>
      </div>
      <div className="actions" style={{ marginTop: '0.75rem' }}>
        <button className="secondary" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button
          className="secondary"
          onClick={onDelete}
          disabled={busy}
          style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
        >
          {busy ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  );
}

function ChannelEditor({
  wire,
  saving,
  onCancel,
  onSave,
}: {
  wire: ChannelWireView;
  saving: boolean;
  onCancel: () => void;
  onSave: (input: UpdateChannelWireInput) => void;
}) {
  const [engageMode, setEngageMode] = useState<EngageMode>(wire.engageMode);
  const [engagePattern, setEngagePattern] = useState(wire.engagePattern ?? '');
  const [senderScope, setSenderScope] = useState<SenderScope>(wire.senderScope);
  const [ignoredMessagePolicy, setIgnoredMessagePolicy] = useState<IgnoredMessagePolicy>(wire.ignoredMessagePolicy);
  const [priority, setPriority] = useState(String(wire.priority));

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const parsedPriority = Number.parseInt(priority, 10);
    onSave({
      engageMode,
      engagePattern: engageMode === 'pattern' ? engagePattern.trim() || null : null,
      senderScope,
      ignoredMessagePolicy,
      priority: Number.isFinite(parsedPriority) ? parsedPriority : wire.priority,
    });
  };

  return (
    <form
      onSubmit={onSubmit}
      style={{
        background: 'white',
        border: '1px solid var(--accent)',
        borderRadius: '8px',
        padding: '1rem 1.25rem',
        marginBottom: '0.75rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.75rem' }}>
        <strong style={{ textTransform: 'capitalize' }}>Editing {wire.channelType}</strong>
        <span className="dim">→ {wire.agentGroupName}</span>
      </div>

      <div className="row">
        <label htmlFor="engageMode">Engage mode</label>
        <select
          id="engageMode"
          value={engageMode}
          onChange={(e) => setEngageMode(e.target.value as EngageMode)}
          disabled={saving}
        >
          <option value="all">all — agent responds to every message</option>
          <option value="mention">mention — only when @-tagged</option>
          <option value="pattern">pattern — when text matches a regex</option>
        </select>
      </div>

      {engageMode === 'pattern' && (
        <div className="row">
          <label htmlFor="engagePattern">Engage pattern (regex)</label>
          <input
            id="engagePattern"
            type="text"
            value={engagePattern}
            onChange={(e) => setEngagePattern(e.target.value)}
            placeholder="^/ask\b"
            disabled={saving}
          />
        </div>
      )}

      <div className="row">
        <label htmlFor="senderScope">Sender scope</label>
        <select
          id="senderScope"
          value={senderScope}
          onChange={(e) => setSenderScope(e.target.value as SenderScope)}
          disabled={saving}
        >
          <option value="all">all — anyone in the thread</option>
          <option value="allowlist">allowlist — only members of the agent group</option>
        </select>
      </div>

      <div className="row">
        <label htmlFor="ignoredMessagePolicy">Ignored-message policy</label>
        <select
          id="ignoredMessagePolicy"
          value={ignoredMessagePolicy}
          onChange={(e) => setIgnoredMessagePolicy(e.target.value as IgnoredMessagePolicy)}
          disabled={saving}
        >
          <option value="drop">drop — discard, no record</option>
          <option value="silent">silent — log but don't reply</option>
        </select>
      </div>

      <div className="row">
        <label htmlFor="priority">Priority</label>
        <input
          id="priority"
          type="number"
          value={priority}
          onChange={(e) => setPriority(e.target.value)}
          disabled={saving}
          style={{ width: '6rem' }}
        />
        <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
          Higher wins when multiple wires could match the same inbound.
        </p>
      </div>

      <div className="actions">
        <button type="button" className="secondary" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
