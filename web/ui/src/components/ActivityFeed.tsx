/**
 * Per-agent-group activity feed. Renders the rows from
 * `GET /api/agent-groups/:folder/activity` as an audit log — collapses runs
 * of the same `(kind, target)` so a chatty agent that hits one tool twenty
 * times in a row doesn't drown out the next interesting event.
 *
 * Three kinds get bespoke rendering per the PR2 brief:
 *   - `secret_use`: "<secret> · used N times" with a key icon
 *   - `mcp_call`:    "<tool> · called N times" with a wrench icon
 *   - `cmd_exec`:    "<command>" with output preview underneath, no run-collapse
 *                    (each command is its own thing — collapsing would lose
 *                    the output diversity that makes this kind useful)
 *
 * Any other kind falls through to a plain `kind • target — summary` row.
 */
import { useCallback, useEffect, useState } from 'react';

import { type ActivityEntry, listGroupActivity } from '../lib/api.ts';
import { formatRelative } from './StatusDot.tsx';

const POLL_MS = 15_000;
const PAGE_SIZE = 100;
const CMD_PREVIEW_CHARS = 140;

interface ActivityFeedProps {
  folder: string;
}

// 404 from the activity endpoint means the server hasn't shipped the route
// yet (UI lands ahead of paraclaw-server's PR2 by design). Render a graceful
// note rather than the raw status string.
function isNotFoundError(err: unknown): boolean {
  return err instanceof Error && /\b404\b|not\s*found/i.test(err.message);
}

const NOT_AVAILABLE_MESSAGE = 'Activity log not available on this server.';

export function ActivityFeed({ folder }: ActivityFeedProps) {
  const [items, setItems] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notAvailable, setNotAvailable] = useState(false);
  const [loading, setLoading] = useState(true);

  // `reload` itself doesn't carry a cancelled flag — it's invoked from the
  // effects below (which do), and from the Retry button (where there's no
  // unmount race because the click and the response live in the same render).
  const reload = useCallback(async () => {
    try {
      const rows = await listGroupActivity(folder, { limit: PAGE_SIZE });
      setItems(rows);
      setError(null);
      setNotAvailable(false);
    } catch (err) {
      if (isNotFoundError(err)) {
        setNotAvailable(true);
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setLoading(false);
    }
  }, [folder]);

  useEffect(() => {
    let cancelled = false;
    listGroupActivity(folder, { limit: PAGE_SIZE })
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setError(null);
        setNotAvailable(false);
      })
      .catch((err) => {
        if (cancelled) return;
        if (isNotFoundError(err)) {
          setNotAvailable(true);
          setError(null);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [folder]);

  // Background poll — silent on failure. The 15s cadence is conservative
  // (this is an audit log, not a chat scroll); user can refresh manually if
  // they're watching live.
  useEffect(() => {
    if (error || notAvailable) return;
    let cancelled = false;
    const t = setInterval(() => {
      listGroupActivity(folder, { limit: PAGE_SIZE })
        .then((rows) => {
          if (!cancelled) setItems(rows);
        })
        .catch(() => {});
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [folder, error, notAvailable]);

  if (loading && !items) {
    return (
      <div className="section">
        <div className="skeleton skeleton-line" style={{ width: '40%' }} />
        <div className="skeleton skeleton-line" />
        <div className="skeleton skeleton-line" style={{ width: '70%' }} />
      </div>
    );
  }

  if (notAvailable) {
    return (
      <div className="section">
        <div className="empty">{NOT_AVAILABLE_MESSAGE}</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="section">
        <div className="error-banner">{error}</div>
        <button onClick={() => void reload()}>Retry</button>
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="section">
        <div className="empty">
          No activity yet. The agent's actions — secret reads, MCP tool calls, command
          executions — will show up here once a session is running.
        </div>
      </div>
    );
  }

  const collapsed = collapseRuns(items);
  return (
    <div className="section activity-feed">
      <ul className="activity-list">
        {collapsed.map((row) => (
          <ActivityRow key={row.key} row={row} />
        ))}
      </ul>
      {items.length >= PAGE_SIZE && (
        <p className="dim activity-more">
          Showing the {PAGE_SIZE} most recent events. Older history is in the agent's
          session DBs.
        </p>
      )}
    </div>
  );
}

// --- collapse logic ---

/**
 * One rendered row. Either a single entry, or a run of consecutive entries
 * sharing the same `(kind, target)` — the latter renders as a count badge.
 *
 * `cmd_exec` is intentionally NEVER run-collapsed: each command's output is
 * unique enough that merging loses the signal.
 */
type Row =
  | { type: 'single'; key: string; entry: ActivityEntry }
  | {
      type: 'run';
      key: string;
      kind: ActivityEntry['kind'];
      target: string;
      count: number;
      newest: ActivityEntry;
      oldestAt: string;
    };

function collapseRuns(items: ActivityEntry[]): Row[] {
  // Server returns newest-first. We collapse adjacent same-(kind,target)
  // entries — preserves chronology while compressing chatter.
  const out: Row[] = [];
  for (const entry of items) {
    if (entry.kind === 'cmd_exec') {
      out.push({ type: 'single', key: entry.id, entry });
      continue;
    }
    const last = out[out.length - 1];
    if (
      last &&
      last.type === 'run' &&
      last.kind === entry.kind &&
      last.target === entry.target
    ) {
      last.count += 1;
      last.oldestAt = entry.createdAt;
    } else if (
      last &&
      last.type === 'single' &&
      last.entry.kind === entry.kind &&
      last.entry.target === entry.target
    ) {
      // Promote the singleton to a run.
      out[out.length - 1] = {
        type: 'run',
        key: last.entry.id,
        kind: last.entry.kind,
        target: last.entry.target,
        count: 2,
        newest: last.entry,
        oldestAt: entry.createdAt,
      };
    } else {
      out.push({ type: 'single', key: entry.id, entry });
    }
  }
  return out;
}

// --- row rendering ---

function ActivityRow({ row }: { row: Row }) {
  if (row.type === 'run') {
    return <RunRow row={row} />;
  }
  const { entry } = row;
  switch (entry.kind) {
    case 'secret_use':
      return <SecretUseRow entry={entry} count={1} />;
    case 'mcp_call':
      return <McpCallRow entry={entry} count={1} />;
    case 'cmd_exec':
      return <CmdExecRow entry={entry} />;
    default:
      return <GenericRow entry={entry} />;
  }
}

function RunRow({ row }: { row: Extract<Row, { type: 'run' }> }) {
  // Use the newest entry's `id` as the React key; the count badge encodes
  // the rest. We surface both endpoints of the run so a quick glance shows
  // the time window the agent was burning through this resource.
  switch (row.kind) {
    case 'secret_use':
      return <SecretUseRow entry={row.newest} count={row.count} oldestAt={row.oldestAt} />;
    case 'mcp_call':
      return <McpCallRow entry={row.newest} count={row.count} oldestAt={row.oldestAt} />;
    default:
      return (
        <li className="activity-row">
          <ActivityIcon kind={row.kind} />
          <div className="activity-body">
            <div className="activity-headline">
              <code>{row.target}</code>
              <span className="tag muted">×{row.count}</span>
            </div>
            <RowMeta newest={row.newest} oldestAt={row.oldestAt} />
          </div>
        </li>
      );
  }
}

function SecretUseRow({
  entry,
  count,
  oldestAt,
}: {
  entry: ActivityEntry;
  count: number;
  oldestAt?: string;
}) {
  return (
    <li className="activity-row">
      <ActivityIcon kind="secret_use" />
      <div className="activity-body">
        <div className="activity-headline">
          <span className="activity-kind-label">Secret</span>
          <code>{entry.target}</code>
          {count > 1 && <span className="tag muted">used ×{count}</span>}
          {count === 1 && <span className="dim">used</span>}
        </div>
        {entry.summary && <div className="activity-summary">{entry.summary}</div>}
        <RowMeta newest={entry} oldestAt={oldestAt} />
      </div>
    </li>
  );
}

function McpCallRow({
  entry,
  count,
  oldestAt,
}: {
  entry: ActivityEntry;
  count: number;
  oldestAt?: string;
}) {
  return (
    <li className="activity-row">
      <ActivityIcon kind="mcp_call" />
      <div className="activity-body">
        <div className="activity-headline">
          <span className="activity-kind-label">MCP</span>
          <code>{entry.target}</code>
          {count > 1 && <span className="tag muted">called ×{count}</span>}
          {count === 1 && <span className="dim">called</span>}
        </div>
        {entry.summary && <div className="activity-summary">{entry.summary}</div>}
        <RowMeta newest={entry} oldestAt={oldestAt} />
      </div>
    </li>
  );
}

function CmdExecRow({ entry }: { entry: ActivityEntry }) {
  // The server's contract has the command in `target` and the output preview
  // in `summary`. We render the command in a code block and truncate output
  // visually (CSS), but also clamp the underlying string so we don't ship
  // megabytes of stdout into the DOM if a server bug drops the truncation.
  const preview = entry.summary
    ? entry.summary.length > CMD_PREVIEW_CHARS
      ? entry.summary.slice(0, CMD_PREVIEW_CHARS) + '…'
      : entry.summary
    : null;
  return (
    <li className="activity-row">
      <ActivityIcon kind="cmd_exec" />
      <div className="activity-body">
        <div className="activity-headline">
          <span className="activity-kind-label">Cmd</span>
          <code className="activity-cmd">{entry.target}</code>
        </div>
        {preview && <pre className="activity-cmd-output">{preview}</pre>}
        <RowMeta newest={entry} />
      </div>
    </li>
  );
}

function GenericRow({ entry }: { entry: ActivityEntry }) {
  return (
    <li className="activity-row">
      <ActivityIcon kind={entry.kind} />
      <div className="activity-body">
        <div className="activity-headline">
          <span className="activity-kind-label">{entry.kind}</span>
          {entry.target && <code>{entry.target}</code>}
        </div>
        {entry.summary && <div className="activity-summary">{entry.summary}</div>}
        <RowMeta newest={entry} />
      </div>
    </li>
  );
}

function RowMeta({ newest, oldestAt }: { newest: ActivityEntry; oldestAt?: string }) {
  const newestAbs = new Date(newest.createdAt).toLocaleString();
  return (
    <div className="activity-meta">
      <span title={newestAbs}>{formatRelative(newest.createdAt)}</span>
      {oldestAt && oldestAt !== newest.createdAt && (
        <span className="dim" title={new Date(oldestAt).toLocaleString()}>
          {' '}
          · since {formatRelative(oldestAt)}
        </span>
      )}
      {newest.sessionId && (
        <span className="dim">
          {' '}
          · session <code>{newest.sessionId.slice(0, 8)}</code>
        </span>
      )}
    </div>
  );
}

// Tiny inline icons — kept inside this file so the activity feed has a
// single dependency footprint. Sized 1em via stroke-width so they pick up
// the surrounding text color.
function ActivityIcon({ kind }: { kind: string }) {
  const className = `activity-icon activity-icon-${iconClass(kind)}`;
  switch (kind) {
    case 'secret_use':
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="6" cy="8" r="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M9 8h5M12 8v3M14 8v2" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'mcp_call':
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 6.5l3-3 1.5 1.5-3 3zm5.5-2L13 9l-1.5 1.5L7 6zM4.5 8.5L7 11l-2.5 2.5L2 11z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'cmd_exec':
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 4l3 4-3 4M8 12h6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg className={className} viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="8" cy="8" r="2" fill="currentColor" />
        </svg>
      );
  }
}

function iconClass(kind: string): string {
  switch (kind) {
    case 'secret_use':
      return 'secret';
    case 'mcp_call':
      return 'mcp';
    case 'cmd_exec':
      return 'cmd';
    default:
      return 'generic';
  }
}
