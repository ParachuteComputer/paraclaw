import fs from 'fs';
import path from 'path';
import { log } from './log.js';

/**
 * Read an env var by its current name, falling back to a legacy name
 * (with a one-shot deprecation warning) when only the old name is set.
 *
 * Used for the paraclaw → parachute-agent env var rename in 0.1.0:
 * existing `.env` files and operator scripts still reference `PARACLAW_*`
 * names; we accept those for one cycle but warn so operators have a
 * window to update before 0.2.0 drops the compat read.
 *
 * One-shot per-legacy-name dedupe: each legacy name warns at most once
 * per process lifetime, so a value read on every request (e.g. inside
 * a Connect middleware) doesn't spam the log.
 *
 * Resolution order, matching the wider PARACHUTE_HOME pattern: explicit
 * fresh override wins, then legacy (with warning), then undefined.
 */
const seenLegacyEnvWarnings = new Set<string>();

export function readEnvWithLegacy(fresh: string, legacy: string): string | undefined {
  const freshVal = process.env[fresh];
  if (freshVal !== undefined) return freshVal;
  const legacyVal = process.env[legacy];
  if (legacyVal !== undefined) {
    if (!seenLegacyEnvWarnings.has(legacy)) {
      seenLegacyEnvWarnings.add(legacy);
      log.warn(`Deprecated env var ${legacy} — rename to ${fresh}. Compat read removed in 0.2.0.`);
    }
    return legacyVal;
  }
  return undefined;
}

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    log.debug('.env file not found, using defaults', { err });
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}
