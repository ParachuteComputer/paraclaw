/**
 * /channels/mg/:id — per-messaging-group detail + policy editor.
 *
 * What's here:
 *   - read-only metadata (channel type, platform id, denial flag, created)
 *   - the `unknownSenderPolicy` editor as a 3-radio toggle
 *   - a read-only summary of wired agents (links to per-MGA detail land in PR3)
 *
 * The MG-id is a UUID generated server-side; the disambiguation prefix
 * `mg/` keeps the route clean against future per-MGA routes (`mga/`)
 * without needing a discriminator query param.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  getMessagingGroupDetail,
  HttpError,
  updateMessagingGroupPolicy,
  type MessagingGroupDetailView,
  type UnknownSenderPolicy,
} from '../lib/api.ts';

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; mg: MessagingGroupDetailView }
  | { kind: 'error'; status: number | null; message: string };

interface PolicyChoice {
  value: UnknownSenderPolicy;
  label: string;
  blurb: string;
}

const POLICY_CHOICES: PolicyChoice[] = [
  {
    value: 'request_approval',
    label: 'Request approval',
    blurb: 'Pause the message and DM you an approve / reject card. Default for newly auto-created channels.',
  },
  {
    value: 'strict',
    label: 'Strict',
    blurb: 'Drop messages from unknown senders silently. Use when the channel should only see vetted traffic.',
  },
  {
    value: 'public',
    label: 'Public',
    blurb:
      'Admit every sender and route normally. Use for channels you trust by ambient context (private servers, allowlisted chats).',
  },
];

export function MessagingGroupDetail() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = rawId ?? '';
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [savingPolicy, setSavingPolicy] = useState<UnknownSenderPolicy | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!id) {
      setState({ kind: 'error', status: null, message: 'no messaging group id in URL' });
      return;
    }
    let cancelled = false;
    getMessagingGroupDetail(id)
      .then((mg) => !cancelled && setState({ kind: 'ok', mg }))
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

  const onPick = async (next: UnknownSenderPolicy) => {
    if (state.kind !== 'ok') return;
    if (next === state.mg.unknownSenderPolicy) return;
    setSavingPolicy(next);
    setSaveError(null);
    try {
      const updated = await updateMessagingGroupPolicy(id, next);
      setState({ kind: 'ok', mg: updated });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingPolicy(null);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div>
        <h2>Channel</h2>
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
        <h2>Channel</h2>
        <div className="error-banner">
          {state.status === 404 ? (
            <>
              No channel with id <code>{id}</code> — it may have been removed.
            </>
          ) : (
            <>
              Couldn't load this channel: <code>{state.message}</code>
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

  const { mg } = state;
  return (
    <div>
      <div className="list-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Link to="/channels" className="muted" style={{ textDecoration: 'none' }}>
            Channels
          </Link>
          <span className="dim">/</span>
          <span style={{ textTransform: 'capitalize' }}>{mg.channelType}</span>
          {mg.displayName && <span className="dim">· {mg.displayName}</span>}
        </h2>
      </div>

      {mg.deniedAt && (
        <div
          className="banner"
          style={{
            background: 'var(--warn-bg, #fff7e0)',
            border: '1px solid var(--warn, #c08a00)',
            borderRadius: '8px',
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
          }}
        >
          <strong>Denied channel.</strong> The owner explicitly blocked this messaging group at{' '}
          <code>{mg.deniedAt}</code>. The router drops messages here before any wiring or policy below applies — undeny
          from the central admin surface to restore routing.
        </div>
      )}

      <section
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '1rem 1.25rem',
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Group details</h3>
        <div className="kv">
          <div>id</div>
          <div>
            <code>{mg.id}</code>
          </div>
          <div>channel</div>
          <div style={{ textTransform: 'capitalize' }}>{mg.channelType}</div>
          <div>platform id</div>
          <div>
            <code>{mg.platformId}</code>
          </div>
          <div>kind</div>
          <div>{mg.isGroup ? 'group / channel' : 'direct message'}</div>
          <div>name</div>
          <div>{mg.displayName ?? <span className="dim">(unset)</span>}</div>
          <div>created</div>
          <div>
            <code>{mg.createdAt}</code>
          </div>
        </div>
      </section>

      <section
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '1rem 1.25rem',
          marginBottom: '1rem',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Unknown-sender policy</h3>
        <p className="muted">
          What should happen when a sender the messaging group hasn't seen before posts a message?
        </p>
        <div role="radiogroup" aria-label="Unknown-sender policy">
          {POLICY_CHOICES.map((choice) => {
            const selected = mg.unknownSenderPolicy === choice.value;
            const saving = savingPolicy === choice.value;
            return (
              <label
                key={choice.value}
                style={{
                  display: 'block',
                  padding: '0.6rem 0.75rem',
                  borderRadius: '6px',
                  background: selected ? 'var(--accent-bg, #eef4ff)' : 'transparent',
                  border: selected ? '1px solid var(--accent, #5076ff)' : '1px solid transparent',
                  cursor: savingPolicy === null ? 'pointer' : 'progress',
                  marginBottom: '0.4rem',
                }}
              >
                <input
                  type="radio"
                  name="unknownSenderPolicy"
                  value={choice.value}
                  checked={selected}
                  disabled={savingPolicy !== null}
                  onChange={() => onPick(choice.value)}
                />{' '}
                <strong>{choice.label}</strong>
                {saving && <span className="dim"> · saving…</span>}
                <p className="muted" style={{ margin: '0.25rem 0 0 1.6rem' }}>
                  {choice.blurb}
                </p>
              </label>
            );
          })}
        </div>
        {saveError && (
          <div className="error-banner" style={{ marginTop: '0.5rem' }}>
            Couldn't save: <code>{saveError}</code>
          </div>
        )}
      </section>

      <section
        style={{
          background: 'white',
          border: '1px solid var(--border)',
          borderRadius: '8px',
          padding: '1rem 1.25rem',
        }}
      >
        <h3 style={{ marginTop: 0 }}>Wired agents ({mg.wiredAgents.length})</h3>
        {mg.wiredAgents.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            No agents wired to this group yet. Wire one from <Link to="/channels/new">Channels → New</Link>.
          </p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {mg.wiredAgents.map((wa) => (
              <li
                key={wa.messagingGroupAgentId}
                style={{
                  borderTop: '1px solid var(--border)',
                  padding: '0.6rem 0',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <Link to={`/groups/${encodeURIComponent(wa.agentGroupFolder)}`}>{wa.agentGroupName}</Link>
                <span className="tag muted">priority {wa.priority}</span>
                <span className="dim">
                  engage <code>{wa.engageMode}</code>
                  {wa.engagePattern && (
                    <>
                      {' '}
                      · pattern <code>{wa.engagePattern}</code>
                    </>
                  )}{' '}
                  · senders <code>{wa.senderScope}</code> · ignored <code>{wa.ignoredMessagePolicy}</code>
                </span>
                <Link
                  to={`/channels/mga/${encodeURIComponent(wa.messagingGroupAgentId)}`}
                  style={{ marginLeft: 'auto' }}
                >
                  Routing rules →
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
