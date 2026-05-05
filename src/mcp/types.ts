/**
 * Shared types for paraclaw's MCP server. The registry is one flat list of
 * `ToolDef`s built once per request — both stdio and HTTP transports
 * consume the same registry, with scope-filtering and "disabled" gating
 * applied at advertise time and re-checked at call time.
 *
 * Why factory-style scope context: stdio defaults to `agent:admin` (the
 * caller is the operator on the same machine, ambient trust); HTTP derives
 * the strongest agent scope from the JWT's grant. Both paths flow into a
 * `ToolHandlerContext` so individual tool handlers can refuse mutating ops
 * when the caller only holds `agent:read`.
 */
import type { ClawScope } from '../web/auth.js';

export type { ClawScope };

/**
 * Per-call context handed to a tool handler. `effectiveScope` is the
 * strongest scope the caller has — handlers that mutate state can choose
 * to refuse if it's below their advertised scope (defense-in-depth; the
 * registry already gates list/call by `t.scope`).
 *
 * `callerSubject` is the JWT `sub` for HTTP and a synthetic
 * `mcp:stdio` for the stdio transport. Used by approval-decide-style
 * tools that need an attribution string.
 */
export interface ToolHandlerContext {
  effectiveScope: ClawScope;
  callerSubject: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /**
   * JSON Schema for the tool's input. We pass it straight through to the
   * MCP SDK's tools/list response; the SDK does no validation, so handlers
   * are expected to defensively coerce / validate the args they care about.
   */
  inputSchema: Record<string, unknown>;
  /** Required scope to advertise + invoke. */
  scope: ClawScope;
  /**
   * If set, the tool is advertised in the registry (for human introspection)
   * but filtered out of `tools/list` and refused on `tools/call`. Used for
   * surfaces that depend on paraclaw-server endpoints not yet on this
   * branch — see tools/oauth.ts and tools/activity.ts.
   */
  disabled?: { reason: string };
  handler: (args: Record<string, unknown>, ctx: ToolHandlerContext) => Promise<unknown>;
}
