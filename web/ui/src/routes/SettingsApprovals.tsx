/**
 * /settings/approvals — default approval-routing bot per (approver, channel).
 *
 * Backs the `bot_id = ''` channel-default slot in `user_dms`. When an
 * approval card needs to land for a given approver and the inbound
 * came in on a bot we don't have a cached DM for, the picker falls
 * through to this configured default. Without a default the picker
 * cold-resolves through whichever adapter happens to be registered
 * first — fine on single-bot installs, surprising on multi-bot.
 *
 * One row per (approver, channel) pair where either the approver has a
 * cached DM or there's at least one active adapter for the channel.
 * Operator changes the default by picking from the channel's active
 * bots; the server cold-resolves through the chosen bot to confirm it
 * can DM the user before re-pointing the slot.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  listApprovalRouting,
  setApprovalRoutingDefault,
  type ApprovalRoutingRow,
} from '../lib/api.ts';

interface SaveError {
  rowKey: string;
  message: string;
}

function rowKey(r: ApprovalRoutingRow): string {
  return `${r.userId}|${r.channelType}`;
}

export function SettingsApprovals() {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'ok'; rows: ApprovalRoutingRow[] }
    | { kind: 'error'; message: string }
  >({ kind: 'loading' });
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<SaveError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    listApprovalRouting()
      .then((rows) => !cancelled && setState({ kind: 'ok', rows }))
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

  const onPickBot = async (row: ApprovalRoutingRow, botId: string) => {
    if (botId === (row.currentBotId ?? '')) return;
    const key = rowKey(row);
    setBusyKey(key);
    setSaveError(null);
    try {
      const updated = await setApprovalRoutingDefault(row.userId, row.channelType, botId);
      setState((s) => {
        if (s.kind !== 'ok') return s;
        return {
          kind: 'ok',
          rows: s.rows.map((r) => (rowKey(r) === key ? updated : r)),
        };
      });
    } catch (err) {
      setSaveError({ rowKey: key, message: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyKey(null);
    }
  };

  if (state.kind === 'loading') {
    return (
      <div>
        <h2>Settings · Approval routing</h2>
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
        <h2>Settings · Approval routing</h2>
        <div className="error-banner">
          Couldn't load settings: <code>{state.message}</code>
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
        <h2>Settings · Approval routing</h2>
        <button className="secondary" onClick={reload}>Refresh</button>
      </div>

      <p className="muted">
        Pick the bot that should deliver approval cards when the inbound bot can't reach you. Each
        approver has their own per-channel default. Adding a new bot? Wire it from{' '}
        <a href="channels/new">Channels → New</a> first — only running adapters appear here.
      </p>

      {state.rows.length === 0 && (
        <div className="empty empty-rich" style={{ marginTop: '1rem' }}>
          <p className="empty-headline">Nothing to configure yet.</p>
          <p className="muted">
            Add an owner or admin (and wire at least one channel) and they'll show up here.
          </p>
        </div>
      )}

      {state.rows.map((row) => (
        <SettingsRow
          key={rowKey(row)}
          row={row}
          busy={busyKey === rowKey(row)}
          error={saveError && saveError.rowKey === rowKey(row) ? saveError.message : null}
          onPick={(botId) => onPickBot(row, botId)}
        />
      ))}
    </div>
  );
}

function SettingsRow({
  row,
  busy,
  error,
  onPick,
}: {
  row: ApprovalRoutingRow;
  busy: boolean;
  error: string | null;
  onPick: (botId: string) => void;
}) {
  const value = row.currentBotId ?? '';
  // Multi-bot install OR a default already pinned to a specific bot.
  // If there's only one available bot AND the default is either unset
  // or already that bot, we render an info row — there's no choice
  // to be made and a dropdown of one option is just visual noise.
  const trivial = useMemo(() => {
    if (row.availableBots.length <= 1) {
      const only = row.availableBots[0]?.botId ?? '';
      if (!value || value === only) return true;
    }
    return false;
  }, [row.availableBots, value]);

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
        <strong>{row.channelType}</strong>
        <span className="tag muted">{row.userId}</span>
      </div>

      <div style={{ marginTop: '0.5rem' }}>
        {trivial ? (
          <p className="muted" style={{ margin: 0 }}>
            {row.availableBots.length === 0 ? (
              <>No active bot for this channel — wire one to enable routing.</>
            ) : (
              <>
                Routing through <code>{row.availableBots[0]!.label}</code> (the only active bot).
              </>
            )}
          </p>
        ) : (
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="muted">Default bot:</span>
            <select
              value={value}
              disabled={busy}
              onChange={(e) => onPick(e.target.value)}
              style={{ minWidth: '14rem' }}
            >
              {value === '' && <option value="">(unset — first adapter wins)</option>}
              {row.availableBots.map((b) => (
                <option key={b.botId} value={b.botId}>
                  {b.label}
                </option>
              ))}
              {/* Surface a stale current selection (e.g. its adapter was
                  taken offline) so the operator sees what's there before
                  switching it. */}
              {value !== '' && !row.availableBots.find((b) => b.botId === value) && (
                <option value={value}>{value} (offline)</option>
              )}
            </select>
            {busy && <span className="dim">saving…</span>}
          </label>
        )}
      </div>

      {error && (
        <div className="error-banner" style={{ marginTop: '0.5rem' }}>
          {error}
        </div>
      )}
    </div>
  );
}
