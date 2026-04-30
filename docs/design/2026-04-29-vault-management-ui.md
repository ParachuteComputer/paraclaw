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

## Admin auth model

paraclaw mints, lists, and revokes vault tokens by calling vault HTTP endpoints directly — no CLI shell-out. Those endpoints are admin-gated (`vault:<name>:admin` scope), so paraclaw needs a credential that carries that scope at request time.

**Chosen approach for v1: forward the operator's hub-issued session JWT.**

Flow:

1. Operator hits `/claw/vaults` in their browser. Their session JWT was issued by the hub at portal sign-in.
2. The first time the operator navigates to a vault management surface, paraclaw checks the JWT for `vault:<name>:admin` on the targeted vault. If absent, paraclaw redirects to `/oauth/authorize?scope=vault:<name>:admin claw:admin …` and the hub prompts the operator to consent. The new JWT comes back via the existing OAuth callback.
3. Subsequent paraclaw → vault calls (mint / list / revoke) attach `Authorization: Bearer <operator-jwt>`. The vault validates against the hub's JWKS (same path it already uses for hub-issued JWTs per parachute-vault#234).

Why this over the alternatives Aaron raised:

- **Pasted setup-time admin token (Option A)** — adds a manual onboarding step ("paste this token") and creates a long-lived secret in paraclaw's secret store. Friction at install; recoverability problem if it leaks (rotate everything that uses it).
- **paraclaw client_credentials grant (Option B)** — paraclaw acquires a JWT via DCR-issued credentials. More plumbing (paraclaw must register a hub client, store its client_secret, refresh JWTs). Audit trail loses the operator identity — actions show as "paraclaw" not "alice@example.com". Worth doing if a non-UI surface ever needs vault admin (cron job, webhook, etc.); not needed for v1, where every admin call originates from an operator click.
- **Hub-issued JWT scoped to the operator's session (Option C, chosen)** — reuses the existing OAuth flow, attributes actions to the operator, expires automatically with the session, revoking the session revokes vault admin access. The one cost is the consent prompt the first time per vault; that's a feature for the security-conscious operator.

Migration path: if multi-tenant cloud later needs a non-operator-bound caller (Aaron's planned cloud Tier 1/2 split), we add Option B alongside C — both auth modes can coexist on the vault side because they're both hub-issued JWTs differentiated only by the `sub` claim.

## Refresh story

The 30s in-process cache in `src/web/hub-discovery.ts:36` is the right default for the picker (saves a hub round-trip on every group-detail page load), but the UI must be able to bypass it on demand:

- **Explicit refresh button** on `/claw/vaults` calls a new endpoint `POST /api/vaults/refresh` that runs `clearHubDiscoveryCache()` + `fetchHubVaults()` + responds with the fresh list. Auth: `claw:read`.
- **Implicit refresh** after a successful mint / revoke — the affected vault's tokens table re-fetches; nothing else needs invalidation since cache is keyed at vault-list level.

That covers paraclaw#37's third suspect root (now closed; root was vault-side `cmdCreate` not calling `upsertService`, fixed in vault#208 — but the refresh button is good UX regardless).

## Token mint flow

1. Operator clicks `Mint` on `/claw/vaults/<name>`.
2. UI shows form (label + scopes + expires).
3. Submit → `POST /api/vaults/<name>/tokens` (new paraclaw endpoint, see § API surface) → paraclaw forwards the operator's hub JWT (see § Admin auth model) and POSTs `<vaultUrl>/tokens` directly. No CLI shell-out.
4. Response from vault: `{ token: "pvt_…", label, scopes, id, created_at }`. paraclaw passes plaintext through to the browser unmodified.
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
| `clearHubDiscoveryCache()` | Cache buster | `src/web/hub-discovery.ts:46` |

The existing `mintVaultToken` shell-out at `src/web/server.ts:144` will be deleted once the new HTTP-based mint endpoint lands; the new flow replaces it everywhere.

### Vault-side, already in place

| Endpoint | Purpose | Source |
|---|---|---|
| `POST /vault/<name>/tokens` | Mint pvt_* token, returns plaintext once | `parachute-vault/src/tokens-routes.ts` |
| `GET /vault/<name>/tokens` | List tokens (metadata only) | same |
| `DELETE /vault/<name>/tokens/<id>` | Revoke; idempotent (200 even if id unknown — no enumeration leak) | same |

All three are admin-gated (`vault:<name>:admin` scope on the bearer JWT). paraclaw calls them with the operator's session JWT in the `Authorization: Bearer …` header.

### New paraclaw endpoints to add

Each endpoint validates the operator's session JWT for `claw:*` scope at the paraclaw boundary, then forwards the same JWT to the vault. The vault validates `vault:<name>:admin` independently — paraclaw doesn't downgrade or re-issue.

| Endpoint | paraclaw-side scope | Forwards to vault? | Purpose |
|---|---|---|---|
| `POST /api/vaults/refresh` | `claw:read` | No | Clear discovery cache + re-fetch |
| `GET /api/vaults/:name` | `claw:read` | No | Detail = listing entry + attached-groups computation |
| `GET /api/vaults/:name/tokens` | `claw:admin` | `GET /vault/:name/tokens` | Proxy + merge attached-to-group from `parachute.json` walk |
| `POST /api/vaults/:name/tokens` | `claw:admin` | `POST /vault/:name/tokens` | Mint, return plaintext once |
| `DELETE /api/vaults/:name/tokens/:id` | `claw:admin` | `DELETE /vault/:name/tokens/:id` | Revoke; warn UI if id is currently attached |
| `POST /api/groups/:folder/detach-vault` (extend) | `claw:write` (+ `vault:<name>:admin` if revoke=true) | Conditional DELETE on revoke=true | Add `revokeToken: boolean` body param |

The vault name in the path is the canonical routing key end-to-end — browser → paraclaw → vault. No additional plumbing needed to pick the vault.

### Vault-side gaps (none blocking)

- No `last_used_at` on tokens today. Nice-to-have for the table; optional. Tracked separately if Aaron wants it.
- No bulk-revoke endpoint. Not needed for v1 — revoke-then-rotate is per-token.

## Phasing

Single PR for the doc (this one). Implementation likely splits into 3 PRs:

1. **Backend** (~150 LOC): the five new paraclaw endpoints (refresh + detail + tokens proxy GET/POST/DELETE) + `detach-vault revokeToken` param + JWT-forwarding helper. Delete the old `mintVaultToken` shell-out and its callers. Tests for the proxy paths + the attached-to derivation + the consent-prompt redirect on missing `vault:<name>:admin` scope.
2. **Frontend index** (~250 LOC): `/claw/vaults` route, vault list table, refresh button.
3. **Frontend detail + mint flow** (~400 LOC): `/claw/vaults/<name>` route, tokens table, attached-groups table, mint form + one-time copy card, detach-modal with revoke option, group-page cross-links.

Order: 1 → 2 → 3 (frontend can stub the backend in dev mode but ships need real endpoints).

## Detach revoke default

Aaron landed on **status-quo + nearby revoke** (paraclaw#36 closed today): keep current `Detach (keep token)` as the default behavior, but surface revoke prominently in this new page. The detach-modal's two-button shape (Keep / Detach + revoke) realizes that — the operator sees both options at decision time, with neither hidden behind a CLI command.

This avoids the "silent revoke wedges unrelated callers" footgun while making the secure default reachable in one click.

## Open questions — resolved

All five Aaron weighed in on; recording the calls here for future-me.

1. **~~Vault HTTP vs CLI shell-out.~~** **Decided: HTTP.** See § Admin auth model. paraclaw forwards the operator's hub JWT to the vault directly; the existing `mintVaultToken` shell-out gets deleted once the new endpoints land.

2. **Token attachment derivation accuracy.** O(groups) walk per page load. **Punt to a follow-up issue if profiling shows it.** Confirmed.

3. **~~Multi-vault mint defaults.~~** **Dissolves under HTTP.** The vault name lives in the URL path (`/api/vaults/:name/tokens`) and is forwarded one-to-one to `<vaultUrl>/tokens`. No "default vault" disambiguation needed.

4. **Hub-issued JWT bindings.** Out of scope for v1. Confirmed.

5. **Refresh button auth.** `claw:read`. Confirmed.

## Dependencies

**hub#141 — `buildWellKnown` emitted one vault per service entry instead of one per path.** Tracked on the hub side; the multi-vault picker and the `/claw/vaults` index page rely on the well-known returning multiple vaults. Phase 1 backend work can land independently (the new paraclaw endpoints don't depend on the well-known shape — vault name comes via URL path), but phase 2 should verify hub#141 has shipped before relying on multi-vault discovery.

---

Ready for review. Once approved, I'll scope the three implementation PRs and start with backend.
