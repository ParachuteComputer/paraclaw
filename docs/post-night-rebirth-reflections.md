# Post-night reflections — paraclaw rebirth

A short retrospective written the morning after `night/paraclaw-rebirth` landed.
The branch carried roughly seven mergeable PRs plus a handful of merges from
sibling subtrees (`night/server`, `night/ui`, `night/arch`), and ended up
absorbing the OneCLI debrand, the AES-GCM secrets cutover, the activity log,
the OAuth-apps scaffold, and the host-side MCP server. The point of this note
is not to inventory what shipped — `git log` does that — but to say what the
process actually felt like, which parts of it earned their keep, and where the
next push should aim.

## A. What worked well

**Tentacle-per-repo stewardship paid off as soon as the merge train started
moving.** Each PR had a single steward who could read the diff cold without
needing to be re-briefed on what `inbound.db` was or why the secret-assignment
table didn't get folded into `agent_groups`. When PR #2's UI-side polish ran
into a missing `assignedMode` field on `/api/secrets`, the fix landed as
`38aa7cf feat(server): surface assignedMode on /api/secrets responses` from
the server tentacle within the same merge window — without a context handoff
or a re-litigation of the contract. The cohesive-PR rule meant the migration
file, the API surface, and the UI consumer were all in the same diff, so the
ack-loop between tentacles was tight.

**Three-tier governance held under load.** The reviewer-then-team-lead-then-Aaron
chain was tested seven times in close succession, and the failure mode that
governance is supposed to prevent — an automated merge that nobody actually
read — never occurred. Even the hotfix PR (#16, the localhost translation)
went through the same three gates. The cost of the discipline was small:
maybe a minute per PR for the human click. The benefit shows up in the kind
of bug that *didn't* land — there's no record of a regression PR, no revert
commit on the branch.

**The serial merge train, with #1→#2→#3→#4→#7→#5→#16→#6 in order, prevented
the migration-index collision class entirely.** Every PR that touched
`src/db/migrations/index.ts` was the only PR in flight that touched it at
that moment. Migration `019_…` slotted in cleanly because `018_…` had already
landed and been numbered. The earlier-era pattern of "open three migration
PRs in parallel and resolve numbering at the end" would have been
correspondingly painful — this branch demonstrated empirically that the
serial-train cost (waiting your turn) is cheaper than the parallel-merge cost
(rebasing migrations against a moving target).

**The /spawn → /report → /loop cadence kept the human out of the inner loop
without losing the human review at the outer loop.** Aaron didn't have to
remember which tentacle was on which PR; the dashboard showed it. Tentacles
didn't have to ask permission to read files or run tests; they just did. The
moments Aaron *did* show up — the merge clicks, the redirect on PR #5 about
the OAuth callback URL — were the moments where his judgment was actually
load-bearing. That ratio is the right one.

## B. Friction worth fixing

**The localhost-translation bug (#16) is the most interesting friction
point, because it landed *after* PR #6 — the host-side MCP server — even
though PR #6 was logically downstream of it.** The architectural gap (a
`url: http://localhost:1939/mcp` baked into `container.json` is unreachable
from inside the container, because container-loopback is not host-loopback)
existed for as long as paraclaw had attached an MCP server with a localhost
URL. Nobody caught it until a real techne agent tried to call its vault and
got a connection refused. The fix in `src/parachute/vault-mcp.ts:65–81` is
clean — translate at spawn time, leave the on-disk URL operator-facing — but
the *detection* came late.

The lesson is not "write more tests"; it's that paraclaw lacks an
operator-facing surface that says "here is what this container can actually
reach." A `/api/groups/<id>/diagnose` endpoint that, at session-spawn time,
ran a synthetic curl from inside the container against every MCP URL would
have caught this on the first attached vault, before any agent message round-tripped.
The same surface would catch DNS, TLS, and missing-auth-header failures —
all in the same shape. This is the kind of thing the setup wizard
(`web/ui/src/routes/SetupWizard.tsx:23`) should be growing toward; right now
it walks the operator through configuration, but it doesn't *prove*
configuration. Proving it would shift a class of bugs from
"reported-by-confused-user" to "caught-at-attach-time."

**Version skew between npm-published and locally-linked packages bit
twice.** The vault-routing pluralization issue earlier in the cycle (vault
exposing `notes/by-tag/:tag` while paraclaw's vault MCP integration assumed
`note/by-tag/:tag`) was an avoidable consequence of two repos shipping
independently with no schema-pinning between them. The night's fix was
ad-hoc; the structural fix is to either (a) pin paraclaw to a specific
parachute-vault version and lockstep them, or (b) treat the vault MCP surface
as an external API and version it with a content-negotiation header. We've
been operating as if both repos are pre-1.0 enough to be "just keep them in
sync mentally," but the empirical record says we drift faster than mental
sync can keep up.

**The reviewer hit usage limits mid-review on at least one of the larger
PRs.** That's not a process bug per se, but it's a signal that some PRs are
too large for a single review session even with cohesive-PR discipline.
The OAuth-apps PR (#7) was the worst offender — it spanned a migration, four
new endpoints, the OAuth flow, the redirect-URI plumbing, and the
mount-aware callback handling. In retrospect, splitting it into "OAuth state
table + scaffolding" then "Google provider" would have kept each review
under the limit and exposed the provider abstraction earlier.

**`c854dc2 fix(web): restore wire-channel route (was dropped in web-merge)`
is a quiet warning.** A route was silently dropped during a subtree merge
and only noticed when the UI lost a feature. The recovery was easy; the
detection was not — there's no test that says "the wire-channel route
exists." Smoke tests at the route level (mount the SPA in test mode, walk
the router tree, assert each known route responds 200) would catch
silent-drop bugs in the cheapest possible way.

## C. Where paraclaw goes next

**The natural next step after the host-side MCP server is the second
tentacle of self-modification.** Today the agent can install packages and
add MCP servers via approval-gated tools (`container/agent-runner/src/mcp-tools/self-mod.ts`).
The absent tier is direct source-level edits — the agent draftng a change
to its own `CLAUDE.md`, its own skills, or even its own host code, and the
draft entering the same approval flow that vault attach goes through. The
scaffolding is mostly there: `pending_approvals`, the approver-routing in
`src/modules/approvals/primitive.ts`, the decide endpoint at
`/api/approvals/:id/decide`. What's missing is the diff-presentation surface
in the UI (we have an approval card, but it shows a JSON payload — for
source edits we want a syntax-highlighted diff) and a sandboxed "apply this
draft to a throwaway worktree, run tests, present the result" step before
the human ever sees the approval card.

**OAuth providers beyond Google are the next obvious extension after PR #5,
and the abstraction is currently thin.** The `oauthTools` in
`src/mcp/tools/oauth.ts` and the `/claw/apps` UI route are Google-shaped in
their assumptions (PKCE, the specific scope strings, the callback contract).
A second provider — Notion, Linear, GitHub — will reveal which of those
assumptions are actually generic and which are accidentally Google. Doing
the second provider sooner rather than later is the cheapest way to find
out.

**Pre-1.0 structural simplifications already flagged in
`docs/fresh-start-thinking.md` are the right size for this window.** Move
`assigned_mode` from `secrets` to `agent_groups` (so the assignment lives
where the consumer is, not where the producer is). Drop `secrets.host_pattern`
— it was an OneCLI-era idea that paraclaw never used. Consolidate
`pending_questions` and `pending_approvals` into one table with a `kind`
column — the divergence is purely historical. Retire the `v2-sessions`
naming on the filesystem; we are no longer "v2 of nano-claw," we are
paraclaw. None of these are urgent; all of them get more expensive the
longer we wait.

**The single thing I would not do next is add another channel adapter.**
We have eleven on the `channels` branch, the install skills are stable, and
the marginal value of the twelfth is low compared to closing the
self-modification loop or proving the OAuth abstraction. The temptation is
strong because new channels are crowd-pleasers, but the right move is to
deepen what's there.

— paraclaw-research, 2026-04-28
