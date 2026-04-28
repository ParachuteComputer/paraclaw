# Parachute integration

Paraclaw is a Parachute module: it ships with a `.parachute/module.json` manifest, registers in the hub's services catalog at install, and accepts hub-issued JWTs on every `/api/*` route. This doc covers what gets wired up when you `parachute install paraclaw`, plus how vault attachments work inside an agent group.

## Module shape

`.parachute/module.json` declares the slot:

```json
{
  "name": "claw",
  "manifestName": "paraclaw",
  "displayName": "Paraclaw",
  "kind": "frontend",
  "port": 1944,
  "paths": ["/claw"],
  "health": "/api/health",
  "startCmd": ["bun", "src/index.ts"],
  "scopes": { "defines": ["claw:read", "claw:write", "claw:admin"] }
}
```

The hub uses this to:
- Reserve port 1944 on the operator's tailnet.
- Mount the SPA at `/claw/`.
- Add `claw:read|write|admin` to its OAuth scope catalog.
- Record paraclaw in `~/.parachute/services.json` so peer modules can discover it.

Paraclaw also publishes its own capability card at `/.well-known/parachute.json` (sourced from the manifest) for runtime discovery without hardcoding.

## Auth

Every `/api/*` route requires a hub-issued JWT — operator token (CLI/scripts) or user OAuth (browser). Validation is via JWKS against the hub origin (`PARACHUTE_HUB_ORIGIN`, stamped on every spawned module by the hub lifecycle). Two routes stay unauthenticated: `/api/health` (operational probe) and `/api/discovery` (returns hub origin so the SPA can bootstrap OAuth without a baked-in URL).

## Vault attachments

An agent group can attach to one or more Parachute vaults. Each attachment grants the in-container Claude Agent SDK a Parachute Vault MCP tool surface (query-notes, create-note, update-note, delete-note, list-tags, update-tag, delete-tag, find-path, vault-info).

### Storage

Attachments are filesystem-scoped, not database-scoped. Two files per group:

- `groups/<folder>/container.json` — the container's MCP config. The vault attachment lands here as an entry under `mcpServers`:

  ```json
  {
    "mcpServers": {
      "parachute-vault": {
        "type": "http",
        "url": "http://127.0.0.1:1940/vault/default/mcp",
        "headers": { "Authorization": "Bearer pvt_..." },
        "instructions": "You have access to a Parachute Vault at ..."
      }
    }
  }
  ```

- `groups/<folder>/parachute.json` — a sibling record holding metadata for the host:

  ```json
  {
    "vault": {
      "parachute-vault": {
        "vaultBaseUrl": "http://127.0.0.1:1940/vault/default",
        "scope": "vault:read",
        "tokenLabel": "claw-research-bot",
        "attachedAt": "2026-04-28T..."
      }
    }
  }
  ```

The agent-runner reads `container.json` at spawn and passes `mcpServers` straight through to Claude Agent SDK's `query()`, which supports HTTP-transport MCPs natively.

### Workflow

```sh
# Mint a scoped token via the hub's vault module.
parachute vault tokens create --scope vault:read --label claw-research-bot
# → pvt_...

# Attach via paraclaw's web UI (preferred) or CLI.
pnpm run parachute attach-vault research-bot --token pvt_... --scope vault:read

# Inspect.
pnpm run parachute status               # all groups
pnpm run parachute status research-bot  # one group

# Detach (does NOT revoke).
pnpm run parachute detach-vault research-bot
parachute vault tokens revoke claw-research-bot
```

### What this deliberately does NOT impose

- **No prescribed note layout.** The agent group has vault access; how it organizes notes is the agent's business.
- **No conflation with paraclaw secrets.** Outbound third-party API keys (Telegram, OpenAI, etc.) live in paraclaw's local AES-GCM secret store and get injected as container env vars. Vault is for the user's knowledge graph; the secret store is for outbound credentials. Different concerns, different layers.

### Threat model

- **Token scope is the boundary.** A `vault:read` claw physically cannot create or delete vault notes. A `vault:write` claw cannot revoke other tokens. A `vault:admin` claw is fully trusted; use sparingly.
- **Token is plaintext on disk and inside the container.** The bearer lives in `container.json` (host) and at `/workspace/agent/container.json` (container, read-only mount). Anyone with shell access on either side can read it. Same posture as any MCP credential — once inside the container they're plaintext env vars, same as any standard process environment.
- **Revocation is per-token.** `parachute vault tokens revoke <label>` invalidates the claw's access immediately; the next request will get 401.

## Lifecycle hooks

`parachute install`, `parachute start`, `parachute restart`, `parachute stop` — the hub drives lifecycle via the manifest. Install runs migrations, generates the master key if absent, and registers paraclaw in the services catalog. Start runs `bun src/index.ts`.

For the full design of hub-as-issuer OAuth and the services catalog, see `parachute.computer/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`.
