/**
 * /api/setup/status — readiness probe consumed by the setup wizard.
 *
 *   - `secrets`        — AES-GCM master key file is present + readable
 *   - `hub`            — hub origin reachable; JWKS endpoint resolves
 *   - `vaultAttached`  — at least one agent group has a vault attached
 *   - `channels`       — discord + telegram adapter modules present in trunk
 *
 * `ready` is the AND of secrets + hub + vaultAttached. Channel installs
 * are advisory; the wizard surfaces the "install now?" CTA based on the
 * per-channel `installed` flag, but a missing channel doesn't gate the
 * rest of the install.
 *
 * Shape mirrors `web/ui/src/lib/api.ts:SetupStatus` — drift here breaks
 * the wizard. The optional `secrets.missing` array is for surfacing
 * specific symptoms (e.g. 'master.key' wrong-mode); empty when ok.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getMasterKeyPath, loadOrCreateMasterKey } from '../../secrets/master-key.js';
import { readVaultAttachment } from '../../parachute/vault-mcp.js';
import { getHubOrigin } from '../auth.js';

interface SetupCheck {
  ok: boolean;
  detail: string;
  fix: string | null;
  missing?: string[];
}

interface SetupStatus {
  secrets: SetupCheck;
  hub: SetupCheck;
  vaultAttached: SetupCheck;
  channels: {
    discord: { installed: boolean };
    telegram: { installed: boolean };
  };
  ready: boolean;
}

// src/channels lives at <repo>/src/channels relative to the project root.
// The web server bootstrap chdirs to project root, so a bare relative path
// works regardless of where Bun launched the process from.
const CHANNELS_DIR = path.resolve('src/channels');

function checkSecrets(): SetupCheck {
  const keyPath = getMasterKeyPath();
  // The wizard runs *before* any agent boot — generating the key here on
  // first poll is intentional. After the file exists, every subsequent
  // call confirms readability + permission mode.
  try {
    loadOrCreateMasterKey();
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: `Inspect ${keyPath} — expected 32 raw bytes, mode 0600.`,
      missing: ['master.key'],
    };
  }
  // Mode check is best-effort: on platforms where the FS doesn't preserve
  // POSIX bits (rare for this tool's target deployments) we still report
  // ok=true since the key loaded — but the fix nudges toward 0600.
  try {
    const stat = fs.statSync(keyPath);
    const mode = stat.mode & 0o777;
    if (mode !== 0o600) {
      return {
        ok: false,
        detail: `master.key has mode 0${mode.toString(8)}; expected 0600`,
        fix: `chmod 600 ${keyPath}`,
      };
    }
  } catch {
    // statSync failure after a successful load is impossible in practice;
    // if it ever fires, treat as ok=true since we already have the key.
  }
  return {
    ok: true,
    detail: `master key present at ${keyPath} (mode 0600)`,
    fix: null,
  };
}

async function checkHub(): Promise<SetupCheck> {
  const origin = getHubOrigin();
  // Probe the JWKS endpoint specifically — that's what auth.ts actually
  // pulls on every request. A 200 with a JSON body containing keys[] is
  // the only signal that matters; root health checks lie when /.well-known
  // is mis-routed.
  const url = `${origin}/.well-known/jwks.json`;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) {
      return {
        ok: false,
        detail: `JWKS at ${url} returned ${r.status}`,
        fix: `Confirm parachute-hub is running and accessible at ${origin}.`,
      };
    }
    const body = (await r.json()) as { keys?: unknown[] };
    if (!Array.isArray(body.keys) || body.keys.length === 0) {
      return {
        ok: false,
        detail: `JWKS at ${url} returned no keys`,
        fix: `Hub may still be initializing; retry in a few seconds.`,
      };
    }
    return { ok: true, detail: `hub reachable at ${origin}`, fix: null };
  } catch (err) {
    return {
      ok: false,
      detail: `${url} unreachable: ${err instanceof Error ? err.message : String(err)}`,
      fix: `Set PARACHUTE_HUB_ORIGIN to the hub's actual origin, or start parachute-hub.`,
    };
  }
}

function checkVaultAttached(): SetupCheck {
  // Agent groups are listed in central DB; vault attachment lives in
  // `groups/<folder>/parachute.json`. The two sources have to agree —
  // a row in agent_groups without a parachute.json means the group exists
  // but isn't vault-bound yet.
  let folders: string[] = [];
  try {
    const rows = getDb().prepare<{ folder: string }>('SELECT folder FROM agent_groups').all();
    folders = rows.map((r) => r.folder);
  } catch (err) {
    return {
      ok: false,
      detail: `agent_groups query failed: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'Run migrations: `bun src/index.ts` once to bring the central DB up to date.',
    };
  }
  if (folders.length === 0) {
    return {
      ok: false,
      detail: 'no agent groups created yet',
      fix: 'Create an agent group from /groups → "+ New".',
    };
  }
  const attached = folders.filter((f) => readVaultAttachment(f) !== null);
  if (attached.length === 0) {
    return {
      ok: false,
      detail: `${folders.length} agent group(s) exist, none have a vault attached`,
      fix: 'Open any group and run "Attach vault".',
    };
  }
  return {
    ok: true,
    detail: `${attached.length} of ${folders.length} agent group(s) have a vault attached`,
    fix: null,
  };
}

function checkChannel(name: string): { installed: boolean } {
  // The channel adapter is installed iff `src/channels/<name>.ts` exists
  // and the barrel imports it. We check the file presence; if the file
  // exists but isn't barrel-imported, the wizard's "install" CTA will
  // re-run idempotently and the import gets appended.
  return {
    installed: fs.existsSync(path.join(CHANNELS_DIR, `${name}.ts`)),
  };
}

export interface SetupStatusContext {
  pathname: string;
  method: string;
  res: http.ServerResponse;
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

export async function handleSetupStatusRoute(ctx: SetupStatusContext): Promise<boolean> {
  if (ctx.pathname !== '/api/setup/status') return false;
  if (ctx.method !== 'GET') return false;

  const secrets = checkSecrets();
  const hub = await checkHub();
  const vaultAttached = checkVaultAttached();
  const status: SetupStatus = {
    secrets,
    hub,
    vaultAttached,
    channels: {
      discord: checkChannel('discord'),
      telegram: checkChannel('telegram'),
    },
    ready: secrets.ok && hub.ok && vaultAttached.ok,
  };
  json(ctx.res, 200, status);
  return true;
}
