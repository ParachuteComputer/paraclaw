import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { beginLogin, handleCallback } from "../lib/auth.ts";

/**
 * Lands the redirect from the hub's /oauth/authorize. Exchanges `code` for
 * tokens via /oauth/token, then bounces to `/`. On any failure (state
 * mismatch, hub error, expired flow), shows the error and a retry that
 * restarts the dance.
 */
export function OAuthCallback() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [state, setState] = useState<
    { kind: "exchanging" } | { kind: "error"; message: string }
  >({ kind: "exchanging" });

  useEffect(() => {
    let cancelled = false;
    handleCallback(params)
      .then(() => {
        if (!cancelled) navigate("/", { replace: true });
      })
      .catch((err) => {
        if (!cancelled) {
          setState({
            kind: "error",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [params, navigate]);

  if (state.kind === "exchanging") {
    return (
      <div className="empty">
        <p>Signing you in&hellip;</p>
      </div>
    );
  }

  return (
    <div>
      <h2>Sign-in failed</h2>
      <div className="error-banner">
        <code>{state.message}</code>
      </div>
      <div className="actions" style={{ marginTop: "1rem" }}>
        <button onClick={() => beginLogin()}>Try again</button>
      </div>
    </div>
  );
}
