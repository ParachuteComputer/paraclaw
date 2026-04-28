/**
 * Self-registration into `~/.parachute/services.json` on server startup.
 *
 * Mirrors `parachute-scribe/src/services-manifest.ts` deliberately — the
 * shape is the contract between every Parachute service and the hub
 * (`parachute-hub/src/services-manifest.ts` is the canonical reader).
 * Once paraclaw earns a slot in the hub's vendored fallback, the
 * manifest read flips to `.parachute/module.json`-backed and this file
 * becomes the live state-side companion. Until then, this is what makes
 * `parachute status` / `parachute expose` see paraclaw at all.
 *
 * Failure mode: any write error is logged + swallowed. Self-registration
 * is best-effort — the server still serves locally even if the manifest
 * write fails (permissions, disk full, race with another writer).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface ServiceEntry {
  name: string;
  port: number;
  paths: string[];
  health: string;
  version: string;
  displayName?: string;
  tagline?: string;
}

interface ServicesManifest {
  services: ServiceEntry[];
}

export function resolveManifestPath(): string {
  const base = process.env.PARACHUTE_HOME ?? join(homedir(), '.parachute');
  return join(base, 'services.json');
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
  // Merge rather than replace so fields the hub stamps onto the row
  // (`installDir` from parachute-hub#84, etc.) survive a self-registration
  // pass. Paraclaw still wins for the fields it owns — port, paths,
  // version, health — because they spread last.
  if (idx >= 0) manifest.services[idx] = { ...manifest.services[idx], ...entry };
  else manifest.services.push(entry);
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, path);
}
