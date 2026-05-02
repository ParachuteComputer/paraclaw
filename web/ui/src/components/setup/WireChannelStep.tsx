/**
 * Step 7 — Wire channel.
 *
 * POST /api/groups/:folder/wire-channel with the right id for the chosen
 * adapter:
 *   - discord  : `botUserId` is the BOT's snowflake (DMs land on @me).
 *   - telegram : `botUserId` carries the OPERATOR's user id (DMs are
 *     chat-routed; chat_id == sender user_id in DMs).
 *
 * The server inserts messaging_groups + messaging_group_agents rows so
 * the first inbound DM doesn't get silently dropped by
 * channel-approval.ts:73-77 (see PR A body).
 *
 * Idempotent: re-clicking returns the same IDs with
 * `created.{messagingGroup,wiring}=false`. Safe to retry.
 *
 * Before advancing we capture `lastInboundBaseline` from the group's
 * status — the test-message step polls /api/groups/:folder and advances
 * when status.lastMessageInAt > this baseline. Without a baseline a
 * stale prior inbound would short-circuit the round-trip wait and lie
 * to the operator.
 */
import { useEffect, useState } from 'react';
import { getGroup, wireChannelToGroup, type WireChannelResult } from '../../lib/api.ts';
import { ADAPTER_LABELS, type StepProps } from './types.ts';

export function WireChannelStep({ state, patchState, next, back }: StepProps) {
  const adapter = state.adapter;
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<WireChannelResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [missingPrereq, setMissingPrereq] = useState<string | null>(null);

  // Per-channel: which captured id do we use for wiring?
  const wireId =
    adapter === 'telegram' ? state.operatorUserId : adapter === 'discord' ? state.botUserId : null;

  // Telegram needs the OPERATOR's user id (DMs are chat-routed). Captured
  // inline here since the rebirth dropped the credentials step that used
  // to ask for it. Discord doesn't need this — its botUserId comes from
  // test-connection's getMe call.
  const [operatorIdInput, setOperatorIdInput] = useState(state.operatorUserId ?? '');

  useEffect(() => {
    if (!adapter) {
      setMissingPrereq('channel (re-run step 2)');
      return;
    }
    const missing: string[] = [];
    if (adapter === 'discord' && !state.botUserId) missing.push('bot user id (re-run test-connection)');
    if (adapter === 'telegram' && !state.operatorUserId) missing.push('your Telegram user id (paste below)');
    if (!state.agentGroupFolder) missing.push('agent group (re-run step 5)');
    setMissingPrereq(missing.length > 0 ? missing.join(', ') : null);
  }, [adapter, state.botUserId, state.operatorUserId, state.agentGroupFolder]);

  if (!adapter) {
    return (
      <>
        <h3>Wire channel</h3>
        <div className="error-banner">No channel selected — go back to step 2.</div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button className="secondary" onClick={back}>Back</button>
        </div>
      </>
    );
  }

  const onWire = async () => {
    if (!state.agentGroupFolder || !wireId) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await wireChannelToGroup(state.agentGroupFolder, {
        channel: adapter,
        // The bot's identity from test-connection's getMe; for both
        // adapters this is the bot's user/application id and forms the
        // bot dimension of the v2 platform_id.
        botId: state.botUserId ?? '',
        botUserId: wireId,
        operatorUserId: state.operatorUserId ?? undefined,
        displayName: state.agentGroupName ? `${state.agentGroupName} DM` : undefined,
      });
      setResult(r);
      const grp = await getGroup(state.agentGroupFolder);
      patchState({ lastInboundBaseline: grp.status?.lastMessageInAt ?? null });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const adapterLabel = ADAPTER_LABELS[adapter];
  const previewPlatformId =
    adapter === 'discord' ? `discord:@me:${wireId ?? '(no bot id)'}` : `telegram:${wireId ?? '(no user id)'}`;

  return (
    <>
      <h3>
        Wire {adapterLabel} DM to <code>{state.agentGroupName ?? state.agentGroupFolder ?? '(no group)'}</code>
      </h3>
      <p className="muted">
        We synthesize the DM platform id <code>{previewPlatformId}</code> and insert the messaging_groups +
        messaging_group_agents rows. After this, the {adapterLabel === 'Telegram' ? "operator's first DM" : "bot's first DM"}{' '}
        lands in your group instead of being silently dropped by the unwired-channel guard.
      </p>

      {adapter === 'telegram' && !state.operatorUserId && (
        <div className="row" style={{ marginTop: '0.75rem' }}>
          <label htmlFor="operatorUserId">Your Telegram user id</label>
          <input
            id="operatorUserId"
            type="text"
            inputMode="numeric"
            pattern="[0-9]+"
            value={operatorIdInput}
            onChange={(e) => setOperatorIdInput(e.target.value)}
            placeholder="123456789  (from @userinfobot)"
          />
          <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
            Telegram routes DMs by chat id (= your user id). Get yours by DMing{' '}
            <a href="https://t.me/userinfobot" target="_blank" rel="noreferrer">@userinfobot</a>.
          </p>
          <button
            type="button"
            className="secondary"
            disabled={!/^[0-9]+$/.test(operatorIdInput.trim())}
            onClick={() => patchState({ operatorUserId: operatorIdInput.trim() })}
            style={{ marginTop: '0.5rem' }}
          >
            Save user id
          </button>
        </div>
      )}

      {missingPrereq && (
        <div className="error-banner">
          Missing prerequisites: {missingPrereq}.
        </div>
      )}

      {result && (
        <div className="empty empty-rich" style={{ marginTop: '0.5rem' }}>
          <p className="empty-headline" style={{ margin: 0 }}>
            {result.created.wiring ? 'Wired.' : 'Already wired — kept existing rows.'}
          </p>
          <p className="muted" style={{ marginTop: '0.4rem', fontSize: '0.85rem' }}>
            messaging_group_id: <code>{result.messagingGroupId}</code><br />
            messaging_group_agent_id: <code>{result.messagingGroupAgentId}</code><br />
            platform_id: <code>{result.platformId}</code>
          </p>
        </div>
      )}

      {error && <div className="error-banner">{error}</div>}

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>Back</button>
        <button onClick={onWire} disabled={submitting || !!missingPrereq}>
          {submitting ? 'Wiring…' : result ? 'Re-wire' : 'Wire DM channel'}
        </button>
        <button onClick={next} disabled={!result}>Next: test message</button>
      </div>
    </>
  );
}
