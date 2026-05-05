import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { StatusDot, formatRelative } from "../components/StatusDot.tsx";
import { listGroups, type AgentGroupView } from "../lib/api.ts";

const POLL_MS = 7_000;
// Set ?bypass=1 (or hash #bypass) to suppress the auto-redirect to /setup
// when no groups exist — useful for inspecting the empty state mid-debug
// without getting bounced into the wizard. Spec from issue #27.
function shouldBypassSetup(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.location.hash === '#bypass') return true;
  return new URLSearchParams(window.location.search).has('bypass');
}

export function GroupList() {
  const navigate = useNavigate();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ok"; groups: AgentGroupView[] }
    | { kind: "error"; message: string }
  >({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  // Initial load + manual reload.
  useEffect(() => {
    let cancelled = false;
    listGroups()
      .then((groups) => {
        if (cancelled) return;
        if (groups.length === 0 && !shouldBypassSetup()) {
          // Fresh install — drop the operator into the setup wizard.
          // Bypass with /?bypass=1 if you want to see the empty state.
          navigate('/setup', { replace: true });
          return;
        }
        setState({ kind: "ok", groups });
      })
      .catch(
        (err) =>
          !cancelled &&
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
      );
    return () => {
      cancelled = true;
    };
  }, [reloadKey, navigate]);

  // Background poll — refresh status without flipping back to loading state.
  useEffect(() => {
    if (state.kind !== "ok") return;
    let cancelled = false;
    const t = setInterval(() => {
      listGroups()
        .then((groups) => {
          if (!cancelled) setState({ kind: "ok", groups });
        })
        .catch(() => {
          // Polling error is silent — leave the last good snapshot in view.
        });
    }, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [state.kind]);

  if (state.kind === "loading") {
    return (
      <div>
        <h2>Agent groups</h2>
        <ul className="skeleton-list" aria-busy="true" aria-label="Loading agent groups">
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
          <li className="skeleton skeleton-row" />
        </ul>
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div>
        <h2>Agent groups</h2>
        <div className="error-banner">
          Couldn't load groups: <code>{state.message}</code>
        </div>
        <p className="muted">
          Make sure paraclaw is running:{" "}
          <code>parachute start claw</code>, or{" "}
          <code>bun src/index.ts</code> from the repo root for development.
          The central DB at <code>~/.parachute/agent/agent.db</code> is
          created on first start.
        </p>
        <div className="actions" style={{ marginTop: "1rem" }}>
          <button onClick={reload}>Retry</button>
        </div>
      </div>
    );
  }

  if (state.groups.length === 0) {
    return (
      <div>
        <h2>Agent groups</h2>
        <div className="empty empty-rich">
          <p className="empty-headline">No agent groups yet.</p>
          <p className="muted">
            Spin up your first agent group in a few clicks — or bootstrap from
            the CLI if you prefer.
          </p>
          <ul className="empty-paths">
            <li>
              <strong>New agent wizard</strong> —
              name + folder + optional vault attach.
            </li>
            <li>
              <strong>Setup wizard</strong> —
              walk to <code>/setup</code> for prereqs + first channel + agent.
            </li>
          </ul>
          <div className="actions" style={{ justifyContent: "center", marginTop: "1rem" }}>
            <Link to="/groups/new"><button>+ New agent group</button></Link>
            <button className="secondary" onClick={reload}>Refresh</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="list-header">
        <h2>Agent groups ({state.groups.length})</h2>
        <Link to="/groups/new"><button>+ New agent group</button></Link>
      </div>
      {state.groups.map((g) => (
        <Link
          key={g.id}
          to={`/groups/${encodeURIComponent(g.folder)}`}
          className="group-row"
        >
          <div className="name">
            <StatusDot status={g.status} />
            {g.name}
            {g.vault ? (
              <span className="tag">{g.vault.scope}</span>
            ) : (
              <span className="tag muted">no vault</span>
            )}
          </div>
          <div className="meta">
            folder: <code>{g.folder}</code>
            {g.agent_provider && (
              <> &middot; provider: <code>{g.agent_provider}</code></>
            )}
            {g.status && g.status.containerRunning && (
              <> &middot; <span className="status-text alive">
                {g.status.activeSessionCount} session{g.status.activeSessionCount === 1 ? "" : "s"} alive
              </span></>
            )}
            {g.status && !g.status.containerRunning && g.status.lastHeartbeatAt && (
              <> &middot; <span className="status-text idle">
                idle &middot; last active {formatRelative(g.status.lastHeartbeatAt)}
              </span></>
            )}
            {g.vault && (
              <>
                {" "}
                &middot; vault:{" "}
                <code>{g.vault.vaultBaseUrl}</code>
              </>
            )}
          </div>
        </Link>
      ))}
    </div>
  );
}
