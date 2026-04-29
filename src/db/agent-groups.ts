import type { AgentGroup, SecretMode } from '../types.js';
import { getDb } from './connection.js';

export function createAgentGroup(group: Omit<AgentGroup, 'secret_mode'> & { secret_mode?: SecretMode }): void {
  getDb()
    .prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, secret_mode, created_at)
       VALUES (@id, @name, @folder, @agent_provider, @secret_mode, @created_at)`,
    )
    .run({ ...group, secret_mode: group.secret_mode ?? 'selective' });
}

export function getAgentGroupSecretMode(agentGroupId: string): SecretMode | undefined {
  const row = getDb()
    .prepare<{ secret_mode: SecretMode }>('SELECT secret_mode FROM agent_groups WHERE id = ?')
    .get(agentGroupId);
  return row?.secret_mode;
}

/**
 * Batched read for callers building list views — avoids the per-row SELECT
 * that `toView` would otherwise fan out into. Returns a Map keyed by group
 * id; missing ids simply aren't in the map (callers fall back to the
 * `'selective'` default the same way the single-row helper does).
 */
export function getAgentGroupSecretModes(agentGroupIds: readonly string[]): Map<string, SecretMode> {
  const result = new Map<string, SecretMode>();
  if (agentGroupIds.length === 0) return result;
  const placeholders = agentGroupIds.map(() => '?').join(',');
  const rows = getDb()
    .prepare<{ id: string; secret_mode: SecretMode }>(
      `SELECT id, secret_mode FROM agent_groups WHERE id IN (${placeholders})`,
    )
    .all(...agentGroupIds);
  for (const r of rows) result.set(r.id, r.secret_mode);
  return result;
}

export function setAgentGroupSecretMode(agentGroupId: string, mode: SecretMode): void {
  getDb().prepare('UPDATE agent_groups SET secret_mode = @mode WHERE id = @id').run({ id: agentGroupId, mode });
}

export function getAgentGroup(id: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE id = ?').get(id) as AgentGroup | undefined;
}

export function getAgentGroupByFolder(folder: string): AgentGroup | undefined {
  return getDb().prepare('SELECT * FROM agent_groups WHERE folder = ?').get(folder) as AgentGroup | undefined;
}

export function getAllAgentGroups(): AgentGroup[] {
  return getDb().prepare('SELECT * FROM agent_groups ORDER BY name').all() as AgentGroup[];
}

export function updateAgentGroup(
  id: string,
  updates: Partial<Pick<AgentGroup, 'name' | 'agent_provider' | 'secret_mode'>>,
): void {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  getDb()
    .prepare(`UPDATE agent_groups SET ${fields.join(', ')} WHERE id = @id`)
    .run(values);
}

export function deleteAgentGroup(id: string): void {
  getDb().prepare('DELETE FROM agent_groups WHERE id = ?').run(id);
}
