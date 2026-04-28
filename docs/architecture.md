# Paraclaw Architecture

> Paraclaw is a single-process Bun service that runs an AI agent companion
> across many channels — Telegram, Discord, CLI, web. State lives in one
> SQLite file; per-session Docker containers sandbox agent execution; secrets
> are managed natively at rest in AES-256-GCM. Paraclaw is a first-class
> Parachute module: it discovers the hub, accepts hub-issued JWTs, and
> attaches Parachute vaults so agents can read and write the user's
> knowledge graph.

This document is the canonical architecture reference for paraclaw. It
defines the primitives every other doc references, the runtime shape, the
schema, the API surface, the trust model, and the integration contract with
the rest of the Parachute ecosystem. It is aimed at contributors who want
to understand or extend paraclaw — not at users picking it up for the first
time. For that, start at the project README.

Paraclaw draws engine-room patterns from NanoClaw (per-session containers,
channel adapters, the message-as-IO discipline), from OneCLI (per-agent
secret modes, approval gating), and from tinyclaw/borg (single-process
collapse, in-process secrets, security zones). None of those are
dependencies of paraclaw v1; paraclaw owns its surface end to end.

## Shape at a glance

```
                ┌─────────────────────────────────────────┐
                │  paraclaw  (single Bun process, port 1944)
                │                                         │
   inbound ─────▶  channel adapters  ──▶  router  ──▶  session manager
   (telegram,    │  (telegram,           │            │
    discord,     │   discord,            │            ▼
    cli, web)    │   cli)                │      sessions table
                │            ▲            │            │
                │            │            │            ▼
                │       outbound          │      container-runner
                │       delivery   ◀──┐   │            │
                │                     │   │            ▼
                │       host sweep    │   │      docker container
                │         (60s)       │   │      (per session)
                │                     │   │            │
                │            ▲────────┴───┴────────────▼
                │                paraclaw.db
                │     agent_groups · sessions · messages_in
                │     messages_out · channel_wires · vault_attachments
                │     secrets · approvals · users · user_roles
                └─────────────────────────────────────────┘
                            ▲                 ▲
                            │ JWT             │ MCP
                            │                 │
                       Parachute hub      Parachute vault(s)
                       (OAuth issuer)     (knowledge graph)
```

Everything is a message. The host writes inbound rows into `messages_in`;
the agent-runner inside a container reads them, calls Claude, and writes
`messages_out`. The host sweeps `messages_out` and delivers via the same
adapter that received the inbound. There is no IPC, no stdin piping, no
file watcher — only rows in SQLite and a heartbeat file.

## Primitives

The schema is the contract. Every primitive below corresponds to a table
in `data/paraclaw.db` and a TypeScript type in `src/db/`.

### Agent group

A workspace plus an agent identity — the unit a user creates ("my Notes
assistant", "my Code helper"). Every other primitive hangs off an agent
group.

| Field | Notes |
|---|---|
| `id` | stable string, ULID-shaped |
| `name` | human-facing display name |
| `folder` | filesystem slug under `groups/<folder>/` (CLAUDE.md, skills, mounts) |
| `instructions` | agent CLAUDE.md content (composed at container spawn) |
| `agent_provider` | `claude` (default), `opencode`, `codex` |
| `container_config_json` | mounts, env, image base, install_packages, mcp servers |
| `created_at`, `updated_at` | ISO-8601 |

An agent group owns zero or more **vault attachments**, zero or more
**channel wires**, zero or more **sessions**, and any **secrets** scoped
to it. Deleting an agent group cascades through all of them.

### Session

A live conversation state for an agent group. Every session has a
per-session Docker container. Sessions are how paraclaw scales context
horizontally — each session has its own Claude conversation, its own
`messages_in` / `messages_out` slices, its own container resource budget.

| Field | Notes |
|---|---|
| `id` | ULID |
| `agent_group_id` | foreign key to `agent_groups.id` |
| `messaging_group_id` | nullable; the platform thread this session serves |
| `mode` | `agent-shared` · `shared` · `per-thread` |
| `status` | `active` · `idle` · `closed` |
| `created_at`, `last_active_at` | ISO-8601 |
| `container_state_json` | last known runtime state, image tag, last heartbeat |

The three session modes capture the channel-isolation choices a user makes
when wiring a platform to an agent group. `agent-shared` means one session
per agent group across all channels (every message lands in the same
context). `shared` means one session per messaging group (a Slack channel
or a Discord guild). `per-thread` means one session per platform thread
(every Slack thread or GitHub PR comment chain is its own conversation).
The mode is stored on the session row and respected by the router.

### Channel wire

A binding from a messaging-platform thread to an agent group. The router
turns inbound platform events into `messages_in` rows by looking up the
matching wire.

| Field | Notes |
|---|---|
| `id` | ULID |
| `channel_type` | `telegram` · `discord` · `cli` (others land as plugins later) |
| `messaging_group_id` | paraclaw-internal id for the platform thread |
| `agent_group_id` | foreign key |
| `engage_mode` | `mention` · `pattern` · `all` |
| `engage_pattern` | regex (when `engage_mode = pattern`) |
| `sender_scope` | `allowlist` · `all` |
| `ignored_message_policy` | `drop` · `silent` |
| `priority` | tie-breaker when multiple wires match |

Wires are created via the API — by the setup wizard during install, by
the web UI later, or programmatically. There is no on-disk config file
that has to stay in sync; the database is the source of truth.

### Vault attachment

An OAuth-bound credential that lets an agent group's container reach a
Parachute vault over MCP. Vault attachments are how agents read and write
the user's knowledge graph from inside a sandboxed session.

| Field | Notes |
|---|---|
| `id` | ULID |
| `agent_group_id` | foreign key |
| `vault_base_url` | e.g. `http://127.0.0.1:1940` (loopback) or tailnet |
| `vault_name` | which vault on that origin (default `default`) |
| `scope` | `vault:read` · `vault:write` · `vault:admin` |
| `token_encrypted` | AES-256-GCM-encrypted bearer; decrypted at injection |
| `token_label` | short user-facing description |
| `attached_at` | ISO-8601 |

The bearer is minted via parachute-hub's OAuth flow (hub-as-issuer; see
`design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md` in
`parachute.computer`). Paraclaw stores the token after the user consents on
the hub's authorization page. At session spawn, the container-runner
decrypts the token and writes the MCP server config into the agent's
`.mcp.json`, so the in-container Claude SDK sees the vault as a
first-class tool source.

### Secret

An encrypted credential value managed by paraclaw. Secrets replace
OneCLI-as-a-dependency for the v1 line: paraclaw owns the layer. The
threat model and the on-disk format are described in `docs/SECURITY.md`;
the schema is summarized here.

| Field | Notes |
|---|---|
| `id` | ULID |
| `name` | unique within `agent_group_id` scope (or globally if null) |
| `value_encrypted` | AES-256-GCM, key from `~/.parachute/claw/master.key` |
| `kind` | `channel-token` · `api-key` · `generic` |
| `agent_group_id` | nullable; null = global |
| `assigned_mode` | `all` · `selective` (mirrors OneCLI's per-agent mode) |
| `host_pattern` | optional URL/host pattern for selective injection |
| `created_at`, `updated_at` | ISO-8601 |

The master key lives at `~/.parachute/claw/master.key` (32 bytes, mode
0600, generated on first start). Secrets are decrypted in-process at
session spawn and injected into the container as environment variables —
never as chat context, never in URL params. A migration command,
`POST /api/secrets/migrate-onecli`, pulls existing OneCLI secrets and
re-encrypts them under the paraclaw key, so users on the prior stack can
move without losing credentials.

### Approval

A pending action that requires human consent before paraclaw will apply
it. Today: `install_packages`, `add_mcp_server`, `access-new-credential`.
The primitive is general — any host-side handler can request an approval.

| Field | Notes |
|---|---|
| `id` | ULID |
| `agent_group_id` | foreign key |
| `kind` | string identifier matched to a registered handler |
| `action_payload_json` | the action to apply on approve |
| `status` | `pending` · `approved` · `rejected` · `expired` |
| `requested_at`, `decided_at` | ISO-8601 |
| `requested_by_session` | foreign key to `sessions.id` |
| `delivery_state_json` | how the approval was surfaced (UI, channel DM) |

Approvals surface in the web UI's notifications panel and via channel DM
to the agent group's owner — `pickApprover` resolves the recipient from
`user_roles` (scoped admin → global admin → owner). Crucially, paraclaw
makes the policy and the delivery one decision: there is no separate
gateway process holding requests while the host doesn't know about them.
If approvals are configured, they are routed; if they are not configured,
nothing hangs.

## Trust zones

Paraclaw inherits the **infra / core / perimeter** vocabulary from borg.
Three named tiers, with explicit cross-zone rules:

- **infra** — paraclaw itself, channel adapters, the host process, the
  router, the sweep loop. Deterministic plumbing. Non-messageable: an agent
  cannot send a chat message *to* infra; it can only request actions
  through documented MCP tools. Code in `src/` outside `src/modules/`
  generally lives here.
- **core** — agent groups and their sessions doing user work with
  credentials. The container is the boundary. Per-session Docker isolation
  is the primary enforcement; `infra` cannot read a session's
  `messages_in` table by default — it does so only through the documented
  router/delivery seams.
- **perimeter** — exposed surfaces. The web UI's `/api/*` endpoints, the
  channel inbound webhooks, anything an external actor can reach. Every
  perimeter entry point authenticates (hub-issued JWT for `/api/*`,
  signature-verified webhooks for channels) before crossing into infra.

Cross-zone actions require approval; same-zone actions are direct. In v1
this is vocabulary plus the load-bearing checks (mount allowlist, JWT
validation, approval-on-credentialed-action). Full enforcement is
deferred to v2 — see [OPEN: trust zones in v1] below.

## Runtime model

### Single-process Bun host

Paraclaw is **one Bun process**. No host-Node-plus-container-Bun split,
no separate web server. The process owns:

1. The HTTP listener on port 1944 (configurable via parachute hub
   port-authority — `paths: ["/claw"]` in `.parachute/module.json`).
2. The web UI bundle (Vite + React + TS), served from `web/ui/dist/` under
   the mount prefix.
3. The router (`src/router.ts`), which converts platform events into
   `messages_in` rows and wakes the appropriate session.
4. The delivery loop (`src/delivery.ts`), which reads `messages_out` and
   delivers through channel adapters.
5. The host sweep (`src/host-sweep.ts`), a 60-second tick that handles
   stale processing, due-message wakeups, and recurrence.
6. The container-runner (`src/container-runner.ts`), which spawns and
   reaps per-session Docker containers.
7. The secret store (in-process AES-256-GCM unwrap).

The Bun-everywhere choice is deliberate. NanoClaw ran the host on Node
and the agent-runner on Bun, which works but leaves two lockfiles and two
test-runner conventions. Paraclaw collapses to Bun: `bun:sqlite` on both
sides, one `bun.lock`, one `bun test`.

[OPEN: parachute lifecycle uses `pnpm exec tsx web/server/src/server.ts`
in the current `.parachute/module.json` — the Bun migration must update
`startCmd` to `["bun", "src/index.ts"]` and confirm the hub spawn path is
runtime-agnostic.]

### Per-session Docker containers

Each session gets a container. The image (`paraclaw-agent:latest`) is
built once by `./container/build.sh`; the runtime mounts the agent
group's folder, the session's row-window of `messages_in` / `messages_out`
(via SQLite-over-mount; see below), and a writable workspace. Secrets
land as env vars at container start, decrypted in-process by the
container-runner from the central DB.

The container is the trust boundary. It runs as an unprivileged user
inside the container, has only the mounts the agent group config grants,
and reaches the network only for hosts the host's outbound proxy allows
(default: vault attachments + provider APIs). `docker` is the runtime by
default; `apple-container` is supported on macOS and selected when
configured. See `src/container-runtime.ts` for the runtime selection.

Containers are spawned on demand: when the host writes the first
`messages_in` row for a session and no container is running, the runner
calls `docker run` and the agent-runner inside immediately starts
polling. After a configurable idle timeout the container is reaped; the
next message respawns it. Sessions are durable across container
lifecycles — containers are not.

### How the host and container talk

Through the database. Period. The container mounts `paraclaw.db`
read-write at `/workspace/.paraclaw.db` and uses bun:sqlite to read
`messages_in` rows where `session_id = ?` and write `messages_out` rows.
The host's sweep and active-poll loops watch the same table from outside.

Session liveness is signalled by a heartbeat file at
`/workspace/.heartbeat` — touched by the agent-runner on every loop tick.
The host reads its mtime to detect stale containers without polling the
DB. The DB has no `last_heartbeat` column.

This was the single biggest pattern decision in the rebuild. NanoClaw
split into `inbound.db` and `outbound.db` to avoid cross-mount lock
contention when host=Node and container=Bun. With Bun on both sides and
the right pragmas (`journal_mode=WAL`, `synchronous=NORMAL`), one DB is
enough — and tinyclaw and borg both validated this independently.

## Schema

One SQLite file: `data/paraclaw.db`. Migrations live at
`src/db/migrations/` and run on host start. The central tables — and
why each exists.

```sql
-- the unit a user creates
CREATE TABLE agent_groups (
  id                    TEXT PRIMARY KEY,
  name                  TEXT NOT NULL,
  folder                TEXT NOT NULL UNIQUE,
  instructions          TEXT,
  agent_provider        TEXT NOT NULL DEFAULT 'claude',
  container_config_json TEXT NOT NULL,
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL
);

-- a live conversation; one container per row
CREATE TABLE sessions (
  id                    TEXT PRIMARY KEY,
  agent_group_id        TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  messaging_group_id    TEXT REFERENCES messaging_groups(id) ON DELETE SET NULL,
  mode                  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  container_state_json  TEXT,
  created_at            TEXT NOT NULL,
  last_active_at        TEXT NOT NULL
);

-- platform-thread identity (one row per Slack channel, Telegram chat, etc.)
CREATE TABLE messaging_groups (
  id                    TEXT PRIMARY KEY,
  channel_type          TEXT NOT NULL,
  platform_id           TEXT NOT NULL,
  thread_id             TEXT,
  display_name          TEXT,
  created_at            TEXT NOT NULL,
  UNIQUE (channel_type, platform_id, thread_id)
);

-- the routing rules from a messaging group to an agent group
CREATE TABLE channel_wires (
  id                       TEXT PRIMARY KEY,
  channel_type             TEXT NOT NULL,
  messaging_group_id       TEXT NOT NULL REFERENCES messaging_groups(id) ON DELETE CASCADE,
  agent_group_id           TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  engage_mode              TEXT NOT NULL DEFAULT 'all',
  engage_pattern           TEXT,
  sender_scope             TEXT NOT NULL DEFAULT 'all',
  ignored_message_policy   TEXT NOT NULL DEFAULT 'drop',
  priority                 INTEGER NOT NULL DEFAULT 0,
  created_at               TEXT NOT NULL
);

-- agent → vault binding (OAuth-bound MCP credentials)
CREATE TABLE vault_attachments (
  id                TEXT PRIMARY KEY,
  agent_group_id    TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  vault_base_url    TEXT NOT NULL,
  vault_name        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  token_encrypted   BLOB NOT NULL,
  token_label       TEXT,
  attached_at       TEXT NOT NULL
);

-- secrets at rest (AES-256-GCM)
CREATE TABLE secrets (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  value_encrypted BLOB NOT NULL,
  kind            TEXT NOT NULL,
  agent_group_id  TEXT REFERENCES agent_groups(id) ON DELETE CASCADE,
  assigned_mode   TEXT NOT NULL DEFAULT 'all',
  host_pattern    TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  UNIQUE (agent_group_id, name)
);

-- pending approvals (host-mediated)
CREATE TABLE approvals (
  id                    TEXT PRIMARY KEY,
  agent_group_id        TEXT NOT NULL REFERENCES agent_groups(id) ON DELETE CASCADE,
  kind                  TEXT NOT NULL,
  action_payload_json   TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  requested_at          TEXT NOT NULL,
  decided_at            TEXT,
  requested_by_session  TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  delivery_state_json   TEXT
);

-- minimal user identity for ownership and approvals
CREATE TABLE users (
  id            TEXT PRIMARY KEY,    -- "<channel>:<handle>" or hub user id
  kind          TEXT NOT NULL,
  display_name  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE user_roles (
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role           TEXT NOT NULL,        -- 'owner' | 'admin'
  agent_group_id TEXT REFERENCES agent_groups(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role, agent_group_id)
);

-- the message bus
CREATE TABLE messages_in  ( /* see "Message bus" below */ );
CREATE TABLE messages_out ( /* see "Message bus" below */ );
```

The user/user_roles pair is intentionally minimal compared to NanoClaw's
four-table model. tinyclaw and borg both pointed out that the
`users → messaging_groups → agent_groups → sessions` chain was
gold-plating — paraclaw keeps users only because approvals need a
recipient, and roles only because owner-vs-admin is load-bearing for
those approvals. Membership-as-access-gate (NanoClaw's
`agent_group_members`) is dropped; perimeter auth is JWT-on-every-route.

## Message bus

Two tables, one DB, one host process, one container per session. The
column shapes are the same as NanoClaw's session DB — that contract was
worth preserving — but they live in the central DB now, scoped by
`session_id`.

```sql
CREATE TABLE messages_in (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,        -- 'chat' | 'chat-sdk' | 'task' | 'webhook' | 'system'
  timestamp       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  status_changed  TEXT,
  process_after   TEXT,                 -- ISO-8601; NULL = process immediately
  recurrence      TEXT,                 -- cron expression; NULL = one-shot
  tries           INTEGER NOT NULL DEFAULT 0,
  platform_id     TEXT,
  channel_type    TEXT,
  thread_id       TEXT,
  content         TEXT NOT NULL         -- JSON blob, format depends on kind
);

CREATE TABLE messages_out (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  in_reply_to     TEXT REFERENCES messages_in(id) ON DELETE SET NULL,
  timestamp       TEXT NOT NULL,
  delivered       INTEGER NOT NULL DEFAULT 0,
  deliver_after   TEXT,
  recurrence      TEXT,
  kind            TEXT NOT NULL,
  platform_id     TEXT,
  channel_type    TEXT,
  thread_id       TEXT,
  content         TEXT NOT NULL
);
```

Five kinds: `chat`, `chat-sdk`, `task`, `webhook`, `system`. The agent
sees `chat` and `chat-sdk` as user-facing turns; `task` is a scheduled
firing; `webhook` is an arbitrary HTTP-triggered event; `system` is the
host's response to a system action the agent requested. `system`-out is
how the agent asks the host to do things — register a group, reset a
session, install a package, attach a vault — and `system`-in is how the
host answers.

Scheduling is *not* a separate subsystem. `process_after` and
`deliver_after` columns plus `recurrence` give one-shot and cron-style
firing on the same tables. The 60-second host sweep handles every
condition in one query family.

## API surface

Every `/api/*` endpoint requires a hub-issued JWT — operator JWT for
admin tooling, user OAuth bearer for the browser. Paraclaw validates
against the hub's JWKS. Two endpoints are unauthenticated by design:
`/api/health` (operational probe) and `/api/discovery` (returns hub
origin so the SPA can bootstrap OAuth without baking the origin into the
bundle).

```
# agent groups
GET    /api/agent-groups
POST   /api/agent-groups
GET    /api/agent-groups/:folder
POST   /api/agent-groups/:folder/sessions
POST   /api/agent-groups/:folder/attach-vault
POST   /api/agent-groups/:folder/wire-channel

# sessions
GET    /api/sessions/:id
POST   /api/sessions/:id/close

# channels
GET    /api/channels
POST   /api/channels/install
POST   /api/channels/:type/test

# secrets (names + metadata only — never values over the wire)
GET    /api/secrets
POST   /api/secrets
DELETE /api/secrets/:id
POST   /api/secrets/migrate-onecli

# approvals
GET    /api/approvals
POST   /api/approvals/:id/decide

# parachute integration
GET    /api/vaults                # proxies hub well-known
GET    /api/discovery             # hub origin (unauth)
GET    /api/setup/status          # readiness probe

# realtime
GET    /stream                    # SSE: groups, sessions, approvals
GET    /api/health                # unauth liveness probe
```

Scopes (declared in `.parachute/module.json` under `scopes.defines`):
`claw:read`, `claw:write`, `claw:admin`. Operator tokens carry all three.
Read-only browser sessions request `claw:read`; the setup wizard escalates
to `claw:admin` for the install actions.

The shapes above are illustrative — the canonical request/response shapes
live in the route definitions under `web/server/src/`. The point of the
list is to make the *surface* legible.

## Parachute integration

Paraclaw ships as a first-class Parachute module. The contract:

### `.parachute/module.json`

The lifecycle and routing manifest the hub reads on install:

```json
{
  "name": "claw",
  "manifestName": "paraclaw",
  "displayName": "Paraclaw",
  "tagline": "Manage your Parachute agent groups + vault attachments.",
  "kind": "frontend",
  "port": 1944,
  "paths": ["/claw"],
  "health": "/api/health",
  "startCmd": ["bun", "src/index.ts"],
  "scopes": {
    "defines": ["claw:read", "claw:write", "claw:admin"]
  }
}
```

Mount: paraclaw lives under `/claw/` behind the hub on the user's tailnet.
The UI bundle and every server route honour the mount via
`import.meta.env.BASE_URL` and `PARACLAW_WEB_MOUNT` (see CLAUDE.md's
"Web UI (mount-aware)" section). The mount is not optional and not
hardcoded.

### `/.well-known/parachute.json`

Paraclaw publishes its capability card at `/.well-known/parachute.json`,
following the well-known shape from
`parachute-patterns/patterns/well-known-discovery-rfc.md`. Content:
display name, scopes defined, well-known URLs for OAuth resource
metadata, services catalog (so peer Parachute modules can discover
paraclaw without hardcoding).

### Hub-as-issuer OAuth

Paraclaw is a resource server, not an issuer. Tokens are minted by
parachute-hub at `:1939`. The flow:

1. Browser hits `/claw/`.
2. SPA reads `/api/discovery` → hub origin.
3. SPA redirects to `<hub>/oauth/authorize?...` with PKCE.
4. User consents on the hub (with hub's owner-password + optional TOTP).
5. Hub redirects back to `/claw/oauth/callback` with a code.
6. SPA exchanges at `<hub>/oauth/token` → bearer with `claw:*` scopes.
7. SPA stores the bearer; every `/api/*` call carries it.

Vault attachments use the same hub-as-issuer flow but for `vault:*`
scopes — and the resulting bearer is what gets stored encrypted in
`vault_attachments.token_encrypted`. The full design is in
`parachute.computer/design/2026-04-20-hub-as-portal-oauth-and-service-catalog.md`.

### Lifecycle hooks

`parachute install`, `parachute start`, `parachute restart`,
`parachute stop` — the hub drives lifecycle via the manifest. Paraclaw's
install command runs migrations, generates the master key if absent, and
registers in the hub's services catalog. Start runs `bun src/index.ts`.

## What's inherited vs what was rewritten

| Domain | Inherited from | What changed |
|---|---|---|
| Per-session containers | NanoClaw | Image renamed `paraclaw-agent`; runtime stays Docker/Apple-container |
| Channel adapter shape | NanoClaw | Telegram + Discord + CLI live in `src/channels/` permanently; rest become plugins |
| Chat SDK bridge | NanoClaw | Kept as-is in `src/channels/chat-sdk-bridge.ts` |
| Message-as-IO discipline | NanoClaw | Same `messages_in` / `messages_out` columns; central DB instead of split files |
| Approval primitive | OneCLI | Rewritten in-process; `pickApprover` resolves from `user_roles`; no gateway daemon |
| Per-agent secret modes | OneCLI | Concept preserved (`assigned_mode`, `host_pattern`); storage replaced with native AES-256-GCM |
| Trust zones (infra/core/perimeter) | borg | Vocabulary adopted; v1 enforces at JWT + container + approval boundaries |
| Single-process collapse | tinyclaw, borg | Bun-everywhere host; no Node/Bun split |
| File-queue option | borg | Considered, rejected — SQLite was already enough with WAL on a single mount |
| Skills system | NanoClaw | Retired in favour of UI; channel install moves into `/api/channels/install` |
| Setup wizard's credential-capture | NanoClaw | Replaced by `/api/secrets` + `/api/secrets/migrate-onecli` |
| Entity model (4-table) | NanoClaw | Flattened — only `users`, `user_roles`, no `agent_group_members` |
| Two-DB session split | NanoClaw | Dropped; one `paraclaw.db` |
| Heartbeat-via-file | NanoClaw | Kept; `/workspace/.heartbeat` mtime |

## Self-tests

The morning smoke (run by team-lead before declaring the rebuild done):

1. `parachute install ~/ParachuteComputer/paraclaw` → installs from night branch.
2. `parachute start claw` → paraclaw boots; logs show Bun, single SQLite, Telegram adapter loaded.
3. `curl /claw/api/setup/status` → `ready=true`.
4. Browser load `/claw/` → control panel renders.
5. Create agent group via UI.
6. Wire Telegram channel from UI.
7. DM the bot — reply within ~10s.
8. `curl /claw/api/secrets` → secrets list (names only, never values).
9. `parachute restart claw` → clean restart, no error.
10. Tests pass: `bun test` 100%, typecheck clean, biome clean.

## Open issues

These were surfaced during the rebirth and need team-lead resolution
before the night completes. They are not architectural drift — they are
genuine seams the seed didn't fully resolve.

- **[OPEN: trust zones in v1]** PRIMITIVES.md says zone *implementation*
  is deferred to v2 unless trivial, but the doc names cross-zone approval
  as a rule. This doc captures the vocabulary and the load-bearing v1
  enforcement points (JWT on perimeter, container on core,
  approval-on-credentialed-action across infra↔core). If team-lead wants
  zones to *do more* than that in v1, the matrix needs to be specified —
  otherwise this is the contract.
- **[OPEN: parachute startCmd]** `.parachute/module.json` currently runs
  the web server via `pnpm exec tsx web/server/src/server.ts` because the
  legacy host loaded `better-sqlite3`. The Bun migration must replace
  this with `["bun", "src/index.ts"]` and absorb the web server into the
  same process — there is no longer a separate "web server" surface.
- **[OPEN: messaging_groups uniqueness]** Channel adapters that don't
  expose a stable `thread_id` (CLI, single-DM Telegram) need a
  conventional null/sentinel value for `messaging_groups.thread_id` so
  the unique constraint behaves. The schema as written allows NULLs and
  SQLite treats NULLs as distinct in unique indexes — fine for now, but
  the routing layer needs to pick a sentinel deliberately.
- **[OPEN: vault attachment token refresh]** Hub-issued tokens have an
  expiry. `vault_attachments` does not yet carry refresh tokens or
  expiry metadata. v1 assumes long-lived bearers; v2 needs a refresh
  loop. Out of scope for tonight, but the schema has room.

## Reference: key files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — DB init, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `messages_in` → wake |
| `src/delivery.ts` | Polls `messages_out`, delivers via adapter, handles system actions |
| `src/host-sweep.ts` | 60s sweep: stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens central DB scoped views; manages heartbeat path |
| `src/container-runner.ts` | Spawns per-session containers with central DB + outbox mounts and secret env injection |
| `src/container-runtime.ts` | Runtime selection (Docker vs Apple containers), orphan cleanup |
| `src/channels/` | Channel adapter infra (registry, Chat SDK bridge) and the inlined Telegram/Discord/CLI adapters |
| `src/parachute/` | Hub discovery, vault attach helpers, `module.json`/`well-known` plumbing |
| `src/db/migrations/` | Schema migrations |
| `web/ui/` | Vite + React + TS control panel |
| `web/server/src/server.ts` | (Legacy in-tree.) HTTP surface — folds into `src/index.ts` after Bun migration |
| `container/agent-runner/` | The in-container poll loop, formatter, MCP tools |
| `container/build.sh` | Image build (`paraclaw-agent:latest`) |

For the deep dives — agent-runner internals, MCP tool surface, build and
runtime split, isolation model — see the per-doc files alongside this one
in `docs/`.
