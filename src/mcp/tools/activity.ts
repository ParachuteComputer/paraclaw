/**
 * Activity-log MCP tool — STUB. The matching paraclaw-server work
 * (`agent_activity` table + the ingest path that populates it from
 * agent-runner tool invocations) hasn't landed on this branch yet. Tool
 * is advertised in the registry for human introspection and filtered
 * out of `tools/list` until then.
 */
import type { ToolDef } from '../types.js';

const PENDING = 'awaiting paraclaw-server: agent_activity table + ingest path not yet on this branch';

export const activityTools: ToolDef[] = [
  {
    name: 'get-activity',
    description:
      'Stream recent agent tool-invocations across the install. STUB — disabled until the agent_activity table + ingest land.',
    scope: 'claw:read',
    disabled: { reason: PENDING },
    inputSchema: {
      type: 'object',
      properties: {
        agentGroupId: { type: 'string', description: 'Optional agent group filter.' },
        sessionId: { type: 'string', description: 'Optional session filter.' },
        limit: { type: 'number', description: 'Max rows. Defaults to 100.' },
      },
      additionalProperties: false,
    },
    handler: async () => {
      throw new Error(`get-activity disabled: ${PENDING}`);
    },
  },
];
