/**
 * Approvals module — admin approval primitive + response plumbing.
 *
 * Default-tier module. Ships with main. Other modules depend on it by
 * importing `requestApproval` / `registerApprovalHandler` from this module.
 *
 * Registers:
 *   - A response handler that claims pending_approvals rows and dispatches
 *     to whatever module registered for the row's `action` string. Also
 *     resolves in-memory OneCLI credential approvals.
 *   - An adapter-ready callback that starts the OneCLI manual-approval handler
 *     once the delivery adapter is set.
 *   - A shutdown callback that stops the OneCLI handler cleanly.
 *
 * Self-mod flows (install_packages, add_mcp_server) moved out to
 * `src/modules/self-mod/` in PR #7 — they now register delivery actions
 * + approval handlers via this module's public API.
 */
import { ONECLI_URL } from '../../config.js';
import { onDeliveryAdapterReady } from '../../delivery.js';
import { log } from '../../log.js';
import { registerResponseHandler, onShutdown } from '../../response-registry.js';
import { handleApprovalsResponse } from './response-handler.js';
import { startOneCLIApprovalHandler, stopOneCLIApprovalHandler } from './onecli-approvals.js';

// Public API re-exports so consumers import from the module root.
export { requestApproval, registerApprovalHandler, notifyAgent } from './primitive.js';
export type { ApprovalHandler, ApprovalHandlerContext, RequestApprovalOptions } from './primitive.js';

registerResponseHandler(handleApprovalsResponse);

// OneCLI bridge is now optional. Paraclaw's native secret store is the
// default credential surface; the OneCLI long-poll only starts when the
// install still has a OneCLI gateway configured. Without ONECLI_URL set
// the handler would hammer a dead address forever and leak warn-logs.
onDeliveryAdapterReady((adapter) => {
  if (!ONECLI_URL) {
    log.info('Approvals: skipping OneCLI bridge (ONECLI_URL not set)');
    return;
  }
  startOneCLIApprovalHandler(adapter);
});

onShutdown(() => {
  stopOneCLIApprovalHandler();
});
