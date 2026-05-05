/**
 * Build a paraclaw MCP server. Same registry serves both transports
 * (stdio + HTTP). Scope-filtering: tools are advertised in `tools/list`
 * only when the caller's effective scope satisfies the tool's required
 * scope (per `hasScope`); `tools/call` re-validates scope + disabled
 * status before invocation.
 *
 * Why one tool list per server (not per registry): the disabled-tool
 * filter is the same code on every server build, so building the list
 * once at construct time is fine. The factory is per-request only on
 * HTTP, where the JWT changes per request.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { hasScope, type AgentScope } from '../web/auth.js';
import type { ToolDef } from './types.js';
import { buildAllTools } from './tools/index.js';

export const MCP_SERVER_NAME = 'parachute-agent';
export const MCP_SERVER_VERSION = '0.1.0';

export interface ServerHooks {
  /** Strongest agent scope the caller has. Used to filter advertise + gate calls. */
  effectiveScope: AgentScope;
  /** JWT `sub` for HTTP, `mcp:stdio` for stdio. Threaded into approval-decide attribution. */
  callerSubject: string;
}

export function buildMcpServer(hooks: ServerHooks): { server: Server; tools: ToolDef[] } {
  const tools = buildAllTools(() => hooks.callerSubject);

  const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools
        .filter((t) => !t.disabled && hasScope([hooks.effectiveScope], t.scope))
        .map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const tool = tools.find((t) => t.name === name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
      };
    }
    if (tool.disabled) {
      return {
        isError: true,
        content: [{ type: 'text', text: `tool disabled: ${tool.disabled.reason}` }],
      };
    }
    if (!hasScope([hooks.effectiveScope], tool.scope)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `insufficient scope: tool '${name}' requires '${tool.scope}', caller has '${hooks.effectiveScope}'`,
          },
        ],
      };
    }
    try {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      const result = await tool.handler(args, {
        effectiveScope: hooks.effectiveScope,
        callerSubject: hooks.callerSubject,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: message }],
      };
    }
  });

  return { server, tools };
}
