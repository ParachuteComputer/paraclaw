# Paraclaw Architecture

> Paraclaw is a single-process Bun service that runs an AI agent companion
> across many channels — Telegram, Discord, CLI, web. State lives in
> SQLite — one central DB on the host plus a small per-session DB mounted
> into each container. Per-session Docker containers sandbox agent
> execution; secrets are managed natively at rest in AES-256-GCM.
> Paraclaw is a first-class Parachute module: it discovers the hub,
> accepts hub-issued JWTs, and attaches Parachute vaults so agents can
> read and write the user's knowledge graph.

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
                ┌──────────────────────────────────────────────┐
                │  paraclaw  (single Bun process, port 1944)   │
                │                                              │
   inbound ─────▶  channel adapters  ──▶  router  ──▶  session manager
   (telegram,    │  (telegram,            │             │      │
    discord,     │   discord,             │             ▼      │
    cli, web)    │   cli)                 │       sessions row │
                 │            ▲           │             │      │
                 │            │           │             ▼      │
                 │       outbound         │       container-runner
                 │       delivery ◀──┐    │             │      │
                 │                   │    │             ▼      │
                 │       host sweep  │    │       docker container
                 │         (60s)     │    │             │      │
                 │                   │    │      mounts session.db
                 │            ▲──────┴────┴─────────────▼      │
                 │       central paraclaw.db    per-session db │
                 │       (host-only writer)     (one writer    │
                 │                               at a time)    │
                 │   agent_groups · sessions      messages_in  │
                 │   messaging_groups · channels  messages_out │
                 │   secrets · approvals          session_state│
                 │   vault_attachments                         │
                 │   users · user_roles                        │
                 └──────────────────────────────────────────────┘
                            ▲                 ▲
                            │ JWT             │ MCP
                            │                 │
                       Parachute hub      Parachute vault(s)
                       (OAuth issuer)     (knowledge graph)
```

Everything is a message. The host writes inbound rows into the session's
`messages_in`; the agent-runner inside the container reads them, calls
Claude, and writes `messages_out`. The host sweeps `messages_out` and
delivers via the same adapter that received the inbound. There is no
IPC, no stdin piping, no file watcher — only rows in SQLite and a
heartbeat file.

## Primitives

The schema is the contract. Most primitives below correspond to a table
in the **central** `~/.parachute/claw/paraclaw.db`. The two exceptions —
`messages_in` and `messages_out` — live in **per-session**
`data/v2-sessions/<session_id>/session.db` files. The §Schema section
explains why; the TypeScript types are in `src/db/`.

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
| `agent_provider` | `claude` (default), `opencode` |
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
  credentials. The container is the boundary. Per-session Docker
  isolation is the primary enforcement: each container mounts only its
  own `session.db`, so cleartext message rows are visible only to that
  session's container — one core actor cannot read another's queue. The
  central `paraclaw.db` is *never* mounted into a container; it is
  host-only state.
- **perimeter** — exposed surfaces. The web UI's `/api/*` endpoints, the
  channel inbound webhooks, anything an external actor can reach. Every
  perimeter entry point authenticates (hub-issued JWT for `/api/*`,
  signature-verified webhooks for channels) before crossing into infra.

Cross-zone actions require approval; same-zone actions are direct. In v1
this is vocabulary plus three load-bearing checks: hub-issued JWT on
every perimeter route, the per-session container/DB mount on every core
action, and approval-on-credentialed-action wherever core asks infra to
do something irreversible (install a package, attach a vault, mount a
new path). A richer enforcement matrix is deferred to v2; this is the
v1 contract.

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
sides, one `bun.lock`, one `bun test`. `.parachute/module.json` therefore
sets `startCmd: ["bun", "src/index.ts"]` — the legacy
`pnpm exec tsx web/server/src/server.ts` path is dropped once the web
server folds into the same process.

### Per-session Docker containers

Each session gets a container. The image (`paraclaw-agent:latest`) is
built once by `./container/build.sh`; the runtime mounts the agent
group's folder, the session's own `session.db` (and nothing else from
the host's data tree), and a writable workspace. Secrets land as env
vars at container start, decrypted in-process by the container-runner
from the central DB.

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

Through SQLite — but **not** through the central DB. The container
mounts only its own per-session file at `/workspace/.session.db` and
uses bun:sqlite to read `messages_in` and write `messages_out`. The
central `paraclaw.db` stays on the host filesystem; the host writes new
inbound rows directly into the session DB before it spawns or wakes the
container. The host's sweep and active-poll loops open and close the
same session file to read outbound rows.

Three cross-mount invariants are load-bearing on the per-session file
(`src/session-manager.ts:5–11`):

1. `journal_mode=DELETE` — WAL's mmapped `-shm` file does not refresh
   from host writes to guest reads across a Docker bind mount. The
   container would silently miss every new message. DELETE-mode rollback
   journals work; WAL does not.
2. The host opens, writes, and **closes** the session DB on every
   operation. A long-lived host connection freezes the container's page
   cache at first read, so closing is what invalidates the guest view.
3. Exactly one writer per file at a time. DELETE-mode journal-unlink is
   not atomic across the mount, so concurrent writers corrupt the DB.
   The router and the agent-runner coordinate by phase: the host writes
   new inbound rows only when the container is not running, or by
   waking the container after each write.

Session liveness is signalled by a heartbeat file at
`/workspace/.heartbeat` — touched by the agent-runner on every loop tick.
The host reads its mtime to detect stale containers without touching the
DB. There is no `last_heartbeat` column.

This is why the v1 schema is **split**, not unified. Both tinyclaw and
borg pointed at "drop the two-DB session model" as a NanoClaw simplification
target — but neither validated single-DB across a Docker bind mount.
tinyclaw is single-process (no mount in the IPC path); borg uses a JSONL
file-queue (no SQLite at all). Their single-DB collapse applies to
single-process state, not to container-mounted message queues. Paraclaw
keeps the cross-mount split for the same reason NanoClaw did, and folds
NanoClaw's two-file split (`inbound.db` + `outbound.db`) into one file
per session — a single DELETE-mode SQLite with both message tables —
because the with-Bun-on-both-sides simplification *is* available there.

## Schema

State splits across two SQLite surfaces, by *who can write to what*:

- **Central** `~/.parachute/claw/paraclaw.db` — host-only writer. Never
  mounted into a container. Holds every primitive that isn't a live
  message queue.
- **Per-session** `data/v2-sessions/<session_id>/session.db` — mounted
  at `/workspace/.session.db` inside that session's container. Holds
  only `messages_in`, `messages_out`, and `session_state`. Runs in
  `journal_mode=DELETE` (see "How the host and container talk" above
  for why).

Migrations for both surfaces live under `src/db/migrations/` and run
on host start. The central migrations apply once; the per-session
schema is created on session spawn.

### Central `paraclaw.db`

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

-- a live conversation; one container per row.
-- Lifecycle metadata only — the live message queue lives in the
-- per-session session.db, never here.
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
```

The user/user_roles pair is intentionally minimal compared to NanoClaw's
four-table model. tinyclaw and borg both pointed out that the
`users → messaging_groups → agent_groups → sessions` chain was
gold-plating — paraclaw keeps users only because approvals need a
recipient, and roles only because owner-vs-admin is load-bearing for
those approvals. Membership-as-access-gate (NanoClaw's
`agent_group_members`) is dropped; perimeter auth is JWT-on-every-route.

### Per-session `session.db`

One file per session under `data/v2-sessions/<session_id>/session.db`,
opened with `journal_mode=DELETE`. Three tables, no foreign keys to the
central DB (a session.db cannot reference a row it cannot see):

```sql
CREATE TABLE messages_in (
  id              TEXT PRIMARY KEY,
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
  in_reply_to     TEXT,                 -- references messages_in.id within this file
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

CREATE TABLE session_state (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);
```

Five message kinds: `chat`, `chat-sdk`, `task`, `webhook`, `system`. The
agent sees `chat` and `chat-sdk` as user-facing turns; `task` is a
scheduled firing; `webhook` is an arbitrary HTTP-triggered event;
`system` is the host's response to a system action the agent requested.
`system`-out is how the agent asks the host to do things — register a
group, reset a session, install a package, attach a vault — and
`system`-in is how the host answers.

`session_state` is a small key/value scratchpad — last-seen Claude
session id, last formatter mode, in-progress streaming context. It's
not a long-term store; durable per-agent state belongs in the central
DB (and crosses the boundary as a `system` message).

Scheduling is *not* a separate subsystem. `process_after` and
`deliver_after` columns plus `recurrence` give one-shot and cron-style
firing on the same tables. The 60-second host sweep visits every
session DB in turn — it's the one place that crosses the per-session
file boundary in bulk — and handles every condition in one query family.

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
| Message-as-IO discipline | NanoClaw | Same `messages_in` / `messages_out` columns; one file per session instead of two |
| Cross-mount DELETE-mode invariant | NanoClaw | Preserved — load-bearing for the host↔container DB seam |
| Approval primitive | OneCLI | Rewritten in-process; `pickApprover` resolves from `user_roles`; no gateway daemon |
| Per-agent secret modes | OneCLI | Concept preserved (`assigned_mode`, `host_pattern`); storage replaced with native AES-256-GCM |
| Trust zones (infra/core/perimeter) | borg | Vocabulary adopted; v1 enforces at JWT + container/DB-mount + approval boundaries |
| Single-process collapse | tinyclaw, borg | Bun-everywhere *host*; per-session DB still mounted — collapse is single-process state, not the IPC seam |
| File-queue option | borg | Considered, rejected — SQLite-with-DELETE-mode is already proven across the mount |
| Skills system | NanoClaw | Retired in favour of UI; channel install moves into `/api/channels/install` |
| Setup wizard's credential-capture | NanoClaw | Replaced by `/api/secrets` + `/api/secrets/migrate-onecli` |
| Entity model (4-table) | NanoClaw | Flattened — only `users`, `user_roles`, no `agent_group_members` |
| Two-file session split | NanoClaw | Folded into one `session.db` per session (Bun on both sides allows it) |
| Heartbeat-via-file | NanoClaw | Kept; `/workspace/.heartbeat` mtime |

## Self-tests

The morning smoke (run by team-lead before declaring the rebuild done):

1. `parachute install ~/ParachuteComputer/paraclaw` → installs from night branch.
2. `parachute start claw` → paraclaw boots; logs show Bun, central + per-session SQLite ready, Telegram adapter loaded.
3. `curl /claw/api/setup/status` → `ready=true`.
4. Browser load `/claw/` → control panel renders.
5. Create agent group via UI.
6. Wire Telegram channel from UI.
7. DM the bot — reply within ~10s.
8. `curl /claw/api/secrets` → secrets list (names only, never values).
9. `parachute restart claw` → clean restart, no error.
10. Tests pass: `bun test` 100%, typecheck clean, biome clean.

## Decisions resolved in v1

A few seams the seed left implicit, captured here so other tentacles
share one contract:

- **Trust zones in v1 = three checks, not a matrix.** Hub-issued JWT on
  every perimeter route; per-session container/DB-mount on every core
  action; approval-on-credentialed-action on infra↔core crossings
  (install_packages, add_mcp_server, attach-vault, mount). The richer
  enforcement matrix (read/write/delete per primitive per zone) is v2.
- **`startCmd` is `["bun", "src/index.ts"]`.** The legacy
  `pnpm exec tsx web/server/src/server.ts` path is dropped; the web
  server is part of the host process post-migration.
- **`messaging_groups.thread_id` allows NULL.** Adapters without a
  stable thread (CLI, single-DM Telegram) write NULL. SQLite treats
  NULLs as distinct in unique indexes, which is the desired behaviour
  here — different DM sessions for the same `(channel_type, platform_id)`
  pair stay distinct rows. The routing layer matches on the
  three-tuple and falls back to the NULL row when no thread is given.
- **Vault token refresh is deferred to v2.** Hub-issued tokens have an
  expiry; `vault_attachments` does not yet carry refresh tokens or
  expiry metadata. v1 assumes long-lived bearers. The schema has room
  for an additive migration when the refresh loop lands.

## Reference: key files

| File | Purpose |
|---|---|
| `src/index.ts` | Entry point — DB init, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `messages_in` → wake |
| `src/delivery.ts` | Polls `messages_out`, delivers via adapter, handles system actions |
| `src/host-sweep.ts` | 60s sweep: stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens/closes the per-session DB; documents the cross-mount invariants |
| `src/container-runner.ts` | Spawns per-session containers with the session's `session.db` mount and secret env injection |
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
