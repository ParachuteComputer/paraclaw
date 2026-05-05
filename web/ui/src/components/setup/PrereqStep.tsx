/**
 * Step 1 — Prereqs (post-rebirth: navigator).
 *
 * Calls GET /api/setup/status, renders one row per check (secrets backend,
 * hub discovery, vault attached, channel-token presence) with the {ok,
 * detail, fix} the server returns. Each blocker links out to the right
 * fix surface — credential issues route to /secrets (paraclaw-native),
 * vault issues route to the agent group create flow, hub issues link to
 * the parachute hub docs.
 *
 * The wizard's credential-capture step is gone (night/ui rebirth) — this
 * page is now the navigator. If the operator needs to add a token, the
 * "Add credential" button takes them to /secrets pre-filled with the
 * pinned secret name; they come back to /setup and click "Re-check".
 *
 * Why we render `fix` verbatim from the server: the hint is canonical (it
 * knows which env var is missing, which subcommand to run); inventing a
 * UI-side version would drift over time.
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSetupStatus, type SetupStatus } from '../../lib/api.ts';
import type { StepProps } from './types.ts';

export function PrereqStep({ next }: StepProps) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ok'; status: SetupStatus } | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getSetupStatus()
      .then((status) => !cancelled && setState({ kind: 'ok', status }))
      .catch((err) => !cancelled && setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }));
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  if (state.kind === 'loading') {
    return (
      <>
        <h3>Prerequisites</h3>
        <ul className="skeleton-list" aria-busy="true">
          <li className="skeleton skeleton-line" />
          <li className="skeleton skeleton-line" />
          <li className="skeleton skeleton-line" />
        </ul>
      </>
    );
  }

  if (state.kind === 'error') {
    return (
      <>
        <h3>Prerequisites</h3>
        <div className="error-banner">Couldn't fetch status: <code>{state.message}</code></div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={() => setReloadKey((k) => k + 1)}>Retry</button>
        </div>
      </>
    );
  }

  type Check = { ok: boolean; detail: string; fix: string | null };
  type Row = { label: string; check: Check; fixHref?: string; fixLabel?: string };

  const rows: Row[] = [
    {
      label: 'Secrets backend',
      check: state.status.secrets,
      // No deep-link — this is paraclaw's own backend; if it's broken the
      // server log is the right place to look.
    },
    {
      label: 'Hub discovery',
      check: state.status.hub,
    },
    {
      label: 'Vault attached',
      check: state.status.vaultAttached,
      fixHref: '/groups/new',
      fixLabel: 'Create an agent group with a vault',
    },
  ];
  const blockers = rows.filter((r) => !r.check.ok);

  return (
    <>
      <h3>Prerequisites</h3>
      <p className="muted">parachute-agent needs these in place before we can wire a channel.</p>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.75rem' }}>
        {rows.map(({ label, check, fixHref, fixLabel }) => (
          <li key={label} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span aria-hidden style={{ fontSize: '1.1rem' }}>{check.ok ? '✓' : '✗'}</span>
              <strong>{label}</strong>
              <span className="dim" style={{ marginLeft: 'auto' }}>{check.detail}</span>
            </div>
            {!check.ok && (check.fix || fixHref) && (
              <div style={{ margin: '0.4rem 0 0 1.6rem', display: 'flex', gap: '0.75rem', alignItems: 'baseline' }}>
                {check.fix && <span className="dim">{check.fix}</span>}
                {fixHref && (
                  <Link to={fixHref} className="muted">{fixLabel ?? 'Fix →'}</Link>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      <p className="dim" style={{ marginTop: '1rem' }}>
        Channel tokens (Discord / Telegram bot tokens, API keys) live on the{' '}
        <Link to="/secrets">/secrets</Link> page now — add them there, come back, and click <em>Re-check</em>. The wizard
        no longer captures credentials inline.
      </p>

      <div className="actions" style={{ marginTop: '1rem' }}>
        <button onClick={() => setReloadKey((k) => k + 1)} className="secondary">
          Re-check
        </button>
        <button onClick={next} disabled={blockers.length > 0}>
          {blockers.length > 0 ? `Resolve ${blockers.length} item${blockers.length === 1 ? '' : 's'} above` : 'Next: pick channel'}
        </button>
      </div>
    </>
  );
}
