/**
 * Step 8 — Test message round-trip.
 *
 * Polls GET /api/groups/:folder every 3 seconds and advances when
 * status.lastMessageInAt > lastInboundBaseline. The baseline was captured
 * at wire-channel time precisely so a stale prior inbound (from another
 * agent group on the same DB) doesn't short-circuit the wait.
 *
 * Operator copy is verbatim from issue #27 §user journey: "DM your bot at
 * @<bot-name> now." Surfacing the exact bot username (captured by
 * test-connection) is the trick that converts a generic "DM your bot"
 * banner into something the operator can act on without context-switching
 * to Discord's user search.
 */
import { useEffect, useState } from 'react';
import { getGroup, type AgentGroupView } from '../../lib/api.ts';
import { ADAPTER_LABELS, type StepProps } from './types.ts';

const POLL_MS = 3000;

export function TestMessageStep({ state, next, back }: StepProps) {
  const [group, setGroup] = useState<AgentGroupView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [received, setReceived] = useState(false);

  useEffect(() => {
    if (!state.agentGroupFolder) return;
    let cancelled = false;
    const poll = () => {
      if (!state.agentGroupFolder) return;
      getGroup(state.agentGroupFolder)
        .then((g) => {
          if (cancelled) return;
          setGroup(g);
          const ts = g.status?.lastMessageInAt ?? null;
          if (ts && (!state.lastInboundBaseline || ts > state.lastInboundBaseline)) {
            setReceived(true);
          }
        })
        .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    };
    poll();
    const t = setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state.agentGroupFolder, state.lastInboundBaseline]);

  return (
    <>
      <h3>Test message</h3>
      <p>
        Open {state.adapter ? ADAPTER_LABELS[state.adapter] : 'your chat app'} and DM your bot. The wizard advances
        as soon as paraclaw records the inbound.
      </p>
      <p className="muted">
        Bot: <code>@{state.botUsername ?? '(unknown — re-run test connection)'}</code>
        {state.adapter === 'discord' && state.botUserId && (
          <>
            {' · '}user id <code>{state.botUserId}</code>
          </>
        )}
        {state.adapter === 'telegram' && state.operatorUserId && (
          <>
            {' · '}wired to your user id <code>{state.operatorUserId}</code>
          </>
        )}
      </p>

      <div className="empty empty-rich" style={{ marginTop: '0.75rem' }}>
        {received ? (
          <>
            <p className="empty-headline" style={{ margin: 0 }}>✓ Inbound received.</p>
            <p className="muted" style={{ marginTop: '0.4rem' }}>
              Last inbound at <code>{group?.status?.lastMessageInAt}</code>. The agent should be replying — check Discord.
            </p>
          </>
        ) : (
          <>
            <p className="empty-headline" style={{ margin: 0 }}>Waiting for first inbound DM…</p>
            <p className="muted" style={{ marginTop: '0.4rem' }}>
              Polling <code>{state.agentGroupFolder}</code> every 3s.{' '}
              {state.lastInboundBaseline ? (
                <>Baseline: <code>{state.lastInboundBaseline}</code> (we'll advance on any newer inbound).</>
              ) : (
                <>No prior inbound recorded — any DM will trigger advance.</>
              )}
            </p>
          </>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>Back</button>
        <button onClick={next} disabled={!received}>
          {received ? 'Next: done' : 'Waiting for inbound…'}
        </button>
      </div>
    </>
  );
}
