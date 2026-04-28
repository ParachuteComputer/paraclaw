/**
 * Step 1 — Prereqs.
 *
 * Calls GET /api/setup/status, renders one row per check (onecli, hub,
 * vault attached) with the {ok, detail, fix} the server returns.
 *
 * Why we render `fix` verbatim: the server's hint is canonical (it knows
 * which env var is missing, which subcommand to run); inventing a UI-side
 * version would drift over time. The hint is plain text — we render it
 * inside <code> when it looks command-shaped, otherwise as prose.
 *
 * Channel-discord is NOT shown here even though /setup/status reports
 * `channels.discord.installed` — the install step is its own card, and
 * surfacing both would suggest the user has to fix it before proceeding,
 * when in fact they install it later in the flow.
 */
import { useEffect, useState } from 'react';
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

  const checks: { label: string; check: { ok: boolean; detail: string; fix: string | null } }[] = [
    { label: 'OneCLI gateway', check: state.status.onecli },
    { label: 'Hub discovery', check: state.status.hub },
    { label: 'Vault attached', check: state.status.vaultAttached },
  ];
  const blockers = checks.filter((c) => !c.check.ok);

  return (
    <>
      <h3>Prerequisites</h3>
      <p className="muted">paraclaw needs these in place before we can wire a channel.</p>
      <ul style={{ listStyle: 'none', padding: 0, marginTop: '0.75rem' }}>
        {checks.map(({ label, check }) => (
          <li key={label} style={{ padding: '0.5rem 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span aria-hidden style={{ fontSize: '1.1rem' }}>{check.ok ? '✓' : '✗'}</span>
              <strong>{label}</strong>
              <span className="dim" style={{ marginLeft: 'auto' }}>{check.detail}</span>
            </div>
            {!check.ok && check.fix && (
              <p className="dim" style={{ margin: '0.4rem 0 0 1.6rem' }}>{check.fix}</p>
            )}
          </li>
        ))}
      </ul>

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
