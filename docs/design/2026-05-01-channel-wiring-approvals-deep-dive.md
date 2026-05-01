# Channel-wiring + approvals deep dive

**Status:** Research · 2026-05-01 · follow-up to paraclaw#67

Aaron wired a second Telegram bot via `/claw/channels/new` (the fast-path landed in PR #69). The form validated the bot, captured his Telegram userId, and offered the wire button. Then he DM'd the new bot — and a "wire this channel?" approval card landed in his **first** Telegram bot's DM, asking him to approve a registration he'd just initiated three seconds earlier through the form.

This is empirically wrong on at least three axes: the approval shouldn't have fired (the form already had operator intent), the card shouldn't have been delivered through a *different* bot, and the resulting wiring used cautious approval-flow defaults instead of the trusted-operator wire-flow defaults. Aaron asked for a deep dive before any code changes.

This document reconstructs what actually happened from the live install's DB and logs, maps the architecture that produced the behavior, critiques what's wrong, and proposes three design directions. Aaron decides what to do.

---

## 1. Empirical trace

Live install at `~/.parachute/claw/paraclaw.db` (note: filename is `paraclaw.db`, not the `v2.db` the prompt referenced; same role). Times are UTC except where noted (log file uses local PT — UTC = local + 6h).

### 1.1 The two bots

`messaging_groups` rows for telegram, ordered by creation:

| MG id | platform_id | name | is_group | unknown_sender_policy | created_at |
|---|---|---|---|---|---|
| `mg-…e4z1rv` | `telegram:8792496425:1190596288` | Techne DM | 0 | **strict** | 2026-04-28 05:05 |
| `mg-…ihfgeq` | `telegram:8792496425:-1003927577645` | (group) | 1 | request_approval | 2026-04-29 02:25 |
| `mg-…90uhi5` | `telegram:8757751201:-1002245300962` | (group) | 1 | request_approval | 2026-05-01 19:13:43.981 |
| `mg-…ogxhkj` | `telegram:8757751201:1190596288` | (DM) | 0 | request_approval | 2026-05-01 19:13:43.982 |

Bot1 = `8792496425` (UnforcedAGI / the original setup-wizard wire). Bot2 = `8757751201` (the new one). Aaron's Telegram user id = `1190596288`.

### 1.2 The wirings

`messaging_group_agents` (all wired to the only existing agent group, Techne):

| MGA id | MG | engage | sender_scope | ignored_msg_policy | created_at |
|---|---|---|---|---|---|
| `mga-…gc6co9` | bot1-DM-Aaron | pattern `.` | **all** | **drop** | 2026-04-28 |
| `mga-…5i9dz9` | bot2-DM-Aaron | pattern `.` | **known** | **accumulate** | 2026-05-01 19:14:17 |
| `mga-…9977ij` | bot2-Group | pattern `.` | known | accumulate | 2026-05-01 19:15:07 |

Bot1's MGA (created by `init-first-agent.ts`) uses the trusted defaults: `sender_scope='all'`, `ignored_message_policy='drop'`, `unknown_sender_policy='strict'`. Bot2's MGA uses the cautious defaults: `sender_scope='known'`, `ignored_message_policy='accumulate'`, `unknown_sender_policy='request_approval'`. **Different rows, different behavior, both wired by the operator on the same day for the same operator.**

### 1.3 user_dms cache

| user_id | channel_type | messaging_group_id | resolved_at |
|---|---|---|---|
| `telegram:1190596288` | telegram | `mg-…e4z1rv` (bot1 DM) | 2026-04-29 |

`user_dms` is keyed `(user_id, channel_type)` — exactly one row per user-channel. When the channel-approval flow asks "where can I reach Aaron?", this cache says "his bot1 DM" and stops.

### 1.4 The timeline (from `~/.parachute/claw/logs/claw.log`)

```
13:13:43.697  Channel bot registered          adapter=telegram botId=8757751201
13:13:43.697  Channel adapter registered dynamically
13:13:43.980  Inbound DM received             channelId=telegram:8757751201:1190596288  (×3)
13:13:43.981  Auto-created messaging group    mg-…90uhi5  (telegram:8757751201:-1002245300962)
13:13:43.982  Auto-created messaging group    mg-…ogxhkj  (telegram:8757751201:1190596288)
13:13:43.983  ERROR Channel-request gate threw — UNIQUE constraint failed:
              pending_channel_approvals.messaging_group_id  (×2)
13:13:44.529  Channel registration card delivered  mg-…90uhi5  approver=telegram:1190596288
13:13:44.555  Channel registration card delivered  mg-…ogxhkj  approver=telegram:1190596288
13:14:17.329  Channel registration approved — wiring created  mga-…5i9dz9
13:14:17.342  Session created
13:14:17.353  Spawning container               techne
13:14:25.204  Message delivered                platformId=telegram:8757751201:1190596288
13:15:07.386  Channel registration approved — wiring created  mga-…9977ij  (group)
```

### 1.5 What this says

**The wire form's `Wire` button never effectively ran.** Validation completed at 13:13:43.697; the dynamic register-bot path (PR #67 B2) brought the Bot2 polling loop live in the same call. **283 ms later** Telegram's `getUpdates` returned three queued DMs Aaron had sent before the form even existed. The router auto-created the bot2-DM messaging group with `unknown_sender_policy='request_approval'` (router.ts:179, hardcoded for any auto-create), saw zero wirings, and called `channelRequestGate` — which delivered the approval card. Aaron approved via the card; the channel-approval handler created the MGA with its own (cautious) defaults. By the time the operator could reach the form's "Wire" button, the MGA already existed; the wire button was a no-op idempotent on the existing MGA pair.

The wire path's defaults (`sender_scope='all'`, `unknown_sender_policy='strict'`) were never applied. The approval-handler's defaults (`sender_scope='known'`, `unknown_sender_policy='request_approval'` inherited from auto-create) won by milliseconds.

### 1.6 The race-condition bug

Three rapid inbound DMs at 13:13:43.980 each fired `requestChannelApproval`. The dedup check (`hasInFlightChannelApproval` in `channel-approval.ts:63`) reads-then-inserts non-atomically. All three saw "no pending row" and raced the `INSERT INTO pending_channel_approvals` (PK on messaging_group_id). The first won; the other two threw `UNIQUE constraint failed` (logged at ERROR). User-visible impact: zero — the first INSERT got an approval card delivered. But the error log is misleading and the dedup is wrong by design.

### 1.7 Why the card came through Bot1

`pickApprovalDelivery(approvers, originChannelType)` (`src/modules/approvals/primitive.ts:104`) walks the approver list, calls `ensureUserDm(userId)` per approver, returns the first one that resolves. `ensureUserDm` looks up `user_dms` first; only on a miss does it call the platform's `openDM`. Aaron's `user_dms` row was Bot1's DM — that's what got returned. The function has no notion of "approval is *about* Bot2; prefer Bot2's DM if reachable."

### 1.8 Hypothesis verdict

The team-lead's three hypotheses:
- (a) **Half-correct.** Wire path's MGA was never created; the approval handler's MGA *was* created with `sender_scope='known'`. Aaron, as approver, was auto-added to `agent_group_members` so the replay wouldn't bounce. So the wire flow eventually produced a working channel — but via the wrong code path.
- (b) **Confirmed.** The bot2-DM `mg-…ogxhkj` was created by `routeInbound`'s auto-create, *not* by `wireDmToAgent`. There's a single MG per (channel_type, platform_id), so we don't have *duplicate* siblings — we have a `wireDmToAgent` that never inserted because `routeInbound` got there first.
- (c) **Wrong.** Platform_id encoding `telegram:8757751201:1190596288` is correct (bot2 + Aaron). PR A's encoding is solid.

Root cause: **the bot adapter goes live the moment the user clicks "Validate."** The wire button's only remaining job in the post-PR #67 flow is creating the MGA — but inbound traffic on a backlogged channel races it.

---

## 2. Architecture map

### 2.1 platform_id encoding

`<channel>:<botId>:<native>` (PR A landed pre-PR #67 B1). Per channel:
- Telegram: `botId` is the bot's Telegram user id (positive int from `getMe`); `native` is the `chat_id`. For DMs `chat_id == userId`; for groups `chat_id` is a negative int.
- Discord: `botId` is the application id; `native` is `@me:<botUserId>` for DMs or a guild-channel id for guilds.

The bot dimension is what makes two Telegram bots' identical DM `chat_id`s resolve to distinct `messaging_groups` rows.

### 2.2 Wire flow (UI → DB)

User clicks "Validate & register bot" on `/claw/channels/new`:
1. `POST /api/channels/{adapter}/register-bot` (B2) → validates token, persists `secrets` row `CHANNEL_BOT_TOKEN:<channel>:<botId>`, calls `registerBotAdapter`. **Adapter goes live now.**
2. UI shows resolved identity, asks for agent group + (Telegram) operator userId.
3. User clicks "Wire" → `POST /api/groups/:folder/wire-channel` → `wireDmToAgent(...)` → INSERT messaging_groups + messaging_group_agents, defaults `sender_scope='all'`, `ignored_message_policy='drop'`, `unknown_sender_policy='strict'`.

Step 1 → 3 is **not atomic**. Anything that hits the polling loop between steps lands on an unwired channel.

### 2.3 Inbound flow (router.ts)

Adapter polling loop receives a message → `routeInbound(event)`:
1. Look up MG by (channel_type, platform_id). If missing AND message is mention/DM, auto-create with `unknown_sender_policy='request_approval'` (router.ts:179, hardcoded).
2. If `agentCount === 0`: record dropped_message, fire `channelRequestGate` (the registration approval), return.
3. Else: `senderResolver` upserts `users` row, fan out to wirings. Each wiring evaluates `engage_mode`, `accessGate`, `senderScopeGate` independently. Engaged → write to session inbound DB + wake container. Not engaged but `accumulate` → write inbound with `trigger=0`. Else drop.

### 2.4 Approval picking (`src/modules/approvals/primitive.ts`)

- `pickApprover(agentGroupId)` returns ordered user ids: scoped admins → global admins → owners. For Aaron's install, owner-only.
- `pickApprovalDelivery(approvers, originChannelType)` walks the list, prefers same-channel approvers, calls `ensureUserDm` to resolve a reachable DM. Returns the first hit. **No bot-level preference** — picks any cached or openable DM.

### 2.5 Identity tables

- `users(id, kind, display_name, created_at)` — id = `<channel>:<handle>` (e.g. `telegram:1190596288`). Upserted on first sender resolution.
- `user_roles(user_id, role, agent_group_id, granted_by, granted_at)` — owner / admin (global if `agent_group_id IS NULL`, scoped otherwise).
- `agent_group_members(user_id, agent_group_id, added_by, added_at)` — unprivileged-access gate; channel-approval handler auto-adds the triggering sender so the replay doesn't bounce on `sender_scope='known'`.
- `user_dms(user_id, channel_type, messaging_group_id, resolved_at)` — DM cache. **One row per user per channel.** First-cached wins.

### 2.6 unknown_sender_policy × sender_scope

These are independent. `unknown_sender_policy` is on `messaging_groups`; `sender_scope` is on `messaging_group_agents`. Most install paths default both to the same posture (strict/all OR request_approval/known) but they drift in the auto-create + approval-handler combo: MG inherits `request_approval` (from router auto-create), MGA inherits `known` (from approval handler). Net effect: senders Aaron hasn't approved get bounced to a sender-approval cascade (`pending_sender_approvals`).

### 2.7 Approval table zoo

Three tables, three lifecycles:
- `pending_channel_approvals` — channel-registration cards (PR #67 area). PK on `messaging_group_id`. Deleted on approve/reject.
- `pending_sender_approvals` — sender-scope cards (when `sender_scope='known'` rejects an unknown sender). Different lifecycle, different module.
- `approvals` — the modular approval primitive (paraclaw#11/#286). Used by self-mod, MCP, etc. Distinct from the channel/sender tables.

The team-lead's prompt asks me to confirm `pending_channel_approvals` and `approvals` are distinct: **yes**, separate tables, separate code paths. Channel registration was deliberately not folded into the unified primitive (see `channel-approval.ts:1-38` header comment).

---

## 3. Critique

### 3.1 The validate-spawns-the-bot UX is the load-bearing problem

PR #67 B2's polish folded validate + register into one button click — for good reason (avoided doubled API quota on Telegram's getUpdates). But it converted "validate the token works" from a read-only action into a side-effecting one. The bot is *live and serving traffic* before the operator picks an agent group. A backlogged channel will race the wire.

### 3.2 The approval cascade for self-wire is wrong

The form *just* captured the operator's userId. The system has all the context it needs to know "Aaron is wiring his own bot to his own DM." Yet the inbound message gets treated as a stranger DM'ing an unwired channel — an approval card is built and delivered to that same operator, by a different bot, asking them to approve what they're already in the middle of doing.

It's not just an annoyance; it's misleading. The card delivery via Bot1 implies "Bot1 owns this approval" or "this is a system-level event in Bot1's chat" — neither is true.

### 3.3 The card-via-different-bot is mostly accidental

`pickApprovalDelivery` tries to find any reachable DM. For a single-bot install this happens to be the right bot. For multi-bot, it's whichever bot's DM got cached first. In Aaron's case, this caused the surprising "Bot1 telling me about Bot2" UX. It's not principled; it's just what the cache returned.

A principled answer: approval cards about Bot X should prefer delivery via Bot X if the approver is reachable there. For first-touch operators (no `user_dms` yet for that bot), fall back. For cross-bot scenarios where the approver isn't reachable on the new bot, the current behavior is fine.

### 3.4 The race in `pending_channel_approvals` is real

Three concurrent inbounds → three concurrent `requestChannelApproval` calls → unique-key collision. The current code logs ERROR and moves on, so user-visible impact is nil, but:
- The error log misleads anyone debugging.
- If the **first** insert fails for any reason (not a duplicate — say, a constraint or transient I/O), the others *would* have succeeded, but never reach INSERT because the dedup check was non-atomic.

Atomic fix: `INSERT … ON CONFLICT DO NOTHING` and check `changes() > 0` to decide whether to deliver. Already cheap; just hasn't been done.

### 3.5 The two MGA-default sets create a hidden invariant

`wireDmToAgent` defaults: trusted (all/drop/strict). `channel-approval.ts` handler defaults: cautious (known/accumulate/request_approval). They're meant to model two different intents:
- Operator proactively wired this bot to themselves → trust.
- An admin approved a stranger's mention/DM after-the-fact → cautious.

But which one applies depends on a milliseconds-level race that the operator can't observe. **The intent isn't legible from the data afterward** — `mga-…5i9dz9` looks identical in shape to a real "I approved a stranger" wire. The system can't recover the operator's actual intent, and neither can the operator looking back at the wirings list.

### 3.6 Multi-bot model gaps surfaced by PR #67

PR #67 B2 introduced the secrets-backed multi-bot scan (`spawnSecretsBackedBots`) that brings every `CHANNEL_BOT_TOKEN:<channel>:<botId>` secret live on boot. Combined with `register-bot` going live immediately on validate, **the system has no notion of a "registered but inert" bot.** Once registered, a bot serves traffic forever. There's no "I want to test this token but not yet route messages" state.

---

## 4. Design proposals

### A. Defer adapter spawn until after wire (atomic register+wire)

**Sketch.** Split `/api/channels/{adapter}/register-bot` into two phases. Phase 1 = validate + persist secret + return identity, **don't bring the adapter live**. Phase 2 = "wire" endpoint creates MGA *and* spawns the adapter atomically. `spawnSecretsBackedBots()` at boot only spawns secrets that have at least one wiring; orphaned secrets stay inert.

**Data model.** No schema changes. New invariant: an adapter is live only when a wiring exists. Implemented in `spawnSecretsBackedBots` (skip orphans) + in the wire endpoint (start adapter on success).

**UX.** The form's "Validate" returns identity but the bot stays cold. "Wire" is the action that brings it live. Backlogged DMs land on a wired channel — engaged immediately, no approval cascade. Operators wanting to "just verify the token works" still get the validation result without committing to a live bot.

**Solves.** The race entirely. The surprise-approval-cascade for self-wire entirely. Makes orphan-secret cleanup (a future tablet on PR #67) trivial.

**Doesn't solve.** Approval card delivery via wrong bot for *post-wire* registrations (different operator, after wire is committed). That's still routed via `pickApprovalDelivery` and still picks the cached DM.

**Migration.** Modest. Update `register-bot` to skip `registerBotAdapter`. Update `wireDmToAgent` (or a new wrapper) to call `registerBotAdapter` after MGA insert. Update `spawnSecretsBackedBots` to JOIN through messaging_groups+messaging_group_agents. Delete the existing race-doc-update from PR #67's body; it ceases to be a thing.

**Risk.** A user who validates and never wires leaves an orphan secret. We need a sweep or a UI prompt. (Discord/Telegram tokens don't expire automatically, so the orphan persists — but it's inert.) Lower-risk than current "always live" semantics.

### B. Operator-self-wire trust hint

**Sketch.** When `/channels/new` form is submitted, persist a short-lived "trusted setup hint" naming `(channel_type, bot_id, operator_user_id, expires_at)`. The router checks for a matching hint when handling the first inbound on an unwired bot's DM. If matched, skip `channelRequestGate` and immediately wire with `wireDmToAgent`'s trusted defaults (all/drop/strict). Hint expires on use or after 10 minutes.

**Data model.** New table `pending_channel_setup_hints (channel_type, bot_id, operator_user_id, expires_at)` or in-memory map (cheaper, lost on restart — fine because hints are 10-minute things).

**UX.** Same form flow as today. The first DM Aaron sends to Bot2 just works; no card. Subsequent DMs from anyone else go through the normal approval path.

**Solves.** The "I just wired this, the next message from me should just work" UX. Preserves the polling-eager validate UX.

**Doesn't solve.** The race is still there for *other* senders (someone else DMs the bot in the validate-to-wire window — they get the approval cascade, which is correct behavior anyway). Card-via-wrong-bot for post-wire approvals is unaddressed.

**Migration.** Small. Add the table or in-memory map, hook into the form submit, hook into router.ts:218 (channel-request gate dispatch) to consult the hint first. Default hint TTL = 10 min, configurable.

**Risk.** Hint table needs cleanup (TTL sweep). In-memory variant is lost on restart, which is correct behavior — operators who don't wire within 10 min are starting over anyway.

### C. Approval delivery follows the bot in question

**Sketch.** Extend `pickApprovalDelivery` to take an optional `preferredBotId`. For channel-registration approvals, pass the bot id of the channel being registered. The function tries to resolve a `user_dms` row for the (approver, channel_type, bot_id) combination; on miss, falls back to current behavior.

**Data model.** Existing `user_dms` is keyed `(user_id, channel_type)` — only one DM per user-channel. Need to extend to `(user_id, channel_type, bot_id)` to differentiate. Migration: ALTER TABLE adds `bot_id TEXT` column, backfill from `messaging_groups.platform_id` (parse second segment). Make `(user_id, channel_type, bot_id)` the new PK; the old `(user_id, channel_type)` constraint goes away.

**UX.** Approval cards land in the right bot. Less confusing for the operator. For first-touch (no cached DM via the new bot), still falls back so functionality doesn't break.

**Solves.** The cross-bot card delivery confusion. Doesn't solve the surprise-approval-cascade for self-wire.

**Migration.** Schema change is non-trivial but mechanical. Code change is one extra arg + a fallback.

**Risk.** Existing `user_dms` rows need a sane bot_id backfill. For Aaron's row (bot1's MG), bot_id is recoverable. For older rows from before PR A's bot dimension, bot_id is `null` and matches the legacy "single-bot per channel" assumption — needs care.

### Recommendation

**A + B together.** A removes the race; B handles the case where the operator wants to test by DM'ing in the validate-but-not-yet-wired window (with A alone, they'd have to wire first). Together: validate is read-only, the form's wire button is the single commit point, and there's a short trust window for the operator to test from their own client.

C is a smaller cleanup that's worth doing independently — it makes the surface principled even if A+B aren't shipped together.

---

## 5. Open questions for Aaron

These are decisions the research can't make alone:

1. **Trust the form's captured userId for self-wire bypass?** Proposal B trusts that the operator filling out `/channels/new` and entering their own Telegram userId is the same person as the one DM'ing the bot. If yes, the hint-based bypass is fine. If no, we need a stronger binding (e.g., the form generates a one-time token the operator includes in their first DM).

2. **Should an inert (registered but unwired) secret persist across restarts?** Proposal A has `spawnSecretsBackedBots()` skip orphans. That means a validated-but-not-wired bot doesn't survive a restart. Alternative: keep the secret, log a warning at boot listing orphans, let the operator decide via a UI sweep. Open: which trade-off do you prefer?

3. **Should approval cards always come from the bot in question?** Proposal C says yes-when-possible. Edge: an admin approving a registration for a bot they've never DM'd — the approval has to come from somewhere. Current fallback (any cached DM) is the simplest answer; alternative is "the bot DMs the admin first" which is more invasive.

4. **What's the right MGA default for "operator approved a stranger's DM via card"?** Today: `sender_scope='known'`, `ignored_message_policy='accumulate'`. The reasoning (only let already-known users engage; stash others' messages until they're approved) is defensive. But it surprised Aaron when he was the "stranger." For *self*-approval (operator approving their own DM), should the defaults flip to `all`/`drop`?

5. **How visible should the post-wire wiring shape be?** Right now the channels list shows the wiring exists but not its `sender_scope`/`ignored_message_policy`/`unknown_sender_policy`. If those shape the engagement profile materially, shouldn't they be surfaced in the channel-edit UI? (This is orthogonal to the proposals above but adjacent.)

6. **Does PR #72 ship as-is, or wait for one of these proposals?** PR #72 is correct for the multi-bot infrastructure. The UX bugs above exist with or without it. The argument for shipping #72 first: the infrastructure is sound, and the design fixes are about the *flow*, not the *capability*. The argument against: shipping the multi-bot path before fixing the surprise-cascade UX means more operators hit the surprise.

---

## Appendix: file references

- Router auto-create policy: `src/router.ts:179`
- Channel-request gate dispatch: `src/router.ts:218`
- Wire-flow defaults (trusted): `src/web/wire-channel.ts:158-172`
- Approval-flow defaults (cautious): `src/modules/permissions/index.ts:344-355`
- Approval delivery picker: `src/modules/approvals/primitive.ts:104-120`
- Channel-registration handler: `src/modules/permissions/channel-approval.ts`
- pending_channel_approvals schema: `src/db/migrations/012-channel-registration.ts`
- B2 register-bot endpoint: `src/web/server.ts` (POST `/api/channels/{adapter}/register-bot`)
- B2 secrets-backed scan: `src/channels/channel-registry.ts` (`spawnSecretsBackedBots`)
- Live install evidence: `~/.parachute/claw/paraclaw.db`, `~/.parachute/claw/logs/claw.log`
