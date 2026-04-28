/**
 * OAuth-flow MCP tools — currently STUBS. The matching paraclaw-server
 * endpoints (`/api/integrations/*` + the OAuth callback scaffold) haven't
 * landed on this branch yet. Tools are advertised in the registry for
 * human introspection (so the team-lead can see the planned surface) but
 * filtered out of `tools/list` and refused on `tools/call` until then.
 */
import type { ToolDef } from '../types.js';

const PENDING = 'awaiting paraclaw-server: /api/integrations/* + OAuth callback scaffold not yet on this branch';

export const oauthTools: ToolDef[] = [
  {
    name: 'start-oauth',
    description:
      'Kick off an OAuth flow against an external provider (Google, Slack, …). Returns the authorization URL the operator should visit. STUB — disabled until /api/integrations/start lands.',
    scope: 'claw:admin',
    disabled: { reason: PENDING },
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider id, e.g. "google" or "slack".' },
        agentGroupId: { type: 'string', description: 'Agent group to attach the resulting integration to.' },
      },
      required: ['provider', 'agentGroupId'],
      additionalProperties: false,
    },
    handler: async () => {
      throw new Error(`start-oauth disabled: ${PENDING}`);
    },
  },
  {
    name: 'revoke-integration',
    description:
      'Revoke an existing integration (deletes stored OAuth tokens, removes the MCP entry). STUB — disabled until /api/integrations/:id lands.',
    scope: 'claw:admin',
    disabled: { reason: PENDING },
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Integration id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async () => {
      throw new Error(`revoke-integration disabled: ${PENDING}`);
    },
  },
];
