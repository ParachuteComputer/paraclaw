/**
 * Helpers for attaching a Parachute Vault as an MCP server to a Paraclaw
 * agent group.
 *
 * The vault MCP is HTTP-transport (`type: 'http'` + `url` + `Authorization`
 * header). Attaching writes the entry into the group's `container.json`
 * `mcpServers.<name>` slot and persists the attach record to a sibling
 * `parachute.json` so we can list/detach later without re-asking for
 * configuration.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../config.js';
import type { McpServerConfig, HttpMcpServerConfig, ContainerConfig } from '../container-config.js';
import { readContainerConfig, writeContainerConfig } from '../container-config.js';
import type { BuildVaultMcpOpts, VaultAttachment, VaultScope } from './types.js';

/** Default name under which we register the vault MCP server. */
export const DEFAULT_VAULT_MCP_NAME = 'parachute-vault';

/** Path to the per-group Parachute attachment record. */
function parachuteJsonPath(folder: string): string {
  return path.join(GROUPS_DIR, folder, 'parachute.json');
}

/**
 * Build the `McpServerConfig` for a vault attach. Pure — does not touch
 * disk. The result is suitable for writing into `container.json`'s
 * `mcpServers.<name>` slot.
 */
export function buildVaultMcpServer(opts: BuildVaultMcpOpts): HttpMcpServerConfig {
  const baseUrl = opts.vaultBaseUrl.replace(/\/+$/, '');
  return {
    type: 'http',
    url: `${baseUrl}/mcp`,
    headers: {
      Authorization: `Bearer ${opts.vaultToken}`,
    },
    instructions: opts.instructions,
  };
}

/**
 * Hostnames that point at "this machine" from outside a container, but
 * inside a container point at the container itself — so an MCP server on
 * the host is unreachable. Rewrite to `host.docker.internal`, which Docker
 * Desktop / OrbStack expose natively on macOS+Windows. On Linux, paraclaw
 * already passes `--add-host=host.docker.internal:host-gateway` to every
 * `docker run` (`src/container-runtime.ts:hostGatewayArgs`), so the same
 * hostname resolves there too.
 *
 * The point of this rewrite happening at *container-spawn* time (rather
 * than persisted on disk) is so the on-disk `container.json` keeps the
 * operator-facing URL — what they typed, what the UI displays. The
 * container sees a derived copy with loopback addresses translated.
 *
 * Non-loopback hostnames (LAN IPs, public domains, tailnet hosts) pass
 * through unchanged: they're already container-reachable via Docker's
 * bridge or the host network.
 */
const CONTAINER_HOST_NAME = 'host.docker.internal';
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', 'localhost.localdomain']);

export function localhostToContainerHost(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a parseable URL — pass through unchanged. Caller will see the
    // same connection error they would have anyway.
    return url;
  }
  // URL canonicalizes `[::1]` to `[::1]` with brackets; strip for compare.
  const hostname = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  if (LOOPBACK_HOSTNAMES.has(hostname)) {
    parsed.hostname = CONTAINER_HOST_NAME;
    return parsed.toString();
  }
  return url;
}

/**
 * Apply `localhostToContainerHost` to every HTTP MCP entry in a container
 * config, returning a deep-cloned copy. The input config is left intact —
 * use this when preparing a per-spawn copy of `container.json` to mount
 * into a container without modifying what's persisted on disk.
 */
export function rewriteMcpUrlsForContainer(config: ContainerConfig): ContainerConfig {
  // Structured clone is fine here: ContainerConfig is JSON-shaped.
  const clone = JSON.parse(JSON.stringify(config)) as ContainerConfig;
  for (const [name, entry] of Object.entries(clone.mcpServers)) {
    if (entry && typeof entry === 'object' && 'type' in entry && entry.type === 'http' && 'url' in entry) {
      const httpEntry = entry as HttpMcpServerConfig;
      httpEntry.url = localhostToContainerHost(httpEntry.url);
      clone.mcpServers[name] = httpEntry;
    }
  }
  return clone;
}

export interface AttachVaultOpts {
  /** Group folder name (matches `groups/<folder>`). */
  folder: string;
  /** Vault base URL, no trailing slash, no `/mcp` suffix. */
  vaultBaseUrl: string;
  /** The `pvt_…` token to bake into the MCP entry. */
  vaultToken: string;
  /** Scope this token was minted at — recorded in parachute.json for visibility. */
  scope: VaultScope;
  /** Token label (matches what's registered with the vault). */
  tokenLabel: string;
  /** Optional MCP name override. Defaults to `parachute-vault`. */
  mcpName?: string;
  /** Optional in-context instructions for the agent. */
  instructions?: string;
}

/**
 * Attach a vault to an agent group. Idempotent — re-attaching with the same
 * `mcpName` updates the entry in place.
 */
export function attachVaultToGroup(opts: AttachVaultOpts): void {
  const name = opts.mcpName ?? DEFAULT_VAULT_MCP_NAME;
  const groupPath = path.join(GROUPS_DIR, opts.folder);
  if (!fs.existsSync(groupPath)) {
    throw new Error(`agent group folder not found: ${groupPath}`);
  }

  const cfg: ContainerConfig = readContainerConfig(opts.folder);
  const mcpEntry: McpServerConfig = buildVaultMcpServer({
    vaultBaseUrl: opts.vaultBaseUrl,
    vaultToken: opts.vaultToken,
    instructions: opts.instructions,
  });
  cfg.mcpServers[name] = mcpEntry;
  writeContainerConfig(opts.folder, cfg);

  const attachment: VaultAttachment = {
    vaultBaseUrl: opts.vaultBaseUrl.replace(/\/+$/, ''),
    scope: opts.scope,
    tokenLabel: opts.tokenLabel,
    attachedAt: new Date().toISOString(),
  };
  fs.writeFileSync(parachuteJsonPath(opts.folder), JSON.stringify({ vault: { [name]: attachment } }, null, 2) + '\n');
}

/**
 * Read the Parachute attach record for a group, if any. Returns null when
 * the file doesn't exist (group was never attached, or attached pre-record).
 */
export function readVaultAttachment(folder: string, mcpName = DEFAULT_VAULT_MCP_NAME): VaultAttachment | null {
  const p = parachuteJsonPath(folder);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
      vault?: Record<string, VaultAttachment>;
    };
    return raw.vault?.[mcpName] ?? null;
  } catch {
    return null;
  }
}

/**
 * Read every vault attachment record across the given folders. Used by the
 * `/claw/vaults` UI to compute "this token is attached to these groups" by
 * matching `tokenLabel` against the vault's listed tokens.
 *
 * Returns one entry per (folder, mcpName) — a single group can have multiple
 * attachments under different MCP names, though in practice we only use
 * `parachute-vault`. Folders without a parachute.json or with malformed JSON
 * are silently skipped (same forgiveness as `readVaultAttachment`).
 */
export interface VaultAttachmentEntry {
  folder: string;
  mcpName: string;
  attachment: VaultAttachment;
}

export function listVaultAttachments(folders: string[]): VaultAttachmentEntry[] {
  const out: VaultAttachmentEntry[] = [];
  for (const folder of folders) {
    const p = parachuteJsonPath(folder);
    if (!fs.existsSync(p)) continue;
    let raw: { vault?: Record<string, VaultAttachment> };
    try {
      raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      continue;
    }
    if (!raw.vault) continue;
    for (const [mcpName, attachment] of Object.entries(raw.vault)) {
      out.push({ folder, mcpName, attachment });
    }
  }
  return out;
}

/**
 * Detach a vault from an agent group. Removes the MCP entry from
 * `container.json` and the attach record from `parachute.json`. Does NOT
 * revoke the vault token — caller is responsible for `parachute vault
 * tokens revoke <label>` since revocation is one-way and we don't want a
 * detach to silently nuke a token an operator might still want.
 */
export function detachVaultFromGroup(folder: string, mcpName = DEFAULT_VAULT_MCP_NAME): void {
  const cfg = readContainerConfig(folder);
  if (cfg.mcpServers[mcpName]) {
    delete cfg.mcpServers[mcpName];
    writeContainerConfig(folder, cfg);
  }

  const p = parachuteJsonPath(folder);
  if (fs.existsSync(p)) {
    try {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as {
        vault?: Record<string, VaultAttachment>;
      };
      if (raw.vault?.[mcpName]) {
        delete raw.vault[mcpName];
        if (Object.keys(raw.vault).length === 0) {
          fs.unlinkSync(p);
        } else {
          fs.writeFileSync(p, JSON.stringify(raw, null, 2) + '\n');
        }
      }
    } catch {
      // best-effort — don't fail detach on a malformed record
    }
  }
}
