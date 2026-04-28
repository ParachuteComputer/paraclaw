/**
 * HTTP MCP transport. Mounted at `/mcp` in `src/web/server.ts`.
 *
 * Auth: hub-issued JWT via `authenticate()` — same seam every other
 * `/api/*` route uses. The strongest claw scope on the token's grant
 * becomes the server's `effectiveScope`, which gates `tools/list` +
 * `tools/call`. We require at minimum `claw:read` to even open the
 * MCP session — without it there's nothing to advertise.
 *
 * Stateless mode: a fresh server + transport pair per HTTP request,
 * with `sessionIdGenerator: undefined`. Each invocation closes its
 * server in `finally` so we don't leak Protocol instances. The cost
 * is one Server allocation per call; the win is no shared session
 * map to evict from.
 */
import http from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { authenticate, type ClawScope } from '../web/auth.js';
import { log } from '../log.js';
import { buildMcpServer } from './server.js';

function pickEffectiveScope(grantedScopes: string[]): ClawScope {
  if (grantedScopes.includes('claw:admin') || grantedScopes.includes('vault:admin')) return 'claw:admin';
  if (grantedScopes.includes('claw:write')) return 'claw:write';
  return 'claw:read';
}

export async function handleMcpHttp(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedBody?: unknown,
): Promise<void> {
  const auth = await authenticate(req.headers.authorization, 'claw:read');
  if (!auth.ok) {
    res.writeHead(auth.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: auth.error }));
    return;
  }

  const effectiveScope = pickEffectiveScope(auth.claims.scopes);
  const { server } = buildMcpServer({
    effectiveScope,
    callerSubject: auth.claims.sub,
  });

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  } catch (err) {
    log.error('mcp http handler failed', { error: err instanceof Error ? err.message : String(err) });
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal mcp error' }));
    }
  } finally {
    await server.close().catch(() => {
      // best-effort; the request is already done
    });
  }
}
