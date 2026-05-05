import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

const threshold = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    parts.push(`${KEY_COLOR}${k}${RESET}=${k === 'err' ? formatErr(v) : JSON.stringify(v)}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data) : ''}\n`);
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});

/**
 * One-shot rename of `<root>/logs/paraclaw{,.error}.log` to the
 * `parachute-agent` names. Called early at host startup so any tooling
 * tailing the new path picks up historical entries without an operator
 * rm/mv step.
 *
 * Caveat operators must know: the running daemon's stdout/stderr
 * descriptors are whatever the supervisor (launchd plist / systemd
 * unit) opened — until the operator re-runs `parachute install
 * parachute-agent` to regenerate the unit, the supervisor still routes
 * stdout to `paraclaw.log`. On the next supervisor-driven respawn, a
 * fresh `paraclaw.log` is recreated and new entries land there. The
 * migration is purely about preserving the historical file under the
 * new name; the live cutover happens at unit regeneration.
 *
 * Idempotent: only renames when `paraclaw*.log` exists and the new path
 * is absent. Best-effort: rename failures (permission / race) log and
 * continue. Drop in 0.2.0 along with the rest of the paraclaw-era
 * compat sweep.
 */
export function migrateLegacyLogFilenames(projectRoot: string): void {
  const logsDir = path.join(projectRoot, 'logs');
  const pairs: Array<[legacy: string, current: string]> = [
    ['paraclaw.log', 'parachute-agent.log'],
    ['paraclaw.error.log', 'parachute-agent.error.log'],
  ];
  for (const [legacyName, currentName] of pairs) {
    const legacy = path.join(logsDir, legacyName);
    const current = path.join(logsDir, currentName);
    let legacyExists: boolean;
    try {
      legacyExists = fs.statSync(legacy).isFile();
    } catch {
      continue;
    }
    if (!legacyExists) continue;
    if (fs.existsSync(current)) continue;
    try {
      fs.renameSync(legacy, current);
      log.info('Log file migrated from legacy name', {
        from: legacy,
        to: current,
        note: 'supervisor unit regeneration writes new entries here only after `parachute install parachute-agent`',
      });
    } catch (err) {
      log.warn('Could not migrate legacy log filename', { from: legacy, to: current, err });
    }
  }
}
