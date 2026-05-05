#!/usr/bin/env bun
/**
 * stdio MCP transport entrypoint. Wired with `claude mcp add parachute-agent
 * bun /path/to/parachute-agent/src/mcp/stdio.ts`.
 *
 * Stdio is a same-machine ambient-trust surface — the operator already has
 * filesystem access, so we default to `agent:admin`. No JWT, no per-call
 * auth.
 *
 * Stdout discipline: parachute-agent's `log.ts` writes info-level messages to
 * `process.stdout`, which would corrupt the JSON-RPC stream the SDK
 * speaks over stdout. We promote LOG_LEVEL to 'warn' BEFORE any module
 * that uses `log` is loaded — dynamic imports below — so the logger
 * never writes a line that isn't a JSON-RPC frame.
 */
if (!process.env.LOG_LEVEL || ['debug', 'info'].includes(process.env.LOG_LEVEL)) {
  process.env.LOG_LEVEL = 'warn';
}

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { initDb } = await import('../db/connection.js');
const { runMigrations } = await import('../db/migrations/index.js');
const { CENTRAL_DB_PATH } = await import('../config.js');
const { buildMcpServer } = await import('./server.js');

const STDIO_USER_ID = 'mcp:stdio';

async function main(): Promise<void> {
  // Open the central DB read-write so admin tools (create-agent-group,
  // put-secret, decide-approval) can mutate. The host process owns the
  // sole writer in production, but stdio is operator-driven and run
  // out-of-band — concurrent writers are tolerable for the human-paced
  // stdio path. Pragmas (WAL, busy_timeout) are set in `connection.ts`.
  const db = initDb(CENTRAL_DB_PATH);
  runMigrations(db);

  const { server } = buildMcpServer({
    effectiveScope: 'agent:admin',
    callerSubject: STDIO_USER_ID,
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(
    `parachute-agent mcp stdio fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
  );
  process.exit(1);
});
