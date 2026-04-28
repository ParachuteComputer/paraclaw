/**
 * Public API for paraclaw's secret store. Replaces OneCLI as the host's
 * credential dependency. Values are AES-256-GCM encrypted in-process before
 * landing in the central DB; decrypted only when injected into per-session
 * containers (`src/container-runner.ts`).
 *
 * Naming: a secret is keyed by `(name, agent_group_id)`. A NULL agent_group_id
 * is global — visible to any agent group when its host_pattern matches.
 * A non-NULL agent_group_id scopes the secret to that group only.
 *
 * Resolution preference at injection time: agent-scoped secret with that
 * name beats the global one. The host walks both rows and the scoped wins.
 */
import crypto from 'crypto';

import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { decryptSecret, encryptSecret } from './crypto.js';
import { loadOrCreateMasterKey } from './master-key.js';

export type SecretKind = 'channel-token' | 'api-key' | 'generic';
export type AssignedMode = 'all' | 'selective';

export interface SecretRow {
  id: string;
  name: string;
  kind: SecretKind;
  agent_group_id: string | null;
  assigned_mode: AssignedMode;
  host_pattern: string | null;
  created_at: string;
  updated_at: string;
}

export interface PutSecretOpts {
  kind?: SecretKind;
  agent_group_id?: string | null;
  assigned_mode?: AssignedMode;
  host_pattern?: string | null;
}

interface RawRow extends SecretRow {
  value_encrypted: string;
}

function db(): Database {
  return getDb();
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Insert or update a secret. Returns the row's id. */
export function putSecret(name: string, value: string, opts: PutSecretOpts = {}): string {
  const key = loadOrCreateMasterKey();
  const ct = encryptSecret(value, key);
  const agentGroupId = opts.agent_group_id ?? null;
  const kind = opts.kind ?? 'generic';
  const mode = opts.assigned_mode ?? 'all';
  const hostPattern = opts.host_pattern ?? null;

  const existing = db()
    .prepare<{ id: string }>(`SELECT id FROM secrets WHERE name = @name AND agent_group_id IS @agent_group_id`)
    .get({ name, agent_group_id: agentGroupId });

  const now = nowIso();
  if (existing) {
    db()
      .prepare(
        `UPDATE secrets
            SET value_encrypted = @value_encrypted,
                kind            = @kind,
                assigned_mode   = @assigned_mode,
                host_pattern    = @host_pattern,
                updated_at      = @updated_at
          WHERE id = @id`,
      )
      .run({
        id: existing.id,
        value_encrypted: ct,
        kind,
        assigned_mode: mode,
        host_pattern: hostPattern,
        updated_at: now,
      });
    return existing.id;
  }

  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO secrets
         (id, name, value_encrypted, kind, agent_group_id, assigned_mode, host_pattern, created_at, updated_at)
       VALUES
         (@id, @name, @value_encrypted, @kind, @agent_group_id, @assigned_mode, @host_pattern, @created_at, @updated_at)`,
    )
    .run({
      id,
      name,
      value_encrypted: ct,
      kind,
      agent_group_id: agentGroupId,
      assigned_mode: mode,
      host_pattern: hostPattern,
      created_at: now,
      updated_at: now,
    });
  return id;
}

/**
 * Decrypt and return a secret's plaintext value. Returns undefined if the
 * named secret does not exist for the given scope. Resolution: an
 * agent-scoped secret beats a global one with the same name.
 */
export function getSecret(name: string, agentGroupId?: string | null): string | undefined {
  const key = loadOrCreateMasterKey();
  const scoped = agentGroupId
    ? db()
        .prepare<RawRow>(`SELECT * FROM secrets WHERE name = @name AND agent_group_id = @agent_group_id`)
        .get({ name, agent_group_id: agentGroupId })
    : undefined;
  const row =
    scoped ?? db().prepare<RawRow>(`SELECT * FROM secrets WHERE name = @name AND agent_group_id IS NULL`).get({ name });
  if (!row) return undefined;
  return decryptSecret(row.value_encrypted, key);
}

/** Names + metadata only — never decrypts. */
export function listSecrets(agentGroupId?: string | null): SecretRow[] {
  if (agentGroupId === undefined) {
    return db()
      .prepare<SecretRow>(
        `SELECT id, name, kind, agent_group_id, assigned_mode, host_pattern, created_at, updated_at
         FROM secrets ORDER BY name`,
      )
      .all();
  }
  if (agentGroupId === null) {
    return db()
      .prepare<SecretRow>(
        `SELECT id, name, kind, agent_group_id, assigned_mode, host_pattern, created_at, updated_at
         FROM secrets WHERE agent_group_id IS NULL ORDER BY name`,
      )
      .all();
  }
  return db()
    .prepare<SecretRow>(
      `SELECT id, name, kind, agent_group_id, assigned_mode, host_pattern, created_at, updated_at
       FROM secrets
       WHERE agent_group_id = @agent_group_id OR agent_group_id IS NULL
       ORDER BY name`,
    )
    .all({ agent_group_id: agentGroupId });
}

export function deleteSecret(id: string): boolean {
  const r = db().prepare(`DELETE FROM secrets WHERE id = @id`).run({ id });
  return r.changes > 0;
}

/**
 * Resolve the secrets that should be injected into a session for the given
 * agent group. Returns plaintext values; callers are expected to inject as
 * env vars and never log. Agent-scoped wins over global on name collision.
 */
export function resolveInjectableSecrets(agentGroupId: string): Map<string, string> {
  const key = loadOrCreateMasterKey();
  const rows = db()
    .prepare<RawRow>(
      `SELECT * FROM secrets
       WHERE agent_group_id = @agent_group_id
          OR agent_group_id IS NULL
       ORDER BY agent_group_id IS NULL`,
    )
    .all({ agent_group_id: agentGroupId });

  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.assigned_mode !== 'all') continue;
    if (out.has(row.name)) continue;
    out.set(row.name, decryptSecret(row.value_encrypted, key));
  }
  return out;
}
