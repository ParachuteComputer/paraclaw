/**
 * /channels/new — wire a new channel to an agent group on a single page.
 *
 * The setup wizard's eight-step march is the right shape for *first* boot
 * (prereqs / install / hub / vault / agent group / wire / test). It's the
 * wrong shape for the operator's *second* channel: by then prereqs are
 * met, the adapter is installed, an agent group exists, and the only
 * unknown is the bot token + (for telegram) the operator's user id.
 *
 * This page is intentionally one form, three sections:
 *   1. Pick adapter (discord / telegram, plus disabled "coming soon" rows)
 *   2. Bot identity (paste token → validate → show identity)
 *   3. Agent group (existing or create, via shared <AgentGroupPicker />)
 *
 * Wiring is the final action button, enabled only when all three are
 * satisfied. After a successful wire we render a confirmation panel with
 * the platform_id and a link back to /channels.
 *
 * State is local-only — no localStorage, no /api/setup/status involvement.
 * If the user navigates away mid-flow, they restart cleanly. The setup
 * wizard remains the resumable surface; this page is the "fast path".
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { AgentGroupPicker, type PickedGroup } from '../components/AgentGroupPicker.tsx';
import {
  COMING_SOON_ADAPTERS,
  SUPPORTED_ADAPTERS,
  type ChannelAdapter,
  type ResolvedIdentity,
} from '../lib/channel-adapters.ts';
import { registerChannelBot, wireChannelToGroup, type WireChannelResult } from '../lib/api.ts';

export function WireChannelPage() {
  const [adapterKey, setAdapterKey] = useState<ChannelAdapter | null>(null);
  const adapter = useMemo(
    () => SUPPORTED_ADAPTERS.find((a) => a.key === adapterKey) ?? null,
    [adapterKey],
  );

  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);
  const [identity, setIdentity] = useState<ResolvedIdentity | null>(null);

  const [operatorUserId, setOperatorUserId] = useState('');

  const [picked, setPicked] = useState<PickedGroup | null>(null);

  const [wiring, setWiring] = useState(false);
  const [wireResult, setWireResult] = useState<WireChannelResult | null>(null);
  const [wireError, setWireError] = useState<string | null>(null);

  const onPickAdapter = (key: ChannelAdapter) => {
    if (key === adapterKey) return;
    setAdapterKey(key);
    setToken('');
    setIdentity(null);
    setValidateError(null);
    setOperatorUserId('');
  };

  const onValidate = async () => {
    if (!adapter || !token.trim()) return;
    setValidating(true);
    setValidateError(null);
    try {
      const trimmed = token.trim();
      // Single hop: register-bot validates upstream, persists to /secrets,
      // and brings the adapter live in one server round-trip. The server
      // surfaces the upstream platform's rejection message via the standard
      // `{ error }` shape on bad tokens, so we don't need a separate /test
      // pre-call.
      //
      // Re-posting the same bot's secret with a new token persists the
      // rotation immediately but the live polling loop keeps the old token
      // until the next host restart — same as a `.env` rotation. Operators
      // doing a forced rotation should restart paraclaw.
      const registered = await registerChannelBot(adapter.key, trimmed);
      setIdentity({ id: registered.botId, username: registered.username });
      setToken('');
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  };

  const operatorFieldOk =
    !adapter ||
    adapter.operatorFields.every((f) => {
      if (f.key === 'operatorUserId') return f.pattern.test(operatorUserId.trim());
      return false;
    });

  const wireId = adapter
    ? adapter.wireIdFor({
        botUserId: identity?.id ?? null,
        operatorUserId: operatorUserId.trim() || null,
      })
    : null;

  const platformIdPreview = adapter
    ? adapter.platformIdPreview({
        botUserId: identity?.id ?? null,
        operatorUserId: operatorUserId.trim() || null,
      })
    : null;

  const canWire = !!adapter && !!identity && operatorFieldOk && !!picked && !!wireId && !wiring;

  const onWire = async () => {
    if (!canWire || !adapter || !picked || !wireId) return;
    setWiring(true);
    setWireError(null);
    try {
      const r = await wireChannelToGroup(picked.folder, {
        channel: adapter.key,
        botUserId: wireId,
        displayName: `${picked.name} DM`,
      });
      setWireResult(r);
    } catch (err) {
      setWireError(err instanceof Error ? err.message : String(err));
    } finally {
      setWiring(false);
    }
  };

  if (wireResult) {
    return (
      <div>
        <h2>Channel wired</h2>
        <p className="muted">
          {adapter?.label} DM is now routed to <code>{picked?.name}</code>. Send a DM to{' '}
          <code>@{identity?.username}</code> to test.
        </p>
        <div className="empty empty-rich" style={{ marginTop: '0.75rem' }}>
          <p className="empty-headline" style={{ margin: 0 }}>
            {wireResult.created.wiring ? 'Wired.' : 'Already wired — kept existing rows.'}
          </p>
          <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
            messaging_group_id: <code>{wireResult.messagingGroupId}</code>
            <br />
            messaging_group_agent_id: <code>{wireResult.messagingGroupAgentId}</code>
            <br />
            platform_id: <code>{wireResult.platformId}</code>
          </p>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <Link to="/channels">
            <button>Back to channels</button>
          </Link>
          <Link to={`/groups/${encodeURIComponent(picked?.folder ?? '')}`}>
            <button className="secondary">Open agent group</button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Wire a new channel</h2>
        <Link to="/channels">
          <button className="secondary">Cancel</button>
        </Link>
      </div>
      <p className="muted">
        Pick an adapter, validate the bot token, choose an agent group. The setup wizard is for
        first-boot only — this is the fast path for adding a second (or third…) channel.
      </p>

      <Section step={1} title="Pick adapter">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: '0.75rem',
            marginTop: '0.5rem',
          }}
        >
          {SUPPORTED_ADAPTERS.map((a) => (
            <AdapterCard
              key={a.key}
              label={a.label}
              blurb={a.blurb}
              available
              selected={a.key === adapterKey}
              onPick={() => onPickAdapter(a.key)}
            />
          ))}
          {COMING_SOON_ADAPTERS.map((a) => (
            <AdapterCard key={a.key} label={a.label} blurb={a.blurb} available={false} />
          ))}
        </div>
      </Section>

      {adapter && (
        <Section step={2} title={`Bot identity — ${adapter.label}`}>
          <p className="dim" style={{ marginTop: 0 }}>
            We hit <code>{adapter.upstreamProbePath}</code> to confirm the token authenticates and the account
            is a bot, then encrypt-and-store it under <code>secrets</code> and bring up the adapter so
            the bot is live across host restarts. Get a token from{' '}
            <a href={adapter.tokenHelp.href} target="_blank" rel="noreferrer">
              {adapter.tokenHelp.title}
            </a>
            .
          </p>

          {identity ? (
            <div className="empty empty-rich" style={{ marginTop: '0.5rem' }}>
              <p className="empty-headline" style={{ margin: 0 }}>
                Bot registered: <code>@{identity.username}</code>{' '}
                <span className="dim">
                  (id <code>{identity.id}</code>)
                </span>
              </p>
              <button
                className="secondary"
                style={{ marginTop: '0.5rem' }}
                onClick={() => {
                  setIdentity(null);
                  setToken('');
                }}
              >
                Use a different token
              </button>
            </div>
          ) : (
            <>
              <div className="row" style={{ marginTop: '0.5rem' }}>
                <label htmlFor="botToken">Bot token</label>
                <input
                  id="botToken"
                  type="password"
                  autoComplete="off"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="paste bot token"
                />
              </div>
              {validateError && <div className="error-banner">{validateError}</div>}
              <div className="actions" style={{ marginTop: '0.5rem' }}>
                <button onClick={onValidate} disabled={!token.trim() || validating}>
                  {validating ? 'Validating + registering…' : 'Validate & register bot'}
                </button>
              </div>
            </>
          )}

          {identity &&
            adapter.operatorFields.map((f) => (
              <div key={f.key} className="row" style={{ marginTop: '0.75rem' }}>
                <label htmlFor={f.key}>{f.label}</label>
                <input
                  id={f.key}
                  type="text"
                  inputMode="numeric"
                  value={operatorUserId}
                  onChange={(e) => setOperatorUserId(e.target.value)}
                  placeholder="123456789"
                />
                <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
                  {f.hint}
                  {f.helpHref && (
                    <>
                      {' '}
                      <a href={f.helpHref} target="_blank" rel="noreferrer">
                        Help
                      </a>
                    </>
                  )}
                </p>
              </div>
            ))}
        </Section>
      )}

      {adapter && identity && operatorFieldOk && (
        <Section step={3} title="Agent group">
          {picked ? (
            <div className="empty empty-rich" style={{ marginTop: '0.5rem' }}>
              <p className="empty-headline" style={{ margin: 0 }}>
                <strong>{picked.name}</strong>{' '}
                <code className="dim">{picked.folder}</code>
              </p>
              <button
                className="secondary"
                style={{ marginTop: '0.5rem' }}
                onClick={() => setPicked(null)}
              >
                Change group
              </button>
            </div>
          ) : (
            <AgentGroupPicker onPicked={setPicked} />
          )}
        </Section>
      )}

      {adapter && identity && operatorFieldOk && picked && (
        <Section step={4} title="Wire">
          <p className="muted">
            Synthesizes the DM platform id <code>{platformIdPreview}</code> and inserts the
            messaging_groups + messaging_group_agents rows. After wiring, the first DM lands in your
            group instead of being silently dropped by the unwired-channel guard.
          </p>
          {wireError && <div className="error-banner">{wireError}</div>}
          <div className="actions" style={{ marginTop: '0.5rem' }}>
            <button onClick={onWire} disabled={!canWire}>
              {wiring ? 'Wiring…' : `Wire ${adapter.label} DM to ${picked.name}`}
            </button>
          </div>
        </Section>
      )}
    </div>
  );
}

function Section({
  step,
  title,
  children,
}: {
  step: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h3 style={{ margin: 0 }}>
        <span className="dim" style={{ marginRight: '0.5rem' }}>
          {step}.
        </span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function AdapterCard({
  label,
  blurb,
  available,
  selected = false,
  onPick,
}: {
  label: string;
  blurb: string;
  available: boolean;
  selected?: boolean;
  onPick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={!available}
      onClick={() => available && onPick?.()}
      className="secondary"
      style={{
        textAlign: 'left',
        padding: '1rem',
        border: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
        background: selected ? 'var(--accent-soft)' : 'white',
        opacity: available ? 1 : 0.5,
        cursor: available ? 'pointer' : 'not-allowed',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <strong>{label}</strong>
        {!available && <span className="tag muted">coming soon</span>}
      </div>
      <p className="dim" style={{ margin: '0.4rem 0 0', fontSize: '0.85rem' }}>
        {blurb}
      </p>
    </button>
  );
}
