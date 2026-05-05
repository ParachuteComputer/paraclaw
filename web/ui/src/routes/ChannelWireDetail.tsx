/**
 * /channels/mga/:id — per-wire (messaging-group ↔ agent-group) detail +
 * routing-rules editor.
 *
 * What's here:
 *   - read-only metadata (linked target group, parent messaging group, channel,
 *     platform id, priority, created)
 *   - the routing rules editor: engage mode (mention | all | pattern), pattern,
 *     sender scope, ignored-message policy, priority
 *   - delete-wire action with native confirm
 *
 * The MGA-id is a UUID generated server-side; the disambiguation prefix
 * `mga/` keeps the route clean against per-MG routes (`mg/`).
 *
 * `engageMode = 'mention'` is the surface for "respond only to mentions".
 * The DB-side enum has a third state `mention-sticky` that the server
 * collapses to `'mention'` for display and preserves on PATCH so a future
 * sticky-aware editor doesn't silently downgrade existing wires.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  deleteChannelWire,
  getChannelWireDetail,
  HttpError,
  updateChannelWire,
  type ChannelWireView,
  type EngageMode,
  type IgnoredMessagePolicy,
  type SenderScope,
  type UpdateChannelWireInput,
} from '../lib/api.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; wire: ChannelWireView }
  | { kind: 'error'; status: number | null; message: string };

export function ChannelWireDetail() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = rawId ?? '';
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!id) {
      setState({ kind: 'error', status: null, message: 'no wire id in URL' });
      return;
    }
    let cancelled = false;
    getChannelWireDetail(id)
      .then((wire) => !cancelled && setState({ kind: 'ok', wire }))
      .catch((err) => {
        if (cancelled) return;
        const status = err instanceof HttpError ? err.status : null;
        setState({
          kind: 'error',
          status,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [id, reloadKey]);

  if (state.kind === 'loading') {
    return (
      <div>
        <h2>Channel wire</h2>
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
        <h2>Channel wire</h2>
        <div className="error-banner">
          {state.status === 404 ? (
            <>
              No wire with id <code>{id}</code> — it may have been removed.
            </>
          ) : (
            <>
              Couldn't load this wire: <code>{state.message}</code>
            </>
          )}
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <Link to="/channels">
            <button className="secondary">Back to channels</button>
          </Link>
          {state.status !== 404 && <button onClick={reload}>Retry</button>}
        </div>
      </div>
    );
  }

  const { wire } = state;

  const onSave = async (input: UpdateChannelWireInput) => {
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await updateChannelWire(id, input);
      setState({ kind: 'ok', wire: updated });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const onDelete = async () => {
    if (
      !confirm(
        `Remove ${wire.channelType} wire to ${wire.agentGroupName}? Inbound messages on this thread will fall back to the unwired-channel guard (silently dropped).`,
      )
    ) {
      return;
    }
    setDeleting(true);
    setSaveError(null);
    try {
      await deleteChannelWire(id);
      setState({ kind: 'error', status: 404, message: 'wire deleted' });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  return (
    <div>
      <div className="list-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to="/channels" className="muted" style={{ textDecoration: 'none' }}>
            Channels
          </Link>
          <span className="dim">/</span>
          <span style={{ textTransform: 'capitalize' }}>{wire.channelType}</span>
          <span className="dim">→</span>
          <Link to={`/groups/${encodeURIComponent(wire.agentGroupFolder)}`}>{wire.agentGroupName}</Link>
        </h2>
      </div>

      <section
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '1rem 1.25rem',
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Wire details</h3>
        <div className="kv">
          <div>id</div>
          <div>
            <code>{wire.id}</code>
          </div>
          <div>channel</div>
          <div style={{ textTransform: 'capitalize' }}>{wire.channelType}</div>
          <div>messaging group</div>
          <div>
            <Link to={`/channels/mg/${encodeURIComponent(wire.messagingGroupId)}`}>
              <code>{wire.messagingGroupId}</code>
            </Link>
            {wire.displayName && <span className="dim"> · {wire.displayName}</span>}
          </div>
          <div>platform id</div>
          <div>
            <code>{wire.platformId}</code>
          </div>
          <div>agent group</div>
          <div>
            <Link to={`/groups/${encodeURIComponent(wire.agentGroupFolder)}`}>{wire.agentGroupName}</Link>
          </div>
          <div>created</div>
          <div>
            <code>{wire.createdAt}</code>
          </div>
        </div>
      </section>

      <RoutingRulesEditor wire={wire} saving={saving} onSave={onSave} />

      {saveError && (
        <div className="error-banner" style={{ marginTop: '0.5rem' }}>
          Couldn't save: <code>{saveError}</code>
        </div>
      )}

      <section
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '1rem 1.25rem',
          marginTop: '1rem',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Danger zone</h3>
        <p className="muted">
          Removing this wire stops the agent from receiving inbound messages on this thread. The messaging group itself
          stays — you can re-wire it later from <Link to="/channels/new">Channels → New</Link>.
        </p>
        <button
          className="secondary"
          onClick={onDelete}
          disabled={deleting || saving}
          style={{ borderColor: 'var(--error)', color: 'var(--error)' }}
        >
          {deleting ? 'Removing…' : 'Remove wire'}
        </button>
      </section>
    </div>
  );
}

interface EngageChoice {
  value: EngageMode;
  label: string;
  blurb: string;
}

const ENGAGE_CHOICES: EngageChoice[] = [
  {
    value: 'mention',
    label: 'Only when mentioned',
    blurb: 'The agent responds only when @-tagged. Best for shared channels where the agent is one of many participants.',
  },
  {
    value: 'all',
    label: 'Every message',
    blurb: 'The agent responds to every message in this thread. Right for DMs and dedicated channels.',
  },
  {
    value: 'pattern',
    label: 'Pattern match',
    blurb: 'The agent responds when the message text matches a regex. Use for command-prefix channels (e.g. ^/ask\\b).',
  },
];

function RoutingRulesEditor({
  wire,
  saving,
  onSave,
}: {
  wire: ChannelWireView;
  saving: boolean;
  onSave: (input: UpdateChannelWireInput) => void;
}) {
  const [engageMode, setEngageMode] = useState<EngageMode>(wire.engageMode);
  const [engagePattern, setEngagePattern] = useState(wire.engagePattern ?? '');
  const [senderScope, setSenderScope] = useState<SenderScope>(wire.senderScope);
  const [ignoredMessagePolicy, setIgnoredMessagePolicy] = useState<IgnoredMessagePolicy>(wire.ignoredMessagePolicy);
  const [priority, setPriority] = useState(String(wire.priority));

  useEffect(() => {
    setEngageMode(wire.engageMode);
    setEngagePattern(wire.engagePattern ?? '');
    setSenderScope(wire.senderScope);
    setIgnoredMessagePolicy(wire.ignoredMessagePolicy);
    setPriority(String(wire.priority));
  }, [wire]);

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
        border: '1px solid var(--border)',
        borderRadius: '8px',
        padding: '1rem 1.25rem',
        marginBottom: '1rem',
      }}
    >
      <h3 style={{ marginTop: 0 }}>Routing rules</h3>

      <div role="radiogroup" aria-label="Engage mode" style={{ marginBottom: '1rem' }}>
        <label htmlFor="engageMode-mention" className="muted" style={{ display: 'block', marginBottom: '0.4rem' }}>
          When should this agent engage?
        </label>
        {ENGAGE_CHOICES.map((choice) => {
          const selected = engageMode === choice.value;
          return (
            <label
              key={choice.value}
              htmlFor={`engageMode-${choice.value}`}
              style={{
                display: 'block',
                padding: '0.6rem 0.75rem',
                borderRadius: '6px',
                background: selected ? 'var(--accent-bg, #eef4ff)' : 'transparent',
                border: selected ? '1px solid var(--accent, #5076ff)' : '1px solid transparent',
                cursor: saving ? 'progress' : 'pointer',
                marginBottom: '0.4rem',
              }}
            >
              <input
                id={`engageMode-${choice.value}`}
                type="radio"
                name="engageMode"
                value={choice.value}
                checked={selected}
                disabled={saving}
                onChange={() => setEngageMode(choice.value)}
              />{' '}
              <strong>{choice.label}</strong>
              <p className="muted" style={{ margin: '0.25rem 0 0 1.6rem' }}>
                {choice.blurb}
              </p>
            </label>
          );
        })}
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
        <label htmlFor="senderScope">Who can talk to this agent?</label>
        <select
          id="senderScope"
          value={senderScope}
          onChange={(e) => setSenderScope(e.target.value as SenderScope)}
          disabled={saving}
        >
          <option value="unrestricted">unrestricted — anyone in the thread</option>
          <option value="allowlist">allowlist — only members of the agent group</option>
        </select>
      </div>

      <div className="row">
        <label htmlFor="ignoredMessagePolicy">What about messages the agent ignores?</label>
        <select
          id="ignoredMessagePolicy"
          value={ignoredMessagePolicy}
          onChange={(e) => setIgnoredMessagePolicy(e.target.value as IgnoredMessagePolicy)}
          disabled={saving}
        >
          <option value="drop">drop — discard, no record</option>
          <option value="silent">silent — log them in the conversation but don't reply</option>
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
        <button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save routing rules'}
        </button>
      </div>
    </form>
  );
}
