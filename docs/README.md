# parachute-agent Documentation

Reference for engineers working on or integrating with parachute-agent (formerly paraclaw). Read [`architecture.md`](architecture.md) first — it covers the primitives, runtime model, schema, and trust zones in one place.

## Map

| Document | What's in it |
|---|---|
| [architecture.md](architecture.md) | Primitives, schema, runtime model, trust zones, integration with Parachute |
| [architecture-diagram.md](architecture-diagram.md) | Visual breakdown of the host ↔ container split |
| [parachute-integration.md](parachute-integration.md) | How parachute-agent plugs into the Parachute hub: install, OAuth, vault attachments |
| [isolation-model.md](isolation-model.md) | The three-level isolation model (channel × messaging group × agent group × session) |
| [SECURITY.md](SECURITY.md) | Threat model, AES-GCM secrets, master-key bootstrap, audit surface |
| [api-details.md](api-details.md) | `/api/*` route catalogue with request/response shapes |
| [agent-runner-details.md](agent-runner-details.md) | Container-side runtime: poll loop, MCP tools, provider abstraction |
| [build-and-runtime.md](build-and-runtime.md) | Bun-on-host, Bun-in-container split — why two runtimes, how they communicate |
| [db.md](db.md) | The three-database model (central + per-session inbound/outbound) |
| [db-central.md](db-central.md) | Central DB schema reference (`~/.parachute/agent/agent.db`) |
| [db-session.md](db-session.md) | Per-session DB schema reference (`inbound.db` + `outbound.db`) |
| [docker-sandboxes.md](docker-sandboxes.md) | Optional micro-VM isolation via Docker Sandboxes |
| [APPLE-CONTAINER-NETWORKING.md](APPLE-CONTAINER-NETWORKING.md) | macOS-native runtime via Apple Container |
| [ollama.md](ollama.md) | Local open-weight model provider via Ollama |
| [SDK_DEEP_DIVE.md](SDK_DEEP_DIVE.md) | Claude Agent SDK integration patterns |
| [BRANCH-FORK-MAINTENANCE.md](BRANCH-FORK-MAINTENANCE.md) | Living-on-a-fork workflow (channels + providers branches) |
| [cross-mount-stress/](cross-mount-stress/) | Empirical proof of the SQLite cross-mount invariants — why we don't collapse the per-session two-file split |
