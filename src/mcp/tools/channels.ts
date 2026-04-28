/**
 * MCP tools for channel-wire CRUD. Mirrors `/api/channels`. The DB still
 * stores the pre-rebuild enum names (engage_mode = mention | pattern |
 * mention-sticky; sender_scope = all | known; ignored_message_policy = drop
 * | accumulate); the API contract these tools speak — same as the web API —
 * uses the new vocabulary (engageMode = mention | pattern | all; senderScope
 * = allowlist | all; ignoredMessagePolicy = drop | silent). The translator
 * is small so we inline it here rather than carving out a shared module
 * that would need its own seam through the route handler.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  deleteMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgent,
  updateMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import type {
  EngageMode as DbEngageMode,
  IgnoredMessagePolicy as DbIgnoredMessagePolicy,
  SenderScope as DbSenderScope,
  MessagingGroupAgent,
} from '../../types.js';
import type { ToolDef } from '../types.js';

type ApiEngageMode = 'mention' | 'pattern' | 'all';
type ApiSenderScope = 'allowlist' | 'all';
type ApiIgnoredMessagePolicy = 'drop' | 'silent';

const ALL_PATTERN = '.';

function dbToApiEngage(mode: DbEngageMode, pattern: string | null): ApiEngageMode {
  if (mode === 'pattern') return pattern === ALL_PATTERN ? 'all' : 'pattern';
  return 'mention';
}
function dbToApiSenderScope(s: DbSenderScope): ApiSenderScope {
  return s === 'known' ? 'allowlist' : 'all';
}
function dbToApiIgnoredPolicy(p: DbIgnoredMessagePolicy): ApiIgnoredMessagePolicy {
  return p === 'accumulate' ? 'silent' : 'drop';
}

interface WireRow extends MessagingGroupAgent {
  mg_channel_type: string;
  mg_platform_id: string;
  mg_name: string | null;
  ag_folder: string;
  ag_name: string;
}

interface ChannelWireView {
  id: string;
  channelType: string;
  messagingGroupId: string;
  platformId: string;
  displayName: string | null;
  agentGroupId: string;
  agentGroupFolder: string;
  agentGroupName: string;
  engageMode: ApiEngageMode;
  engagePattern: string | null;
  senderScope: ApiSenderScope;
  ignoredMessagePolicy: ApiIgnoredMessagePolicy;
  priority: number;
  createdAt: string;
}

function rowToView(row: WireRow): ChannelWireView {
  return {
    id: row.id,
    channelType: row.mg_channel_type,
    messagingGroupId: row.messaging_group_id,
    platformId: row.mg_platform_id,
    displayName: row.mg_name,
    agentGroupId: row.agent_group_id,
    agentGroupFolder: row.ag_folder,
    agentGroupName: row.ag_name,
    engageMode: dbToApiEngage(row.engage_mode, row.engage_pattern),
    engagePattern: row.engage_mode === 'pattern' && row.engage_pattern !== ALL_PATTERN ? row.engage_pattern : null,
    senderScope: dbToApiSenderScope(row.sender_scope),
    ignoredMessagePolicy: dbToApiIgnoredPolicy(row.ignored_message_policy),
    priority: row.priority,
    createdAt: row.created_at,
  };
}

function listAllWires(): ChannelWireView[] {
  return (
    getDb()
      .prepare<WireRow>(
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
      .all() as WireRow[]
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
    scope: 'claw:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => ({ wires: listAllWires() }),
  },
  {
    name: 'delete-channel-wire',
    description: 'Delete a channel wire by id. The agent_destinations row created at wire time is left in place.',
    scope: 'claw:admin',
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
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        engageMode: { type: 'string', enum: ['mention', 'pattern', 'all'] },
        engagePattern: { type: ['string', 'null'] },
        senderScope: { type: 'string', enum: ['allowlist', 'all'] },
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
      const patch: Partial<MessagingGroupAgent> = {};
      if (args.engageMode === 'all') {
        patch.engage_mode = 'pattern';
        patch.engage_pattern = ALL_PATTERN;
      } else if (args.engageMode === 'pattern') {
        patch.engage_mode = 'pattern';
        if (typeof args.engagePattern === 'string' && args.engagePattern !== ALL_PATTERN) {
          patch.engage_pattern = args.engagePattern;
        }
      } else if (args.engageMode === 'mention') {
        patch.engage_mode = current.engage_mode === 'mention-sticky' ? 'mention-sticky' : 'mention';
        patch.engage_pattern = null;
      } else if (typeof args.engagePattern === 'string' || args.engagePattern === null) {
        patch.engage_pattern = args.engagePattern as string | null;
      }
      if (args.senderScope === 'allowlist') patch.sender_scope = 'known';
      else if (args.senderScope === 'all') patch.sender_scope = 'all';
      if (args.ignoredMessagePolicy === 'silent') patch.ignored_message_policy = 'accumulate';
      else if (args.ignoredMessagePolicy === 'drop') patch.ignored_message_policy = 'drop';
      if (typeof args.priority === 'number' && Number.isFinite(args.priority)) patch.priority = args.priority;
      updateMessagingGroupAgent(id, patch);
      const after = getWireView(id);
      if (!after) throw new Error(`channel wire ${id} disappeared after update`);
      return { wire: after };
    },
  },
];
