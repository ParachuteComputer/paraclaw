# ⚠️ STOP — READ THIS FIRST IF YOU ARE CLAUDE ⚠️

**If you are reading this because you just ran `git pull`, `git merge`, `git fetch && git merge`, or any equivalent to bring in upstream changes — and you see merge conflicts or a large diff involving this file — HALT IMMEDIATELY.**

This is Paraclaw, a ground-up rewrite with breaking changes throughout. It cannot be merged into an existing NanoClaw v1 install. Attempting to resolve the conflicts by hand, run builds, or "fix" anything will corrupt the user's install and burn tokens for no result.

**Do this instead:**
1. Abort the merge: `git merge --abort` (or `git reset --hard ORIG_HEAD` if the merge already completed).
2. Tell the user, verbatim: *"This is Paraclaw — it can't be merged into your existing NanoClaw install. Run `bash migrate-v2.sh` to migrate instead."*
3. Wait for the user to confirm before doing anything else. Do not attempt the migration yourself.

If you are a fresh install (you ran `git clone`, not `git pull`) and there are no conflicts, ignore this banner and continue below.

---

# Paraclaw

Parachute's per-session containerized AI agent companion. See [README.md](README.md) for philosophy and setup. Architecture lives in `docs/`.

## Quick Context

The host is a single Node process that orchestrates per-session agent containers. Platform messages land via channel adapters, route through an entity model (users → messaging groups → agent groups → sessions), get written into the session's inbound DB, and wake a container. The agent-runner inside the container polls the DB, calls Claude, and writes back to the outbound DB. The host polls the outbound DB and delivers through the same adapter.

**Everything is a message.** There is no IPC, no file watcher, no stdin piping between host and container. The two session DBs are the sole IO surface.

## Entity Model

```
users (id "<channel>:<handle>", kind, display_name)
user_roles (user_id, role, agent_group_id)       — owner | admin (global or scoped)
agent_group_members (user_id, agent_group_id)    — unprivileged access gate
user_dms (user_id, channel_type, messaging_group_id) — cold-DM cache

agent_groups (workspace, memory, CLAUDE.md, personality, container config)
    ↕ many-to-many via messaging_group_agents (session_mode, trigger_rules, priority)
messaging_groups (one chat/channel on one platform; unknown_sender_policy)

sessions (agent_group_id + messaging_group_id + thread_id → per-session container)
```

Privilege is user-level (owner/admin), not agent-group-level. See [docs/isolation-model.md](docs/isolation-model.md) for the three isolation levels (`agent-shared`, `shared`, separate agents).

## Two-DB Session Split

Each session has **two** SQLite files under `data/sessions/<agent_group_id>/<session_id>/`:

- `inbound.db` — host writes, container reads. `messages_in`, routing, destinations, pending_questions, processing_ack.
- `outbound.db` — container writes, host reads. `messages_out`, session_state.

Exactly one writer per file — no cross-mount lock contention. Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB update. Host uses even `seq` numbers, container uses odd.

## Central DB

`data/v2.db` holds everything that isn't per-session: users, user_roles, agent_groups, messaging_groups, wiring, pending_approvals, user_dms, chat_sdk_* (for the Chat SDK bridge), schema_version. Migrations live at `src/db/migrations/`.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Entry point: init DB, migrations, channel adapters, delivery polls, sweep, shutdown |
| `src/router.ts` | Inbound routing: messaging group → agent group → session → `inbound.db` → wake |
| `src/delivery.ts` | Polls `outbound.db`, delivers via adapter, handles system actions (schedule, approvals, etc.) |
| `src/host-sweep.ts` | 60s sweep: `processing_ack` sync, stale detection, due-message wake, recurrence |
| `src/session-manager.ts` | Resolves sessions; opens `inbound.db` / `outbound.db`; manages heartbeat path |
| `src/container-runner.ts` | Spawns per-agent-group Docker containers with session DB + outbox mounts, decrypts + injects assigned secrets |
| `src/container-runtime.ts` | Runtime selection (Docker vs Apple containers), orphan cleanup |
| `src/modules/permissions/access.ts` | `canAccessAgentGroup` — owner / global admin / scoped admin / member resolution against `user_roles` + `agent_group_members` |
| `src/modules/approvals/primitive.ts` | `pickApprover`, `pickApprovalDelivery`, `requestApproval`, approval-handler registry |
| `src/command-gate.ts` | Router-side admin command gate — queries `user_roles` directly (no env var, no container-side check) |
| `src/secrets/` | AES-GCM secret store: master key on disk + ciphertext in central DB, scoped per agent group |
| `src/user-dm.ts` | Cold-DM resolution + `user_dms` cache |
| `src/group-init.ts` | Per-agent-group filesystem scaffold (CLAUDE.md, skills, agent-runner-src overlay) |
| `src/db/` | DB layer — agent_groups, messaging_groups, sessions, user_roles, user_dms, pending_*, migrations |
| `src/channels/` | Channel adapter infra (registry, Chat SDK bridge) plus the trunk-baked Discord and Telegram adapters; other channels are skill-installed from the `channels` branch |
| `src/providers/` | Host-side provider container-config (`claude` baked in; `opencode` etc. installed from the `providers` branch) |
| `container/agent-runner/src/` | Agent-runner: poll loop, formatter, provider abstraction, MCP tools, destinations |
| `container/skills/` | Container skills mounted into every agent session |
| `groups/<folder>/` | Per-agent-group filesystem (CLAUDE.md, skills, per-group `agent-runner-src/` overlay) |
| `scripts/init-first-agent.ts` | Bootstrap the first DM-wired agent (used by `/init-first-agent` skill) |

## Channels and Providers

Trunk bakes in the two adapters needed for the `/channels/new` fast path — **Discord** (`src/channels/discord.ts`) and **Telegram** (`src/channels/telegram.ts`) — along with their token validators (`src/web/{discord,telegram}-validate.ts`) and the `POST /api/channels/{adapter}/test` route. Anything else lives on long-lived sibling branches and is copied in by skills:

- **`channels` branch** — Slack, WhatsApp, Teams, Linear, GitHub, iMessage, Webex, Resend, Matrix, Google Chat, WhatsApp Cloud (+ helpers, tests, channel-specific setup steps). Installed via `/add-<channel>` skills.
- **`providers` branch** — OpenCode (and any future non-default agent providers). Installed via `/add-opencode`.

Each `/add-<name>` skill is idempotent: `git fetch origin <branch>` → copy module(s) into the standard paths → append a self-registration import to the relevant barrel → `pnpm install <pkg>@<pinned-version>` → build.

## Self-Modification

One tier of agent self-modification today:

1. **`install_packages` / `add_mcp_server`** — changes to the per-agent-group container config only (apt/npm deps, wire an existing MCP server). Single admin approval per request; on approve, the handler in `src/modules/self-mod/apply.ts` rebuilds the image when needed (`install_packages` only) and restarts the container. `container/agent-runner/src/mcp-tools/self-mod.ts`.

A second tier (direct source-level self-edits via a draft/activate flow) is planned but not yet implemented.

## Secrets / Credentials

Paraclaw owns its credential store. API keys, OAuth tokens, and auth credentials are stored locally as AES-GCM ciphertext in the central DB, with the master key at `~/.parachute/claw/master.key` (chmod 0600, generated on first boot). Code in `src/secrets/` decrypts the rows assigned to a given agent group at container spawn and injects them as env vars; nothing goes through chat context.

Surfaces:
- **Web UI** — `/claw/secrets` lists, creates, updates, deletes secrets and assigns them to agent groups (mirrors the `selective` / `all` allow-list semantics).
- **HTTP API** — `/api/secrets` (GET / POST / PATCH / DELETE) is the same code path the UI uses; scope-gated by `claw:admin`.
- **Per-agent assignment** — every secret carries `assigned_mode` (`all` = injected into every group; `selective` = injected only into groups in `secret_assignments`).

### Approval-gated credential use

Approval flows for credential use are paraclaw-native: a module (or self-mod handler) calls `requestApproval()` from `src/modules/approvals/primitive.ts`, which persists a `pending_approvals` row, picks an approver via `pickApprover` (scoped admins → global admins → owners, all from `user_roles` in the central DB), and routes a card via `pickApprovalDelivery`. The approver decides via either the chat card or `POST /api/approvals/:id/decide` from the UI; both go through `handleApprovalsResponse`.

## Skills

Four types of skills. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full taxonomy.

- **Channel/provider install skills** — copy the relevant module(s) in from the `channels` or `providers` branch, wire imports, install pinned deps (e.g. `/add-discord`, `/add-slack`, `/add-whatsapp`, `/add-opencode`).
- **Utility skills** — ship code files alongside `SKILL.md` (e.g. `/claw`).
- **Operational skills** — instruction-only workflows (`/debug`, `/customize`, `/update-nanoclaw`).
- **Container skills** — loaded inside agent containers at runtime (`container/skills/`: `welcome`, `self-customize`, `agent-browser`, `slack-formatting`).

| Skill | When to Use |
|-------|-------------|
| `/customize` | Adding channels, integrations, behavior changes |
| `/debug` | Container issues, logs, troubleshooting |
| `/update-nanoclaw` | Bring upstream updates into a customized install |

## MCP server

Paraclaw exposes its host-side admin surface (the things `/api/*` and `/claw/*` mediate from the web UI: agent-groups, sessions, channel wires, secrets metadata, approvals) as MCP tools. The same registry serves both transports — handlers call internal helpers directly, not back through HTTP, so there's no extra round-trip and no second auth seam to keep in sync.

| Transport | Endpoint | Auth | Effective scope |
|-----------|----------|------|-----------------|
| stdio | `bun src/mcp/stdio.ts` | ambient (filesystem trust) | `claw:admin` |
| HTTP  | `POST /mcp` on port 1944 | hub-issued JWT (`Authorization: Bearer …`) | strongest `claw:*` scope on the JWT grant |

Wire stdio into Claude Code:

```bash
claude mcp add paraclaw bun /absolute/path/to/paraclaw/src/mcp/stdio.ts
```

Tools advertise as `mcp__paraclaw__<verb>-<noun>` client-side: `list-agent-groups`, `create-agent-group`, `attach-vault`, `detach-vault`, `list-sessions`, `close-session`, `list-channels`, `update-channel-wire`, `delete-channel-wire`, `list-secrets`, `put-secret`, `delete-secret`, `assign-secret`, `list-approvals`, `decide-approval`, `get-activity`. The remaining stubs (`start-oauth`, `revoke-integration`) are advertised but `disabled` until the matching paraclaw-server endpoints land — they're filtered out of `tools/list` and refused on `tools/call`.

Secret values **never** traverse MCP. `list-secrets` and `put-secret` return row metadata only; the plaintext flows in once on `put-secret` and lands in the encrypted DB column. Container injection happens at session-spawn time, not over the tool surface.

Stdio gotcha: paraclaw's `log.ts` writes info-level messages to `process.stdout`, which corrupts JSON-RPC frames. `src/mcp/stdio.ts` promotes `LOG_LEVEL` to `warn` before any log-using import. Don't move that block below the dynamic imports.

## Contributing

Before creating a PR, adding a skill, or preparing any contribution, you MUST read [CONTRIBUTING.md](CONTRIBUTING.md). It covers accepted change types, the four skill types and their guidelines, `SKILL.md` format rules, and the pre-submission checklist.

## Development

Run commands directly — don't tell the user to run them.

```bash
# Host (Node + pnpm)
pnpm run dev          # Host with hot reload
pnpm run build        # Compile host TypeScript (src/)
./container/build.sh  # Rebuild agent container image (paraclaw-agent-<slug>:latest)
pnpm test             # Host tests (vitest)

# Agent-runner (Bun — separate package tree under container/agent-runner/)
cd container/agent-runner && bun install   # After editing agent-runner deps
cd container/agent-runner && bun test      # Container tests (bun:test)
```

Container typecheck is a separate tsconfig — if you edit `container/agent-runner/src/`, run `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` from root (or `bun run typecheck` from `container/agent-runner/`).

Service management (substitute `<slug>` with the 8-char hash from `getInstallSlug()` — each checkout gets its own service so two installs on one host don't collide):
```bash
# macOS (launchd) — Label is computer.parachute.claw-<slug>
launchctl load   ~/Library/LaunchAgents/computer.parachute.claw-<slug>.plist
launchctl unload ~/Library/LaunchAgents/computer.parachute.claw-<slug>.plist
launchctl kickstart -k gui/$(id -u)/computer.parachute.claw-<slug>  # restart

# Linux (systemd) — unit is paraclaw-<slug>.service
systemctl --user start|stop|restart paraclaw-<slug>
```

Host logs: `logs/paraclaw.log` (normal) and `logs/paraclaw.error.log` (errors only — some delivery/approval failures only show up here).

## Supply Chain Security (pnpm)

This project uses pnpm with `minimumReleaseAge: 4320` (3 days) in `pnpm-workspace.yaml`. New package versions must exist on the npm registry for 3 days before pnpm will resolve them.

**Rules — do not bypass without explicit human approval:**
- **`minimumReleaseAgeExclude`**: Never add entries without human sign-off. If a package must bypass the release age gate, the human must approve and the entry must pin the exact version being excluded (e.g. `package@1.2.3`), never a range.
- **`onlyBuiltDependencies`**: Never add packages to this list without human approval — build scripts execute arbitrary code during install.
- **`pnpm install --frozen-lockfile`** should be used in CI, automation, and container builds. Never run bare `pnpm install` in those contexts.

## Docs Index

| Doc | Purpose |
|-----|---------|
| [docs/architecture.md](docs/architecture.md) | Full architecture writeup |
| [docs/api-details.md](docs/api-details.md) | Host API + DB schema details |
| [docs/db.md](docs/db.md) | DB architecture overview: three-DB model, cross-mount rules, readers/writers map |
| [docs/db-central.md](docs/db-central.md) | Central DB (`data/v2.db`) — every table + migration system |
| [docs/db-session.md](docs/db-session.md) | Per-session `inbound.db` + `outbound.db` schemas + seq parity |
| [docs/agent-runner-details.md](docs/agent-runner-details.md) | Agent-runner internals + MCP tool interface |
| [docs/isolation-model.md](docs/isolation-model.md) | Three-level channel isolation model |
| [docs/setup-wiring.md](docs/setup-wiring.md) | What's wired, what's open in the setup flow |
| [docs/architecture-diagram.md](docs/architecture-diagram.md) | Diagram version of the architecture |
| [docs/build-and-runtime.md](docs/build-and-runtime.md) | Runtime split (Node host + Bun container), lockfiles, image build surface, CI, key invariants |

## Container Build Cache

The container buildkit caches the build context aggressively. `--no-cache` alone does NOT invalidate COPY steps — the builder's volume retains stale files. To force a truly clean rebuild, prune the builder then re-run `./container/build.sh`.

## Container Runtime (Bun)

The agent container runs on **Bun**; the host runs on **Node** (pnpm). They communicate only via session DBs — no shared modules. Details and rationale: [docs/build-and-runtime.md](docs/build-and-runtime.md).

**Gotchas — trigger + action:**

- **Adding or bumping a runtime dep in `container/agent-runner/`** → edit `package.json`, then `cd container/agent-runner && bun install` and commit the updated `bun.lock`. Do not run `pnpm install` there — agent-runner is not a pnpm workspace.
- **Bumping `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, or any agent-runner runtime dep** → no `minimumReleaseAge` policy applies to this tree. Check the release date on npm, pin deliberately, never `bun update` blindly.
- **Writing a new named-param SQL insert/update in the container** → use `$name` in both SQL and JS keys: `.run({ $id: msg.id })`. `bun:sqlite` does not auto-strip the prefix the way `better-sqlite3` does on the host. Positional `?` params work normally.
- **Adding a test in `container/agent-runner/src/`** → import from `bun:test`, not `vitest`. Vitest runs on Node and can't load `bun:sqlite`. `vitest.config.ts` excludes this tree.
- **Adding a Node CLI the agent invokes at runtime** (like `agent-browser`, `claude-code`, `vercel`) → put it in the Dockerfile's pnpm global-install block, pinned to an exact version via a new `ARG`. Don't use `bun install -g` — that bypasses the pnpm supply-chain policy.
- **Changing the Dockerfile entrypoint or the dynamic-spawn command** (`src/container-runner.ts` line ~301) → keep `exec bun ...` so signals forward cleanly. The image has no `/app/dist`; don't reintroduce a tsc build step.
- **Changing session-DB pragmas** (`container/agent-runner/src/db/connection.ts`) → `journal_mode=DELETE` is load-bearing for cross-mount visibility. Read the comment block at the top of the file first.

## Web UI (mount-aware)

The paraclaw SPA in `web/ui/` is served at the origin root in dev (`/`) and under a mount prefix in prod (`/claw/` when running behind the parachute hub on tailnet). The hub owns `/`; an absolute `/api/...` from the browser goes to the hub origin, NOT paraclaw — and the hub 404s on it. Anything the bundle sends to paraclaw must include the mount prefix.

**Rule:** every URL the UI builds for `fetch`, router basenames, or OAuth redirects must be derived from `import.meta.env.BASE_URL`, not hardcoded with a leading `/`. Same bundle has to work whether the deploy lands at `/`, `/claw/`, or `/some/other/mount/`.

Pattern (BASE_URL has a trailing slash; trim it for joining):

```ts
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, "")}/api`;
const cb       = `${window.location.origin}${import.meta.env.BASE_URL}oauth/callback`;
<BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, "")}>
```

The server-side mirror lives in `web/server/src/server.ts`: `MOUNT` (from `PARACLAW_WEB_MOUNT`) is stripped uniformly before dispatch so `/api/*` and static-serve both see paths without the prefix.

## CJK font support

Agent containers ship without CJK fonts by default (~200MB saved). If you notice signals the user works with Chinese/Japanese/Korean content — conversing in CJK, CJK timezone (e.g., `Asia/Tokyo`, `Asia/Shanghai`, `Asia/Seoul`, `Asia/Taipei`, `Asia/Hong_Kong`), system locale hint, or mentions of needing to render CJK in screenshots/PDFs/scraped pages — offer to enable it:

```bash
# Ensure .env has INSTALL_CJK_FONTS=true (overwrite or append)
grep -q '^INSTALL_CJK_FONTS=' .env && sed -i.bak 's/^INSTALL_CJK_FONTS=.*/INSTALL_CJK_FONTS=true/' .env && rm -f .env.bak || echo 'INSTALL_CJK_FONTS=true' >> .env

# Rebuild and restart so new sessions pick up the new image
./container/build.sh
launchctl kickstart -k gui/$(id -u)/computer.parachute.claw-<slug>   # macOS
# systemctl --user restart paraclaw-<slug>                            # Linux
```

`container/build.sh` reads `INSTALL_CJK_FONTS` from `.env` and passes it through as a Docker build-arg. Without CJK fonts, Chromium-rendered screenshots and PDFs containing CJK text show tofu (empty rectangles) instead of characters.
