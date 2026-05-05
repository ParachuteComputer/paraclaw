# Channel policy + approval routing

**Status:** Design proposal · 2026-05-02 · paraclaw#67 follow-up

Three threads surfaced once the multi-bot wiring landed and Aaron started using two Telegram bots side by side:

1. **Approval delivery doesn't follow the bot in question.** TechneRobot group-chat approval cards arrived through UnforcedAGI's DM — wrong bot, wrong mental model.
2. **Per-channel policy is buried.** `unknown_sender_policy` (per-MG) and `engage_mode` / `sender_scope` / `ignored_message_policy` (per-MGA) are real, working knobs, but only the per-MGA three are surfaced in the UI. The per-MG one isn't editable anywhere outside the trust-hint code path. There's no "always allow this group" toggle, no "respond only to mentions" toggle on a wired chat.
3. **NanoClaw heritage.** Some of these knobs predate paraclaw; some are paraclaw-era. Reusing NanoClaw shapes where they exist (instead of re-deriving) saves churn and keeps the user-facing language stable.

This doc proposes how to fix all three together. No impl until Aaron reads it.

## 1. Current state — what exists today

### 1a. The four MGA knobs (paraclaw migration 010, replaced legacy `trigger_rules` JSON)

`messaging_group_agents` carries four orthogonal columns governing per-wiring behavior. Migration 010 (`src/db/migrations/010-engage-modes.ts`) split them out of the legacy `trigger_rules` (opaque JSON) + `response_scope` (conflated axis) shape. Behavior at runtime, traced through `src/router.ts`:

| Column | Values | What the router actually does | Code |
|---|---|---|---|
| `engage_mode` | `pattern` \| `mention` \| `mention-sticky` | `pattern`+regex test on text (`'.'` sentinel = always); `mention` requires `event.message.isMention`; `mention-sticky` accepts mention OR an existing per-thread session for this `(agent, mg, thread)` | `evaluateEngage` at `src/router.ts:402-433` |
| `engage_pattern` | regex string, nullable | Used only when `engage_mode='pattern'`. Bad regex fails open. | `src/router.ts:411-418` |
| `sender_scope` | `all` \| `known` | `all` = no-op; `known` = `canAccessAgentGroup(userId, agent_group_id)` must allow. Enforced via the `senderScopeGate` hook the permissions module registers. | `src/modules/permissions/index.ts:175-183` |
| `ignored_message_policy` | `drop` \| `accumulate` | Branch on the *non-engaging* path: `drop` = silently skip; `accumulate` = still write the inbound row to the agent's session DB with `trigger=0`, so context is available next time it does engage | `src/router.ts:355-358` |

Note the API surface (`src/web/routes/channels.ts:8-22`) uses different enum names that translate at the route boundary — `engageMode='all'` collapses to DB `engage_mode='pattern'` + `engage_pattern='.'`; `senderScope='allowlist'` ↔ `sender_scope='known'` and `senderScope='unrestricted'` ↔ `sender_scope='all'` (paraclaw#94 renamed wire-side `'all'` → `'unrestricted'` so the two `SenderScope` unions are literal-disjoint); `ignoredMessagePolicy='silent'` ↔ `ignored_message_policy='accumulate'`. The UI sees the API names. The DB keeps the original ones. The translator is lossy on the `mention` ↔ `mention-sticky` distinction (renders both as `mention`); the `apiToDbPatch` at `src/web/routes/channels.ts:97-127` carefully preserves sticky on round-trip.

### 1b. The MG-level knob

`messaging_groups.unknown_sender_policy` is a single column with three values, set at MG creation (default `'strict'`):

| Value | Router behavior | Source |
|---|---|---|
| `strict` | Drop messages from senders the access gate refuses; record in `dropped_messages` (paraclaw default). | `src/modules/permissions/index.ts:106-115` |
| `request_approval` | Drop, record, AND fire a sender-approval card to admins. Used by the unwired-channel auto-set flow at `src/router.ts:183`. | `src/modules/permissions/index.ts:117-140` |
| `public` | Skip the access gate entirely — anyone in the chat can engage the agent (subject to per-MGA `sender_scope`). | `src/modules/permissions/index.ts:147-151` |

This is the per-MG "always allow" knob Aaron's asking for — it already exists end-to-end. What's missing is a UI surface to flip it.

### 1c. UI surfaces today

- `web/ui/src/routes/ChannelsList.tsx` — per-MGA inline editor. Edits `engageMode`, `engagePattern`, `senderScope`, `ignoredMessagePolicy`, `priority`. **Does not edit `unknown_sender_policy`.**
- `web/ui/src/routes/WireChannelPage.tsx` — wire-creation only. Sets `unknown_sender_policy='strict'` on new MGs (see `src/web/wire-channel.ts:136`). No per-MG detail page.
- `web/ui/src/routes/GroupDetail.tsx` — agent-group detail. Vault attachments + activity. No channel-policy surface.
- Approval card itself — Approve / Ignore (or Approve / Reject) buttons only. No "Approve & always allow this group" shortcut.

### 1d. Approval routing today

`pickApprovalDelivery` in `src/modules/approvals/primitive.ts:104-120`:

```ts
if (originChannelType) {
  for (const userId of approvers) {
    if (channelTypeOf(userId) !== originChannelType) continue;
    const mg = await ensureUserDm(userId);
    if (mg) return { userId, messagingGroup: mg };
  }
}
for (const userId of approvers) {
  const mg = await ensureUserDm(userId);
  if (mg) return { userId, messagingGroup: mg };
}
```

`ensureUserDm` (`src/modules/permissions/user-dm.ts:52-112`) is keyed `(user_id, channel_type)` against `user_dms` — so for an operator with two Telegram bots, this **always returns whichever bot's DM was resolved first**. Aaron's live `user_dms` has exactly one row, pinned to `mg-1777352749546-e4z1rv` (the UnforcedAGI Aaron-DM). Every TechneRobot approval card delivers via UnforcedAGI. That's the bug.

### 1e. Aaron's live state (ground truth, queried 2026-05-02)

Four telegram MGs, three wired:

| MG | Bot | Chat | `unknown_sender_policy` | MGA `engage_mode` / `engage_pattern` | `sender_scope` | `ignored_message_policy` |
|---|---|---|---|---|---|---|
| `mg-…e4z1rv` | UnforcedAGI (8792…425) | Aaron DM (1190…288) | `strict` | `pattern` / `.` | `all` | `drop` |
| `mg-…ihfgeq` | UnforcedAGI | group (-1003…645) | `request_approval` | *(unwired)* | — | — |
| `mg-…ogxhkj` | TechneRobot (8757…201) | Aaron DM (1190…288) | `request_approval` | `pattern` / `.` | `known` | `accumulate` |
| `mg-…90uhi5` | TechneRobot | group (-1002…962) | `request_approval` | `pattern` / `.` | `known` | `accumulate` |

`user_dms` has one row: Aaron → telegram → UnforcedAGI Aaron-DM. So every approval today, regardless of origin bot, goes through UnforcedAGI.

## 2. NanoClaw heritage

Migration 010 explicitly back-compats from NanoClaw's pre-rebirth `trigger_rules` JSON + `response_scope` enum. The five-knob model in section 1a is paraclaw's split of NanoClaw's two — same axis count, cleaner names, no JSON parsing in the hot path. The default values match NanoClaw's: `requiresTrigger=true` ↔ `engage_mode='mention'`; `response_scope='allowlisted'` ↔ `sender_scope='known'`. New users see paraclaw shapes; legacy installs migrated forward.

`unknown_sender_policy` is paraclaw-era — there's no equivalent in NanoClaw migration history. NanoClaw treated unknown senders the same way it treated everyone else (`response_scope` did all the gating). Paraclaw added the MG-level dimension specifically to support `request_approval` (the unwired-channel cascade) without overloading per-MGA `sender_scope`. So the *concept* is paraclaw's; the *axis split* mimics NanoClaw's design instinct (orthogonal columns over JSON blobs).

`user_dms` is also paraclaw-era. NanoClaw single-bot setups never needed bot disambiguation in DM caching — there was only one bot per channel. The `(user_id, channel_type)` PK is a NanoClaw-shaped assumption that paraclaw inherited and never updated when multi-bot landed.

**Implication for Proposal C:** there is no NanoClaw shape to defer to. We're inventing the multi-bot DM cache from scratch. That's fine — the bot dimension is genuinely new.

**Implication for the policy UI:** NanoClaw shipped a CLI-driven config model; there was no per-channel settings page on the host UI. Paraclaw added the web UI and inherited NanoClaw's enum vocabulary, then split it. So we're not deviating from a NanoClaw UI pattern — we're filling a gap that was never built.

## 3. Problem statement (the three asks)

1. **Approval routing follows the bot, not the operator-channel pair.** When an approval originates from an inbound on bot X, the card should reach the approver via bot X if at all possible, falling back gracefully when the approver hasn't DM'd that bot yet.
2. **Per-MG / per-MGA policy is editable from a single intuitive surface.** Operator should be able to flip "always allow this group" (per-MG) and "respond only to mentions" (per-MGA) without remembering enum names or visiting two pages.
3. **The approval card itself carries quick-actions** so deciding "yes, and trust this chat going forward" is one click, not a click-then-navigate.

## 4. Proposals

### 4a. Proposal C — bot-aware approval delivery

**Shape: extend `user_dms` PK to `(user_id, channel_type, bot_id)`.** Drop the row when `bot_id` is empty / null only for channel types that don't have a bot dimension (none today, but the schema must allow it for future channels like email). Migration:

```sql
ALTER TABLE user_dms RENAME TO user_dms_legacy;
CREATE TABLE user_dms (
  user_id            TEXT NOT NULL REFERENCES users(id),
  channel_type       TEXT NOT NULL,
  bot_id             TEXT NOT NULL DEFAULT '',
  messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
  resolved_at        TEXT NOT NULL,
  PRIMARY KEY (user_id, channel_type, bot_id)
);
INSERT INTO user_dms (user_id, channel_type, bot_id, messaging_group_id, resolved_at)
SELECT
  u.user_id,
  u.channel_type,
  COALESCE(
    -- Decode bot_id from the cached MG's v2 platform_id (slot 1 after channel:).
    SUBSTR(mg.platform_id, LENGTH(mg.channel_type) + 2,
           INSTR(SUBSTR(mg.platform_id, LENGTH(mg.channel_type) + 2), ':') - 1),
    ''
  ) AS bot_id,
  u.messaging_group_id,
  u.resolved_at
FROM user_dms_legacy u
JOIN messaging_groups mg ON mg.id = u.messaging_group_id;
DROP TABLE user_dms_legacy;
```

Aaron's existing row would migrate to `bot_id='8792496425'` (UnforcedAGI). TechneRobot DMs become uncached on day one — `ensureUserDm(userId, botId='8757751201')` returns null on first lookup, falls through to the resolver, and re-caches.

**Resolver change:** `ensureUserDm` takes an optional `botId` parameter. When provided, the cache key includes it, and on miss the resolver picks the live adapter for `(channelType, botId)` (we already have `getChannelAdapterByBotId` from PR A). When omitted, behavior is the legacy "any bot" — preserved for callers that don't care which bot delivers.

**Routing change:** `pickApprovalDelivery` takes an optional `originBotId`. The signature becomes:

```ts
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
  originBotId: string | null,
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null>;
```

Resolution order (preserving the channel-tie-break that's already there):

1. Same channel type AND `ensureUserDm(userId, originBotId)` resolves — return that bot's DM.
2. Same channel type AND `ensureUserDm(userId, /* any */)` resolves — return whatever bot (fallback).
3. Different channel type AND `ensureUserDm(userId, /* any */)` resolves — cross-channel fallback (existing behavior).
4. None — `null` (existing behavior).

Step 2 is the load-bearing fallback Aaron asked about: "what if the approver hasn't DM'd this bot yet?" — they get the card on whatever bot they have DM'd, with no extra surface. The card body should still name the origin bot ("New DM to **TechneRobot** in chat XYZ") so the approver isn't confused about which bot wired up. That's a card-rendering tweak in the modules that build cards (`channel-approval.ts:115-122`, `sender-approval.ts`).

**Default for "no DM with anyone":** unchanged. `pickApprovalDelivery` returns null, the requesting module logs and aborts. Static admin-notification channels are out of scope for this doc — would be a separate dimension on the install (`alerts:` channel concept).

**Why this shape over alternatives:**

- *Separate `(user_id, channel_type, bot_id) → mg_id` table:* same row count, less migration churn (no rename), but adds a new table the rest of the code has to learn about. The PK extension is honest about what changed.
- *Compute on the fly from `messaging_groups`:* you'd resolve "what's user X's DM with bot Y" by scanning MGs. Plausible — slot1 of `platform_id` IS the bot_id under v2 — but it loses the resolver semantics (you can't cache a *failure* to find the DM; every lookup re-attempts `openDM`). The cache is load-bearing for Discord rate limits.

### 4b. Per-MG detail page (the granular policy UI)

**Route shape: `/claw/channels/<mga-id>` for the per-wiring surface, `/claw/channels/<mg-id>` for the per-MG surface.** Disambiguate by id prefix (`mg-` vs `mga-`) — both are routable from the existing channels list with a single click.

Why two routes and not one tabbed page: the MG-level knob (`unknown_sender_policy`) is independent of any one wiring; a user can have multiple MGAs on the same MG and the policy applies to all of them. Mounting both on one MGA-keyed URL would mislead.

**`/claw/channels/<mg-id>` (per-MG):**

```
[ telegram ]   ←  channel-type pill
TechneRobot   ←  bot.name
group: Techne Friends · -1002245300962

Who can engage?
  ◉ Strict — only members of this agent group can talk to it
  ◯ Always allow — anyone in this chat can engage
  ◯ Approval-gated — first message from a new sender requires admin OK

[ Wirings to this group ]
   • Techne (priority 0) — engage on @mention; senders: known; ignored: accumulate    [ Edit ]

[ Save ]    [ Cancel ]
```

Three radio choices map directly to `strict | public | request_approval`. Copy is operator-facing — no enum names. The wirings list links each MGA to its detail page.

**`/claw/channels/<mga-id>` (per-MGA, replaces today's inline ChannelsList editor):**

```
[ telegram ]
TechneRobot → Techne agent group

When does it engage?
  ◯ Always — every message in this chat
  ◉ Mentions — when @TechneRobot is tagged
  ◯ Pattern — text matches a regex:  [____________]

Who can talk to it?
  ◯ Anyone in the chat
  ◉ Members only — owner / admin / explicit member

What about messages it ignores?
  ◯ Drop — not seen, not stored
  ◉ Accumulate — stored for context, no reply

Priority [0]   ← higher wins when multiple wirings could match

[ Save ]    [ Remove wiring ]
```

Same fields as today's inline editor, just promoted to a route so the "Edit" button can carry richer copy and there's room to display read-only metadata (created at, agent group folder, MG link).

The existing `ChannelsList` collapses to a list of MGAs that link to per-MGA detail. The per-MGA detail page links up to the per-MG page via a "Group settings →" pill at the top.

### 4c. Quick-action on the approval card

Replace the two-button card with three buttons on cards that originate from `request_approval` policy:

- **Approve** — current behavior (admit sender + replay).
- **Approve & always allow** — admit sender, AND flip the MG's `unknown_sender_policy` to `public`. Tracked in payload, executed by the response handler.
- **Reject** — current behavior.

Three buttons fit comfortably in Telegram and Discord chat-card layouts (they accept arbitrary button rows). The rendering happens in `chat-sdk-bridge` via `ask_question`; we extend the option list and the response handler in `src/modules/permissions/index.ts:handleSenderApprovalResponse` to interpret the new value.

**Out of scope for this doc:** mention-only quick-action on the card (it's per-MGA, requires picking which MGA to update — adds card complexity). Operators who want that can navigate to per-MGA settings; it's a one-tap path from the card's chat link.

## 5. Migration notes

- **Proposal C:** see SQL above. One migration file (`026-user-dms-bot-id.ts`). Backfill is decode-from-platform_id — works because v2 platform_ids are guaranteed by paraclaw#67 PR A. Rollback is "drop the column"; no data loss because the legacy keying is reconstructible (any bot caches just collapse).
- **Per-MG / per-MGA UI:** no schema change. Routes added, list view trimmed, two new components.
- **Quick-actions on card:** no schema change. New option `approve_and_allow` in the sender-approval card payload; handler dispatches on it.

## 6. Open questions for Aaron

1. **Card copy when origin bot ≠ delivery bot.** When step-2 fallback fires (TechneRobot approval delivered via UnforcedAGI because no TechneRobot↔operator DM exists yet), the card needs to clearly say "this is about **TechneRobot** in *Techne Friends*." Should the bot-name come from the agent group name, the bot's display_name, or the platform-level bot username? My instinct: bot username (most identifiable to a Telegram operator who knows `@TechneRobot`).

2. **`Approve & always allow` scope.** Does that flip apply to the *current MG only* (per-chat trust), or also auto-add the sender as a member? The pure interpretation is MG-only; the convenient interpretation is both. I lean MG-only — admitting the sender is what regular Approve already does, and bundling them feels like overreach.

3. **Mention-only on the card.** Section 4c skipped this. Do you want a fourth button on cards, or are operators OK navigating to per-MGA settings to flip mention mode? Three buttons is comfortable; four starts to crowd.

4. **Two routes vs tabbed.** I went with `/channels/<mg-id>` and `/channels/<mga-id>`. If you'd rather have `/channels/<mga-id>` as the only route and surface MG settings as a collapsed accordion, that simplifies routing at the cost of nesting unrelated knobs.

## Phasing for impl (after this doc is signed off)

1. **PR 1: Proposal C migration + resolver + routing change.** Backwards-compatible API (botId optional). One DB migration, two function signatures. Tests: bot-aware ensureUserDm, fallback chain in pickApprovalDelivery.
2. **PR 2: per-MGA detail page.** Route + component. No schema change. Replaces inline editor in ChannelsList.
3. **PR 3: per-MG detail page + UnknownSenderPolicy editor.** Route + component + new PATCH on `/api/channels/mg/:id`.
4. **PR 4: Quick-action card.** Schema-free. Card option list grows, handler grows, tests for each branch.

Each PR is independently shippable; PR 1 unblocks the routing fix Aaron asked about first; PRs 2-4 are pure UX polish over the working data model.
