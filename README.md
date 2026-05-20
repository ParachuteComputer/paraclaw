# parachute-agent

> [!CAUTION]
> **`@openparachute/agent` is deprecated as of 2026-05-20.**
>
> Most users should NOT install this module. The "Claude in containers" architecture proved too heavy for the owner-operated, trusted-vault use case it was built for. A simpler primitive — a cron-scheduled Python runner that spawns `claude -p` with inline MCP config against your vault — handles 90% of the actual use cases at a fraction of the complexity.
>
> **What to use instead:**
> - **For owner-operated automation**: write a small runner script. See the Gitcoin Brain (2026-05) pattern — a small Python+cron runner that proves the lightweight model. The `parachute-vault mcp-config <name>` CLI (vault 0.4.6+) gives you the inline MCP config JSON for free; until it's on `@latest`, you can construct the JSON manually.
> - **For hosted multi-tenant or untrusted prompts**: parachute-agent's container isolation IS the right shape — but this scenario will be served by `parachute-cloud` (TBD), not by self-hosting `@openparachute/agent` directly.
> - **For experimentation**: this repo and module remain installable; nothing's been removed. Read [DEPRECATED.md](./DEPRECATED.md) for the full rationale.

(The original README follows.)

---

<p align="center">
  An AI assistant that runs agents securely in their own containers. Lightweight, built to be easily understood and completely customized for your needs. A [Parachute](https://parachute.computer) module.
</p>

<p align="center">
  <a href="https://parachute.computer">parachute.computer</a>&nbsp; • &nbsp;
  <a href="docs/">docs</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>&nbsp; • &nbsp;
  <a href="README_ja.md">日本語</a>
</p>

---

## Why parachute-agent

Most AI-assistant frameworks fall into one of two camps: heavyweight platforms with hundreds of thousands of lines of code, dozens of config files, and security at the application layer (allowlists, pairing codes); or DIY scripts with no isolation at all. Both ask you to either trust software you can't read, or hand the agent direct access to your machine.

parachute-agent runs each agent group in its own Linux container with filesystem isolation, in a codebase small enough to read in an afternoon — one process and a handful of files. Bash access is safe because commands run inside the container, not on your host. The user's [Parachute Vault](https://github.com/ParachuteComputer/parachute-vault) is the agent's substrate: scoped vault tokens grant exactly the read/write surface you choose, and credentials live in a local AES-GCM-encrypted store, never round-tripped through chat context.

## Quick Start

parachute-agent is a [Parachute](https://parachute.computer) module — install it through the hub and configure it from the web UI:

```bash
parachute install parachute-agent
```

The hub builds the agent container, brings the host process up under `bun src/index.ts`, and serves the configuration UI at `http://127.0.0.1:1944/agent/`. From there: drop in your Anthropic API key, pick a channel (Telegram, Discord, or the local CLI), and pair your first agent — no shell scripts required. See [`docs/parachute-integration.md`](docs/parachute-integration.md) for the full Parachute path.

## Philosophy

**Small enough to understand.** One process, a few source files and no microservices. If you want to understand the full parachute-agent codebase, just ask Claude Code to walk you through it.

**Secure by isolation.** Agents run in Linux containers and they can only see what's explicitly mounted. Bash access is safe because commands run inside the container, not on your host.

**Built for the individual user.** parachute-agent isn't a monolithic framework; it's software that fits each user's exact needs. Instead of becoming bloatware, parachute-agent is designed to be bespoke. You make your own fork and have Claude Code modify it to match your needs.

**Customization = code changes.** No configuration sprawl. Want different behavior? Modify the code. The codebase is small enough that it's safe to make changes.

**AI-native, hybrid by design.** The install and onboarding flow is an optimized scripted path, fast and deterministic. When a step needs judgment, whether a failed install, a guided decision, or a customization, control hands off to Claude Code seamlessly. Beyond setup there's no monitoring dashboard or debugging UI either: describe the problem in chat and Claude Code handles it.

**Skills over features.** Trunk ships the registry and infrastructure, not specific channel adapters or alternative agent providers. Channels (Discord, Slack, Telegram, WhatsApp, …) live on a long-lived `channels` branch; alternative providers (OpenCode, Ollama) live on `providers`. You run `/add-telegram`, `/add-opencode`, etc. and the skill copies exactly the module(s) you need into your fork. No feature you didn't ask for.

**Best harness, best model.** parachute-agent natively uses Claude Code via Anthropic's official Claude Agent SDK, so you get the latest Claude models and Claude Code's full toolset, including the ability to modify and expand your own parachute-agent fork. Other providers are drop-in options: `/add-codex` for OpenAI's Codex (ChatGPT subscription or API key), `/add-opencode` for OpenRouter, Google, DeepSeek and more via OpenCode, and `/add-ollama-provider` for local open-weight models. Provider is configurable per agent group.

## What It Supports

- **Multi-channel messaging** — WhatsApp, Telegram, Discord, Slack, Microsoft Teams, iMessage, Matrix, Google Chat, Webex, Linear, GitHub, WeChat, and email via Resend. Installed on demand with `/add-<channel>` skills. Run one or many at the same time.
- **Flexible isolation** — connect each channel to its own agent for full privacy, share one agent across many channels for unified memory with separate conversations, or fold multiple channels into a single shared session so one conversation spans many surfaces. Pick per channel via `/manage-channels`. See [docs/isolation-model.md](docs/isolation-model.md).
- **Per-agent workspace** — each agent group has its own `CLAUDE.md`, its own memory, its own container, and only the mounts you allow. Nothing crosses the boundary unless you wire it to.
- **Scheduled tasks** — recurring jobs that run Claude and can message you back
- **Web access** — search and fetch content from the web
- **Container isolation** — agents are sandboxed in Docker (macOS/Linux/WSL2), with optional [Docker Sandboxes](docs/docker-sandboxes.md) micro-VM isolation or Apple Container as a macOS-native opt-in
- **Credential security** — agents never hold raw API keys. parachute-agent stores credentials in a local AES-GCM-encrypted secret store (`~/.parachute/agent/master.key` + the central DB), injects them into the container's environment at spawn time, and never round-trips them through chat context.

## Usage

Talk to your assistant with the trigger word (default: `@Andy`):

```
@Andy send an overview of the sales pipeline every weekday morning at 9am (has access to my Obsidian vault folder)
@Andy review the git history for the past week each Friday and update the README if there's drift
@Andy every Monday at 8am, compile news on AI developments from Hacker News and TechCrunch and message me a briefing
```

From a channel you own or administer, you can manage groups and tasks:
```
@Andy list all scheduled tasks across groups
@Andy pause the Monday briefing task
@Andy join the Family Chat group
```

## Customizing

parachute-agent doesn't use configuration files. To make changes, just tell Claude Code what you want:

- "Change the trigger word to @Bob"
- "Remember in the future to make responses shorter and more direct"
- "Add a custom greeting when I say good morning"
- "Store conversation summaries weekly"

Or run `/customize` for guided changes.

The codebase is small enough that Claude can safely modify it.

## Contributing

**Don't add features. Add skills.**

If you want to add a new channel or agent provider, don't add it to trunk. New channel adapters land on the `channels` branch; new agent providers land on `providers`. Users install them in their own fork with `/add-<name>` skills, which copy the relevant module(s) into the standard paths, wire the registration, and pin dependencies.

This keeps trunk as pure registry and infra, and every fork stays lean — users get the channels and providers they asked for and nothing else.

### RFS (Request for Skills)

Skills we'd like to see:

**Communication Channels**
- `/add-signal` — Add Signal as a channel

## Requirements

- macOS or Linux (Windows via WSL2)
- Node.js 20+ and pnpm 10+ (the installer will install both if missing)
- [Docker Desktop](https://docker.com/products/docker-desktop) (macOS/Windows) or Docker Engine (Linux)
- [Claude Code](https://claude.ai/download) for `/customize`, `/debug`, error recovery during setup, and all `/add-<channel>` skills

## Architecture

```
messaging apps → host process (router) → inbound.db → container (Bun, Claude Agent SDK) → outbound.db → host process (delivery) → messaging apps
```

A single Node host orchestrates per-session agent containers. When a message arrives, the host routes it via the entity model (user → messaging group → agent group → session), writes it to the session's `inbound.db`, and wakes the container. The agent-runner inside the container polls `inbound.db`, runs Claude, and writes responses to `outbound.db`. The host polls `outbound.db` and delivers back through the channel adapter.

Two SQLite files per session, each with exactly one writer — no cross-mount contention, no IPC, no stdin piping. Channels and alternative providers self-register at startup; trunk ships the registry and the Chat SDK bridge, while the adapters themselves are skill-installed per fork.

For the full architecture writeup see [docs/architecture.md](docs/architecture.md); for the three-level isolation model see [docs/isolation-model.md](docs/isolation-model.md).

Key files:
- `src/index.ts` — entry point: DB init, channel adapters, delivery polls, sweep
- `src/router.ts` — inbound routing: messaging group → agent group → session → `inbound.db`
- `src/delivery.ts` — polls `outbound.db`, delivers via adapter, handles system actions
- `src/host-sweep.ts` — 60s sweep: stale detection, due-message wake, recurrence
- `src/session-manager.ts` — resolves sessions, opens `inbound.db` / `outbound.db`
- `src/container-runner.ts` — spawns per-agent-group containers, injects encrypted secrets at spawn
- `src/db/` — central DB (users, roles, agent groups, messaging groups, wiring, migrations)
- `src/channels/` — channel adapter infra (adapters installed via `/add-<channel>` skills)
- `src/providers/` — host-side provider config (`claude` baked in; others via skills)
- `container/agent-runner/` — Bun agent-runner: poll loop, MCP tools, provider abstraction
- `groups/<folder>/` — per-agent-group filesystem (`CLAUDE.md`, skills, container config)

## FAQ

**Why Docker?**

Docker provides cross-platform support (macOS, Linux and Windows via WSL2) and a mature ecosystem. On macOS, you can optionally switch to Apple Container via `/convert-to-apple-container` for a lighter-weight native runtime. For additional isolation, [Docker Sandboxes](docs/docker-sandboxes.md) run each container inside a micro VM.

**Can I run this on Linux or Windows?**

Yes. Docker is the default runtime and works on macOS, Linux, and Windows (via WSL2). Install via the Parachute hub: `parachute install parachute-agent`.

**Is this secure?**

Agents run in containers, not behind application-level permission checks. They can only access explicitly mounted directories. Credentials live in parachute-agent's AES-GCM-encrypted secret store (master key at `~/.parachute/agent/master.key`, ciphertext in the central DB), injected into each container at spawn time and scoped per agent group. You should still review what you're running, but the codebase is small enough that you actually can.

**Why no configuration files?**

We don't want configuration sprawl. Every user should customize parachute-agent so that the code does exactly what they want, rather than configuring a generic system. If you prefer having config files, you can tell Claude to add them.

**Can I use third-party or open-source models?**

Yes. The supported path is `/add-opencode` (OpenRouter, OpenAI, Google, DeepSeek, and more via OpenCode config) or `/add-ollama-provider` (local open-weight models via Ollama). Both are configurable per agent group, so different agents can run on different backends in the same install.

For one-off experiments, any Claude API-compatible endpoint also works via `.env`:

```bash
ANTHROPIC_BASE_URL=https://your-api-endpoint.com
ANTHROPIC_AUTH_TOKEN=your-token-here
```

**How do I debug issues?**

Ask Claude Code. "Why isn't the scheduler running?" "What's in the recent logs?" "Why did this message not get a response?" That's the AI-native approach that underlies parachute-agent.

**Why isn't the setup working for me?**

If a step fails, run `claude`, then `/debug`. If Claude identifies an issue likely to affect other users, open a PR against the relevant setup step or skill.

**What changes will be accepted into the codebase?**

Only security fixes, bug fixes, and clear improvements will be accepted to the base configuration. That's all.

Everything else (new capabilities, OS compatibility, hardware support, enhancements) should be contributed as skills on the `channels` or `providers` branch.

This keeps the base system minimal and lets every user customize their installation without inheriting features they don't want.

## Community

Questions? Ideas? [Join the Discord](https://discord.gg/VDdww8qS42).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for breaking changes.

## License

parachute-agent is licensed under the GNU Affero General Public License v3.0
([LICENSE](./LICENSE)).

It is a derivative of [NanoClaw](https://github.com/qwibitai/nanoclaw) (MIT —
see [LICENSE-NANOCLAW-MIT](./LICENSE-NANOCLAW-MIT) for the original copyright
notice). Substantial modifications and the combined work are AGPL-3.0; the
original NanoClaw code remains MIT-licensed and can be obtained from the
upstream project.
