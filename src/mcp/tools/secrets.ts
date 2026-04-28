/**
 * MCP tools for the secret store. Mirrors `/api/secrets` (and the matching
 * UI under `/claw/secrets`), with one important wrinkle: the MCP surface
 * NEVER returns plaintext values. Even on `put-secret`, the response only
 * carries the row id + metadata — the value flows in once over the
 * transport, lands in the encrypted DB column, and is read back only by
 * the container-runner at session-spawn time.
 *
 * `assign-secret` is advertised but disabled until paraclaw-server lands
 * the matching `/api/secrets/:id/assignments` endpoints + `secret_assignments`
 * table on this branch. See PENDING_REASON below.
 */
import {
  type AssignedMode,
  type SecretKind,
  type SecretRow,
  deleteSecret,
  listSecrets,
  putSecret,
} from '../../secrets/index.js';
import type { ToolDef } from '../types.js';

const ALLOWED_KINDS: SecretKind[] = ['channel-token', 'api-key', 'generic'];
const ALLOWED_MODES: AssignedMode[] = ['all', 'selective'];

interface SecretView {
  id: string;
  name: string;
  kind: SecretKind;
  agentGroupId: string | null;
  assignedMode: AssignedMode;
  createdAt: string;
  updatedAt: string;
}

function toView(r: SecretRow): SecretView {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    agentGroupId: r.agent_group_id,
    assignedMode: r.assigned_mode,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const ASSIGN_PENDING =
  'awaiting paraclaw-server: /api/secrets/:id/assignments + secret_assignments table not yet on this branch';

export const secretTools: ToolDef[] = [
  {
    name: 'list-secrets',
    description:
      'List secret metadata. NEVER returns plaintext values. Optional `agentGroupId` filter: empty string = global only; non-empty = global + that scope.',
    scope: 'claw:read',
    inputSchema: {
      type: 'object',
      properties: {
        agentGroupId: { type: ['string', 'null'], description: 'Optional filter; empty/null = global only.' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      let scope: string | null | undefined = undefined;
      if (args.agentGroupId === null || args.agentGroupId === '') scope = null;
      else if (typeof args.agentGroupId === 'string') scope = args.agentGroupId;
      return { secrets: listSecrets(scope).map(toView) };
    },
  },
  {
    name: 'put-secret',
    description:
      'Insert or update a secret by (name, agentGroupId). Returns the row metadata — never the plaintext. The value is AES-256-GCM encrypted in-process before landing in the DB.',
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        value: { type: 'string', description: 'Plaintext value. Encrypted before storage; never logged.' },
        kind: { type: 'string', enum: ALLOWED_KINDS, description: 'Defaults to "generic".' },
        agentGroupId: {
          type: ['string', 'null'],
          description: 'null = global; non-empty = scoped to that agent group.',
        },
        assignedMode: {
          type: 'string',
          enum: ALLOWED_MODES,
          description:
            '"all" = injected into every group; "selective" = only into groups in secret_assignments. Defaults to "all".',
        },
      },
      required: ['name', 'value'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const name = String(args.name ?? '').trim();
      const value = typeof args.value === 'string' ? args.value : '';
      if (!name) throw new Error('name is required');
      if (!value) throw new Error('value is required');
      const kind = (typeof args.kind === 'string' ? args.kind : 'generic') as SecretKind;
      if (!ALLOWED_KINDS.includes(kind)) throw new Error(`invalid kind: ${kind}`);
      const mode = (typeof args.assignedMode === 'string' ? args.assignedMode : 'all') as AssignedMode;
      if (!ALLOWED_MODES.includes(mode)) throw new Error(`invalid assignedMode: ${mode}`);
      const agentGroupId = typeof args.agentGroupId === 'string' && args.agentGroupId.length ? args.agentGroupId : null;

      const id = putSecret(name, value, { kind, agent_group_id: agentGroupId, assigned_mode: mode });
      const row = listSecrets(agentGroupId).find((r) => r.id === id);
      if (!row) throw new Error(`secret ${id} disappeared after write`);
      return { secret: toView(row) };
    },
  },
  {
    name: 'delete-secret',
    description: 'Delete a secret by id. Returns { deleted: true } on success, throws on unknown id.',
    scope: 'claw:admin',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const id = String(args.id ?? '');
      if (!id) throw new Error('id is required');
      const ok = deleteSecret(id);
      if (!ok) throw new Error(`secret not found: ${id}`);
      return { id, deleted: true };
    },
  },
  {
    name: 'assign-secret',
    description:
      "Assign a 'selective' secret to one or more agent groups. STUB — disabled until paraclaw-server's secret_assignments endpoints land on this branch.",
    scope: 'claw:admin',
    disabled: { reason: ASSIGN_PENDING },
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Secret id.' },
        agentGroupIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Agent group ids to inject the secret into.',
        },
      },
      required: ['id', 'agentGroupIds'],
      additionalProperties: false,
    },
    handler: async () => {
      throw new Error(`assign-secret disabled: ${ASSIGN_PENDING}`);
    },
  },
];
