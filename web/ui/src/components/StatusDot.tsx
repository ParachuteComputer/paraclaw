import type { GroupStatus } from "../lib/api.ts";

export function StatusDot({ status }: { status: GroupStatus | null }) {
  if (!status) {
    return <span className="status-dot status-dot-unknown" title="status unavailable" aria-label="status unavailable" />;
  }
  if (status.containerRunning) {
    const lastActive = status.lastHeartbeatAt
      ? `last heartbeat ${formatRelative(status.lastHeartbeatAt)}`
      : "alive";
    return (
      <span
        className="status-dot status-dot-alive"
        title={`${status.activeSessionCount} session${status.activeSessionCount === 1 ? "" : "s"} alive — ${lastActive}`}
        aria-label="alive"
      />
    );
  }
  const idleTitle = status.lastHeartbeatAt
    ? `idle — last heartbeat ${formatRelative(status.lastHeartbeatAt)}`
    : "idle — never started";
  return (
    <span
      className="status-dot status-dot-idle"
      title={idleTitle}
      aria-label="idle"
    />
  );
}

export function formatRelative(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}
