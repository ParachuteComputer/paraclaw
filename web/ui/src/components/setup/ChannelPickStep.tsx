/**
 * Step 2 — Channel pick.
 *
 * Phase 1 ships Discord + Telegram. Slack/WhatsApp/Teams render disabled
 * with a "coming soon" badge so the operator sees the trajectory — when
 * those phases land, the UI shape doesn't change, only the disabled flag
 * flips.
 */
import { useEffect } from 'react';
import type { ChannelAdapter, StepProps } from './types.ts';

interface AdapterCard {
  key: ChannelAdapter | 'slack' | 'whatsapp';
  name: string;
  blurb: string;
  available: boolean;
}

const ADAPTERS: AdapterCard[] = [
  { key: 'telegram', name: 'Telegram', blurb: 'Easiest first run — BotFather + @userinfobot, ~1 minute.', available: true },
  { key: 'discord', name: 'Discord', blurb: 'DM your bot or @-mention it in a server.', available: true },
  { key: 'slack', name: 'Slack', blurb: 'Workspace bot.', available: false },
  { key: 'whatsapp', name: 'WhatsApp', blurb: 'Cloud API.', available: false },
];

export function ChannelPickStep({ state, patchState, next, back }: StepProps) {
  // If the user re-enters this step without an adapter set, default to telegram
  // (the lower-friction onboarding path).
  useEffect(() => {
    if (!state.adapter) patchState({ adapter: 'telegram' });
  }, [state.adapter, patchState]);

  return (
    <>
      <h3>Pick a channel</h3>
      <p className="muted">Telegram is the lowest-friction setup; Discord is the production target. Slack + WhatsApp arrive in Phase 3.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '0.75rem', marginTop: '0.75rem' }}>
        {ADAPTERS.map((a) => {
          const selected = state.adapter === a.key;
          return (
            <button
              key={a.key}
              type="button"
              disabled={!a.available}
              onClick={() => a.available && patchState({ adapter: a.key as ChannelAdapter })}
              className="secondary"
              style={{
                textAlign: 'left',
                padding: '1rem',
                border: selected ? '2px solid var(--accent)' : '1px solid var(--border)',
                background: selected ? 'var(--accent-soft)' : 'white',
                opacity: a.available ? 1 : 0.5,
                cursor: a.available ? 'pointer' : 'not-allowed',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <strong>{a.name}</strong>
                {!a.available && <span className="tag muted">coming soon</span>}
              </div>
              <p className="dim" style={{ margin: '0.4rem 0 0', fontSize: '0.85rem' }}>{a.blurb}</p>
            </button>
          );
        })}
      </div>

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button className="secondary" onClick={back}>Back</button>
        <button onClick={next} disabled={state.adapter !== 'discord' && state.adapter !== 'telegram'}>
          Next: install adapter
        </button>
      </div>
    </>
  );
}
