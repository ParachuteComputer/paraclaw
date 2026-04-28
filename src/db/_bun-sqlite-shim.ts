/**
 * Test-only shim that re-exports the `bun:sqlite` surface backed by
 * `better-sqlite3`. Wired in via vitest's `resolve.alias` so the host code
 * (which imports `bun:sqlite`) can be exercised under Node + vitest without
 * a real bun runtime.
 *
 * Production code runs under Bun and sees the real `bun:sqlite` module —
 * never this shim. Symmetric inverse of the wrapper in connection.ts:
 * connection.ts prefixes object keys with `@` for bun's binder; this shim
 * strips that prefix so better-sqlite3's binder is happy.
 */
import BetterSqlite3 from 'better-sqlite3';

type Bindable = unknown;

function stripPrefix(key: string): string {
  return key.startsWith('@') || key.startsWith('$') || key.startsWith(':') ? key.slice(1) : key;
}

function adaptArgs(args: Bindable[]): Bindable[] {
  return args.map((a) => {
    if (a == null) return a;
    if (Array.isArray(a)) return a;
    if (typeof a !== 'object') return a;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      out[stripPrefix(k)] = v;
    }
    return out;
  });
}

class ShimStatement {
  constructor(private readonly stmt: BetterSqlite3.Statement) {}
  run(...args: Bindable[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt.run(...(adaptArgs(args) as never[]));
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }
  get<T = unknown>(...args: Bindable[]): T | null {
    const r = this.stmt.get(...(adaptArgs(args) as never[]));
    return (r ?? null) as T | null;
  }
  all<T = unknown>(...args: Bindable[]): T[] {
    return this.stmt.all(...(adaptArgs(args) as never[])) as T[];
  }
  values(...args: Bindable[]): unknown[][] {
    return this.stmt.raw().all(...(adaptArgs(args) as never[])) as unknown[][];
  }
  iterate<T = unknown>(...args: Bindable[]): IterableIterator<T> {
    return this.stmt.iterate(...(adaptArgs(args) as never[])) as IterableIterator<T>;
  }
  finalize(): void {
    /* no-op — better-sqlite3 finalizes on GC */
  }
  toString(): string {
    return this.stmt.source;
  }
}

export class Database {
  public readonly raw: BetterSqlite3.Database;
  constructor(path: string, opts?: { readonly?: boolean }) {
    this.raw = new BetterSqlite3(path, opts);
  }
  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.raw.prepare(sql));
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }
  query(sql: string): ShimStatement {
    return this.prepare(sql);
  }
  run(sql: string): void {
    this.raw.exec(sql);
  }
  transaction<F extends (...a: never[]) => unknown>(fn: F): F {
    return this.raw.transaction(fn) as unknown as F;
  }
  close(): void {
    this.raw.close();
  }
  get filename(): string {
    return this.raw.name;
  }
}

export type Statement = ShimStatement;
