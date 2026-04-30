# Channel-wiring rework

**Status:** Design proposal · 2026-04-30 · paraclaw#67

Aaron, during 2026-04-30 evening claw+techne testing: adding a *second* Telegram bot to an already-set-up paraclaw drops the operator into the full first-run setup wizard. Wrong shape — the operator's mental model is "wire another bot," not "set paraclaw up from scratch."

This proposes a focused `/claw/channels/new` surface for routine channel-add ops, leaving `/claw/setup` reserved for true first-run.

## Goals

- **Routine channel-add is short.** Three concrete actions max: identify the bot, pick the agent group, wire. Skip everything that's already true.
- **Adapter parity.** Telegram is the immediate need, but the same surface handles Discord, Slack, WhatsApp, etc. — we add adapters by registering descriptors, not by re-shaping the page.
- **Setup wizard stays for first-run.** Initial install (no master key, no vault attached, no agent groups) still walks the full 8-step wizard. Once paraclaw is "ready," the wizard is reachable at `/claw/setup` but isn't where the "+ Wire a new channel" CTA points.
- **Resilient mid-flow recovery.** Bad token, name collision, idempotent re-wire, adapter-missing — every failure is recoverable in-place without restarting from step one.

## Non-goals

- Rewriting `/claw/setup`. The first-run wizard is a separate surface and stays as-is. (Phase-3 nice-to-have: refactor it to use the same descriptor-driven adapter components, but not required by this rework.)
- Replacing the `/claw/channels` index. The list-and-edit page stays; we just point its `+ Wire a new channel` button at the new surface.
- Moving credential capture out of the wizard's `TestConnectionStep` model. We reuse the same `/api/channels/<adapter>/test` validators and `/api/secrets` write path — this is a flow rework, not a credentials-store rework.
- Channel adapter installation UX. Installing a *new* adapter remains the skill-driven path (`/add-discord`, `/add-telegram`); the new surface only handles *wiring* once an adapter is installed (see § Adapter not installed).

## Current flow walk-through

When the operator clicks `+ Wire a new channel` on `/claw/channels`, the link points at `/setup` (see `web/ui/src/routes/ChannelsList.tsx:130-132`). They land in `SetupWizard` and walk:

| # | Step | What it does | Friction for routine ops |
|---|---|---|---|
| 1 | **Prerequisites** | Polls `/api/setup/status` — checks master key, hub reachability, vault attachment | **Wholly redundant.** All three are guaranteed true if paraclaw is running. |
| 2 | **Pick channel** | Card grid: Telegram / Discord (Slack/WhatsApp render disabled) | Relevant — needed even on re-wire. |
| 3 | **Install adapter** | Idempotent. If already installed (status check), shows "already installed" empty state with a `Next` button | One extra click. Not painful but unmotivated. |
| 4 | **Test connection** | Operator pastes token, server hits `/getMe` (or Discord `/users/@me`), captures `botUserId` + `botUsername` | Relevant — captures bot identity for the wire. |
| 5 | **Agent group** | Pick existing OR create new (inline form) | Relevant — needs to choose where this bot routes. |
| 6 | **Wire channel** | `POST /api/groups/:folder/wire-channel` — synthesizes `discord:@me:<id>` or `telegram:<id>` and inserts `messaging_groups` + `messaging_group_agents` | Relevant — the load-bearing action. |
| 7 | **Test message** | Polls `/api/groups/:folder` for `lastMessageInAt > baseline`, advances when a real DM arrives | Optional but useful for confirming the wire works. |
| 8 | **Done** | Static "you're done" page with links | Pure ceremony. |

Friction summary: **steps 1, 3, and 8 add nothing for routine ops.** Step 2 is one click. The actual work is steps 4 → 5 → 6 (+ optional 7) — three concrete decisions. The wizard's framing copy ("Set up paraclaw / Fresh install? Walk these steps to land your first agent") is also wrong context — the operator already has paraclaw set up.

Secondary friction sources:

- **localStorage state collision.** The wizard's `SETUP_STORAGE_KEY = 'paraclaw.setupWizard.v1'` is a single global slot. If the operator's paused mid-first-install with `currentStep: 'wire-channel'`, then comes back later to wire a *new* bot, the wizard resumes mid-state with stale `botUserId` from the old bot. Reset is manual (button at the bottom).
- **Step indicator visual weight.** "1 / 8 — Prerequisites" is loud for a 3-decision task.
- **No surface for "I already have a Telegram bot, I just want to add it as a second wiring."** Today the only path is the wizard.

## Target flow

A single page at **`/claw/channels/new`**, reached from the `+ Wire a new channel` button on `/claw/channels`. One form, three sections, progressive disclosure (later sections gate on earlier ones being valid):

```
┌─ Wire a new channel ──────────────────────────────────┐
│                                                       │
│ 1. Channel adapter                                    │
│    [○ Telegram (installed)]  [● Discord (installed)]  │
│    [+ Install another adapter →] (drops to /setup     │
│                                   on install step)    │
│                                                       │
│ 2. Bot identity                                       │
│    Bot token: [paste here]              [Validate]   │
│    ✓ Bot identified: @your_bot (id 7654321)          │
│    [✓] Save token to /secrets as `discord-bot-2`     │
│                                                       │
│   (Telegram-only): Your Telegram user id              │
│    [123456789]   (DM @userinfobot to find this)      │
│                                                       │
│ 3. Agent group                                        │
│    [● Forge       ] [○ Research  ] [○ + Create new] │
│                                                       │
│ Preview: discord:@me:7654321 → Forge                  │
│ [Cancel]                          [ Wire channel ]   │
└───────────────────────────────────────────────────────┘
```

Behavior:

1. **Section 1 — Channel adapter.** Lists every *installed* adapter as a primary card. A secondary "+ Install another adapter →" link drops the operator into `/setup?step=install` (the existing install step, narrowed). Adapter list is data-driven from `/api/setup/status`'s `channels.<name>.installed` plus a UI-side descriptor table.
2. **Section 2 — Bot identity.** Per-adapter credential fields (token always, plus per-adapter extras like Telegram's operator user id). `[Validate]` calls `POST /api/channels/<adapter>/test` to confirm the token works and capture `{id, username}`. On success, an opt-in "save to /secrets" checkbox appears (default checked, with a sensible name like `<adapter>-bot-<botUsername>`).
3. **Section 3 — Agent group.** Same picker the wizard uses (existing groups + "create new" inline form). Shape lifted from `AgentGroupStep.tsx`'s `pick`/`create` modes — extracted into a shared component.
4. **Wire button.** Calls `POST /api/groups/:folder/wire-channel` with the right id (bot snowflake for Discord, operator user id for Telegram). On success, shows the canonical platform_id + a "wire complete" confirmation with two CTAs: `Send a test message` (links to a test-message panel) and `View on /channels` (back to the index).

No localStorage state. The page is stateless across reloads — if the operator refreshes mid-flow, they re-paste the token (deliberately; tokens are write-only by design). Form-internal state is React component state, scoped to the page lifetime.

The page is reachable directly via URL — operators can deep-link `/claw/channels/new?adapter=telegram` from docs or scripts.

## Adapter parity (descriptor-driven)

We introduce a per-adapter descriptor so the page doesn't fork by channel type:

```ts
// web/ui/src/lib/channel-adapters.ts (new)
export interface ChannelAdapterDescriptor {
  /** key matching server side (`discord`, `telegram`, `slack`, …) */
  key: ChannelKind;
  /** human label */
  label: string;
  /** label hint shown under card; doc-style */
  blurb: string;
  /**
   * Credential fields the operator must paste. The first field is always the
   * token (used by /api/channels/<key>/test). Additional fields are
   * adapter-specific (e.g. Telegram operator user id, Slack signing secret).
   */
  credentials: ChannelAdapterField[];
  /**
   * Which captured field becomes the wire's `botUserId` payload. Discord uses
   * the bot's getMe id; Telegram uses the operator's user id (chat-routed DMs).
   * Slack will be the workspace id, etc.
   */
  wireIdSource: 'validatedIdentityId' | 'operatorUserId' | { fromField: string };
  /** Default "save to /secrets" name template. */
  secretNameTemplate: (validated: ValidatedIdentity) => string;
}

interface ChannelAdapterField {
  name: string;
  label: string;
  hint?: string;
  /** secret=true → password input + autoComplete=off + obscure-on-success */
  secret: boolean;
  /** numeric=true → inputMode=numeric, pattern=[0-9]+ */
  numeric?: boolean;
}
```

The page renders `descriptor.credentials` as a generic field list, calls the descriptor's validator (always `POST /api/channels/<key>/test`), and synthesizes the wire body from `wireIdSource`. Adding Slack means adding a Slack descriptor — no new page logic.

Today's two descriptors (sketch):

```ts
const TELEGRAM: ChannelAdapterDescriptor = {
  key: 'telegram',
  label: 'Telegram',
  blurb: 'Easiest first run — BotFather + @userinfobot, ~1 minute.',
  credentials: [
    { name: 'token', label: 'Bot token', secret: true },
    { name: 'operatorUserId', label: 'Your Telegram user id', numeric: true,
      hint: 'DM @userinfobot to find this. Telegram routes DMs by chat id (= your user id).' },
  ],
  wireIdSource: { fromField: 'operatorUserId' },
  secretNameTemplate: (v) => `telegram-bot-${v.username}`,
};

const DISCORD: ChannelAdapterDescriptor = {
  key: 'discord',
  label: 'Discord',
  blurb: 'DM your bot or @-mention it in a server.',
  credentials: [{ name: 'token', label: 'Bot token', secret: true }],
  wireIdSource: 'validatedIdentityId',
  secretNameTemplate: (v) => `discord-bot-${v.username}`,
};
```

Phase 2 ships only the `WireChannel` page reusing today's two adapters. Phase 3 (later, separate PR) extracts the wizard's `ChannelPickStep` + `TestConnectionStep` + `WireChannelStep` to read from the same descriptor table — that's churn we don't need for Aaron's blocker.

## Setup wizard scope

Setup wizard runs only when the install isn't ready yet. Trigger condition: `/api/setup/status` returns `ready: false` (i.e., master key missing, hub unreachable, OR no agent group has a vault attached).

Concretely:

- `/claw/setup` remains a real route, accessible by direct URL anytime (operator can re-walk it for diagnostic purposes).
- The CLI / hub-side dispatcher that lands a fresh operator on `/claw/setup` checks `ready` and redirects to `/claw/` (groups index) when ready=true, leaving the wizard as an opt-in deep link.
- The `+ Wire a new channel` button on `/claw/channels` always points at `/claw/channels/new`, never `/setup`.
- The `+ Install another adapter →` affordance on `/claw/channels/new` deep-links into `/setup?step=install` — re-entering the wizard *just* on the install step. (Setup wizard already supports `goto(step)`, so an opening URL param can route directly.) This is the one path back into the wizard for routine ops, and it's only needed when the adapter binary isn't on disk.

The SetupWizard's localStorage key gets bumped (`paraclaw.setupWizard.v2`) so prior stale state from the v1-era flow doesn't haunt operators returning months later.

## Credentials capture model

Reuse the existing pieces, narrowly:

- **Validate token:** `POST /api/channels/<adapter>/test` (already used by `TestConnectionStep`). Returns `{ identity: { id, username, ... } }`.
- **Save secret:** `POST /api/secrets` with `{ name, value, assigned_mode: 'all' }` (paraclaw#201 repurposed `CredentialFormStep` toward this; we just call the API directly). Default-checked checkbox in section 2 — operator opts out only if they already have the token in /secrets and don't want a duplicate. Naming defaults from `secretNameTemplate(validated)`.
- **Pull secret name into the wire?** No — the wiring layer doesn't reference the secret by name. The adapter at runtime looks up its token via the standard secret-injection path (`assigned_mode: 'all'` → injected into every group's container). This means: the saved secret is what makes the bot actually *talk*; the wire row makes the bot's messages route to the right agent group. Both must succeed for the new bot to work end-to-end. This dual-write is documented in the success state.

We deliberately do NOT reintroduce the wizard's old `CredentialFormStep` as a sub-component. Its three-step internal navigation would fight the single-page model. Instead, section 2 is a stateless inline form whose pieces (token input + validate button + result strip + save-to-secrets checkbox) are scoped to this surface.

## Resilience

Failure modes the page handles in-place, no restart:

| Failure | Surface | Recovery |
|---|---|---|
| **Bad token** | `POST /channels/<adapter>/test` returns 401/400 with provider message ("Unauthorized" from Discord, "Not Found" from Telegram for malformed token) | Inline error under the token field. Operator pastes a different token, clicks Validate again. No state lost. |
| **Network glitch on Validate** | fetch throws / 5xx | Inline error with retry button. Token field stays populated. |
| **Token validates but `/api/secrets` POST fails** (e.g. duplicate secret name) | 409 from secrets API | Inline warning under the checkbox: "A secret named `X` already exists. [Use a different name] [Skip saving]." Wire still proceeds without saving the secret. |
| **Agent group doesn't exist on wire** (operator deletes it in another tab between picking and wiring) | 404 from `wire-channel` | Inline error in section 3: "Group X no longer exists. [Refresh group list]." |
| **Wire fails because rows already exist** | `wire-channel` is idempotent; returns `created.wiring=false` | NOT a failure — page shows "Already wired — kept existing rows" success state with the existing platform_id. (Same as today's wizard step 7.) |
| **Wire fails for unexpected DB reason** | 500 from `wire-channel` | Inline error with retry. Operator can retry — second call is idempotent. |
| **Adapter not installed** | `/api/setup/status`'s `channels.<key>.installed=false` | The card for that adapter is rendered with "Install required" affordance instead of being clickable. CTA: "Install via /add-`<key>` skill" (links to docs) OR "Open install step" (deep-links into `/setup?step=install&adapter=<key>`). |
| **Two operators wiring same bot in two tabs** | Both run idempotent wire; first wins, second returns same `messagingGroupId`/`messagingGroupAgentId` with `created=false` | No conflict — idempotency by (channel_type, platform_id) protects this. |

Mid-flow recovery is structurally easier than the wizard because there are no ordered steps with localStorage that could go stale: each section reads its prerequisite data on mount, validates on demand, and degrades gracefully.

## API surface changes

**New:**
- *None server-side.* The page is pure UI + reuses existing endpoints (`/api/setup/status`, `/api/channels/<adapter>/test`, `/api/groups`, `POST /api/groups/:folder/wire-channel`, `POST /api/secrets`).

**Modified UI behavior:**
- `web/ui/src/routes/ChannelsList.tsx:130` — `+ Wire a new channel` Link's `to` changes from `/setup` to `/channels/new`.
- `web/ui/src/routes/ChannelsList.tsx:147` — empty-state copy changes from `Run /setup` to `Wire your first channel`.
- New route `/channels/new` registered in the router (next to `/groups/new` shape).

**Wizard preserved:** `SetupWizard` and its 8 steps stay reachable at `/setup`, untouched. The `+ Install another adapter →` link from `/claw/channels/new` lands at `/setup?step=install` to reuse the install pipeline; no new install code.

## Files (Phase 2 implementation sketch)

- **New:** `web/ui/src/routes/WireChannelPage.tsx` — the new single-page form (~250 lines).
- **New:** `web/ui/src/lib/channel-adapters.ts` — descriptor table (DISCORD, TELEGRAM); ~70 lines.
- **New:** `web/ui/src/components/AgentGroupPicker.tsx` — extracted from `AgentGroupStep.tsx`'s `pick`/`create` modes; ~150 lines. (Reused by the new page; the wizard step is refactored to thin-wrap this component to avoid duplication.)
- **Modified:** `web/ui/src/App.tsx` (or wherever the router is) — register the new route.
- **Modified:** `web/ui/src/routes/ChannelsList.tsx` — re-point the CTA + empty-state copy.
- **Modified:** `web/ui/src/components/setup/AgentGroupStep.tsx` — thin-wrap `AgentGroupPicker`.
- **Modified:** `web/ui/src/components/setup/types.ts` — bump `SETUP_STORAGE_KEY` to `paraclaw.setupWizard.v2`.

No host-side changes. No DB migration. No new endpoints. Clean.

## Test plan (Phase 2)

- **Vitest unit tests** (`web/ui/`): descriptor-driven field rendering for both adapters; validate-button success/error paths with mocked fetch; wire-button payload shape per adapter; idempotent re-wire renders the "already wired" state.
- **Manual smoke** on Aaron's local install:
  1. With paraclaw set up + 1 Telegram bot wired, navigate `/claw/channels` → click `+ Wire a new channel` → land on `/claw/channels/new`. Pick Telegram → paste second bot's token → Validate (`@second_bot` shows up) → enter operator user id → pick existing agent group → Wire. Confirm row appears on `/claw/channels` index.
  2. Repeat for Discord (no operator-user-id field shown).
  3. With second bot wired, send DM to it from Telegram → confirm message lands in the agent group's session (round-trip works = wire is real).
  4. Visit `/claw/setup` directly → wizard still works (regression check).
  5. Wipe agent groups / vault attachment → reload `/claw/` → confirm dispatcher routes back into setup wizard (first-run-still-works check).

## Open questions for Aaron

1. **Should the "Install another adapter →" link drop into the existing wizard's install step, or should we build a narrower `/claw/channels/install` micro-page?** Proposed: reuse the wizard step (saves code, install flow is rare and the wizard chrome isn't friction here). Decline if you'd rather fully isolate this surface from the wizard.
2. **Default for "save token to /secrets" checkbox: checked or unchecked?** Proposed: checked. Unchecked means the bot won't actually deliver — the operator would have a routed wire but no token in the secrets store, so the adapter wouldn't authenticate. Defaulting unchecked invites that footgun. Counter-argument: operators who already saved the token via `/claw/secrets` shouldn't get duplicates pushed at them.
3. **Should this surface also detect "you already have a wire for this exact (adapter, identity) pair" and short-circuit?** E.g., re-wiring the same Telegram operator id to the same group is a no-op (idempotency handles it), but re-wiring to a *different* group when an existing wire exists for the same operator id is ambiguous. Proposed: leave it to the operator (the route to a different group is their explicit pick), but show a warning ("this Telegram identity is already wired to group Y — this will add a second wire on top") under the wire button when the case matches. Decline if you'd rather treat that as an error.
4. **Phase 2 scope: does the new page also include a "test message" affordance (the wizard's step 7), or is "wired successfully" enough?** Proposed: include a simple `[Send test message]` button in the post-wire success state that opens an inline test-message panel mirroring the wizard step. It's the cheapest thing to leave behind for confidence-checking.
