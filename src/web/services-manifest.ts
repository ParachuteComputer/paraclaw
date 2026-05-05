/**
 * Self-registration into `~/.parachute/services.json` on server startup.
 *
 * Mirrors `parachute-scribe/src/services-manifest.ts` deliberately — the
 * shape is the contract between every Parachute service and the hub
 * (`parachute-hub/src/services-manifest.ts` is the canonical reader).
 * Failure mode: any write error is logged + swallowed. Self-registration
 * is best-effort — the server still serves locally even if the manifest
 * write fails (permissions, disk full, race with another writer).
 *
 * `installDir` is the third-party-module hook (parachute-hub#84): hub
 * looks the field up to resolve `parachute restart agent` back to the
 * checkout it should drive. Self-registering it here means the agent
 * doesn't need a vendored fallback in hub — paraclaw#115.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PARACHUTE_DIR } from '../config.js';

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  displayName?: string;
  tagline?: string;
  installDir?: string;
}

interface ServicesManifest {
  services: ServiceEntry[];
}

export function resolveManifestPath(): string {
  return join(PARACHUTE_DIR, 'services.json');
}

function readManifest(path: string): ServicesManifest {
  if (!existsSync(path)) return { services: [] };
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { services?: unknown }).services)) {
    throw new Error(`services manifest at ${path} is malformed (missing "services" array)`);
  }
  return raw as ServicesManifest;
}

export function upsertService(entry: ServiceEntry, path: string = resolveManifestPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const manifest = readManifest(path);
  const idx = manifest.services.findIndex((s) => s.name === entry.name);
  // Merge rather than replace, intentionally diverging from
  // `parachute-hub/src/services-manifest.ts` which full-replaces the row.
  // The asymmetry tracks who's authoritative: hub owns the first-party
  // shape (read → schema-validate → write), so it can replace safely;
  // we're a third-party self-registrant preserving any fields hub stamps
  // that we don't own (the hub#84 `installDir` slot, future hub-stamped
  // metadata). The agent still wins for the fields it owns — port, paths,
  // version, health, installDir — because `entry` spreads last.
  if (idx >= 0) manifest.services[idx] = { ...manifest.services[idx], ...entry };
  else manifest.services.push(entry);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}
