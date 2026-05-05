/**
 * /vaults/:name — vault management detail page (Phase 3 of paraclaw#38).
 *
 * Three sections:
 *   1. Tokens table     — GET /api/vaults/:name/tokens, with Revoke confirm modal.
 *   2. Attached groups  — derived from GET /api/vaults/:name, with Detach modal
 *                          offering Keep token (default) and Detach + revoke.
 *   3. Mint new token   — POST /api/vaults/:name/tokens, plaintext shown ONCE
 *                          in a copy-card. Plaintext lives in component state
 *                          only; never persisted, never logged.
 *
 * Auth model (Option C from the design doc): paraclaw forwards the operator's
 * hub session JWT to the vault unmodified. The vault checks `vault:<name>:admin`
 * itself; a 401/403 here means the operator hasn't consented to that narrow
 * scope yet. Render an explicit "Grant access" CTA that calls
 * `beginLogin([\`vault:\${name}:admin\`])` rather than auto-redirecting — the
 * operator should see *why* they're being bounced back to the hub.
 *
 * Plaintext rules (loadbearing per design § Token rendering rules):
 *   - Shown once on mint, in a copy-card with explicit copy button.
 *   - Never round-tripped through localStorage / sessionStorage.
 *   - Never re-rendered after the operator dismisses the card.
 *   - If the operator dismisses without copying, surface a yellow recovery
 *     banner pointing them at Revoke + re-mint.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatRelative } from '../components/StatusDot.tsx';
import {
  HttpError,
  detachVault,
  getVaultDetail,
  listVaultTokens,
  mintVaultToken,
  revokeVaultToken,
  type MintedVaultToken,
  type VaultAttachedGroup,
  type VaultDetail as VaultDetailData,
  type VaultToken,
} from '../lib/api.ts';
import { beginLogin } from '../lib/auth.ts';

const BROAD_SCOPES = ['vault:read', 'vault:write', 'vault:admin'] as const;

interface LoadedState {
  kind: 'ok';
  detail: VaultDetailData;
  tokens: VaultToken[];
}

interface AuthGateState {
  kind: 'auth-gate';
  detail: VaultDetailData;
  /** What the vault returned — we surface the message verbatim so the operator can debug. */
  message: string;
}

type State =
  | { kind: 'loading' }
  | LoadedState
  | AuthGateState
  | { kind: 'error'; message: string };

export function VaultDetail() {
  const { name: rawName } = useParams<{ name: string }>();
  const name = rawName ?? '';

  const [state, setState] = useState<State>({ kind: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    if (!name) return;
    let cancelled = false;
    // Skip the loading-skeleton transition on reloads — keep the existing
    // LoadedView mounted so its ephemeral local state (mintedDismissed,
    // pre-targeted modals, etc.) survives the round-trip. Initial mount
    // still shows the skeleton because state starts as { kind: 'loading' }.
    setState((prev) =>
      prev.kind === 'ok' || prev.kind === 'auth-gate' ? prev : { kind: 'loading' },
    );

    (async () => {
      // Load detail (agent:read) and tokens (agent:admin + vault:<name>:admin)
      // in parallel. The detail call always succeeds for an operator with
      // a valid session JWT; the tokens call may 401/403 vault-side if the
      // operator hasn't consented to the narrow vault scope yet.
      const [detailResult, tokensResult] = await Promise.allSettled([
        getVaultDetail(name),
        listVaultTokens(name),
      ]);

      if (cancelled) return;

      if (detailResult.status === 'rejected') {
        const err = detailResult.reason;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
        return;
      }

      if (tokensResult.status === 'rejected') {
        const err = tokensResult.reason;
        if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
          setState({ kind: 'auth-gate', detail: detailResult.value, message: err.message });
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
        return;
      }

      setState({ kind: 'ok', detail: detailResult.value, tokens: tokensResult.value });
    })();

    return () => {
      cancelled = true;
    };
  }, [name, reloadKey]);

  if (!name) {
    return (
      <div>
        <Link to="/vaults" className="muted">
          ← All vaults
        </Link>
        <div className="empty">No vault name in URL.</div>
      </div>
    );
  }

  if (state.kind === 'loading') {
    return (
      <div>
        <Link to="/vaults" className="muted">
          ← All vaults
        </Link>
        <div className="skeleton skeleton-heading" style={{ marginTop: '1rem' }} />
        <div className="section">
          <div className="skeleton skeleton-line" style={{ width: '30%' }} />
          <div className="skeleton skeleton-line" />
          <div className="skeleton skeleton-line" style={{ width: '70%' }} />
        </div>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div>
        <Link to="/vaults" className="muted">
          ← All vaults
        </Link>
        <h2>{name}</h2>
        <div className="error-banner">
          Couldn't load vault: <code>{state.message}</code>
        </div>
        <div className="actions" style={{ marginTop: '1rem' }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  if (state.kind === 'auth-gate') {
    return <AuthGateView name={name} detail={state.detail} message={state.message} />;
  }

  return <LoadedView name={name} state={state} reload={reload} />;
}

function AuthGateView({
  name,
  detail,
  message,
}: {
  name: string;
  detail: VaultDetailData;
  message: string;
}) {
  // Click → fire OAuth flow with the narrow per-vault admin scope appended.
  // beginLogin never returns control (it does window.location.replace); we
  // wrap in an async function only so the test harness can await the call.
  const onGrant = async () => {
    await beginLogin([`vault:${name}:admin`]);
  };
  return (
    <div>
      <Link to="/vaults" className="muted">
        ← All vaults
      </Link>
      <h2>
        <code>{name}</code>{' '}
        <span className="tag muted" title="Vault version reported by the hub">
          v{detail.vault.version}
        </span>
      </h2>
      <div className="section">
        <h3>Additional consent required</h3>
        <p>
          Managing tokens for <code>{name}</code> requires the per-vault scope{' '}
          <code>vault:{name}:admin</code>. Your current session doesn't carry it. The
          hub will prompt you to consent — you'll come right back here.
        </p>
        <p className="dim">
          Vault said: <code>{message}</code>
        </p>
        <div className="actions">
          <button onClick={() => void onGrant()}>Grant access</button>
          <Link to="/vaults" className="secondary">
            Back to vaults
          </Link>
        </div>
      </div>
    </div>
  );
}

interface LoadedViewProps {
  name: string;
  state: LoadedState;
  reload: () => void;
}

function LoadedView({ name, state, reload }: LoadedViewProps) {
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<VaultToken | null>(null);
  const [detachTarget, setDetachTarget] = useState<VaultAttachedGroup | null>(null);
  const [minted, setMinted] = useState<MintedVaultToken | null>(null);
  const [mintedCopied, setMintedCopied] = useState(false);
  // Only id + label here — the full MintedVaultToken carries the plaintext,
  // and we only need the label for display + id to look up the live
  // VaultToken if the operator clicks the inline 'Revoke' shortcut.
  const [mintedDismissed, setMintedDismissed] = useState<{ id: string; label: string } | null>(null);

  const onMinted = (token: MintedVaultToken) => {
    setMinted(token);
    setMintedCopied(false);
    setMintedDismissed(null);
    setFlash(null);
  };

  const onCloseMinted = (copied: boolean) => {
    if (minted && !copied) {
      setMintedDismissed({ id: minted.id, label: minted.label });
    }
    setMinted(null);
    setMintedCopied(false);
    reload();
  };

  // Derive the live VaultToken for the banner's inline Revoke CTA. Computed
  // outside the handler so the JSX can disable the button + show a tooltip
  // when the lookup misses (race vs. reload, or vault renamed the id post-
  // mint). Without this guard, clicking the button is inert and the operator
  // sees no feedback.
  const liveDismissedToken = mintedDismissed
    ? (state.tokens.find((t) => t.id === mintedDismissed.id) ?? null)
    : null;

  const onRevokeFromBanner = () => {
    if (liveDismissedToken) {
      setRevokeTarget(liveDismissedToken);
      setMintedDismissed(null);
    }
  };

  return (
    <div>
      <Link to="/vaults" className="muted">
        ← All vaults
      </Link>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', flexWrap: 'wrap' }}>
        <code>{name}</code>
        <span className="tag muted" title="Vault version reported by the hub">
          v{state.detail.vault.version}
        </span>
      </h2>
      <div className="dim" style={{ marginTop: '-0.5rem', wordBreak: 'break-all' }}>
        <code>{state.detail.vault.url}</code>
      </div>

      {flash && (
        <div className={flash.kind === 'ok' ? 'status-banner' : 'error-banner'} style={{ marginTop: '1rem' }}>
          {flash.text}
        </div>
      )}

      {mintedDismissed && (
        <div className="warn-banner" style={{ marginTop: '1rem' }}>
          Token <code>{mintedDismissed.label}</code> was minted but you didn't copy the
          plaintext. The plaintext is gone — vault stores only a hash. Revoke this token now and
          mint a new one if you need access.
          <div className="actions" style={{ marginTop: '0.5rem' }}>
            <button
              type="button"
              className="danger"
              onClick={onRevokeFromBanner}
              disabled={!liveDismissedToken}
              title={
                liveDismissedToken
                  ? undefined
                  : 'Token no longer in current list — see tokens table below'
              }
            >
              Revoke {mintedDismissed.label}
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => setMintedDismissed(null)}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      <TokensSection
        name={name}
        tokens={state.tokens}
        onRevokeClick={setRevokeTarget}
      />

      <AttachedGroupsSection
        attachedGroups={state.detail.attachedGroups}
        onDetachClick={setDetachTarget}
      />

      <MintSection
        name={name}
        defaultLabel={`agent-${name}`}
        onMinted={onMinted}
        onError={(text) => setFlash({ kind: 'error', text })}
      />

      {minted && (
        <MintedTokenCard
          token={minted}
          copied={mintedCopied}
          onCopied={() => setMintedCopied(true)}
          onClose={() => onCloseMinted(mintedCopied)}
        />
      )}

      {revokeTarget && (
        <RevokeModal
          name={name}
          token={revokeTarget}
          onClose={(revoked) => {
            setRevokeTarget(null);
            if (revoked) {
              setFlash({ kind: 'ok', text: `Token ${revokeTarget.label} revoked.` });
              reload();
            }
          }}
          onError={(text) => setFlash({ kind: 'error', text })}
        />
      )}

      {detachTarget && (
        <DetachModal
          vaultName={name}
          target={detachTarget}
          onClose={(result) => {
            setDetachTarget(null);
            if (result) {
              const parts = [`Detached ${result.group} from vault.`];
              if (result.revokedTokenId) parts.push(`Token ${detachTarget.tokenLabel} revoked.`);
              else if (result.revokeError)
                parts.push(`Detach succeeded but revoke failed: ${result.revokeError}`);
              setFlash({
                kind: result.revokeError ? 'error' : 'ok',
                text: parts.join(' '),
              });
              reload();
            }
          }}
          onError={(text) => setFlash({ kind: 'error', text })}
        />
      )}
    </div>
  );
}

// --- Tokens section -------------------------------------------------------

function TokensSection({
  name: _name,
  tokens,
  onRevokeClick,
}: {
  name: string;
  tokens: VaultToken[];
  onRevokeClick: (t: VaultToken) => void;
}) {
  return (
    <div className="section" style={{ marginTop: '1.5rem' }}>
      <h3>Tokens ({tokens.length})</h3>
      {tokens.length === 0 ? (
        <p className="muted">No tokens minted for this vault yet. Use the form below to mint one.</p>
      ) : (
        <div>
          {tokens.map((t) => (
            <TokenRow key={t.id} token={t} onRevoke={() => onRevokeClick(t)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TokenRow({ token, onRevoke }: { token: VaultToken; onRevoke: () => void }) {
  const scopes = resolveScopes(token);
  const isLegacy = !token.scopes && !!token.permission;
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
          <code style={{ fontSize: '0.95em' }}>{token.label}</code>
          {scopes.map((s) => (
            <span key={s} className="tag muted">
              {s}
            </span>
          ))}
          {isLegacy && (
            <span className="tag warn" title="Legacy permission shape — re-mint at your earliest convenience.">
              legacy
            </span>
          )}
          {token.attachedTo.length === 0 ? (
            <span className="tag muted" title="No agent group is currently using this token.">
              orphan
            </span>
          ) : (
            token.attachedTo.map((a) => (
              <span key={a.folder} className="tag" title={`Attached as ${a.scope}`}>
                {a.folder}
              </span>
            ))
          )}
        </div>
        <div className="dim" style={{ marginTop: '0.25rem' }}>
          {token.created_at && (
            <span title={new Date(token.created_at).toLocaleString()}>
              created {formatRelative(token.created_at)}
            </span>
          )}
          {token.last_used_at !== undefined && (
            <>
              {' • '}
              {token.last_used_at ? (
                <span title={new Date(token.last_used_at).toLocaleString()}>
                  last used {formatRelative(token.last_used_at)}
                </span>
              ) : (
                <span className="dim">never used</span>
              )}
            </>
          )}
          {token.expires_at && (
            <>
              {' • '}
              <span title={new Date(token.expires_at).toLocaleString()}>
                expires {formatRelative(token.expires_at)}
              </span>
            </>
          )}
          {' • '}
          <code style={{ fontSize: '0.78rem' }}>{token.id}</code>
        </div>
      </div>
      <button
        type="button"
        className="secondary danger"
        onClick={onRevoke}
        style={{ background: 'white', borderColor: 'var(--error)', color: 'var(--error)' }}
      >
        Revoke
      </button>
    </div>
  );
}

function resolveScopes(token: VaultToken): string[] {
  if (token.scopes && token.scopes.length > 0) {
    return [...token.scopes].sort();
  }
  // Legacy bridge: vault's `permission` field maps to scope set per
  // parachute-vault/src/scopes.ts:24. Mirror the rule client-side so the
  // table renders correctly during the back-compat window.
  if (token.permission === 'full') return ['vault:read', 'vault:write'];
  if (token.permission === 'read') return ['vault:read'];
  return [];
}

// --- Attached-groups section ---------------------------------------------

function AttachedGroupsSection({
  attachedGroups,
  onDetachClick,
}: {
  attachedGroups: VaultAttachedGroup[];
  onDetachClick: (g: VaultAttachedGroup) => void;
}) {
  return (
    <div className="section" style={{ marginTop: '1.5rem' }}>
      <h3>Attached groups ({attachedGroups.length})</h3>
      {attachedGroups.length === 0 ? (
        <p className="muted">No agent groups are using this vault.</p>
      ) : (
        <div>
          {attachedGroups.map((g) => (
            <div
              key={g.folder}
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
                  <Link to={`/groups/${encodeURIComponent(g.folder)}`}>
                    <code style={{ fontSize: '0.95em' }}>{g.folder}</code>
                  </Link>
                  <span className="tag">{g.scope}</span>
                  <span className="tag muted" title="The token label used to mint this attachment.">
                    {g.tokenLabel}
                  </span>
                </div>
                <div className="dim" style={{ marginTop: '0.25rem' }}>
                  attached <span title={new Date(g.attachedAt).toLocaleString()}>{formatRelative(g.attachedAt)}</span>
                </div>
              </div>
              <button type="button" className="secondary" onClick={() => onDetachClick(g)}>
                Detach…
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// --- Mint section ---------------------------------------------------------

interface MintSectionProps {
  name: string;
  defaultLabel: string;
  onMinted: (t: MintedVaultToken) => void;
  onError: (message: string) => void;
}

function MintSection({ name, defaultLabel, onMinted, onError }: MintSectionProps) {
  const [label, setLabel] = useState(defaultLabel);
  const [scopes, setScopes] = useState<Set<string>>(new Set(['vault:read']));
  const [expiresAt, setExpiresAt] = useState('');
  const [busy, setBusy] = useState(false);

  const toggleScope = (s: string) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!label.trim() || scopes.size === 0) return;
    setBusy(true);
    try {
      const minted = await mintVaultToken(name, {
        label: label.trim(),
        scopes: Array.from(scopes),
        expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
      });
      onMinted(minted);
      setLabel(defaultLabel);
      setScopes(new Set(['vault:read']));
      setExpiresAt('');
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="section" style={{ marginTop: '1.5rem' }}>
      <h3>Mint new token</h3>
      <form onSubmit={onSubmit}>
        <div className="row">
          <label htmlFor="mint-label">Label</label>
          <input
            id="mint-label"
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
            maxLength={64}
            placeholder="agent-research"
            required
          />
          <p className="dim">Identifier for revocation — alphanumeric + dashes, 64 chars max.</p>
        </div>

        <div className="row">
          <label>Scopes</label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
            {BROAD_SCOPES.map((s) => (
              <label key={s} style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'center', fontWeight: 400 }}>
                <input
                  type="checkbox"
                  checked={scopes.has(s)}
                  onChange={() => toggleScope(s)}
                  disabled={busy}
                />
                <code>{s}</code>
                <span className="dim">{SCOPE_HINT[s]}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="row">
          <label htmlFor="mint-expires">Expires (optional)</label>
          <input
            id="mint-expires"
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            disabled={busy}
          />
          <p className="dim">Leave blank for never. Vault interprets the absence as no expiry.</p>
        </div>

        <div className="actions">
          <button type="submit" disabled={busy || !label.trim() || scopes.size === 0}>
            {busy ? 'Minting…' : 'Mint token'}
          </button>
        </div>
      </form>
    </div>
  );
}

const SCOPE_HINT: Record<(typeof BROAD_SCOPES)[number], string> = {
  'vault:read': 'read notes, search, follow links',
  'vault:write': 'read + create/update/delete notes',
  'vault:admin': 'write + token management + vault config',
};

// --- Minted token card ----------------------------------------------------

function MintedTokenCard({
  token,
  copied,
  onCopied,
  onClose,
}: {
  token: MintedVaultToken;
  copied: boolean;
  onCopied: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const onCopy = async () => {
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(token.token);
      onCopied();
    } catch (err) {
      setCopyError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      style={{
        width: 'min(560px, 92vw)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: 0,
        background: 'white',
      }}
    >
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Token minted — copy now</h3>
          <p className="dim" style={{ marginTop: '0.4rem' }}>
            Plaintext is shown <strong>once</strong>. The vault stores only a hash; closing this card
            without copying means the token is unrecoverable.
          </p>
        </div>
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <div className="row">
            <label>Label</label>
            <code>{token.label}</code>
          </div>
          <div className="row">
            <label htmlFor="minted-token">Plaintext token</label>
            <input
              id="minted-token"
              type="text"
              readOnly
              value={token.token}
              style={{ fontFamily: 'monospace', fontSize: '0.85rem' }}
              onFocus={(e) => e.currentTarget.select()}
            />
            <div className="actions" style={{ marginTop: '0.5rem' }}>
              <button type="button" onClick={() => void onCopy()}>
                {copied ? 'Copied ✓' : 'Copy to clipboard'}
              </button>
              <button type="button" className="secondary" onClick={onClose}>
                {copied ? 'Done' : 'Close without copying'}
              </button>
            </div>
            {copyError && (
              <p className="error-banner" style={{ marginTop: '0.5rem' }}>
                Couldn't copy: {copyError}. Select the value above and copy manually.
              </p>
            )}
          </div>
          {!copied && (
            <p className="warn-banner" style={{ marginTop: '0.5rem' }}>
              You haven't copied the token yet. If you close now, you'll need to revoke and mint a
              new one.
            </p>
          )}
        </div>
      </form>
    </dialog>
  );
}

// --- Revoke modal ---------------------------------------------------------

function RevokeModal({
  name,
  token,
  onClose,
  onError,
}: {
  name: string;
  token: VaultToken;
  onClose: (revoked: boolean) => void;
  onError: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const onConfirm = async () => {
    setBusy(true);
    try {
      await revokeVaultToken(name, token.id);
      onClose(true);
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onClose(false)}
      style={{
        width: 'min(480px, 92vw)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: 0,
        background: 'white',
      }}
    >
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
            Revoke <code>{token.label}</code>?
          </h3>
        </div>
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <p>
            Revocation is <strong>one-way</strong>. Any agent group still using this token will
            start failing immediately on its next vault call.
          </p>
          {token.attachedTo.length > 0 && (
            <p className="warn-banner">
              This token is currently attached to:{' '}
              {token.attachedTo.map((a) => a.folder).join(', ')}.
            </p>
          )}
          <div className="actions" style={{ marginTop: '1rem', justifyContent: 'flex-end' }}>
            <button type="button" className="secondary" onClick={() => onClose(false)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void onConfirm()}
              disabled={busy}
            >
              {busy ? 'Revoking…' : 'Revoke token'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

// --- Detach modal ---------------------------------------------------------

interface DetachOutcome {
  group: string;
  revokedTokenId: string | null;
  revokeError: string | null;
}

function DetachModal({
  vaultName,
  target,
  onClose,
  onError,
}: {
  vaultName: string;
  target: VaultAttachedGroup;
  onClose: (result: DetachOutcome | null) => void;
  onError: (message: string) => void;
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialogRef.current;
    if (d && !d.open) d.showModal();
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  const detach = async (revokeToken: boolean) => {
    setBusy(true);
    try {
      // Thread the narrow per-vault admin scope only when we're actually
      // calling vault — Keep-token (revokeToken=false) just hits the
      // parachute-agent-side agent:write check, which the broad re-auth set
      // already covers. Asking for vault:<name>:admin on the Keep path
      // would be a no-op extra scope on the consent screen.
      const result = await detachVault(target.folder, {
        mcpName: target.mcpName,
        revokeToken,
        authExtraScopes: revokeToken ? [`vault:${vaultName}:admin`] : undefined,
      });
      onClose({
        group: result.group.folder,
        revokedTokenId: result.revokedTokenId,
        revokeError: result.revokeError,
      });
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      onClose={() => onClose(null)}
      style={{
        width: 'min(520px, 92vw)',
        border: '1px solid var(--border)',
        borderRadius: '12px',
        padding: 0,
        background: 'white',
      }}
    >
      <form method="dialog" onSubmit={(e) => e.preventDefault()}>
        <div style={{ padding: '1.25rem 1.5rem', borderBottom: '1px solid var(--border)' }}>
          <h3 style={{ margin: 0, fontSize: '1.05rem' }}>
            Detach <code>{target.folder}</code> from this vault
          </h3>
        </div>
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <p>
            Token <code>{target.tokenLabel}</code> minted as <code>{target.scope}</code>.
          </p>
          <p className="muted">
            Choose what happens to the token. Detaching always removes the agent's vault MCP entry —
            the difference is whether the token stays live on the vault.
          </p>
          <div className="actions" style={{ marginTop: '1rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <button type="button" className="secondary" onClick={() => onClose(null)} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => void detach(true)}
              disabled={busy}
            >
              {busy ? 'Working…' : 'Detach + revoke'}
            </button>
            <button
              type="button"
              onClick={() => void detach(false)}
              disabled={busy}
              autoFocus
              style={{ cursor: 'default' }}
            >
              Keep token
            </button>
          </div>
          <p className="dim" style={{ marginTop: '0.75rem' }}>
            <strong>Keep token</strong> is the default — silently revoking can wedge unrelated
            callers. Use <strong>Detach + revoke</strong> when retiring a group.
          </p>
        </div>
      </form>
    </dialog>
  );
}
