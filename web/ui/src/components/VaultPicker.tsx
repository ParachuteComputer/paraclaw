import { useEffect, useRef, useState } from 'react';
import { listVaults, type VaultListing } from '../lib/api.ts';

interface VaultPickerProps {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  inputId?: string;
  /** Fires with the picked vault's display name (or null when "Other" is selected / no match). */
  onPickedName?: (name: string | null) => void;
}

const OTHER_SENTINEL = '__other__';

export function VaultPicker({ value, onChange, disabled, inputId, onPickedName }: VaultPickerProps) {
  const [vaults, setVaults] = useState<VaultListing[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [useCustomUrl, setUseCustomUrl] = useState(false);
  const initializedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    listVaults()
      .then((vs) => {
        if (cancelled) return;
        setVaults(vs);
        if (initializedRef.current) return;
        initializedRef.current = true;
        if (vs.length === 0) {
          setUseCustomUrl(true);
          onPickedName?.(null);
          return;
        }
        const match = vs.find((v) => v.url === value);
        if (!match) onChange(vs[0].url);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadError(e instanceof Error ? e.message : String(e));
        setUseCustomUrl(true);
        initializedRef.current = true;
        onPickedName?.(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notify parent when the picked-name changes (selection or value flip).
  useEffect(() => {
    if (!onPickedName) return;
    if (useCustomUrl) {
      onPickedName(null);
      return;
    }
    if (!vaults) return;
    const match = vaults.find((v) => v.url === value);
    onPickedName(match ? match.name : null);
  }, [vaults, value, useCustomUrl, onPickedName]);

  const trimmed = value.replace(/\/+$/, '');
  const reachLine = (
    <p className="dim">
      The agent will reach this at <code>{trimmed || '…'}/mcp</code>.
    </p>
  );

  if (vaults === null && !loadError) {
    return <p className="dim">Loading vaults…</p>;
  }

  const customInput = (
    <input
      id={vaults && vaults.length > 0 ? undefined : inputId}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder="https://parachute.example/vault/default"
      style={vaults && vaults.length > 0 ? { marginTop: '0.5rem' } : undefined}
    />
  );

  if (!vaults || vaults.length === 0) {
    return (
      <>
        {customInput}
        {reachLine}
        {loadError && <p className="dim">(could not list registered vaults: {loadError})</p>}
      </>
    );
  }

  return (
    <>
      <select
        id={inputId}
        value={useCustomUrl ? OTHER_SENTINEL : value}
        onChange={(e) => {
          if (e.target.value === OTHER_SENTINEL) {
            setUseCustomUrl(true);
          } else {
            setUseCustomUrl(false);
            onChange(e.target.value);
          }
        }}
        disabled={disabled}
      >
        {vaults.map((v) => (
          <option key={v.url} value={v.url}>
            {v.name} — {v.url}
          </option>
        ))}
        <option value={OTHER_SENTINEL}>Other (paste URL)…</option>
      </select>
      {useCustomUrl && customInput}
      {reachLine}
    </>
  );
}

export function vaultLabelForUrl(vaults: VaultListing[] | null, url: string): string | null {
  if (!vaults) return null;
  const match = vaults.find((v) => v.url === url.replace(/\/+$/, ''));
  return match ? match.name : null;
}
