/**
 * Public API for paraclaw's secret store. Values are AES-256-GCM encrypted
 * in-process before landing in the central DB; decrypted only when injected
 * into per-session containers (`src/container-runner.ts`).
 *
 * Naming: a secret is keyed by `(name, agent_group_id)`. A NULL agent_group_id
 * is global; a non-NULL agent_group_id scopes the secret to that group only.
 *
 * Resolution preference at injection time: agent-scoped secret with that
 * name beats the global one. The host walks both rows and the scoped wins.
 */
import crypto from 'crypto';

import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { decryptSecret, deriveKey, encryptSecret } from './crypto.js';
import { loadOrCreateMasterKey } from './master-key.js';

// Domain tag for HKDF-derived secrets-store key. Bumping the version (v2…)
// would force re-encryption of every row in this table. See crypto.ts.
const SECRETS_INFO = 'paraclaw.secrets.v1';

function secretsKey(): Buffer {
  return deriveKey(loadOrCreateMasterKey(), SECRETS_INFO);
}

export type SecretKind = 'channel-token' | 'api-key' | 'generic';
export type AssignedMode = 'all' | 'selective';

export interface SecretRow {
  id: string;
  name: string;
  kind: SecretKind;
  agent_group_id: string | null;
  assigned_mode: AssignedMode;
  created_at: string;
  updated_at: string;
}

export interface PutSecretOpts {
  kind?: SecretKind;
  agent_group_id?: string | null;
  assigned_mode?: AssignedMode;
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
  const key = secretsKey();
  const ct = encryptSecret(value, key);
  const agentGroupId = opts.agent_group_id ?? null;
  const kind = opts.kind ?? 'generic';
  const mode = opts.assigned_mode ?? 'all';

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
                updated_at      = @updated_at
          WHERE id = @id`,
      )
      .run({
        id: existing.id,
        value_encrypted: ct,
        kind,
        assigned_mode: mode,
        updated_at: now,
      });
    return existing.id;
  }

  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO secrets
         (id, name, value_encrypted, kind, agent_group_id, assigned_mode, created_at, updated_at)
       VALUES
         (@id, @name, @value_encrypted, @kind, @agent_group_id, @assigned_mode, @created_at, @updated_at)`,
    )
    .run({
      id,
      name,
      value_encrypted: ct,
      kind,
      agent_group_id: agentGroupId,
      assigned_mode: mode,
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
  const key = secretsKey();
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
        `SELECT id, name, kind, agent_group_id, assigned_mode, created_at, updated_at
         FROM secrets ORDER BY name`,
      )
      .all();
  }
  if (agentGroupId === null) {
    return db()
      .prepare<SecretRow>(
        `SELECT id, name, kind, agent_group_id, assigned_mode, created_at, updated_at
         FROM secrets WHERE agent_group_id IS NULL ORDER BY name`,
      )
      .all();
  }
  return db()
    .prepare<SecretRow>(
      `SELECT id, name, kind, agent_group_id, assigned_mode, created_at, updated_at
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
 *
 * Mode semantics:
 *   - `all`       — inject if scope matches (scoped row → its own group;
 *                   global row → every group). Default behaviour.
 *   - `selective` — inject only when an explicit `secret_assignments` row
 *                   names this agent group. Lets operators stage a credential
 *                   in the store before any agent gets it (and revoke per-
 *                   agent without rotating the value).
 */
export function resolveInjectableSecrets(agentGroupId: string): Map<string, string> {
  const key = secretsKey();
  const rows = db()
    .prepare<RawRow>(
      `SELECT s.*
         FROM secrets s
         LEFT JOIN secret_assignments a
           ON a.secret_id = s.id
          AND a.agent_group_id = @agent_group_id
        WHERE (s.agent_group_id = @agent_group_id OR s.agent_group_id IS NULL)
          AND (s.assigned_mode = 'all' OR a.secret_id IS NOT NULL)
        ORDER BY s.agent_group_id IS NULL`,
    )
    .all({ agent_group_id: agentGroupId });

  const out = new Map<string, string>();
  for (const row of rows) {
    if (out.has(row.name)) continue;
    out.set(row.name, decryptSecret(row.value_encrypted, key));
  }
  return out;
}

// ── Assignments ──

export interface SecretAssignment {
  secret_id: string;
  agent_group_id: string;
  created_at: string;
}

/** All agent_group_ids assigned to this secret (selective-mode allowlist). */
export function listAssignments(secretId: string): string[] {
  const rows = db()
    .prepare<{ agent_group_id: string }>(
      `SELECT agent_group_id FROM secret_assignments
         WHERE secret_id = @secret_id
         ORDER BY agent_group_id`,
    )
    .all({ secret_id: secretId });
  return rows.map((r) => r.agent_group_id);
}

/**
 * Replace the assignment set atomically. Empty array = revoke everything.
 * Throws if the secret doesn't exist; FK ON DELETE CASCADE handles agent
 * groups that vanish. The whole replace runs inside one transaction so
 * the UI's "save" button is all-or-nothing.
 */
export function replaceAssignments(secretId: string, agentGroupIds: string[]): void {
  const exists = db().prepare<{ id: string }>(`SELECT id FROM secrets WHERE id = @id`).get({ id: secretId });
  if (!exists) throw new Error(`secret not found: ${secretId}`);
  const now = nowIso();
  db().transaction(() => {
    db().prepare(`DELETE FROM secret_assignments WHERE secret_id = @secret_id`).run({ secret_id: secretId });
    const insert = db().prepare(
      `INSERT INTO secret_assignments (secret_id, agent_group_id, created_at)
         VALUES (@secret_id, @agent_group_id, @created_at)`,
    );
    for (const gid of agentGroupIds) {
      insert.run({ secret_id: secretId, agent_group_id: gid, created_at: now });
    }
  })();
}

/** Idempotent — re-adding an existing assignment is a no-op (composite PK). */
export function addAssignment(secretId: string, agentGroupId: string): boolean {
  const r = db()
    .prepare(
      `INSERT INTO secret_assignments (secret_id, agent_group_id, created_at)
         VALUES (@secret_id, @agent_group_id, @created_at)
         ON CONFLICT (secret_id, agent_group_id) DO NOTHING`,
    )
    .run({ secret_id: secretId, agent_group_id: agentGroupId, created_at: nowIso() });
  return r.changes > 0;
}

export function removeAssignment(secretId: string, agentGroupId: string): boolean {
  const r = db()
    .prepare(`DELETE FROM secret_assignments WHERE secret_id = @secret_id AND agent_group_id = @agent_group_id`)
    .run({ secret_id: secretId, agent_group_id: agentGroupId });
  return r.changes > 0;
}
