import { Link, Route, Routes, useLocation } from "react-router-dom";
import { GroupList } from "./routes/GroupList.tsx";
import { GroupDetail } from "./routes/GroupDetail.tsx";
import { NewGroupWizard } from "./routes/NewGroupWizard.tsx";
import { OAuthCallback } from "./routes/OAuthCallback.tsx";
import { SetupWizard } from "./routes/SetupWizard.tsx";

export function App() {
  // The OAuth callback page is intentionally chrome-free — the user is
  // mid-handoff back from the hub and the nav frame would just be noise.
  const location = useLocation();
  const isCallback = location.pathname === "/oauth/callback";

  if (isCallback) {
    return (
      <div className="page">
        <Routes>
          <Route path="/oauth/callback" element={<OAuthCallback />} />
        </Routes>
      </div>
    );
  }

  return (
    <div className="page">
      <nav className="nav">
        <Link to="/" className="brand">
          Paraclaw <span className="sub">claws &amp; vaults</span>
        </Link>
        <Link to="/">Agent groups</Link>
        <Link to="/setup">Setup</Link>
        <a
          href="https://github.com/ParachuteComputer/paraclaw/blob/main/docs/parachute-integration.md"
          target="_blank"
          rel="noreferrer"
        >
          Docs
        </a>
      </nav>

      <Routes>
        <Route path="/" element={<GroupList />} />
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/groups/new" element={<NewGroupWizard />} />
        <Route path="/groups/:folder" element={<GroupDetail />} />
        <Route path="*" element={<div className="empty">404 — back to <Link to="/">groups</Link>.</div>} />
      </Routes>
    </div>
  );
}
