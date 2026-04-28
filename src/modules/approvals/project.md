## Approvals module

Admin-gated approval flow for agent self-modification. Lives in `src/modules/approvals/`.

### Flow

The container writes a `system`-kind outbound row with one of two actions — `install_packages`, `add_mcp_server`. The module's delivery-action handlers validate, route to the right approver's DM, and persist a `pending_approvals` row. When the admin clicks a button, the registered response handler applies the change (config update → image rebuild if needed → container kill) and notifies the agent via system chat.

### Wiring

- **Delivery actions:** `install_packages`, `add_mcp_server` via `registerDeliveryAction`.
- **Response handler:** claims approval cards by `pending_approvals` row lookup.

### Tables

`pending_approvals` (created by `module-approvals-pending-approvals.ts`). Not dropped on uninstall — approvals in flight aren't lost on reinstall.

### Core integration

The module depends on host-side infra but does not reach into core decision paths beyond the registered hooks:

- `buildAgentGroupImage`, `killContainer` from container-runner (image rebuilds)
- `updateContainerConfig` from container-config (apt/npm/mcp edits)
- `pickApprover`, `pickApprovalDelivery` from access
- `getDeliveryAdapter` in request-approval.ts

No core code imports from this module. Removing it: delete `src/modules/approvals/`, remove the import from `src/modules/index.ts`. Delivery actions will log "Unknown system action"; button clicks on approval cards will log "Unclaimed response". Stale rows remain in `pending_approvals` until reinstall or manual cleanup.
