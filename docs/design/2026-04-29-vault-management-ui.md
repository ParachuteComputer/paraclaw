# Vault management UI

**Status:** Design proposal · 2026-04-29 · paraclaw#38

Aaron, while testing vault attach/detach (paraclaw#36/#37/#38): *"vault UI feels like a high priority. when we give people a host instance, we don't want them to have to use cli at all."*

This doc proposes a first-class `/claw/vaults` admin surface that replaces "use the CLI" as the answer to: "what vaults do I have? which token is attached where? how do I rotate? how do I detach + revoke?"

## Goals

- **Discover** — see every vault registered with the hub, in one place, without opening a terminal.
- **Inspect** — for any vault, see all minted tokens (label, scopes, attached-to, last-used), without ever exposing plaintext.
- **Mint** — create a new token with a chosen scope set, copy plaintext exactly once, save the assignment.
- **Rotate / revoke** — revoke any token by id; revocation is one-way and obvious.
- **Attach / detach** — attach a vault token to an agent group, detach with explicit choice between "keep token" (re-attach later) and "detach + revoke" (security default for retired groups).
- **Refresh** — bypass the 30s discovery cache when the operator just installed a vault.

## Non-goals

- Vault-side admin (creating vaults, configuring webhooks, importing Obsidian) — that stays in `parachute-vault` CLI / vault config UI. The paraclaw page is **agent-group-facing**: which vaults can my agents reach, with what permissions.
- Migrating away from the `pvt_*` token model. Hub-issued JWT scope-narrowing (#234, just merged) is the future, but pvt_* tokens remain the storage shape for direct-attached vaults; the UI accepts both.
- Backups, snapshotting, or vault data inspection (that's the vault's web UI, not paraclaw's).

## What lives where

### `/claw/vaults` — index page

Table, one row per vault from `<hubOrigin>/.well-known/parachute.json`:

| Vault name | URL | Version | Tokens | Attached groups | Actions |
|---|---|---|---|---|---|
| `default` | `https://hub.tail.../vault/default` | `0.4.7` | `3` | `2` | `▸ Manage` |
| `work` | `https://hub.tail.../vault/work` | `0.4.7` | `1` | `1` | `▸ Manage` |

Header controls: `[Refresh from hub]` button (clears `clearHubDiscoveryCache()` + re-fetches). Empty state when zero vaults: link to "How to install a vault" (parachute-vault README).

### `/claw/vaults/<name>` — detail page

Three sections:

**1. Tokens** — table from `GET /vault/<name>/tokens` (vault REST, admin-gated):

| Label | Scopes | Attached to | Created | Last used | Actions |
|---|---|---|---|---|---|
| `claw-personal` | `vault:read vault:write` | `personal` | 2026-04-15 | 2026-04-29 | `Revoke` |
| `claw-research` | `vault:read` | `research` | 2026-04-20 | 2026-04-28 | `Revoke` |
| `claw-orphan` | `vault:admin` | *(none)* | 2026-04-10 | *(never)* | `Revoke` |

Plaintext is **never** rendered after mint — the table shows label + scopes + group attachments + activity timestamps only. "Attached to" is computed paraclaw-side by walking each agent group's `parachute.json` and matching `tokenLabel` → token row.

`Revoke` is a confirm-modal action. Confirmation copy explicitly says revocation is one-way.

**2. Attached groups** — table of agent groups currently using this vault:

| Group | Scope | Token label | Detach |
|---|---|---|---|
| `personal` | `vault:write` | `claw-personal` | `Detach…` |
| `research` | `vault:read` | `claw-research` | `Detach…` |

`Detach…` opens a modal with two buttons: `Keep token` (current behavior — `parachute.json` removed, `container.json` MCP entry removed, token stays live in vault) or `Detach + revoke` (the above + DELETE on the vault token endpoint). Secondary action button order is deliberate: **keep token is the default-cursor button**, since silent revoke can wedge unrelated callers; revoke is opt-in but one click away. (See § Detach revoke default below.)

**3. Mint new token** — form:

- **Label** — text input. Default `claw-<group-or-purpose>`. Validation: alphanumeric + dashes, 64 char max.
- **Scopes** — multiselect with three rows:
  - `vault:read` (read notes, search, follow links)
  - `vault:write` (read + create / update / delete notes)
  - `vault:admin` (write + token mgmt + vault config)
  - …or one row per **named scope** if the vault is hub-routed: `vault:<name>:<verb>` (see § Scope formats below).
- **Expires** — date picker, optional. Default never.
- Submit → POST mint → server displays plaintext **once** in a copy-with-confirmation card, with a button to assign-to-group inline (skips a round-trip back to `/claw/groups/<id>/vault`).

## Refresh story

The 30s in-process cache in `src/web/hub-discovery.ts:36` is the right default for the picker (saves a hub round-trip on every group-detail page load), but the UI must be able to bypass it on demand:

- **Explicit refresh button** on `/claw/vaults` calls a new endpoint `POST /api/vaults/refresh` that runs `clearHubDiscoveryCache()` + `fetchHubVaults()` + responds with the fresh list. Auth: `claw:read`.
- **Implicit refresh** after a successful mint / revoke — the affected vault's tokens table re-fetches; nothing else needs invalidation since cache is keyed at vault-list level.

That covers paraclaw#37's third suspect root (now closed; root was vault-side `cmdCreate` not calling `upsertService`, fixed in vault#208 — but the refresh button is good UX regardless).

## Token mint flow

1. Operator clicks `Mint` on `/claw/vaults/<name>`.
2. UI shows form (label + scopes + expires).
3. Submit → `POST /api/vaults/<name>/tokens` (new paraclaw endpoint, see § API surface) → paraclaw shells out to `parachute vault tokens create --vault <name> --scope <s> --label <l>` (extending the existing `mintVaultToken` shell-out at `src/web/server.ts:144` to take a `--vault` arg) OR directly POSTs to `<vaultUrl>/tokens` if we'd rather avoid the CLI shellout (see § Open question 4).
4. Response: `{ token: "pvt_…", label, scopes, id, created_at }`.
5. UI renders a one-time copy-card. Plaintext is held in component state, never persisted in a state store, never echoed back to a server log.
6. Operator either copies-and-closes (token saved server-side via the mint, plaintext never touches the disk) or clicks `Attach to group…` which lets them pick a target group inline; this triggers `POST /api/groups/<folder>/attach-vault` with the freshly-minted token (saving the round-trip).

If the operator dismisses without copying: there is no recovery. The token is stored hashed in the vault's token store; plaintext is gone. UI surfaces a yellow banner: *"Token minted but not copied. Revoke it now and mint a new one if you need access."*

## Token rendering rules

Inviolable across every surface:

| Field | Shown? | Notes |
|---|---|---|
| `pvt_…` plaintext | Once, on mint | Held in component state, copy-button only |
| Token id (`t_…`) | Yes, always | Used for revoke-by-id |
| Label | Yes, always | Operator-chosen identifier |
| Scopes | Yes, always | Resolved + sorted; legacy `permission=full` displayed as `vault:read vault:write` (legacy bridge per `parachute-vault/src/scopes.ts:24`) |
| `created_at` / `last_used_at` | Yes, always | If vault exposes them; relative time (`2 days ago`) |
| Attached-to group | Yes, derived | Walk every group's `parachute.json`, match `tokenLabel` |

Ban list: never log plaintext, never send plaintext to telemetry/sentry, never include plaintext in 4xx error bodies, never round-trip through localStorage / sessionStorage.

## Relationship to existing `/groups/<id>/vault`

Keep it. The per-group attach/detach UI lives at `/claw/groups/<folder>` (`src/web/server.ts:478` → `/attach-vault`, `:562` → `/detach-vault`) and answers a *different* question: "I'm configuring this group; what vault should it talk to?" That's the right entry point when adding a new group.

The new `/claw/vaults` page answers the inverse: "I'm auditing/managing my vaults; what's attached where?" Cross-link both ways:

- Group detail page → "Manage vault" link to `/claw/vaults/<name>` (when attached).
- Vault detail page → group rows → click → `/claw/groups/<folder>`.

The detach modal on the vault page offers the same operation as the group page's detach button, plus the explicit "+ revoke" option that the group page doesn't currently surface (see § Detach revoke default).

## Scope formats

Per the just-merged scope work (`parachute-vault/src/scopes.ts`), two shapes coexist:

- **Broad** `vault:<verb>` — used by `pvt_*` tokens (vault-pinned by storage). Three values: `vault:read`, `vault:write`, `vault:admin`.
- **Narrowed** `vault:<name>:<verb>` — used by hub-issued JWTs. Required (broad scopes on JWTs are rejected). The vault name is the same name shown in `/claw/vaults`.

UI treatment:

- **pvt_* tokens** (the case paraclaw mints today): the scope picker is the broad shape — three checkboxes.
- **JWT-bound attachments** (hub-routed grants from the OAuth flow, when that lands for vault — currently it's `pvt_*` only): the picker presents narrowed-shape scopes, defaulted to the vault the form is on. Other-vault scopes are not selectable from this surface.
- **Legacy back-compat**: tokens minted before scope landing have `permission` instead of `scopes`. We display them via the `legacyPermissionToScopes` mapping (`vault:read` for read; `vault:read vault:write` for full). Clearly badge them as "Legacy — re-mint at your earliest convenience" since the legacy shim is documented as one-release-only.

## API surface paraclaw needs

### Already in place

| Endpoint | Purpose | Source |
|---|---|---|
| `GET /api/vaults` | List vaults from hub well-known | `src/web/server.ts:357` |
| `POST /api/groups/:folder/attach-vault` | Attach vault to group (mint or use existing token) | `:478` |
| `POST /api/groups/:folder/detach-vault` | Detach (no revoke) | `:562` |
| `mintVaultToken({ scope, label })` | Shells out `parachute vault tokens create` | `:144` |
| `clearHubDiscoveryCache()` | Cache buster | `src/web/hub-discovery.ts:46` |

### Vault-side, already in place (paraclaw will call HTTP, hub will proxy)

| Endpoint | Purpose | Source |
|---|---|---|
| `POST /vault/<name>/tokens` | Mint pvt_* token, returns plaintext once | `parachute-vault/src/tokens-routes.ts` |
| `GET /vault/<name>/tokens` | List tokens (metadata only) | same |
| `DELETE /vault/<name>/tokens/<id>` | Revoke; idempotent (200 even if id unknown — no enumeration leak) | same |

All three are admin-gated (`vault:admin` scope).

### New paraclaw endpoints to add

| Endpoint | Scope | Purpose |
|---|---|---|
| `POST /api/vaults/refresh` | `claw:read` | Clear discovery cache + re-fetch |
| `GET /api/vaults/:name` | `claw:read` | Detail = listing entry + attached-groups computation |
| `GET /api/vaults/:name/tokens` | `claw:admin` | Proxy to vault `GET /vault/:name/tokens`; merge in attached-to-group derived from `parachute.json` walk |
| `POST /api/vaults/:name/tokens` | `claw:admin` | Mint via shell-out (extend `mintVaultToken` to take `--vault`) or proxy POST |
| `DELETE /api/vaults/:name/tokens/:id` | `claw:admin` | Proxy to vault DELETE; warn UI if the id is currently attached to a group |
| `POST /api/groups/:folder/detach-vault` (extend) | `claw:write` | Add `revokeToken: boolean` query param; when true, also DELETE the vault token after detach |

Open question: should paraclaw call the vault HTTP endpoints directly (bypassing CLI), or keep shelling out? See § Open questions.

### Vault-side gaps (none blocking)

- No `last_used_at` on tokens today. Nice-to-have for the table; optional. Tracked separately if Aaron wants it.
- No bulk-revoke endpoint. Not needed for v1 — revoke-then-rotate is per-token.

## Phasing

Single PR for the doc (this one). Implementation likely splits into 3 PRs:

1. **Backend** (~150 LOC): the five new paraclaw endpoints + refresh + per-vault token proxy + `mintVaultToken` `--vault` extension + `detach-vault revokeToken` param. Tests for the proxy + the attached-to derivation.
2. **Frontend index** (~250 LOC): `/claw/vaults` route, vault list table, refresh button.
3. **Frontend detail + mint flow** (~400 LOC): `/claw/vaults/<name>` route, tokens table, attached-groups table, mint form + one-time copy card, detach-modal with revoke option, group-page cross-links.

Order: 1 → 2 → 3 (frontend can stub the backend in dev mode but ships need real endpoints).

## Detach revoke default

Aaron landed on **status-quo + nearby revoke** (paraclaw#36 closed today): keep current `Detach (keep token)` as the default behavior, but surface revoke prominently in this new page. The detach-modal's two-button shape (Keep / Detach + revoke) realizes that — the operator sees both options at decision time, with neither hidden behind a CLI command.

This avoids the "silent revoke wedges unrelated callers" footgun while making the secure default reachable in one click.

## Open questions

1. **Vault HTTP vs CLI shell-out.** `mintVaultToken` shells out to `parachute vault tokens create` today. For the new endpoints we have two paths: (a) extend the shell-out — minimal change, but needs `--vault <name>` support in the vault CLI (does the CLI accept that today? worth verifying); (b) bypass the CLI and POST directly to `<vaultUrl>/tokens` from paraclaw — fewer process spawns, but paraclaw needs an admin token to *the vault* to mint other tokens, which is the bootstrap problem. **Lean (a)** for the v1 MVP — the CLI is already authenticated against the vault's owner credentials.

2. **Token attachment derivation accuracy.** Building "attached to group X" by walking every `parachute.json` is O(groups) per page load. Fine at <100 groups; if multi-tenant cloud needs scale, we'd want an index. **Punt to a follow-up issue if it shows up in profiling.**

3. **Multi-vault mint defaults.** When the operator is on `/claw/vaults/work`, the mint form should default to *that* vault's name. But `mintVaultToken` was written assuming a single default vault — the path through `/api/groups/:folder/attach-vault` doesn't currently take a `vault` argument. The new mint endpoint addresses this directly; the existing attach endpoint either needs `body.vaultName` (preferred) or stays default-only and the new flow on `/claw/vaults/:name` does mint+attach in one POST.

4. **Hub-issued JWT bindings.** When a future surface lets operators grant a hub-issued JWT for vault access (instead of a pvt_*), the UI needs a third "tokens" sub-table: "JWT grants" (label, audience, scopes, expires). **Out of scope for v1** — design noted, schema-extensible.

5. **Refresh button auth.** `POST /api/vaults/refresh` is logically a write (mutates the cache) but doesn't write user data. Gating on `claw:read` is more consistent (any reader can trigger a re-fetch); on `claw:write` is more conservative. **Lean `claw:read`** since the worst case is one extra hub round-trip.

---

Ready for review. Once approved, I'll scope the three implementation PRs and start with backend.
