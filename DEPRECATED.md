# parachute-agent — deprecated 2026-05-20

## Why this module is deprecated

parachute-agent shipped a "Claude in containers" architecture: each agent task runs in an isolated container, with image-per-project, supervisor-managed lifecycle, network policy. The intent was a safe runtime for arbitrary Claude work against a vault.

In practice, that architecture solves problems most operators don't have:

- **The container isolation matters when you don't trust the prompts.** For owner-operated vaults where the operator wrote the prompts AND owns the vault, the trust gradient is flat — there's nothing to isolate from.
- **The complexity cost is real.** Docker images, container lifecycle, slug-keyed image names, supervisor coordination — all of this is operational surface that owner-operators don't want to manage.
- **A simpler primitive does the job.** A ~200-line Python runner that spawns `claude -p` with `--mcp-config '<json>'` against the vault, scheduled by cron, handles the common case completely. The Gitcoin Brain (2026-05) prototype proves this.

## Migration

### If you're running an owner-operated automation use case

Don't install parachute-agent. Instead:

1. Install `@openparachute/vault` and `@openparachute/hub` per the [main install guide](https://parachute.computer/install/).
2. Mint an operator token: `parachute-vault tokens create --scope vault:<name>:write`.
3. Write a small runner script. Pattern:
   ```python
   import subprocess, json, requests
   token = os.environ["PARACHUTE_VAULT_TOKEN"]
   hub = os.environ["PARACHUTE_HUB_URL"]
   # Fetch your job notes via vault REST
   # For each one, spawn: claude -p --mcp-config '<json>' ...  # construct the JSON manually, or use 'parachute-vault mcp-config <name>' (vault 0.4.6+)
   # Write outputs back via vault REST
   ```
4. `crontab -e` to schedule it.

Vault 0.4.6 ships a `parachute-vault mcp-config <name>` CLI that emits the MCP config JSON for you, eliminating boilerplate — until it's on `@latest`, you can construct the JSON manually.

### If you're running a hosted multi-tenant scenario (untrusted prompts, sandbox isolation)

The container-isolation architecture is genuinely valuable here. parachute-cloud (TBD) will provide this as a hosted service. Until parachute-cloud ships, you can continue using parachute-agent — but expect no new features.

## Status

- No new features. Bugfixes only.
- npm deprecate warning on install (after Aaron runs the command below).
- Existing installs continue working. Nothing has been unpublished. Roll back to a specific version if needed.

The deprecation command (for Aaron — copy-paste, kept under 80 chars so npm install doesn't wrap awkwardly):

```bash
npm deprecate @openparachute/agent "Deprecated 2026-05-20. Use cron + claude -p instead. See repo DEPRECATED.md"
```

- `@latest` and `@rc` tags maintained for now.
- Retirement timeline: when `parachute-jobs` (TBD module) ships AND has been stable for 1-2 months, parachute-agent moves out of the committed-core list entirely. This is expected in Q3 2026.

## What replaces it

`parachute-jobs` (TBD module) will provide the lightweight runner pattern with:

- Vault notes tagged `job` as the unit of work
- Cron / launchd / systemd integration for scheduling
- Light sandboxing via subprocess isolation + env scrubbing + restricted PATH (NOT containers)
- Subscription-funded inference (claude CLI), not API-billed per request

Design doc: TBD at `parachute.computer/design/2026-xx-parachute-jobs.md` once Gitcoin Brain pattern has run long enough to inform the spec.

## Questions / issues

File at https://github.com/ParachuteComputer/parachute-agent/issues — Aaron will respond.
