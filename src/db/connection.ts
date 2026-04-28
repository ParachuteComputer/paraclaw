import { Database as RawDatabase } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

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
