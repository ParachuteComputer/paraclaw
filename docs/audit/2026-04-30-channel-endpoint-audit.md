# Channel endpoint audit (paraclaw#67, Phase 2 prep)

**Date:** 2026-04-30
**Scope:** what server endpoints exist for channel install/test/wire on `main` vs. what the design doc and the abandoned `feat/setup-wizard-discord` branch assumed.

The Phase 1 design doc flagged `/api/setup/install-channel` and `/api/channels/{adapter}/test` as "unclear-but-noted." This audit resolves them before impl begins so we don't write code that duplicates or contradicts existing surface.

## Findings

### 1. The validate/test handlers do not exist on `main`

`POST /api/channels/discord/test` and `POST /api/channels/telegram/test` are referenced by the wizard's `WireChannelStep` only via the wizard's *idempotent shortcut* (which assumes the adapter is already installed). On main, `src/web/server.ts` does not register either route. The handlers were written on `feat/setup-wizard-discord` under the old `web/server/src/` layout (pre-reorg) and were never ported.

The validator modules themselves (`discord-validate.ts`, `telegram-validate.ts`) and their tests are clean, well-typed, and portable. They will be lifted verbatim into `src/web/` as Phase 2 commit 2.

### 2. The install-channel orchestrator is obsolete

The 341-line `install-channel.ts` orchestrator on `feat/setup-wizard-discord` shells out to `.claude/skills/add-discord` / `add-telegram` to materialize an adapter. As of `main`:

- `src/channels/discord.ts` and `src/channels/telegram.ts` are **trunk-baked** — present at install time, no skill installation needed.
- `.claude/skills/add-discord` and `.claude/skills/add-telegram` no longer exist.
- The setup wizard's "install channel" step is a no-op for both, masked by an idempotent shortcut.

Implication for Phase 2: we do **not** need to port install-channel. The new `/channels/new` page can skip the install step entirely for trunk-baked adapters. Slack/WhatsApp/Teams remain "coming soon" and disabled in `ChannelPickStep.tsx`; their install path will be designed when those ship.

### 3. Open question O1 ("reuse wizard install step") doesn't bind

Aaron approved O1 in design review, but on the ground there is nothing to reuse: discord/telegram are already installed when the user lands, and slack/whatsapp aren't in scope. The new `/channels/new` page should hide the install section entirely for the supported adapters and surface a "coming soon" affordance for the rest.

### 4. CLAUDE.md is stale on adapter packaging

The repo-root `CLAUDE.md` states "trunk does not ship any specific channel adapter." That was true pre-reorg; it is not true today. Discord and Telegram are baked into the trunk install. Not fixed in this audit (out of scope), but flagging for a cleanup pass.

## Phase 2 scope (narrowed)

Result of the audit: Phase 2 is **server-light** (validators + 2 routes, ~395 LOC including tests, no DB migration) and **UI-bulky** (new page, descriptor table, picker extraction, ChannelsList re-link, wizard refactor). Single PR, per-feature commits.
