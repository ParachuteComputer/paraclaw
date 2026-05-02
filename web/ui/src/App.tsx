import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { Apps } from './routes/Apps.tsx';
import { ApprovalsList } from './routes/ApprovalsList.tsx';
import { ChannelsList } from './routes/ChannelsList.tsx';
import { ChannelWireDetail } from './routes/ChannelWireDetail.tsx';
import { GroupDetail } from './routes/GroupDetail.tsx';
import { GroupList } from './routes/GroupList.tsx';
import { MessagingGroupDetail } from './routes/MessagingGroupDetail.tsx';
import { NewGroupWizard } from './routes/NewGroupWizard.tsx';
import { OAuthCallback } from './routes/OAuthCallback.tsx';
import { SecretsList } from './routes/SecretsList.tsx';
import { SessionsList } from './routes/SessionsList.tsx';
import { SettingsAgentProvider } from './routes/SettingsAgentProvider.tsx';
import { SettingsApprovals } from './routes/SettingsApprovals.tsx';
import { SetupWizard } from './routes/SetupWizard.tsx';
import { VaultDetail } from './routes/VaultDetail.tsx';
import { VaultsList } from './routes/VaultsList.tsx';
import { WireChannelPage } from './routes/WireChannelPage.tsx';

export function App() {
  // The OAuth callback page is intentionally chrome-free — the user is
  // mid-handoff back from the hub and the nav frame would just be noise.
  const location = useLocation();
  const isCallback = location.pathname === '/oauth/callback';

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
        <Link to="/sessions">Sessions</Link>
        <Link to="/channels">Channels</Link>
        <Link to="/vaults">Vaults</Link>
        <Link to="/secrets">Secrets</Link>
        <Link to="/apps">Apps</Link>
        <Link to="/approvals">Approvals</Link>
        <Link to="/settings/approvals">Settings</Link>
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
        <Route path="/secrets" element={<SecretsList />} />
        <Route path="/sessions" element={<SessionsList />} />
        <Route path="/vaults" element={<VaultsList />} />
        <Route path="/vaults/:name" element={<VaultDetail />} />
        <Route path="/channels" element={<ChannelsList />} />
        <Route path="/channels/new" element={<WireChannelPage />} />
        <Route path="/channels/mg/:id" element={<MessagingGroupDetail />} />
        <Route path="/channels/mga/:id" element={<ChannelWireDetail />} />
        <Route path="/apps" element={<Apps />} />
        <Route path="/approvals" element={<ApprovalsList />} />
        <Route path="/settings/approvals" element={<SettingsApprovals />} />
        <Route path="/settings/agent-provider" element={<SettingsAgentProvider />} />
        <Route path="/setup" element={<SetupWizard />} />
        <Route path="/groups/new" element={<NewGroupWizard />} />
        <Route path="/groups/:folder" element={<GroupDetail />} />
        <Route
          path="*"
          element={
            <div className="empty">
              404 — back to <Link to="/">groups</Link>.
            </div>
          }
        />
      </Routes>
    </div>
  );
}
