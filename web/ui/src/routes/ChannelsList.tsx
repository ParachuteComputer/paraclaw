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
 *   - Routing rules → opens /channels/mga/:id, the per-wire detail page
 *                     (engage mode editor, sender scope, ignored policy,
 *                     priority, hard-delete).
 *   - Group settings → opens /channels/mg/:id, the messaging-group page
 *                      (unknown-sender policy + denied-channel banner).
 *
 * New wirings are created by the setup wizard — there's no "+ new wire"
 * button here, by design. The wizard owns the channel-token-validate +
 * platform-id-capture dance; doing it here would just duplicate that
 * surface.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { listChannelWires, type ChannelWireView } from '../lib/api.ts';

export function ChannelsList() {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; wires: ChannelWireView[] } | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

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

      {state.wires.length === 0 && (
        <div className="empty empty-rich" style={{ marginTop: '1rem' }}>
          <p className="empty-headline">No channels wired yet.</p>
          <p className="muted">
            <Link to="/channels/new">Wire a new channel</Link> to route Discord or Telegram DMs into an agent group.
          </p>
        </div>
      )}

      {state.wires.map((w) => (
        <ChannelRow key={w.id} wire={w} />
      ))}
    </div>
  );
}

function ChannelRow({ wire }: { wire: ChannelWireView }) {
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
          {wire.engagePattern && (
            <>
              {' '}
              · pattern <code>{wire.engagePattern}</code>
            </>
          )}
        </div>
        <div>senders</div>
        <div>{wire.senderScope}</div>
        <div>ignored</div>
        <div>{wire.ignoredMessagePolicy}</div>
      </div>
      <div className="actions" style={{ marginTop: '0.75rem' }}>
        <Link to={`/channels/mga/${encodeURIComponent(wire.id)}`}>
          <button className="secondary">Routing rules →</button>
        </Link>
        <Link to={`/channels/mg/${encodeURIComponent(wire.messagingGroupId)}`}>
          <button className="secondary">Group settings →</button>
        </Link>
      </div>
    </div>
  );
}
