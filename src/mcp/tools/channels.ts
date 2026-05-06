/**
 * MCP tools for channel-wire CRUD. Mirrors `/api/channels`.
 *
 * The wire-shape <-> DB-shape translator + patch validator now live in
 * `src/channels/api-translator.ts` (paraclaw#123) and are shared with the
 * HTTP route. See that module for the enum translation contract; this
 * file owns the MCP tool plumbing only.
 *
 * The MCP SDK does NOT enforce `inputSchema` against `tools/call` args
 * before dispatch (see ToolDef.inputSchema in src/mcp/types.ts), so the
 * shared `validatePatchInput` doubles as the defensive gate this handler
 * relied on inline before. paraclaw#94 / PR #122 closed the same
 * silent-coerce class on the HTTP side; #123 brings the MCP side onto
 * the same canonical validator.
 */
import {
  apiToDbPatch,
  type ChannelWireView,
  rowToView,
  validatePatchInput,
  type WireJoinRow,
} from '../../channels/api-translator.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  deleteMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgent,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import type { ToolDef } from '../types.js';

function listAllWires(): ChannelWireView[] {
  return (
    getDb()
      .prepare<WireJoinRow>(
        `SELECT mga.*,
                mg.channel_type AS mg_channel_type,
                mg.platform_id  AS mg_platform_id,
                mg.name         AS mg_name,
                ag.folder       AS ag_folder,
                ag.name         AS ag_name
           FROM messaging_group_agents mga
           JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
           JOIN agent_groups ag     ON ag.id = mga.agent_group_id
          ORDER BY mga.created_at DESC`,
      )
      .all() as WireJoinRow[]
  ).map(rowToView);
}

function getWireView(id: string): ChannelWireView | null {
  const mga = getMessagingGroupAgent(id);
  if (!mga) return null;
  const mg = getMessagingGroup(mga.messaging_group_id);
  const ag = getAgentGroup(mga.agent_group_id);
  if (!mg || !ag) return null;
  return rowToView({
    ...mga,
    mg_channel_type: mg.channel_type,
    mg_platform_id: mg.platform_id,
    mg_name: mg.name,
    ag_folder: ag.folder,
    ag_name: ag.name,
  });
}

export const channelTools: ToolDef[] = [
  {
    name: 'list-channels',
    description:
      'List every channel wire in the install — each row is a (messaging-group → agent-group) routing rule with its engage/sender/policy/priority settings.',
    scope: 'agent:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ wires: listAllWires() }),
  },
  {
    name: 'delete-channel-wire',
    description: 'Delete a channel wire by id. The agent_destinations row created at wire time is left in place.',
    scope: 'agent:admin',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Channel wire id.' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const current = getMessagingGroupAgent(id);
      if (!current) throw new Error(`channel wire not found: ${id}`);
      deleteMessagingGroupAgent(id);
      return { id, deleted: true };
    },
  },
  {
    name: 'update-channel-wire',
    description:
      'Update a channel wire by id. Any subset of engageMode, engagePattern, senderScope, ignoredMessagePolicy, priority can be supplied.',
    scope: 'agent:admin',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        engageMode: { type: 'string', enum: ['mention', 'pattern', 'all'] },
        engagePattern: { type: ['string', 'null'] },
        senderScope: { type: 'string', enum: ['allowlist', 'unrestricted'] },
        ignoredMessagePolicy: { type: 'string', enum: ['drop', 'silent'] },
        priority: { type: 'number' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = String(args.id ?? '');
      const current = getMessagingGroupAgent(id);
      if (!current) throw new Error(`channel wire not found: ${id}`);

      // validatePatchInput inspects only the fields it knows; `id` and any
      // future-compat keys are ignored. On `ok: false`, throw the reason —
      // the HTTP route does the same translation on its end (400 + JSON
      // error). Both surfaces now share the same rejection contract,
      // including the engagePattern='.' sentinel guard.
      const validated = validatePatchInput(args);
      if (!validated.ok) throw new Error(validated.reason);

      const patch = apiToDbPatch(validated.input, current);
      updateMessagingGroupAgent(id, patch);
      const after = getWireView(id);
      if (!after) throw new Error(`channel wire ${id} disappeared after update`);
      return { wire: after };
    },
  },
];
