import { Database as RawDatabase } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

import { CENTRAL_DB_PATH, LEGACY_CENTRAL_DB_PATH, LEGACY_PARACLAW_DB_DIR, LEGACY_PARACLAW_DB_PATH } from '../config.js';
import { log } from '../log.js';

let _db: WrappedDatabase | null = null;

export function getDb(): WrappedDatabase {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.');
  return _db;
}

export function initDb(dbPath: string): WrappedDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  _db = new WrappedDatabase(new RawDatabase(dbPath));
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  log.info('Central DB initialized', { path: dbPath });
  return _db;
}

/**
 * One-shot migration: relocate the central DB from a legacy location to the
 * operator-owned `<PARACHUTE_DIR>/agent/agent.db`. Two legacy locations are
 * checked in priority order:
 *   1. `<PARACHUTE_DIR>/claw/paraclaw.db` — pre-0.1.0, before the
 *      paraclaw → parachute-agent rename.
 *   2. `<PROJECT_ROOT>/data/v2.db` — pre-0.0.6, before central state moved
 *      out of the project tree.
 * Idempotent — noop if the new path already exists OR no legacy path does.
 *
 * The legacy file is left in place as a backup. Operators can rm it after they
 * verify the new location works; we don't delete on their behalf because the
 * data is irreplaceable (per-session message state, agent group config, etc).
 *
 * Called from src/index.ts before initDb. Safe to call multiple times.
 *
 * Path overrides exist for tests; production callers pass no args.
 */
export function migrateCentralDbLocation(
  legacy: string = LEGACY_CENTRAL_DB_PATH,
  current: string = CENTRAL_DB_PATH,
  paraclawLegacy: string = LEGACY_PARACLAW_DB_PATH,
): void {
  if (fs.existsSync(current)) return; // already on the new location

  // Prefer the paraclaw-era legacy path: it's the more recent state for
  // anyone upgrading through 0.0.x → 0.1.0.
  const source = fs.existsSync(paraclawLegacy) ? paraclawLegacy : fs.existsSync(legacy) ? legacy : null;
  if (!source) return; // fresh install, nothing to migrate

  fs.mkdirSync(path.dirname(current), { recursive: true, mode: 0o700 });
  // Use copyFile (not rename) so a partial migration doesn't strand the user
  // between locations. After successful copy the legacy file stays as backup.
  fs.copyFileSync(source, current);
  fs.chmodSync(current, 0o600);
  log.info('Central DB migrated from legacy location', {
    from: source,
    to: current,
    note: 'legacy file kept as backup; rm manually after verifying',
  });
}

/**
 * One-shot migration: copy `<PARACHUTE_DIR>/claw/master.key` to
 * `<PARACHUTE_DIR>/agent/master.key` so encrypted-secret rows decrypted under
 * the old key continue to decrypt after the paraclaw → parachute-agent
 * rename. Idempotent — noop if the new key already exists OR the legacy
 * key doesn't.
 *
 * The legacy file is left in place — same rationale as the DB migration.
 *
 * Path overrides exist for tests; production callers pass no args.
 */
export function migrateMasterKeyLocation(
  legacyDir: string = LEGACY_PARACLAW_DB_DIR,
  currentDir: string = path.dirname(CENTRAL_DB_PATH),
): void {
  const legacyKey = path.join(legacyDir, 'master.key');
  const currentKey = path.join(currentDir, 'master.key');
  if (fs.existsSync(currentKey)) return;
  if (!fs.existsSync(legacyKey)) return;

  fs.mkdirSync(currentDir, { recursive: true, mode: 0o700 });
  fs.copyFileSync(legacyKey, currentKey);
  fs.chmodSync(currentKey, 0o600);
  log.info('Master key migrated from legacy location', {
    from: legacyKey,
    to: currentKey,
    note: 'legacy file kept as backup; rm manually after verifying',
  });
}

/** For tests only — creates an in-memory DB and runs migrations. */
export function initTestDb(): WrappedDatabase {
  _db = new WrappedDatabase(new RawDatabase(':memory:'));
  _db.exec('PRAGMA foreign_keys = ON');
  return _db;
}

export function closeDb(): void {
  _db?.close();
  _db = null;
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Cheap: a single indexed lookup on
 * sqlite_master. Results are not cached — a module install adds the
 * table at runtime (next service start), and callers may run before
 * or after that boundary.
 */
export function hasTable(db: WrappedDatabase, name: string): boolean {
  const row = db.prepare(`SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
    | { one: number }
    | undefined
    | null;
  return row != null;
}

// ---------------------------------------------------------------------------
// bun:sqlite wrapper — papers over the named-param prefix gotcha.
//
// better-sqlite3 lets you write SQL `@name` and pass `{ name: ... }`. bun:sqlite
// does NOT auto-strip the prefix: it silently binds null. We wrap prepare() so
// that plain-object args get keys auto-prefixed with `@`. Callers can keep
// writing their existing patterns; positional `?` + primitive args are
// unaffected.
// ---------------------------------------------------------------------------

type Bindable = unknown;

function prefixObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@') || k.startsWith('$') || k.startsWith(':')) {
      out[k] = v;
    } else {
      out[`@${k}`] = v;
    }
  }
  return out;
}

function adaptArg(arg: Bindable): Bindable {
  if (arg == null) return arg;
  if (Array.isArray(arg)) return arg;
  if (typeof arg !== 'object') return arg;
  return prefixObjectKeys(arg as Record<string, unknown>);
}

function adaptArgs(args: Bindable[]): Bindable[] {
  return args.map(adaptArg);
}

export class WrappedStatement<T = unknown> {
  // bun:sqlite's Statement type is exported but constructor isn't, so use unknown
  constructor(public readonly stmt: ReturnType<RawDatabase['prepare']>) {}

  run(...args: Bindable[]): { changes: number; lastInsertRowid: number | bigint } {
    return this.stmt.run(...(adaptArgs(args) as never[]));
  }
  get(...args: Bindable[]): T | undefined {
    const r = this.stmt.get(...(adaptArgs(args) as never[]));
    return (r ?? undefined) as T | undefined;
  }
  all(...args: Bindable[]): T[] {
    return this.stmt.all(...(adaptArgs(args) as never[])) as T[];
  }
  values(...args: Bindable[]): unknown[][] {
    return this.stmt.values(...(adaptArgs(args) as never[]));
  }
  iterate(...args: Bindable[]): IterableIterator<T> {
    return this.stmt.iterate(...(adaptArgs(args) as never[])) as IterableIterator<T>;
  }
  finalize(): void {
    this.stmt.finalize();
  }
  toString(): string {
    return this.stmt.toString();
  }
}

export class WrappedDatabase {
  constructor(public readonly raw: RawDatabase) {}

  prepare<T = unknown>(sql: string): WrappedStatement<T> {
    return new WrappedStatement<T>(this.raw.prepare(sql));
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  /**
   * better-sqlite3 had `.pragma('foo = bar')`; bun:sqlite uses exec.
   * Kept for compatibility across the host code.
   */
  pragma(setting: string): void {
    this.raw.exec(`PRAGMA ${setting}`);
  }
  transaction<F extends (...a: never[]) => unknown>(fn: F): F {
    return this.raw.transaction(fn) as unknown as F;
  }
  close(): void {
    this.raw.close();
  }
  get name(): string {
    return this.raw.filename;
  }
}

/** Re-export under the legacy alias so call sites that imported `Database` keep working. */
export type Database = WrappedDatabase;

/**
 * Open a SQLite file at an arbitrary path (not the central DB).
 * Used by session-DB helpers and other ad-hoc readers.
 */
export function openDb(dbPath: string, opts?: { readonly?: boolean }): WrappedDatabase {
  const raw = new RawDatabase(dbPath, opts);
  return new WrappedDatabase(raw);
}
