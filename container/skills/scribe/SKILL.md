---
name: scribe
description: Transcribe audio to text using parachute-scribe. Use whenever the user shares an audio file (voice memo, meeting recording, podcast clip, .mp3/.m4a/.wav/.flac) or asks for speech-to-text. Calls scribe's HTTP API via curl using a pre-injected SCRIBE_TOKEN.
allowed-tools: Bash(curl:*)
---

# Scribe — Audio Transcription via REST

Scribe is a Parachute service that exposes a Whisper-compatible HTTP API. You call it directly with `curl` — no MCP server, no SDK. The operator pre-injects a `SCRIBE_TOKEN` environment variable so you authenticate without ever seeing the token's value.

## When to use

- The user uploads or links an audio file (`.mp3`, `.m4a`, `.wav`, `.flac`, `.ogg`, etc.) and wants the contents.
- The user asks "what's said in this recording?", "transcribe this voice memo", "summarize this podcast" — any request that requires understanding spoken audio.
- Even when not asked explicitly: if a downstream step (search, summary, translation) needs the text and only audio is available, transcribe first.

## Prerequisites

`SCRIBE_TOKEN` must be set in your environment — a hub-issued JWT (or shared-secret token) carrying the `scribe:transcribe` scope.

```bash
[ -n "${SCRIBE_TOKEN}" ] && echo "ready" || echo "missing"
```

If missing: tell the user that scribe isn't available, and add: *"Operator: add SCRIBE_TOKEN via /agent/secrets, or run `parachute auth mint-token scribe:transcribe` and paste the result as a new secret."* Don't try to mint or rotate the token yourself — you have no path to.

## Endpoint

`SCRIBE_URL` if set, otherwise compute from `PARACHUTE_HUB_ORIGIN` (the host injects this into every container — the loopback case is rewritten to `host.docker.internal` so it's always reachable from inside Docker, see paraclaw#142):

```bash
SCRIBE_URL="${SCRIBE_URL:-${PARACHUTE_HUB_ORIGIN}/scribe}"
```

Verify reachability before the first transcribe of a session:

```bash
curl -fsS "${SCRIBE_URL}/health"
# → {"ok":true}
```

## Operations

### 1. Transcribe a local audio file

```bash
curl -fsS -X POST "${SCRIBE_URL}/v1/audio/transcriptions" \
  -H "Authorization: Bearer ${SCRIBE_TOKEN}" \
  -F "file=@/workspace/agent/voice-memo.m4a"
```

Response shape (synchronous — scribe blocks until done, no job polling):

```json
{ "text": "Hey, just wanted to record a quick thought about the project..." }
```

### 2. Transcribe with cleanup off (raw output)

By default scribe runs an LLM cleanup pass — punctuation, filler-word removal, capitalization. Pass `cleanup=false` to get the raw transcript:

```bash
curl -fsS -X POST "${SCRIBE_URL}/v1/audio/transcriptions" \
  -H "Authorization: Bearer ${SCRIBE_TOKEN}" \
  -F "file=@/workspace/agent/recording.wav" \
  -F "cleanup=false"
```

Use raw mode when:
- You want the original disfluencies preserved (linguistic analysis, accessibility transcript).
- The user explicitly asks for "verbatim" or "as-spoken".

### 3. Transcribe with proper-noun context

Cleanup uses an LLM that doesn't know your domain. To fix proper-noun spelling (people, products, jargon), pass a `context` JSON payload:

```bash
curl -fsS -X POST "${SCRIBE_URL}/v1/audio/transcriptions" \
  -H "Authorization: Bearer ${SCRIBE_TOKEN}" \
  -F "file=@/workspace/agent/standup.m4a" \
  -F 'context={"entries":[
    {"name":"Margaret","aliases":["Marg","Maggie"]},
    {"name":"Learn Vibe Build","aliases":["LVB"]},
    {"name":"parachute-agent"}
  ]}'
```

Each entry needs `name` (canonical spelling); `aliases` and any other free-form fields (`summary`, role hints) help the cleanup LLM disambiguate. Pull entries from your group memory (`CLAUDE.local.md`, contact files, project files) before transcribing meetings or anything name-heavy — that's where the value compounds.

### 4. List configured models

```bash
curl -fsS "${SCRIBE_URL}/v1/models" \
  -H "Authorization: Bearer ${SCRIBE_TOKEN}"
```

Most installs run a single transcription model — you don't pass `model` in the transcribe request; scribe routes to whatever the operator configured.

## Failure modes

| Status | Meaning | What to tell the user |
|--------|---------|------------------------|
| **400** `missing 'file' field` | Multipart form-data missing the `file` part | Internal — fix the curl invocation |
| **401** `unauthorized` | Token missing, expired, or rejected | *"Scribe rejected my token. Operator: rotate `SCRIBE_TOKEN` in `/agent/secrets`."* |
| **403** `insufficient_scope` | Token valid but lacks `scribe:transcribe` | *"My scribe token doesn't have transcribe access. Operator: re-mint with `scribe:transcribe` scope."* |
| **404** | Wrong URL or scribe daemon not running | *"Scribe isn't reachable at ${SCRIBE_URL}. Operator: `parachute start scribe` (or check the install)."* |
| **500** | Transcription provider error (model crashed, audio unreadable) | *"Scribe couldn't process this audio — the file may be corrupt or in an unsupported format. Try re-encoding to mp3 or wav."* |
| Connection refused | Daemon down or wrong port | Same as 404 |

When you hit 401 / 403 / 404 once, **stop retrying** — these are operator-action failures, not transient. Surface the situation to the user once, clearly, and move on. Don't burn turns on hopeless retries.

## What scribe does NOT do

- **No async jobs.** Every call blocks until done; there's no `job_id` and no `/jobs/:id` endpoint. If a file is large enough that you're worried about timeouts, warn the user before starting.
- **No URL ingest.** Scribe takes the file bytes via multipart only. If the audio is at a URL, download to `/workspace/agent/` first (use existing tools — `curl`, `agent-browser`), then transcribe the local file.
- **No language hint.** The current API has no `language` form field; the model auto-detects.
- **No streaming response.** You get the full transcript in one JSON body when scribe is done.

## Tone for results

When you return the transcript:
- Lead with the content the user asked for — not "I successfully transcribed your audio."
- Quote the transcript directly when it's short; summarize first + offer the full text when it's long.
- Save useful one-time transcripts under `/workspace/agent/transcripts/<date>-<slug>.md` so future sessions can search them. Add a one-line index entry to `CLAUDE.local.md` if it's reference-grade.
