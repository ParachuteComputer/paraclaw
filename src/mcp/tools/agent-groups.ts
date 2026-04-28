/**
 * MCP tools for the agent-group surface — list / get / create. Mirrors what
 * the web UI exposes at `/api/groups/*`, but calls the internal helpers
 * directly rather than HTTP-round-tripping.
 *
 * Vault attach is exposed as a separate `attach-vault` tool because the
 * input shape is meaningfully different (token + scope + label, not a
 * simple group field). It refuses unknown groups with a structured error
 * rather than silently no-op'ing — the test suite leans on that contract.
 */
import {
  attachVaultToGroup,
  detachVaultFromGroup,
  readVaultAttachment,
  DEFAULT_VAULT_MCP_NAME,
} from '../../parachute/vault-mcp.js';
import type { VaultScope } from '../../parachute/types.js';
import { getAgentGroup, getAgentGroupByFolder, getAllAgentGroups } from '../../db/agent-groups.js';
import { createParachuteAgentGroup, isFolderTaken, validateFolderSlug } from '../../parachute/create-agent.js';
import { getGroupStatus } from '../../parachute/group-status.js';
import type { ToolDef } from '../types.js';

function viewForGroup(folder: string): Record<string, unknown> | null {
  const row = getAgentGroupByFolder(folder);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    folder: row.folder,
    agentProvider: row.agent_provider,
    createdAt: row.created_at,
    vault: readVaultAttachment(row.folder),
    status: getGroupStatus(row.folder),
  };
}

const VALID_VAULT_SCOPES: VaultScope[] = ['vault:read', 'vault:write', 'vault:admin'];

export const agentGroupTools: ToolDef[] = [
  {
    name: 'list-agent-groups',
    description:
      'List every agent group (workspace) in the install. Returns id, folder, name, agent provider, vault attachment, and live status (alive sessions, container state).',
    scope: 'claw:read',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => {
      return {
        groups: getAllAgentGroups().map((row) => ({
          id: row.id,
          name: row.name,
          folder: row.folder,
          agentProvider: row.agent_provider,
          createdAt: row.created_at,
          vault: readVaultAttachment(row.folder),
          status: getGroupStatus(row.folder),
        })),
      };
    },
  },
  {
    name: 'get-agent-group',
    description:
      'Look up a single agent group by folder slug. Same view shape as list-agent-groups. Returns null when the folder is unknown.',
    scope: 'claw:read',
    inputSchema: {
      type: 'object',
      properties: { folder: { type: 'string', description: 'Folder slug, e.g. "my-agent".' } },
      required: ['folder'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const folder = String(args.folder ?? '').trim();
      if (!folder) throw new Error('folder is required');
      const view = viewForGroup(folder);
      if (!view) throw new Error(`agent group not found: ${folder}`);
      return view;
    },
  },
  {
    name: 'create-agent-group',
    description:
      'Create a new agent group. Validates the folder slug, refuses duplicates, writes the DB row, and scaffolds the per-group filesystem (CLAUDE.md, container.json, …).',
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name.' },
        folder: { type: 'string', description: 'URL-safe slug (kebab-case).' },
        instructions: { type: 'string', description: 'Optional CLAUDE.md content for the group.' },
      },
      required: ['name', 'folder'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = String(args.name ?? '').trim();
      const folder = String(args.folder ?? '').trim();
      if (!name) throw new Error('name is required');
      const folderCheck = validateFolderSlug(folder);
      if (!folderCheck.ok) throw new Error(`invalid folder: ${folderCheck.reason}`);
      if (isFolderTaken(folder)) throw new Error(`folder already exists: ${folder}`);
      const instructions = typeof args.instructions === 'string' ? args.instructions : undefined;
      const result = createParachuteAgentGroup({ name, folder, instructions });
      return {
        group: {
          id: result.group.id,
          name: result.group.name,
          folder: result.group.folder,
          agentProvider: result.group.agent_provider,
          createdAt: result.group.created_at,
        },
      };
    },
  },
  {
    name: 'attach-vault',
    description:
      "Attach a Parachute Vault to an agent group as an MCP server. Writes the entry into the group's container.json and records the attachment in parachute.json. The vault token must already be minted.",
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Agent group folder slug.' },
        vaultBaseUrl: { type: 'string', description: 'Vault base URL, no trailing slash, no /mcp suffix.' },
        vaultToken: { type: 'string', description: 'pvt_… token to bake into the MCP entry.' },
        scope: {
          type: 'string',
          enum: VALID_VAULT_SCOPES,
          description: 'Scope this token was minted at.',
        },
        tokenLabel: { type: 'string', description: 'Token label (matches vault registration).' },
        mcpName: { type: 'string', description: 'Optional MCP entry name. Defaults to "parachute-vault".' },
        instructions: { type: 'string', description: 'Optional in-context instructions for the agent.' },
      },
      required: ['folder', 'vaultBaseUrl', 'vaultToken', 'scope', 'tokenLabel'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const folder = String(args.folder ?? '').trim();
      if (!folder) throw new Error('folder is required');
      if (!getAgentGroupByFolder(folder)) throw new Error(`agent group not found: ${folder}`);
      const scope = String(args.scope ?? '');
      if (!VALID_VAULT_SCOPES.includes(scope as VaultScope)) {
        throw new Error(`invalid scope: ${scope}`);
      }
      attachVaultToGroup({
        folder,
        vaultBaseUrl: String(args.vaultBaseUrl ?? '').replace(/\/+$/, ''),
        vaultToken: String(args.vaultToken ?? ''),
        scope: scope as VaultScope,
        tokenLabel: String(args.tokenLabel ?? ''),
        mcpName: typeof args.mcpName === 'string' ? args.mcpName : undefined,
        instructions: typeof args.instructions === 'string' ? args.instructions : undefined,
      });
      const mcpName = typeof args.mcpName === 'string' ? args.mcpName : DEFAULT_VAULT_MCP_NAME;
      return { vault: readVaultAttachment(folder, mcpName) };
    },
  },
  {
    name: 'detach-vault',
    description:
      "Detach a previously attached vault from an agent group. Removes the MCP entry from container.json and the attach record from parachute.json. Does NOT revoke the vault token — that's a separate action against the vault.",
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: {
        folder: { type: 'string', description: 'Agent group folder slug.' },
        mcpName: { type: 'string', description: 'Optional MCP entry name. Defaults to "parachute-vault".' },
      },
      required: ['folder'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const folder = String(args.folder ?? '').trim();
      if (!folder) throw new Error('folder is required');
      if (!getAgentGroup(folder) && !getAgentGroupByFolder(folder)) {
        throw new Error(`agent group not found: ${folder}`);
      }
      const mcpName = typeof args.mcpName === 'string' ? args.mcpName : DEFAULT_VAULT_MCP_NAME;
      detachVaultFromGroup(folder, mcpName);
      return { detached: true, folder, mcpName };
    },
  },
];
