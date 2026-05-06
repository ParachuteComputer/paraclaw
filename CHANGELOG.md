# Changelog

All notable changes to parachute-agent will be documented in this file.

## [0.1.2-rc.14] - 2026-05-05

### Fixed

- **SPA OAuth bootstrap — three narrowing fixes for the agent web UI (paraclaw#136, #137, #138).** Bundled audit of `web/ui/src/lib/auth.ts`:

  1. **Drop `vault:read vault:write` from `REQUESTED_SCOPES` (paraclaw#136).** The agent SPA used to ask for broad vault read/write at bootstrap, but every vault interaction in the UI (VaultDetail, GroupDetail, NewGroupWizard) already runs the paraclaw#56 re-consent pattern — calling `beginLogin([\`vault:\${name}:admin\`])` with the narrow per-vault scope when the operator's existing JWT doesn't carry admin for the targeted vault. The bootstrap-time `vault:read vault:write` were dead weight: never used by any code path, but visible on the hub's consent screen as "this app wants to read/write all your vaults" — the wrong story for an SPA whose vault touches are narrowly per-vault and on-demand. Narrow `REQUESTED_SCOPES` to `agent:admin agent:write`. Refactor `beginLogin`'s URL-construction inline-block into a pure exported `buildAuthorizeUrl(opts)` helper so tests can pin the scope string and the `extraScopes` append-and-dedupe behavior without mocking `window.location.replace`. 5 new tests pin the post-narrowing surface: REQUESTED_SCOPES literal, no-vault output when extraScopes is empty (belt-and-suspenders against URL-encoded `vault:` reappearing), narrow scope appended, dedupe of scopes already in REQUESTED_SCOPES, full PKCE-S256 query-param coverage.

  2. **Regression-pin OAuth `client_name` in the registerClient body (paraclaw#137).** The hub renders this string verbatim on its DCR consent screen — operator-visible UX, not an internal identifier. The 0.1.0 brand sweep (PR #112, commit 2a83e77) renamed it from `Paraclaw web UI` to `Parachute Agent web UI`; this commit adds the wire-level test that pins it. Two new tests on `ensureClient`: first-registration mocks fetch and asserts the POST body carries `client_name: "Parachute Agent web UI"` plus belt assertions on `scope` (= REQUESTED_SCOPES) and `token_endpoint_auth_method` ("none"); cached-path asserts a pre-seeded match returns without calling fetch. Production-code change is a single `export` keyword on `ensureClient` — no behavior change.

  3. **Re-register OAuth client when `redirect_uri` changes (paraclaw#138).** The hub-side DCR row binds each `client_id` to the specific `redirect_uris` it registered with; if the SPA's mount path changes (e.g. an operator flips `PARACHUTE_AGENT_WEB_MOUNT` from `/claw/` to `/agent/` after the 0.1.0 rename), the cached `client_id` keeps coming through `getRedirectUri()` as the new path while the hub still has the old one — `/oauth/authorize` errors out before the consent screen and the operator is stranded. Extend `ClientRecord` to `{ client_id, redirect_uri }`, compare in the `ensureClient` cache check before returning cached, treat any mismatch (or a legacy record with no `redirect_uri` field at all) as a cache miss → re-register fresh under the current path. Records written before this commit lack the field; the legacy-shape branch self-heals on the first 0.1.x bootstrap after upgrade (one extra `/oauth/register` round-trip per operator, then steady-state). 3 new tests cover the matrix: mismatch re-registers + persists the current redirect_uri (so subsequent loads cache-hit), legacy-shape self-heal, first-registration persists both fields. The Commit-2 cached-hit test was tightened to seed both fields under the new contract. Closes paraclaw#136, #137, #138.

## [0.1.2-rc.13] - 2026-05-05

### Fixed

- **`putSecret` auto-seeds the owner assignment for scoped creates (paraclaw#127).** The default `agent_groups.secret_mode` is `selective` (migration 023). Before this fix, `putSecret(name, value, { agent_group_id })` inserted the `secrets` row without writing the matching `secret_assignments` row — leaving the row silently invisible to `resolveInjectableSecrets` (which gates on `secret_mode='all' OR assignment row exists`). The "+ New secret" → CredentialForm "free" mode in the SPA called only `putSecret` with no follow-up `setSecretAssignments`, so the standard create flow produced orphan rows whose values would never reach the agent container. The issue body's premise ("unreachable via UI because the create flow always seeds an assignment row") was incorrect — the SecretEditor *edit* path seeded, but the Credential *create* path did not. Fix: `putSecret` writes the (id, owning_group) assignment row in the same transaction on INSERT; UPDATE/rotate leaves the assignment set alone (operator may have deliberately revoked an assignment, and a value rotation must not undo that). Idempotent via `ON CONFLICT (secret_id, agent_group_id) DO NOTHING`. The `findStaleSessionsForSecret` doc-comment that previously called the orphan state "unreachable via the UI" now correctly identifies it as "structurally unreachable from `putSecret`". Six new tests in `src/secrets/secrets.test.ts` pin the new contract: scoped create writes the assignment row, scoped create is visible via both `resolveInjectableSecrets` and `listInjectableSecretsForGroup` under selective mode without an explicit assign call (the regression catch), global create writes no assignment row, rotate path leaves the assignment set alone, two scoped creates with different owners each seed their own row. The pre-existing "mode=selective injects nothing without explicit assignments" test was updated to reflect the new behaviour (globals still hide, but scoped secrets are auto-seeded into their owner). The "orphaned-scoped lockstep" test in the lockstep-guard block now constructs the orphan state via direct SQL (since `putSecret` no longer produces it) so the SQL-drift guard between `resolveInjectableSecrets` and `listInjectableSecretsForGroup` still fires. Stash-and-rerun confirmed: reverting just the auto-seed makes 6 of the new/updated tests fail, including the resolver-visibility regression catch. Closes paraclaw#127. Follow-up issue tracked for surfacing pre-existing orphans in the GroupDetail Secrets section UI.

## [0.1.2-rc.12] - 2026-05-05

### Changed

- **Channel-wire translator extracted into a single shared module (paraclaw#123).** `src/web/routes/channels.ts` and `src/mcp/tools/channels.ts` each maintained their own copy of the `Api*` types, the `VALID_API_*` enum arrays, the `dbToApi*` translator pair, the `ChannelWireView` shape, the `WireRow → view` projection, and (in HTTP) the `validatePatchInput` / `apiToDbPatch` validator+encoder. That duplication was the structural drift hazard paraclaw#94 / PR #122 surfaced concretely — the rename of wire-side `'all'` → `'unrestricted'` initially landed only in the HTTP validator, leaving the MCP-side handler with a silent-coerce hole that #122 had to close inline. Lifted everything into `src/channels/api-translator.ts`. The HTTP route file now owns only the transport layer (json/error helpers, route dispatcher, the messaging-group `mg/:id` detail block, the unknown-sender-policy validator); the MCP file owns only the tool-def plumbing. Both surfaces share `validatePatchInput` and `apiToDbPatch`, so a future enum change touches one file and both surfaces pick it up automatically. 35 new tests in `src/channels/api-translator.test.ts` cover every Db ↔ Api literal pair, the `mention-sticky` PATCH-preservation contract, and the legacy-literal rejections (`senderScope='all'`, `ignoredMessagePolicy='accumulate'`, `engageMode='mention-sticky'`).

  Behavioural change worth flagging: the inline MCP handler used to silently *drop* `engagePattern='.'` when supplied alongside `engageMode='pattern'` or by itself (the DB sentinel for `engageMode='all'` would silently round-trip back as `'all'` on the next read, losing the user's intended literal-dot match). The shared validator hard-rejects that input with the sentinel-reservation error the HTTP route already used since #122 — now both surfaces reject it identically. The escaped form `'\\.'` is the documented way to match a literal dot. Closes paraclaw#123. Refs paraclaw#94, #122.

## [0.1.2-rc.11] - 2026-05-05

### Added

- **Retry button on GroupDetail Secrets section error state (paraclaw#128).** From paraclaw#126 review: the new SecretsSection's error banner had no recovery affordance — operators hit a transient API failure and had to navigate away to try again. Mirrors the existing AgentProviderSection pattern: extracts the fetch into a `reload` `useCallback`, the `useEffect` calls `void reload()`, and the error branch now renders the banner + an `actions` div with a Retry button bound to the same `reload` callback. New `GroupDetail.test.tsx` test mocks `listGroupInjectableSecrets` to reject once then resolve, asserts the error banner + Retry button render, clicks Retry, and asserts the success state replaces the error (and that the API was called twice). Stash-and-rerun confirmed: removing the Retry button fails the test with `Unable to find role="button" with name "Retry"`. Closes paraclaw#128. Refs paraclaw#126.

## [0.1.2-rc.10] - 2026-05-05

### Added

- **Parallel-equality test for `resolveInjectableSecrets ↔ listInjectableSecretsForGroup` lockstep (paraclaw#129).** The two functions in `src/secrets/index.ts` are SQL-identical mirrors with a load-bearing doc-comment requiring lockstep edits — today the invariant is preserved by careful reading and a #126-era reviewer note. Adds a `describe('… lockstep …')` block in `src/secrets/secrets.test.ts` with an `expectLockstep(groupId, expectedNames)` helper that calls both functions, asserts name-set equality, and walks each name through `getSecret(name, groupId)` to verify the chosen row id (the `ORDER BY s.agent_group_id IS NULL` scoped-wins ordering) agrees with the plaintext returned. Five fixtures cover the configs the issue calls out: rich mix (scoped+all + global+assigned + global+mode=all + name collision), mode=selective with mixed reachable/unreachable globals, the orphaned-scoped (selective + no assignment) "unreachable via UI" corner the `findStaleSessionsForSecret` doc-comment flags, the unknown-agent-group selective-default path, and an empty store. Stash-and-rerun confirmed: flipping `listInjectableSecretsForGroup`'s `ORDER BY s.agent_group_id IS NULL` to `s.agent_group_id IS NOT NULL` (the dedup-picks-global drift mode) fails the rich-mix name-collision check, and dropping the gate clause `(g.secret_mode = 'all' OR a.secret_id IS NOT NULL)` from one function fails the orphaned-scoped check. Mechanical guard, no production code change. Closes paraclaw#129. Refs paraclaw#126.

## [0.1.2-rc.9] - 2026-05-05

### Added

- **Integration coverage for `writeSessionMessage` dup-skip + sender-approval replay (paraclaw#97).** The unit test added with #95 proved `insertMessage` returns `inserted=false` on a duplicate id, but the write-path side effects layered above it were never asserted at the integration level. Adds two new test surfaces. (1) `src/session-manager.dup-skip.test.ts` — four tests using real session DBs and real fs, asserting that `writeSessionMessage` does NOT bump `sessions.last_active` on a duplicate dispatch (captured timestamp before/after, equality check), emits the documented `log.debug` payload with `agentGroupId / sessionId / messageId` exactly once, absorbs N near-concurrent same-id calls (Promise.all of 6 → one row, one inbox file, no spurious siblings), and still lands distinct ids in the same burst (sanity check that dup-skip is keyed on id, not on burst). (2) Two new tests in `src/modules/permissions/sender-approval.test.ts` exercise the approval-replay chain end-to-end: an attachment-bearing message routed through the request_approval gate, persisted in `pending_sender_approvals.original_message`, then replayed via `routeInbound` after approve — first that the replay lands cleanly at the namespaced `messages_in.id` path with the file at `inbox/<id>:<agentGroupId>/photo.jpg`; second that when `original_message` has been mutated since first write (accumulate-mode wiring already wrote the row + extracted the file with original bytes, then someone path-normalizes or re-encodes the JSON), the on-disk file is preserved byte-for-byte — the #96 file-clobber invariant under the sender-approval entry point. Stash-and-rerun discipline confirmed both regression tests catch the underlying bugs: pre-#96 ordering (extract before insert) makes the mutated-replay test fail on the file-bytes assertion; moving `updateSession` outside the `inserted` gate makes the last_active test fail with a non-equal timestamp. Closes paraclaw#97. Refs paraclaw#92, #95, #96, #120.

## [0.1.2-rc.8] - 2026-05-05

### Added

- **GroupDetail: "Secrets" panel — what the agent will receive at next session spawn (paraclaw#104).** `/agent/groups/:folder` now surfaces a read-only Secrets section showing the same set `resolveInjectableSecrets()` would inject into a new container, with three scope badges that explain *why* each row is included: `scoped` (owned by this group), `assigned` (global with explicit assignment row), `global` (global reaching the group only because `secret_mode='all'`). On a name collision the scoped row wins and reports `scoped`, mirroring the host's resolution rule; on assignment-row + mode='all' double-cover, `assigned` wins (the explicit row is more specific operator intent). Click-through routes to `/secrets?edit=<id>` and the SecretsList page now consumes that deep-link param to auto-open SecretEditor on mount. Empty state distinguishes between mode='selective' (reads as "by design") and mode='all' (suggests creating a secret).

  Wire surface: new `GET /api/groups/:folder/secrets` endpoint (scope `agent:read`) — metadata only, never decrypts. New host helper `listInjectableSecretsForGroup` mirrors `resolveInjectableSecrets`'s SQL gate exactly so the panel cannot disagree with what the container actually receives — the two are pinned together by tests and a doc-comment instructing future maintainers to keep them in lockstep. AgentGroupView additively gains `secret_mode` so the panel header can render the group's mode in context. Test coverage: 6 new tests in `src/secrets/secrets.test.ts` (each scope path, mode-selective hides bare globals, assignment+mode=all → assigned wins, scoped wins on collision, unknown group, no value leak), 2 new tests in `src/web/routes/secrets.test.ts` (wire-shape projection + empty-state under selective), 4 new SPA tests in `web/ui/src/routes/GroupDetail.test.tsx` (three-badge render, click-through href, both empty-state copies). Closes paraclaw#104. Refs paraclaw#103 (sibling secret-flow fixes).

## [0.1.2-rc.7] - 2026-05-05

### Changed

- **Mount-security: import `HOME_DIR` from `src/config.ts` instead of redrawing `os.homedir()` in-place (paraclaw#99).** `expandPath` in `src/modules/mount-security/index.ts` resolves operator-supplied `~/projects` etc. paths inside the mount-allowlist; before this change it called `process.env.HOME || os.homedir()` directly, the only remaining offender after #98 routed the rest of the host's HOME-derived paths through `config.ts`. Now `HOME_DIR` is exported from `config.ts` and imported here, so a future precedence-rule refactor (e.g. add a `PARACHUTE_AGENT_HOME` override) is one edit upstream. Default behavior unchanged.

  Deliberate non-change: mount-allowlist's on-disk location stays at `<HOME>/.config/parachute-agent/mount-allowlist.json`; it does NOT route through `PARACHUTE_DIR`. Mount-allowlist is **operator-host policy** ("which paths can the agent ever mount on this host"), not per-install runtime state — two installs sharing a host should agree on the same allowlist, and a sandbox at `PARACHUTE_HOME=/tmp/sandbox` deliberately reads the same file the live install does. Runtime state (central DB + master.key) routes through `PARACHUTE_DIR` per #98; this PR pins the split with a regression test that fails if a future refactor accidentally collapses the two. Test coverage added in `src/modules/mount-security/expand-path.test.ts` (5 cases — default expansion, bare `~`, absolute passthrough, HOME-override, PARACHUTE_HOME-collapse-check). Closes #99.

## [0.1.2-rc.6] - 2026-05-05

### Changed

- **Wire-side `senderScope.'all'` renamed to `'unrestricted'` (paraclaw#94).** The wire vocabulary `'allowlist' | 'all'` shared the literal `'all'` with the DB-side `'all' | 'known'` — both meant "no sender filter", but the literal collision meant a grep-based rename of either side would silently break the translator in `src/web/routes/channels.ts` (and its duplicate in `src/mcp/tools/channels.ts`) without any compile error. Renamed wire-side `'all'` → `'unrestricted'` so the two unions are now literal-disjoint; the DB schema is untouched (no migration). Touchpoints: both translators, the MCP tool's `update-channel-wire` schema enum (now `['allowlist', 'unrestricted']`), `web/ui/src/lib/api.ts:SenderScope`, and the dropdown copy in `ChannelWireDetail.tsx` (now reads "unrestricted — anyone in the thread"). Tests pin the round-trip and reject the legacy literal on PATCH. Breaking change to the API/MCP wire vocabulary — pre-1.0, no operator-data risk.

### Fixed

- **MCP `update-channel-wire`: defensive validation gate on enum-typed fields.** The MCP SDK does not enforce a tool's `inputSchema` against `tools/call` arguments before dispatching to the handler (see `ToolDef.inputSchema` doc-comment in `src/mcp/types.ts`). The handler's patch-construction was a chain of `if` / `else if` branches that silently fell through on unrecognized values: a stale-schema MCP client sending the legacy `senderScope: 'all'` (cached pre-rc.6 vocabulary) — or `ignoredMessagePolicy: 'accumulate'` (DB literal), or a typo'd `engageMode` — landed past the rename gate, never matched any branch, never assigned `patch.sender_scope` (etc.), and `updateMessagingGroupAgent` ran without that key. Server returned success, the client believed the field had been set, and the column kept its previous value silently. Same silent-coerce class paraclaw#94 was supposed to close, just one surface deeper. Added explicit upfront enum gates that mirror `validatePatchInput` from `src/web/routes/channels.ts` and reject legacy / unknown literals with a diagnostic error. Test coverage added in `src/mcp/tools/channels.test.ts` (the first MCP-tool test file in the tree) covers the round-trip + rejection on all three enum fields. Refs paraclaw#94. Tracked translator extraction as paraclaw#123.

## [0.1.2-rc.5] - 2026-05-05

### Changed

- **Depersonalize test fixtures + comments (no behavior change).** The #119 PR snuck a real install-slug (`16f7e9e8`, the sha1 prefix of one operator's specific path) into `src/container-runtime.test.ts` peer-image fixtures, and a comment in `src/container-runtime.ts` named the specific `mv` command that exposed paraclaw#114. Codebase should be operator-agnostic. Replaced the fixture slug with the synthetic `cafef00d` consistently across all current-prefix and legacy-prefix peer-image tests (the `PEER_IMAGE_PATTERN` regex matches any 8-hex slug, so the choice is cosmetic), and rephrased the comment to reference paraclaw#114 without the personal `mv` command. No behavior change; same 540/540 host tests.

## [0.1.2-rc.4] - 2026-05-05

### Fixed

- **Inbound: extract attachment files only after the row commits.** `writeSessionMessage` previously decoded base64 attachment data and wrote files to `inbox/<messageId>/` *before* the `INSERT … ON CONFLICT(id) DO NOTHING` returned. After paraclaw#92 / #95 made duplicate-dispatch a warm code path (sender-approval replay, Telegram getUpdates retry, chat-sdk re-emit), a replay carrying the same `messages_in.id` but mutated attachment bytes would silently clobber the on-disk file under the original message id while the DB row stayed unchanged — divergent state with no audit trail. Reordered: insert with raw inline-base64 content, check `inserted`, and only when `inserted === true` run `extractAttachmentFiles` and `UPDATE messages_in SET content = ?` with the path-replaced form. Disk state now stays strictly downstream of the row commit. Closes paraclaw#96. Refs #95, #92.

## [0.1.2-rc.3] - 2026-05-05

### Fixed

- **Auto-retag the per-install container image when `INSTALL_SLUG` shifts.** `INSTALL_SLUG = sha1(process.cwd())[:8]`, so an operator dir-rename (the trigger that exposed this bug today: `mv paraclaw parachute-agent`) flips the slug. The previously-built image carried the old slug; new container spawns went out under the new slug; `docker run` returned `code=125` ("image not found") and every Telegram message produced a silent crashloop. New `ensureContainerImage()` step in `src/index.ts` (between `ensureContainerRuntimeRunning` and `cleanupOrphans`) detects the mismatch at boot and `docker tag`s any `parachute-agent-image-<peer-slug>:latest` it finds onto the expected name. Pre-0.1.0 `paraclaw-agent-<slug>:latest` peers also match (one cycle of compat). When no peer is on disk at all (fresh install, no `./container/build.sh` run yet), the daemon now fails visibly at startup with an actionable error instead of crashlooping silently. Closes paraclaw#114.

## [0.1.2-rc.2] - 2026-05-05

### Fixed

- **Self-register `installDir` in `services.json`.** The agent's startup self-registration into `~/.parachute/services.json` now includes `installDir: process.cwd()` alongside the existing `name`/`port`/`paths`/`health`/`version` fields. Without it, hub's third-party-module lifecycle resolution path (parachute-hub#84) couldn't locate the start command for `parachute restart agent` — the agent has a `.parachute/module.json` with `startCmd`, but hub needed `installDir` to know which checkout to drive. parachute-hub#177 ships graceful-degradation for the missing-installDir case as a safety net; this is the proper fix on the agent side. Closes paraclaw#115.

## [0.1.2-rc.1] - 2026-05-05

### Fixed

- **Master-key migration: detect the both-exist split-state explicitly.** `migrateMasterKeyLocation` previously silent-no-op'd when both `<PARACHUTE_DIR>/claw/master.key` and `<PARACHUTE_DIR>/agent/master.key` existed — masking the case where an earlier 0.1.x boot generated a fresh key at the new path before the legacy was copied (so encrypted secrets sealed under the legacy key became undecryptable). The function now logs a `warn` with both paths and copy-pasteable recovery commands. Standalone scripts that ran `migrateCentralDbLocation` (`init-cli-agent`, `init-first-agent`, `seed-discord`) now also run `migrateMasterKeyLocation` before opening the DB, so a script-driven first touch of the central DB no longer skips the key copy.
- **SPA browser title.** `<title>Paraclaw</title>` → `<title>Parachute Agent</title>` and the meta description now references "Parachute Agent groups". Two GitHub repo links in the navbar and the group-detail page point at `parachute-agent` (not the renamed-from `paraclaw` repo URL).

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

- **Log filenames.** `logs/paraclaw.log` + `logs/paraclaw.error.log` → `logs/parachute-agent.log` + `logs/parachute-agent.error.log`. **Auto-renamed on first 0.1.0 boot** so historical entries stay accessible under the new name. The supervisor (launchd plist / systemd unit) is what routes the *live* daemon's stdout/stderr — until the operator re-runs `parachute install parachute-agent` to regenerate the unit, new entries continue landing in `paraclaw.log` (recreated by the supervisor after the rename) and the next supervisor-driven respawn opens it fresh. Once the unit is regenerated, subsequent boots write to `parachute-agent.log` directly. Operators tailing the new path see migrated history immediately; live writes follow on the next install-run.
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
