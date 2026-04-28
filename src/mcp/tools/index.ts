/**
 * One flat tool registry. The factory threads a `getCallerSubject` getter
 * through to handlers that need it (today: `decide-approval`). The getter
 * is closure-captured at server-build time — for HTTP that's per-request
 * (the JWT `sub` for that request); for stdio that's a constant
 * `mcp:stdio`.
 */
import type { ToolDef } from '../types.js';
import { activityTools } from './activity.js';
import { agentGroupTools } from './agent-groups.js';
import { buildApprovalTools } from './approvals.js';
import { channelTools } from './channels.js';
import { oauthTools } from './oauth.js';
import { secretTools } from './secrets.js';
import { sessionTools } from './sessions.js';

export function buildAllTools(getCallerSubject: () => string): ToolDef[] {
  return [
    ...agentGroupTools,
    ...sessionTools,
    ...channelTools,
    ...secretTools,
    ...buildApprovalTools(getCallerSubject),
    ...oauthTools,
    ...activityTools,
  ];
}
