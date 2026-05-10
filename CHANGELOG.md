# Changelog

All notable changes to parachute-agent will be documented in this file.

## [0.1.4-rc.2] - 2026-05-10

### Added

- **`uiUrl: "/agent"` in `.parachute/module.json` (parachute-patterns#52).** Adopt the [`module-ui-declaration`](https://github.com/ParachuteComputer/parachute-patterns/blob/main/patterns/module-ui-declaration.md) convention — services declare their user-facing UI URL in `module.json`, and hub's discovery page renders one tile per declaring service. Agent's UI (combining run + config + admin) lives at `/agent`, so the field mirrors the existing `paths[0]`. Pairs with `parachute-notes` (already declares `uiUrl: "/notes"`); vault and scribe stay absent until each grows a UI surface. Step 2 of the cross-repo adoption sequence (patterns convention defined → modules declare → hub consumer-side reads). Backwards-compatible: hub before its consumer-side update simply ignores the new field; nothing else in the agent repo reads it today.

## [0.1.4-rc.1] - 2026-05-10

### Added

- **Hub-revocation-list enforcement on hub-issued JWTs (parachute-hub#212 Phase 4).** Adopt `@openparachute/scope-guard@^0.2.1`, which fetches `<hub-origin>/.well-known/parachute-revocation.json` (60s cache, fail-closed on cold start, fail-open with last-good cache on transient outage), and rejects any JWT whose `jti` appears on the list. `src/web/auth.ts:validateHubJwt` now delegates to `guard.validateHubJwt` from a process-wide `ScopeGuard` instance bound to agent's `getHubOrigin()` resolver — keeping the existing `PARACHUTE_AGENT_HUB_ORIGIN` → `PARACLAW_HUB_ORIGIN` (legacy) → `PARACHUTE_HUB_ORIGIN` → loopback precedence intact. The `authenticate()` seam every `/api/*` handler runs through is unchanged for callers; signature/issuer/audience/expiry rejections preserve their existing 401 messages bit-for-bit. Re-exports `resetRevocationCache()` alongside `resetJwksCache()` for test-clean lifecycle. Aligns agent with vault (PR #281) and scribe (PR #43) so the three resource servers share one trust kernel — no silent drift on the worst place to drift. Coverage: existing 23 hub-JWT tests preserved as migration regression; 3 new tests pin the scope-guard wiring + response-shape contract (happy path, revoked rejection, cold-start unreachable).

- **Operator-debuggability fix: sanitized client messages on revocation rejections; full diagnostics routed to server-side audit log.** When `authenticate()` catches a `HubJwtError` with `code === "revoked"` or `code === "revocation_unavailable"`, it logs the full `err.message` (which carries the `jti` for `revoked`, and the implementation-detail phrasing "no last-good cache" for `revocation_unavailable`) via `console.warn` for the audit trail, then returns a code-shaped sanitized message to the unauthenticated caller — `"token has been revoked"` or `"token cannot be validated: revocation list unavailable"`. The jti never leaks in the response body; the operator chasing a 401 in production logs can still correlate to which token was retired. Inheritable pattern across vault/scribe/agent: *all revocation-related codes get sanitized client messages, full detail lives in server-side audit logs*. Other `HubJwtError` codes (signature, audience, expired, etc.) carry generic messages and are forwarded as-is — only the two revocation-flavored codes need the sanitization seam.

### Changed

- **`pnpm-workspace.yaml`: first `minimumReleaseAgeExclude` entry, narrowly scoped.** Aaron-approved exclusion of `@openparachute/scope-guard@0.2.1` from the 3-day registry-age gate. The gate exists to mitigate unknown-upstream supply-chain risk; that risk doesn't apply to a parachute-org package Aaron publishes himself, so this carve-out unblocks Phase 4 cascade timing without weakening the policy. Pinned exact version — any future scope-guard publish goes through the gate by default. Pattern-establishing rationale comment lives in `pnpm-workspace.yaml`.

### Tests

- **Hub fixture extended to serve `/.well-known/parachute-revocation.json`.** The existing `startJwksFixture` (renamed `startHubFixture`) now serves both well-known endpoints from one `node:http` server with mutable `setRevoked: (jtis: string[]) => void` and `setRevocationFails: (fails: boolean) => void` setters per-test. Pattern mirrors scribe's `auth-hub-jwt.test.ts` (PR #43) so the three RS adopters share a fixture shape; agent's twist is `node:http` + vitest in place of `Bun.serve` + bun:test. Empty revocation list is the default in `beforeEach`, which is what every pre-Phase-4 test assumes — no per-test fixture mutation needed in the migration regression set.

- **Three new revocation-enforcement integration tests in `src/web/auth.test.ts`.** Happy-path regression (signed valid JWT not in revocation list → 200 + claims); revoked-jti rejection (sanitized 401 message; `vi.spyOn(console, "warn")` asserts the audit log carries the full diagnostic with `jti`); cold-start unreachable (revocation server 503s; sanitized 401; spy asserts the implementation-detail "no last-good cache" phrase stays in the audit log only). Skips the explicit fail-open-with-last-good case — scope-guard's own unit suite covers the cache mechanics.

## [0.1.3] - 2026-05-09

### Added

- **Container skill: `scribe` (paraclaw#142).** Doc-only skill at `container/skills/scribe/SKILL.md` that teaches the in-container agent how to call parachute-scribe over its REST API using `curl` and a pre-injected `SCRIBE_TOKEN`. Operator mints a hub-issued JWT (or shared-secret token) carrying `scribe:transcribe`, drops it into `/agent/secrets`, and the secret store injects it as an env var at session spawn. Documents the real scribe API surface — `POST /v1/audio/transcriptions` (multipart `file` + optional `cleanup` / `context`), `GET /v1/models`, `GET /health`, `GET /.parachute/info` — verified against `parachute-scribe/src/`. No async-job polling (scribe is synchronous), no `language` form field, no URL ingest. Skills auto-mount via `container-runner.ts:syncSkillSymlinks` when `skills === 'all'` (the default), so adding the directory is the entire ship on the skill side. Architectural reframe parking paraclaw#100 (per-agent-group scribe-MCP attach): for 3–4 leaf operations over HTTP with a Whisper-shape response, skill+secret+REST is lighter than building an MCP server. Pairs with parachute-hub's parallel `parachute auth mint-token` work — operators get a CLI path to mint the JWT.

- **Bare `PORT` env tier in `resolvePort()` to match scribe's 4-tier ladder (paraclaw#147).** `src/web/server.ts` now resolves its listen port from a 4-tier chain — `services.json` agent entry > `PARACHUTE_AGENT_WEB_PORT` (or legacy `PARACLAW_WEB_PORT`) > **bare `PORT` env (new)** > canonical `1944` — matching `parachute-scribe/src/port-resolve.ts`'s 4-tier ladder ordering. The bare `PORT` tier is the generic PaaS / hub-injection path: `parachute install parachute-agent` writes `PORT=<n>` into the service-managed `.env`, and now agent honors that value when no agent-specific override is set and the manifest has no entry yet (first-run / fresh install). Specific env wins over bare `PORT` so an operator's deliberate `export PARACHUTE_AGENT_WEB_PORT=…` isn't silently overridden by a stale `.env` line; manifest still beats every env tier (the paraclaw#145 invariant). The 4-tier ladder is the canonical service-side shape documented in `parachute-patterns/patterns/cli-as-port-authority.md` (patterns#45) — closing this gap lets the patterns doc cleanly say "scribe + agent both implement," instead of qualifying the symmetry. Coverage: 7 new tests in `src/web/server-port.test.ts` covering the four spec cases (specific-env beats `PORT`; `PORT`-as-fallback when only `PORT` is set; default when nothing is set; manifest beats both env tiers) plus empty-string + non-numeric + out-of-range `PORT` rejection so a misconfigured `.env` surfaces loudly instead of degrading to default. Bind-error hint extended with a `port` source case so EADDRINUSE diagnostics name `PORT` explicitly when bare `PORT` was the resolved tier. Companions: parachute-scribe#41 (the symmetry target); parachute-agent#146 (the 3-tier predecessor we're extending).

### Fixed

- **Inject `PARACHUTE_HUB_ORIGIN` into every spawned container with loopback rewritten to `host.docker.internal` (paraclaw#142 review fold).** Pre-fix, `PARACHUTE_HUB_ORIGIN` was read on the host but never pushed into containers via `buildContainerArgs`, so any skill (or future module) that tried `curl ${PARACHUTE_HUB_ORIGIN}/...` from inside the container hit `undefined` or — worse — silently used a hardcoded `http://127.0.0.1:1939` fallback that resolves to the container's own loopback, not the host. New helper `getHubOriginForContainer()` composes `getHubOrigin()` (the host's resolution chain) with `localhostToContainerHost()` (already shipped for MCP URLs in `vault-mcp.ts`) so loopback origins get rewritten to `host.docker.internal`, and tailnet/LAN origins pass through unchanged. The rewrite mirrors the path already in place for HTTP-MCP URLs in `container.json` — same loopback-to-host-gateway problem, same solution. Without this, the new scribe skill (and any future skill that reaches a Parachute service via the hub-aggregated mount) would fail silently on every install that doesn't set `SCRIBE_URL` explicitly. 5 new tests in `src/container-runner.test.ts` cover loopback rewrite, localhost rewrite, tailnet pass-through, default fallback (no env set), override-via-`PARACHUTE_AGENT_HUB_ORIGIN`, and trailing-slash hygiene.

- **Boot-time port resolution respects `services.json`; bind failure is now loud (paraclaw#145).** Pre-fix, `src/web/server.ts` resolved its listen port from a single source — env var or hardcoded `1944` — and `upsertService` re-stamped that port into `~/.parachute/services.json` on every boot. Operator-edited `agent.port` values were silently reverted on the next start, and a port collision with scribe (which also raced for 1944 in scribe v0.4.0, parachute-scribe#40) produced a silent EADDRINUSE that hub-side `parachute start agent` did not surface. New three-tier resolution in `resolvePort()`: existing `services.json` agent entry > `PARACHUTE_AGENT_WEB_PORT` (or legacy `PARACLAW_WEB_PORT`) > default `1944` — symmetric with parachute-scribe#41 so operators see one rule across both modules. The default is preserved as the canonical-port floor; what changed is the agent now reads the manifest before clobbering it. Manifest write rule also tightened: when an entry already exists, the agent re-stamps its metadata (version, paths, health, displayName, installDir) but writes back the existing port unchanged — so an env-var override that points the agent at 1947 doesn't permanently rewrite services.json the way it used to. Bind error path: a new `server.on('error')` handler logs the named conflict (`port`, `host`, `portSource`, actionable hint) and `process.exit(1)`s, so the supervisor (launchd / systemd / hub) sees a failure instead of a half-booted host process. Coverage: 9 tests in `src/web/server-port.test.ts` (services.json > env > default ordering, the `services.json wins over env` regression case mirroring scribe#41, legacy `PARACLAW_WEB_PORT` accept, non-numeric env reject, out-of-range env reject, empty-string env treated as unset, EADDRINUSE event-shape pin), plus 4 in `src/web/services-manifest.test.ts` for the new `readService(name)` accessor. Companions: parachute-hub#195 adds hub-side validation/warnings for collisions; parachute-scribe#41 lands the same fix shape on scribe.

- **Inverted port-resolution precedence to `services.json > env > default`, mirroring parachute-scribe#41 (paraclaw#146 review fold).** Initial cut of paraclaw#146 had `env > services.json > default`, which inverted the intended fix: the bug class motivating both PRs is *stale env clobbers operator-set manifest values* (hub's port-assigner stamped `PORT=1944` once and the env stayed pinned across boots). With env winning, an operator's `agent.port = 1947` edit was silently reverted by the stale env on the next start. With `services.json` winning, the operator's pin holds across restarts — and the precedence is now symmetric with scribe, so the rule "the manifest is the source of truth, env is a first-run fallback" reads consistently across both modules. Default stays `1944` (agent's canonical slot); only the relative ordering of services.json vs env changed. Test fixture updates: the `env wins over services.json` positive case is replaced by a `services.json wins over env` regression test; the bare env path moves to a `no manifest entry → env wins` assertion.

- **Tighten port parser to reject non-integer values, matching scribe's `parsePort` strictness (paraclaw#148 review fold).** Both env tiers in `resolvePort()` (`PARACHUTE_AGENT_WEB_PORT` / `PARACLAW_WEB_PORT` and bare `PORT`) previously guarded with `Number.isFinite(n)` only — so a fractional string like `PORT=1.5` would coerce to a finite-but-non-integer `1.5`, slip past port resolution, and crash deeper in `server.listen()` with an error that didn't name the env var. Scribe's `parsePort` (`parachute-scribe/src/port-resolve.ts`) uses an integer regex `/^[1-9]\d{0,4}$/` for string input, which naturally rejects fractional. Agent now uses `Number.isInteger(n)` in both env-tier guards — same effect (integer-only, ≥1, ≤65535), one-line change per tier. Closes the parsing-asymmetry gap that pre-dated this PR (it applied to the specific-env tier on `0.1.3-rc.2` too, not just the new `PORT` tier added here) so agent's parser is now literally as strict as scribe's, not just shaped similarly. Coverage: 2 new tests in `src/web/server-port.test.ts` (one per env tier) pinning `PORT=1.5` / `PARACHUTE_AGENT_WEB_PORT=1.5` to throw with the env-name-prefixed error message. No behavior change for any value scribe would have accepted.

## [0.1.2] - 2026-05-05

The first patch series after the 0.1.0 paraclaw → parachute-agent rename. Fourteen iterative cuts (rc.1 through rc.14) collapsed into one stable. No operator action required: every change is either a transparent fix, an additive UI affordance, or a behind-the-scenes test addition.

### Fixed

- **Master-key migration: detect the both-exist split-state explicitly.** `migrateMasterKeyLocation` previously silent-no-op'd when both `<PARACHUTE_DIR>/claw/master.key` and `<PARACHUTE_DIR>/agent/master.key` existed — masking the case where an earlier 0.1.x boot generated a fresh key at the new path before the legacy was copied (so encrypted secrets sealed under the legacy key became undecryptable). The function now logs a `warn` with both paths and copy-pasteable recovery commands. Standalone scripts (`init-cli-agent`, `init-first-agent`, `seed-discord`) that ran `migrateCentralDbLocation` now also run `migrateMasterKeyLocation` before opening the DB, so a script-driven first touch no longer skips the key copy. Also: SPA browser title `<title>Paraclaw</title>` → `<title>Parachute Agent</title>` and two stale GitHub repo links pointing at the renamed-from `paraclaw` URL — small follow-ups to the 0.1.0 brand sweep that landed in the same cut.

- **Auto-retag the per-install container image when `INSTALL_SLUG` shifts (paraclaw#114).** `INSTALL_SLUG = sha1(process.cwd())[:8]`, so an operator dir-rename (the trigger that exposed this: `mv paraclaw parachute-agent`) flips the slug. Previously-built images carried the old slug; new container spawns went out under the new slug; `docker run` returned `code=125` ("image not found") and every Telegram message produced a silent crashloop. New `ensureContainerImage()` step at boot detects the mismatch and `docker tag`s any `parachute-agent-image-<peer-slug>:latest` it finds onto the expected name. Pre-0.1.0 `paraclaw-agent-<slug>:latest` peers also match (one cycle of compat). When no peer is on disk, the daemon now fails visibly at startup with an actionable error instead of crashlooping silently.

- **Inbound: extract attachment files only after the row commits (paraclaw#96).** `writeSessionMessage` previously decoded base64 attachments and wrote files to `inbox/<messageId>/` _before_ `INSERT … ON CONFLICT(id) DO NOTHING` returned. Once duplicate dispatch became a warm code path (sender-approval replay, Telegram getUpdates retry, chat-sdk re-emit), a replay carrying the same `messages_in.id` but mutated bytes silently clobbered the on-disk file under the original message id while the DB row stayed unchanged — divergent state with no audit trail. Reordered: insert with raw inline-base64 content, check `inserted`, and only when `inserted === true` extract files and `UPDATE messages_in SET content = ?` with the path-replaced form. Disk state now stays strictly downstream of the row commit.

- **Wire-side `senderScope` vocabulary clash (paraclaw#94).** The wire vocab `'allowlist' | 'all'` shared the literal `'all'` with the DB-side `'all' | 'known'` — both meant "no sender filter", but the literal collision meant a grep-based rename of either side would silently break translation without a compile error. Renamed wire-side `'all'` → `'unrestricted'` so the two unions are now literal-disjoint; DB schema untouched (no migration). Touchpoints: HTTP + MCP translators, MCP `update-channel-wire` schema enum (now `['allowlist', 'unrestricted']`), `web/ui/src/lib/api.ts:SenderScope`, and the dropdown copy in `ChannelWireDetail.tsx`. Plus a defensive validation gate on the MCP handler — the SDK does not enforce `inputSchema` against `tools/call` arguments, so a stale-schema client sending the legacy `senderScope: 'all'` (or `ignoredMessagePolicy: 'accumulate'`, or a typo'd `engageMode`) would previously land past the rename gate, never match any branch, and silently no-op. Now explicitly rejected with a diagnostic error. **Breaking change to the API/MCP wire vocabulary** — pre-1.0, no operator-data risk.

- **Mount-security imports `HOME_DIR` from `src/config.ts` (paraclaw#99).** `expandPath` in `src/modules/mount-security/index.ts` previously called `process.env.HOME || os.homedir()` directly — the only remaining offender after the rest of the host's HOME-derived paths routed through `config.ts`. Now imports the canonical `HOME_DIR`, so a future precedence-rule refactor (e.g. add a `PARACHUTE_AGENT_HOME` override) is one edit upstream. Default behavior unchanged. Mount-allowlist's on-disk location intentionally stays at `<HOME>/.config/parachute-agent/` (operator-host policy, not per-install runtime state) — pinned with a regression test.

- **`putSecret` auto-seeds the owner assignment for scoped creates (paraclaw#127).** The default `agent_groups.secret_mode` is `selective` (migration 023). Before this fix, `putSecret(name, value, { agent_group_id })` inserted the `secrets` row without writing the matching `secret_assignments` row — leaving the row silently invisible to `resolveInjectableSecrets` (which gates on `secret_mode='all' OR assignment row exists`). The "+ New secret" → CredentialForm "free" mode in the SPA called only `putSecret` with no follow-up `setSecretAssignments`, so the standard create flow produced orphan rows whose values would never reach the agent container. Fix: `putSecret` writes the (id, owning_group) assignment row in the same transaction on INSERT (idempotent via `ON CONFLICT … DO NOTHING`); UPDATE/rotate leaves the assignment set alone (operator may have deliberately revoked an assignment, and a value rotation must not undo that).

- **SPA OAuth bootstrap — three narrowing fixes (paraclaw#136, #137, #138).** (1) Drop `vault:read vault:write` from `REQUESTED_SCOPES` — the agent SPA is self-contained, every vault flow already runs the per-vault re-consent pattern (`vault:<name>:admin` via `extraScopes`), so the broad bootstrap scopes were dead weight on the consent screen ("this app wants to read/write all your vaults" — wrong story for an SPA whose vault touches are narrowly per-vault and on-demand). (2) Regression-pin OAuth `client_name` in the registerClient body — the hub renders this string verbatim on its DCR consent screen; the 0.1.0 brand sweep renamed it from `Paraclaw web UI` to `Parachute Agent web UI`, this pins the wire-level test. (3) Re-register OAuth client when `redirect_uri` changes — the hub binds each DCR `client_id` to the redirect_uri it registered with; if the SPA's mount path changes (operator flips `PARACHUTE_AGENT_WEB_MOUNT` from `/claw/` → `/agent/`, or any custom remount), the cached client_id stops matching and `/oauth/authorize` errors out before the consent screen. Extended `ClientRecord` to `{ client_id, redirect_uri }`, compare in `ensureClient`, treat mismatch (or legacy missing-field record) as cache miss → re-register. Legacy records self-heal on first 0.1.x reload.

### Changed

- **`services.json` self-registers `installDir` (paraclaw#115).** The agent's startup self-registration into `~/.parachute/services.json` now includes `installDir: process.cwd()` alongside the existing `name`/`port`/`paths`/`health`/`version` fields. Without it, hub's third-party-module lifecycle resolution (parachute-hub#84) couldn't locate the start command for `parachute restart agent` — the agent had a `.parachute/module.json` with `startCmd`, but hub needed `installDir` to know which checkout to drive.

- **GroupDetail "Secrets" panel — what the agent will receive at next session spawn (paraclaw#104).** `/agent/groups/:folder` now surfaces a read-only Secrets section showing the same set `resolveInjectableSecrets()` would inject into a new container, with three scope badges that explain _why_ each row is included: `scoped` (owned by this group), `assigned` (global with explicit assignment row), `global` (global reaching the group only because `secret_mode='all'`). On a name collision the scoped row wins and reports `scoped`, mirroring the host's resolution rule. Click-through routes to `/secrets?edit=<id>` with a deep-link param for SecretEditor. New `GET /api/groups/:folder/secrets` endpoint (scope `agent:read`) — metadata only, never decrypts. Empty state distinguishes between mode='selective' (reads as "by design") and mode='all' (suggests creating a secret).

- **GroupDetail Secrets section — Retry button on error state (paraclaw#128).** Mirrors the existing AgentProviderSection pattern: the error banner now renders a Retry button bound to the same fetch callback so operators don't have to navigate away after a transient API failure.

- **Channel-wire translator extracted into a single shared module (paraclaw#123).** `src/web/routes/channels.ts` and `src/mcp/tools/channels.ts` each maintained their own copy of the `Api*` types, the `VALID_API_*` enum arrays, the `dbToApi*` translator pair, and the `ChannelWireView` shape. That duplication was the structural drift hazard paraclaw#94 surfaced concretely. Lifted everything into `src/channels/api-translator.ts`; the HTTP route file now owns only the transport layer, the MCP file only the tool-def plumbing. A future enum change touches one file and both surfaces pick it up automatically. (Behavioral side note: the inline MCP handler used to silently _drop_ `engagePattern='.'` because the DB sentinel for `engageMode='all'` would round-trip back as `'all'` on the next read; the shared validator now hard-rejects that input identically on both surfaces. Use `'\\.'` to match a literal dot.)

- **Depersonalize test fixtures + comments.** Removed a real install-slug (`16f7e9e8`, the sha1 prefix of one operator's specific path) that had snuck into `src/container-runtime.test.ts` peer-image fixtures, plus a comment in `src/container-runtime.ts` that named the specific `mv` command from one operator's environment. Codebase should be operator-agnostic. Replaced with synthetic `cafef00d`. No behavior change.

### Tests

- **Integration coverage for `writeSessionMessage` dup-skip + sender-approval replay (paraclaw#97).** The unit test added with #95 proved `insertMessage` returns `inserted=false` on a duplicate id, but the write-path side effects layered above it were never asserted at the integration level. New `src/session-manager.dup-skip.test.ts` (4 tests using real session DBs and real fs: dup dispatch doesn't bump `sessions.last_active`, log payload shape, N-concurrent same-id absorption to one row + one inbox file, distinct ids in the same burst still land), plus 2 new tests in `src/modules/permissions/sender-approval.test.ts` exercising the approval-replay chain end-to-end (file at `inbox/<id>:<agentGroupId>/photo.jpg`, byte-preserved on `original_message` mutation under accumulate-mode wiring). Stash-and-rerun confirmed both regression tests catch the underlying #92/#95/#96 bugs.

- **Parallel-equality lockstep guard for `resolveInjectableSecrets ↔ listInjectableSecretsForGroup` (paraclaw#129).** The two functions in `src/secrets/index.ts` are SQL-identical mirrors with a load-bearing doc-comment requiring lockstep edits — previously preserved only by careful reading and a #126-era reviewer note. Adds a `describe('… lockstep …')` block with an `expectLockstep` helper that calls both functions, asserts name-set equality, and walks each name through `getSecret` to verify the chosen row id (the `ORDER BY s.agent_group_id IS NULL` scoped-wins ordering) agrees with the plaintext returned. Five fixtures cover the rich-mix (scoped+all + global+assigned + global+mode=all + name collision), mode=selective, the orphaned-scoped corner, the unknown-agent-group selective-default path, and an empty store. Mechanical guard, no production code change.

---

For per-rc commit-level detail of the 0.1.2 patch series, see `git log v0.1.1..v0.1.2 -- src/ web/ui/src/` or the merged PRs (#113 through #139).

## [0.1.1] - 2026-05-05

### Changed

- **License.** parachute-agent now declares **AGPL-3.0** in `package.json` and `LICENSE`, matching the rest of the Parachute ecosystem (vault, hub, scribe, notes). The original NanoClaw MIT license is preserved verbatim as `LICENSE-NANOCLAW-MIT` to honor the upstream copyright (Copyright (c) 2026 Gavriel — https://github.com/qwibitai/nanoclaw). Modifications and the combined work are AGPL-3.0; the original NanoClaw code remains MIT-licensed and obtainable from the upstream project. Resolves the npm "Proprietary" display that came from the missing `license` field at 0.1.0.

## [0.1.0] - 2026-05-05

Renamed paraclaw → **parachute-agent**, joining the Parachute ecosystem's named-after-purpose convention (vault, notes, scribe, hub). The name on disk, in the npm registry, on the mount path, and on the wire all change. Operator data migrates automatically on first boot; tokens, container labels, and module manifests carry one cycle of back-compat.

- **npm package.** `paraclaw` → `@openparachute/agent`. The `parachute-agent` bin wraps the same entry point.
- **`.parachute/module.json` `name`** → `parachute-agent`. The hub picks up the new identifier from the manifest; old installs that re-pull will see the rename without intervention.
- **Mount path.** `/claw/*` → `/agent/*`. Hub-fronted UI lives under `/agent/`. The SPA derives its mount from `import.meta.env.BASE_URL`, so the same bundle works at any prefix. **No 301 redirect** — hard cut. Re-bookmark.
- **Data dir.** `~/.parachute/claw/{paraclaw.db,master.key}` → `~/.parachute/agent/{agent.db,master.key}`. **Auto-migrated on startup** the first time 0.1.x boots: the legacy file copies to the new path with mode 0600, and the legacy file is left in place as a manual-rm backup. Honors `PARACHUTE_HOME`. Both legacies (pre-0.0.6 in-tree `data/v2.db` and pre-0.1.0 `~/.parachute/claw/paraclaw.db`) are preferred over an absent current; if both exist, the paraclaw-era file wins.
- **Container labels.** Spawn label is now `parachute-agent-install=<slug>`. Cleanup reaps both the new label and the legacy `paraclaw-install=<slug>` label for one upgrade cycle, so a 0.1.x host coming up against pre-0.1.0 orphan containers cleans them up correctly. **Drop `paraclaw-install` compat in 0.2.0** (tracked as a follow-up issue).
- **Container image tag.** `paraclaw-agent-<slug>:latest` → `parachute-agent-image-<slug>:latest`. `container/build.sh` produces the new tag; `container-runner` spawns from it. The `-image-` infix avoids colliding with the npm package name.
- **MCP scope strings + symbols.** Wire scopes are `agent:read|write|admin` (was `claw:*`). Hub-issued JWTs carrying legacy `claw:*` grants still pass — they normalize to their `agent:*` equivalents inside `hasScope` and `pickEffectiveScope`. **Drop `claw:*` normalization in 0.2.0.** TS symbols renamed: `ClawScope` → `AgentScope`; `SCOPE_CLAW_*` → `SCOPE_AGENT_*`.
- **MCP server name.** `paraclaw` → `parachute-agent`. Tools advertise as `mcp__parachute_agent__<verb>-<noun>` to clients. Renamed in three places that all need to agree: the host-side stdio entrypoint (operator wires this into Claude Code via `claude mcp add parachute-agent …`), the host-side HTTP `/mcp` endpoint, and the container-side built-in MCP server that the in-container agent calls. **⚠ Operator action**: restart any active sessions on first boot — existing in-flight sessions have message history referencing `mcp__paraclaw__*` tool calls and need a fresh container to pick up the new tool prefix. New tool calls in restarted sessions use the new prefix; the historical log entries stay (they're conversation history, not tool routing). Closes paraclaw#110.
- **Service registry.** `services-manifest` displayName `Paraclaw` → `Parachute Agent`; service identifiers (`parachute-agent-web-server`) and the `name: 'agent'` route entry follow.
- **launchd / systemd.** No service-file generator changes in this PR — service install is now owned by the hub install path. Operators on existing installs who still have the old `computer.parachute.claw-<slug>.plist` / `paraclaw-<slug>.service` units will continue to work; re-running the hub installer rewrites them with the new label/unit name.

### Operator migration steps (existing installs)

1. **Stop the daemon** (so the migration sees a quiescent state):
   - macOS: `launchctl unload ~/Library/LaunchAgents/computer.parachute.claw-<slug>.plist`
   - Linux: `systemctl --user stop paraclaw-<slug>`
2. **Pull the rename**: `git pull --ff-only` on the install dir, then `pnpm install` (the `postinstall` hook rebuilds the SPA bundle).
3. **Start the daemon**. On first boot, you'll see one or both of these log lines once and only once:
   ```
   Central DB migrated from legacy location  from=…/paraclaw.db  to=…/agent.db
   Master key migrated from legacy location   from=…/claw/master.key  to=…/agent/master.key
   ```
4. **Verify** via the web UI at the new mount: `/agent/` (was `/claw/`).
5. **Re-register the MCP server** in any Claude Code (or other MCP client) configs. The stdio entrypoint hasn't moved, but the server name has — old `claude mcp add paraclaw …` registrations keep pointing at the old name and tools advertise as `mcp__paraclaw__*` instead of `mcp__parachute_agent__*`:
   ```sh
   claude mcp remove paraclaw
   claude mcp add parachute-agent bun /path/to/install/src/mcp/stdio.ts
   ```
6. **Cleanup (optional)**: once you've verified the new install boots and decrypts secrets, delete the legacy backups: `rm ~/.parachute/claw/paraclaw.db ~/.parachute/claw/master.key && rmdir ~/.parachute/claw`.

Browser sessions auto-migrate the SPA's `paraclaw.*` localStorage / sessionStorage keys (cached OAuth discovery, DCR client_id, tokens, in-flight flow state, setup-wizard resume state) to `parachute-agent.*` on first reload after the upgrade — no manual action required.

- **Log filenames.** `logs/paraclaw.log` + `logs/paraclaw.error.log` → `logs/parachute-agent.log` + `logs/parachute-agent.error.log`. **Auto-renamed on first 0.1.0 boot** so historical entries stay accessible under the new name. The supervisor (launchd plist / systemd unit) is what routes the _live_ daemon's stdout/stderr — until the operator re-runs `parachute install parachute-agent` to regenerate the unit, new entries continue landing in `paraclaw.log` (recreated by the supervisor after the rename) and the next supervisor-driven respawn opens it fresh. Once the unit is regenerated, subsequent boots write to `parachute-agent.log` directly. Operators tailing the new path see migrated history immediately; live writes follow on the next install-run.
- **Env var prefix.** `PARACLAW_*` → `PARACHUTE_AGENT_*` (six vars: `_HUB_ORIGIN`, `_WEB_PORT`, `_WEB_BIND`, `_WEB_MOUNT`, `_WEB_ORIGIN`, `_CENTRAL_DB_PATH`). Each callsite reads the new name first, falls back to the legacy `PARACLAW_*` name if only that's set, and emits a one-shot deprecation warning per legacy name read. Operators can update their `.env` files at their leisure through 0.1.x; the legacy compat-read drops in 0.2.0. The Vite type declaration `VITE_PARACLAW_WEB_SERVER_URL` is also renamed to `VITE_PARACHUTE_AGENT_WEB_SERVER_URL` (the SPA doesn't read the value — it's a leftover declaration), no operator action needed.
- **Allowlist directory.** `~/.config/paraclaw/{mount,sender}-allowlist.json` → `~/.config/parachute-agent/{mount,sender}-allowlist.json`. **Auto-moved on first 0.1.0 boot**: the legacy directory is left in place (operators may have stashed unrelated files there) but each known allowlist file is renamed to the new dir if the new path is absent. If both exist (e.g. operator pre-populated the new dir before upgrading), the new file wins and the legacy orphan is left for the operator to `rm`. Drop the auto-move in 0.2.0.
- **Vault token-label default.** Fresh mints from the web UI's attach-vault flow and the new-group wizard now default to `agent-<folder>` (was `claw-<folder>`). Existing operator-typed labels keep working — the label is opaque to the vault, so prior `claw-<folder>` tokens continue to authenticate. Operators who want consistency can re-mint via the vault tokens UI. Reverses the parachute-agent#108 §2 deliberation in favor of brand consistency at the 0.1.0-stable cut.
- **HKDF info strings — intentionally NOT renamed.** Five HKDF info constants (`paraclaw.secrets.v1`, `paraclaw.oauth.{client,access,refresh}.v1`, `paraclaw.provider-credentials.v1`) keep the `paraclaw.` prefix forever. They're cryptographic domain separators mixed into key derivation, not user-facing strings — renaming them would derive a different key and render every existing ciphertext row (secrets, OAuth tokens, provider credentials) undecryptable. Documented at each constant-definition site so a future brand sweep knows to skip these five lines. No operator action.

## [Unreleased]

Hard fork from NanoClaw v2. Paraclaw is now its own service: single Bun process (host + web merged), native AES-GCM secrets layer, channels inlined permanently, skills system retired, capability card published at `/.well-known/parachute.json`. OneCLI is no longer a dependency.

- **Schema relocate.** Central DB moved to `~/.parachute/claw/paraclaw.db`. Per-session two-file split (`inbound.db` + `outbound.db`) preserved — empirically validated as the only safe shape across Docker bind-mounts.
- **Native secrets.** Master key at `~/.parachute/claw/master.key` (32 bytes, mode 0600), AES-256-GCM with HKDF domain separation per subsystem, redacted error messages. Migration 015 drops the vestigial `host_pattern` column.
- **Web UI** ships native pages for paraclaw primitives: `/secrets`, `/approvals`, `/sessions`, `/channels`. Wizard's credential-capture step removed (replaced by `/secrets`).
- **Lifecycle.** Install via `parachute install paraclaw`; start runs `bun src/index.ts`. Module manifest at `.parachute/module.json`.
- **fix(secrets):** per-secret mode radio for global secrets was a silent UI illusion (paraclaw#9-era migration moved mode to `agent_groups.secret_mode`). Globals now hide the radio with explainer; scoped secrets reframe the radio as `<group> accepts: [all in-scope | only assigned]`, surfacing the per-group nature of the setting.
- **feat(secrets):** post-save staleness banner detects running containers spawned before the secret update + per-session `[Restart]` + `Restart all N`. Calls existing `closeSession`; next inbound message respawns fresh with new env. New `GET /api/secrets/:id/stale-sessions` (claw:read).
- **feat(GroupDetail):** per-session `[Restart]` button on the Live status list + inline help on the spawn-time env model — operators can restart any running container without leaving the agent group page, for code/env/agent-provider changes too, not just secrets.

## [2.0.0] - 2026-04-22 (NanoClaw v2 — paraclaw's ancestor)

Major version. NanoClaw v2 was a substantial architectural rewrite that paraclaw forks from.

- [BREAKING] **New entity model.** Users, roles (owner/admin), messaging groups, and agent groups are now tracked as separate entities, wired via `messaging_group_agents`. Privilege is user-level instead of channel-level, so the old "main channel = admin" concept is retired. See [docs/architecture.md](docs/architecture.md) and [docs/isolation-model.md](docs/isolation-model.md).
- [BREAKING] **Two-DB session split.** Each session now has `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads) with exactly one writer each. Replaces the single shared session DB and eliminates cross-mount SQLite contention. See [docs/db-session.md](docs/db-session.md).
- [BREAKING] **Install flow replaced.** `bash nanoclaw.sh` is the new default: a scripted installer that hands off to Claude Code for error recovery and guided decisions. The `/setup` Claude-guided skill still works as an alternative.
- [BREAKING] **Channels moved to the `channels` branch.** Trunk no longer ships Discord, Slack, Telegram, WhatsApp, iMessage, Teams, Linear, GitHub, WeChat, Matrix, Google Chat, Webex, Resend, or WhatsApp Cloud. Install them per fork via `/add-<channel>` skills, which copy from the `channels` branch. `/update-nanoclaw` will re-install the channels your fork had.
- [BREAKING] **Alternative providers moved to the `providers` branch.** OpenCode, Codex, and Ollama install via `/add-opencode`, `/add-codex`, `/add-ollama-provider`. Claude remains the default provider baked into trunk.
- [BREAKING] **Three-level channel isolation.** Wire channels to their own agent (separate agent groups), share an agent with independent conversations (`session_mode: 'shared'`), or merge channels into one shared session (`session_mode: 'agent-shared'`). Chosen per channel via `/manage-channels`.
- [BREAKING] **Apple Container removed from default setup.** Still available as an opt-in via `/convert-to-apple-container`.
- **Shared-source agent-runner.** Per-group `agent-runner-src/` overlays are gone; all groups mount the same agent-runner read-only. Per-group customization flows through composed `CLAUDE.md` (shared base + per-group fragments).
- **Agent-runner runtime moved from Node to Bun.** Container image is self-contained; no host-side impact. Host remains on Node + pnpm.
- **OneCLI Agent Vault is the sole credential path.** Containers never receive raw API keys; credentials are injected at request time.

## [1.2.36] - 2026-03-26

- [BREAKING] Replaced pino logger with built-in logger. WhatsApp users must re-merge the WhatsApp fork to pick up the Baileys logger compatibility fix: `git fetch whatsapp main && git merge whatsapp/main`. If the `whatsapp` remote is not configured: `git remote add whatsapp https://github.com/qwibitai/nanoclaw-whatsapp.git`.

## [1.2.35] - 2026-03-26

- [BREAKING] OneCLI Agent Vault replaces the built-in credential proxy. Check your runtime: `grep CONTAINER_RUNTIME_BIN src/container-runtime.ts` — if it shows `'container'` you are on Apple Container, if `'docker'` you are on Docker. Docker users: run `/init-onecli` to install OneCLI and migrate `.env` credentials to the vault. Apple Container users: re-merge the skill branch (`git fetch upstream skill/apple-container && git merge upstream/skill/apple-container`) then run `/convert-to-apple-container` and follow all instructions (configures credential proxy networking) — do NOT run `/init-onecli`, it requires Docker.

## [1.2.21] - 2026-03-22

- Added opt-in diagnostics via PostHog with explicit user consent (Yes / No / Never ask again)

## [1.2.20] - 2026-03-21

- Added ESLint configuration with error-handling rules

## [1.2.19] - 2026-03-19

- Reduced `docker stop` timeout for faster container restarts (`-t 1` flag)

## [1.2.18] - 2026-03-19

- User prompt content no longer logged on container errors — only input metadata
- Added Japanese README translation

## [1.2.17] - 2026-03-18

- Added `/capabilities` and `/status` container-agent skills

## [1.2.16] - 2026-03-18

- Tasks snapshot now refreshes immediately after IPC task mutations

## [1.2.15] - 2026-03-16

- Fixed remote-control prompt auto-accept to prevent immediate exit
- Added `KillMode=process` so remote-control survives service restarts

## [1.2.14] - 2026-03-14

- Added `/remote-control` command for host-level Claude Code access from within containers

## [1.2.13] - 2026-03-14

**Breaking:** Skills are now git branches, channels are separate fork repos.

- Skills live as `skill/*` git branches merged via `git merge`
- Added Docker Sandboxes support
- Fixed setup registration to use correct CLI commands

## [1.2.12] - 2026-03-08

- Added `/compact` skill for manual context compaction
- Enhanced container environment isolation via credential proxy

## [1.2.11] - 2026-03-08

- Added PDF reader, image vision, and WhatsApp reactions skills
- Fixed task container to close promptly when agent uses IPC-only messaging

## [1.2.10] - 2026-03-06

- Added `LIMIT` to unbounded message history queries for better performance

## [1.2.9] - 2026-03-06

- Agent prompts now include timezone context for accurate time references

## [1.2.8] - 2026-03-06

- Fixed misleading `send_message` tool description for scheduled tasks

## [1.2.7] - 2026-03-06

- Added `/add-ollama` skill for local model inference
- Added `update_task` tool and return task ID from `schedule_task`

## [1.2.6] - 2026-03-04

- Updated `claude-agent-sdk` to 0.2.68

## [1.2.5] - 2026-03-04

- CI formatting fix

## [1.2.4] - 2026-03-04

- Fixed `_chatJid` rename to `chatJid` in `onMessage` callback

## [1.2.3] - 2026-03-04

- Added sender allowlist for per-chat access control

## [1.2.2] - 2026-03-04

- Added `/use-local-whisper` skill for local voice transcription
- Atomic task claims prevent scheduled tasks from executing twice

## [1.2.1] - 2026-03-02

- Version bump (no functional changes)

## [1.2.0] - 2026-03-02

**Breaking:** WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add.

- Channel registry: channels self-register at startup via `registerChannel()` factory pattern
- `isMain` flag replaces folder-name-based main group detection
- `ENABLED_CHANNELS` removed — channels detected by credential presence
- Prevent scheduled tasks from executing twice when container runtime exceeds poll interval

## [1.1.6] - 2026-03-01

- Added CJK font support for Chromium screenshots

## [1.1.5] - 2026-03-01

- Fixed wrapped WhatsApp message normalization

## [1.1.4] - 2026-03-01

- Added third-party model support
- Added `/update-nanoclaw` skill for syncing with upstream

## [1.1.3] - 2026-02-25

- Added `/add-slack` skill
- Restructured Gmail skill for new architecture

## [1.1.2] - 2026-02-24

- Improved error handling for WhatsApp Web version fetch

## [1.1.1] - 2026-02-24

- Added Qodo skills and codebase intelligence
- Fixed WhatsApp 405 connection failures

## [1.1.0] - 2026-02-23

- Added `/update` skill to pull upstream changes from within Claude Code
- Enhanced container environment isolation via credential proxy
