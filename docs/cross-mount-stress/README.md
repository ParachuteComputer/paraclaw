# Cross-mount SQLite stress harness

This directory exists for one reason: to **prove, with real numbers, that two
writers contending on a single SQLite file across a container bind-mount is
unsafe** — even with `journal_mode = DELETE` and a generous `busy_timeout`. It
is the empirical foundation for paraclaw's load-bearing invariant:

> **Each session has two SQLite files: `inbound.db` (host writes, container
> reads) and `outbound.db` (container writes, host reads). Exactly one writer
> per file.** See [`docs/db.md`](../db.md#1-the-three-databases) and
> [`docs/db-session.md`](../db-session.md).

If a future contributor (human or Claude) is tempted to "simplify" the model to
a single `session.db` shared by host + container, run this harness first.

## Why it exists

The two-DB split has visible cost — duplicate schema work, two open handles per
session, slightly more code on every read path. The recurring temptation is
"can we collapse this to one DB? SQLite has busy_timeout, journal_mode=DELETE
forces flushes across the mount, what could go wrong?"

This harness was built to answer that question concretely on the actual paraclaw
runtime stack — Bun on the container side, Node + better-sqlite3 on the host side,
OrbStack VirtioFS as the bind-mount, on macOS Darwin. The methodology and findings
are below; commit them so we don't have to rediscover this.

## What's in here

Three pairs of writers, each pair runs simultaneously on host + container:

| Script | Pair | Behavior |
|---|---|---|
| `host-writer.mjs` / `container-writer.mjs` | basic | Insert N rows, no retry. Bursty pacing. |
| `host-writer-slow.mjs` / `container-writer-slow.mjs` | slow | Loop on a duration deadline at ~100 writes/sec. Forces real overlap. |
| `host-writer-retry.mjs` / `container-writer-retry.mjs` | retry | Same as slow but with 8-attempt exponential backoff per write — the production-shaped variant. |

All three pairs use `journal_mode = DELETE` and `busy_timeout = 5000`, which is
the strongest configuration the paraclaw runtime can use without resorting to
WAL (which doesn't survive the bind mount).

## How to run

```bash
# Pick a working dir — any path the host can read/write that you can also
# bind-mount into a container.
WORK=/tmp/paraclaw-xmount-test
mkdir -p "$WORK"
cp docs/cross-mount-stress/*.mjs "$WORK/"

# Need better-sqlite3 reachable for the host scripts.
( cd "$WORK" && pnpm init -y && pnpm add better-sqlite3 )

# Ensure a paraclaw-agent image is built (uses bun).
./container/build.sh

# Run the slow-overlap variant: 30 seconds, both sides at once.
( cd "$WORK" && node host-writer-slow.mjs "$WORK/session.db" host 30 ) &
docker run --rm -v "$WORK:/workspace" \
  paraclaw-agent:latest \
  bun /workspace/container-writer-slow.mjs /workspace/session.db container 30
wait
```

To run the retry variant, swap the `*-slow.mjs` filenames for `*-retry.mjs`.

## What the data showed (Apr 28 2026)

Run on macOS Darwin 25.3.0 + OrbStack with the paraclaw v2 agent image
(Bun 1.3.13, bun:sqlite). Session files on a VirtioFS bind mount.

**Basic (no-retry) pair, ~500 inserts each side, 30s overlap window:**
- Container side: 2–20% of writes failed with `disk I/O error` or `unable to open database file` (the SQLITE_IOERR / SQLITE_CANTOPEN family).
- Host side: lower error rate but still nonzero. Final rowcount short of expected on both sides.
- `PRAGMA integrity_check` came back `ok` after the run — *the file isn't corrupted*, but writes are silently dropped.

**Retry pair, 8-attempt exponential backoff, 30s overlap window:**
- All writes eventually landed (zero permanent failures both sides).
- Container retry rate: **~21%** of operations needed at least one retry.
- Host retry rate: ~5–8%.
- Steady-state throughput dropped roughly 2–3× vs. uncontended.
- Integrity still `ok`.

In other words: the file isn't corrupted, but a "single shared session.db"
design needs every caller wrapped in a retry loop, and ~1 in 5 container writes
will hit the slow path. The current paraclaw codebase has ~14+ writer call
sites in `container/agent-runner/` alone — adding retry loops to every one of
them is the cost of "simpler mental model," and the math doesn't work out.

## What this means for the design

- **Two-DB split is the right model.** Host writes `inbound.db`, container
  writes `outbound.db`. Cross-mount visibility is required for *reading* — and
  with `journal_mode = DELETE` + open-write-close, reads see committed pages
  reliably. The dangerous case is two writers contending on the same file,
  which the split avoids by construction.
- **No retry wrappers on the writer paths.** Because each file has exactly one
  writer, there is no contention to retry around.
- **Don't switch to WAL.** WAL across this mount is a known bug farm — the
  `-wal` and `-shm` files don't reliably propagate, and the other side can
  read stale pages. Stick with `journal_mode = DELETE`.

## When to re-run

Re-run the harness if any of the following changes:
- The container bind-mount technology (e.g., switching off VirtioFS).
- Bun's `bun:sqlite` storage layer.
- `better-sqlite3`'s SQLite version.
- The host platform (different VM, different filesystem).

If the new numbers say two-writer is now safe, *then* it's worth revisiting the
single-DB design. Until then: two files, one writer each.
