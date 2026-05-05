/**
 * /vaults — vault management index page (Phase 2 of paraclaw#38).
 *
 * One row per vault from the hub's well-known discovery doc, with
 * attached-group + token-count summaries pulled from the new /api/vaults
 * proxy endpoints. Clicking ▸ Manage drills into /vaults/<name> for the
 * detail/mint/revoke surface (Phase 3 — placeholder route for now).
 *
 * Token-count probes hit `GET /api/vaults/:name/tokens`, which forwards
 * the operator's session JWT to the vault and requires a per-vault
 * `vault:<name>:admin` scope. The probe is tolerant — a 401/403 renders
 * "—" so an operator who hasn't consented to that scope yet can still
 * see the index. The consent prompt fires on the detail page (Phase 3),
 * not here, where it would trap users in a re-auth loop before they
 * could even see what vaults exist.
 *
 * State shape mirrors SecretsList.tsx (loading | ok | error tagged
 * union) for visual + interaction consistency.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  getVaultDetail,
  listVaults,
  refreshVaults,
  tryListVaultTokenCount,
  type TokenCountProbe,
  type VaultListing,
} from '../lib/api.ts';

/**
 * `null` is in-flight (initial load before the per-row enrichment Promise
 * settles). `'unauthorized'` only fires for the token-count column when
 * the vault returns 401/403 — i.e. the operator hasn't consented to
 * `vault:<name>:admin` yet — and renders a Manage-to-grant hint.
 * `'error'` is the catch-all for everything else (network blip, 5xx,
 * malformed body) so we don't mislabel a server failure as an auth
 * problem the operator can fix by clicking Manage.
 */
type CountState = number | null | 'unauthorized' | 'error';

interface VaultRow {
  vault: VaultListing;
  attachedGroupsCount: CountState;
  tokenCount: CountState;
}

type State =
  | { kind: 'loading' }
  | { kind: 'ok'; rows: VaultRow[] }
  | { kind: 'error'; message: string };

export function VaultsList() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadCounter, setReloadCounter] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const enrichRow = useCallback(
    async (name: string, isCancelled: () => boolean) => {
      const [detail, count] = await Promise.allSettled([
        getVaultDetail(name),
        tryListVaultTokenCount(name),
      ]);
      if (isCancelled()) return;
      setState((prev) => {
        if (prev.kind !== 'ok') return prev;
        return {
          kind: 'ok',
          rows: prev.rows.map((r) => {
            if (r.vault.name !== name) return r;
            return {
              ...r,
              // getVaultDetail only requires `agent:read`, which the session
              // already has if the operator hit /vaults at all. A 401/403
              // here would be re-auth'd by `request<T>` before throwing,
              // so a rejected promise is a 5xx / network blip — not an
              // auth issue. Don't mislabel it as unauthorized.
              attachedGroupsCount:
                detail.status === 'fulfilled' ? detail.value.attachedGroups.length : 'error',
              tokenCount: tokenProbeToCountState(count),
            };
          }),
        };
      });
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    const isRefresh = reloadCounter > 0;
    const fetcher = isRefresh ? refreshVaults : listVaults;

    fetcher()
      .then((vaults) => {
        if (cancelled) return;
        setState({
          kind: 'ok',
          rows: vaults.map((v) => ({
            vault: v,
            attachedGroupsCount: null,
            tokenCount: null,
          })),
        });
        for (const v of vaults) {
          void enrichRow(v.name, isCancelled);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        if (isRefresh) {
          // Refresh-while-data-shown: don't blow the page away. Keep the
          // (now-stale) table visible and surface the failure as a banner
          // above it so the operator can read the cause and retry. If the
          // page was already in `error` (initial load failed and user hit
          // Retry), update the error message in place so the full-page
          // error UI reflects the latest cause instead of a stale one.
          setRefreshError(message);
          setState((prev) => (prev.kind === 'error' ? { kind: 'error', message } : prev));
        } else {
          // Initial load with no data yet — full-page error is the
          // honest state; nothing to preserve.
          setState({ kind: 'error', message });
        }
      })
      .finally(() => {
        if (cancelled) return;
        if (isRefresh) setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [reloadCounter, enrichRow]);

  const onRefresh = () => {
    setRefreshError(null);
    setRefreshing(true);
    setReloadCounter((n) => n + 1);
  };

  if (state.kind === 'loading') {
    return (
      <div>
        <h2>Vaults</h2>
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
        <h2>Vaults</h2>
        <div className="error-banner">
          Couldn't load vaults: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={onRefresh} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh from hub'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Vaults ({state.rows.length})</h2>
        <button onClick={onRefresh} disabled={refreshing}>
          {refreshing ? 'Refreshing…' : 'Refresh from hub'}
        </button>
      </div>

      <p className="muted">
        Vaults registered with this hub at <code>/.well-known/parachute.json</code>. The
        list is cached in paraclaw for 30 seconds; <strong>Refresh from hub</strong> bypasses
        the cache and re-fetches.
      </p>

      {refreshError && <div className="error-banner">{refreshError}</div>}

      {state.rows.length === 0 ? (
        <div className="empty empty-rich">
          <p className="empty-headline">No vaults yet.</p>
          <p className="muted">
            Install one with <code>parachute install vault</code> on the host this hub runs on,
            then click <strong>Refresh from hub</strong> above.
          </p>
          <p style={{ marginTop: '0.75rem' }}>
            <a
              href="https://github.com/ParachuteComputer/parachute-vault#install"
              target="_blank"
              rel="noreferrer"
            >
              How to install a vault →
            </a>
          </p>
        </div>
      ) : (
        <div style={{ marginTop: '1rem' }}>
          {state.rows.map((r) => (
            <VaultRowView key={r.vault.name} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function VaultRowView({ row }: { row: VaultRow }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0.75rem 1rem',
        background: 'white',
        border: '1px solid var(--border)',
        borderRadius: '8px',
        marginBottom: '0.5rem',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          <code style={{ fontSize: '0.95em' }}>{row.vault.name}</code>
          <span className="tag muted" title="Vault version reported by the hub">
            v{row.vault.version}
          </span>
          <CountBadge label="tokens" value={row.tokenCount} />
          <CountBadge label="attached" value={row.attachedGroupsCount} />
        </div>
        <div className="dim" style={{ marginTop: '0.25rem', wordBreak: 'break-all' }}>
          <code>{row.vault.url}</code>
        </div>
      </div>
      <Link to={`/vaults/${encodeURIComponent(row.vault.name)}`} className="secondary">
        ▸ Manage
      </Link>
    </div>
  );
}

function tokenProbeToCountState(
  result: PromiseSettledResult<TokenCountProbe>,
): CountState {
  if (result.status === 'rejected') return 'error';
  switch (result.value.kind) {
    case 'count':
      return result.value.value;
    case 'unauthorized':
      return 'unauthorized';
    case 'error':
      return 'error';
  }
}

function CountBadge({ label, value }: { label: string; value: CountState }) {
  if (value === null) {
    return (
      <span className="tag muted" title={`Loading ${label}…`}>
        {`${label}: …`}
      </span>
    );
  }
  if (value === 'unauthorized') {
    // vault:<name>:admin scope is granted on the detail page — until then,
    // the index can't read the vault's token list. Don't break the whole
    // page over a single missing per-vault scope.
    return (
      <span
        className="tag muted"
        title={`Click Manage to grant vault:${label} access.`}
      >
        {`${label}: —`}
      </span>
    );
  }
  if (value === 'error') {
    return (
      <span className="tag muted" title={`Couldn't load ${label} — vault may be down. Click Refresh from hub or Manage to retry.`}>
        {`${label}: ?`}
      </span>
    );
  }
  return <span className="tag muted">{`${label}: ${value}`}</span>;
}
