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
 *
 * Injection policy lives on the recipient `agent_groups.secret_mode` row
 * (migration 023): `all` injects every in-scope secret; `selective` injects
 * only those with an explicit `secret_assignments` row pointing to the group.
 */
import crypto from 'crypto';

import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { decryptSecret, deriveKey, encryptSecret } from './crypto.js';
import { loadOrCreateMasterKey } from './master-key.js';

// Domain tag for HKDF-derived secrets-store key. Bumping the version (v2…)
// would force re-encryption of every row in this table. See crypto.ts.
//
// ⚠ The `paraclaw.` prefix is a cryptographic domain separator and must
// stay frozen across the paraclaw → parachute-agent rename. Renaming it
// changes the derived key and renders every existing ciphertext row
// undecryptable. The brand-sweep documentation lives in commit messages
// and CHANGELOG; the bytes here do not change.
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
  created_at: string;
  updated_at: string;
}

export interface PutSecretOpts {
  kind?: SecretKind;
  agent_group_id?: string | null;
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
                updated_at      = @updated_at
          WHERE id = @id`,
      )
      .run({
        id: existing.id,
        value_encrypted: ct,
        kind,
        updated_at: now,
      });
    return existing.id;
  }

  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO secrets
         (id, name, value_encrypted, kind, agent_group_id, created_at, updated_at)
       VALUES
         (@id, @name, @value_encrypted, @kind, @agent_group_id, @created_at, @updated_at)`,
    )
    .run({
      id,
      name,
      value_encrypted: ct,
      kind,
      agent_group_id: agentGroupId,
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
        `SELECT id, name, kind, agent_group_id, created_at, updated_at
         FROM secrets ORDER BY name`,
      )
      .all();
  }
  if (agentGroupId === null) {
    return db()
      .prepare<SecretRow>(
        `SELECT id, name, kind, agent_group_id, created_at, updated_at
         FROM secrets WHERE agent_group_id IS NULL ORDER BY name`,
      )
      .all();
  }
  return db()
    .prepare<SecretRow>(
      `SELECT id, name, kind, agent_group_id, created_at, updated_at
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
 * Mode lives on the recipient `agent_groups.secret_mode`:
 *   - `all`       — inject every in-scope secret (scoped + globals).
 *   - `selective` — inject only those with an explicit assignment row
 *                   pointing to this group. Lets operators stage credentials
 *                   in the store before any agent gets them and revoke per
 *                   agent without rotating the value.
 *
 * Unknown agent_group_id is treated as `selective` (the safe default) — the
 * group-level row is the source of truth, so a missing row means we err on
 * the side of withholding.
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
         LEFT JOIN agent_groups g
           ON g.id = @agent_group_id
        WHERE (s.agent_group_id = @agent_group_id OR s.agent_group_id IS NULL)
          AND (g.secret_mode = 'all' OR a.secret_id IS NOT NULL)
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

// ── Staleness detection (Bug B) ──

export interface StaleSession {
  sessionId: string;
  agentGroupId: string;
  agentGroupName: string;
  agentGroupFolder: string;
  sessionCreatedAt: string;
  secretUpdatedAt: string;
}

/**
 * Sessions whose container was spawned BEFORE this secret was last updated
 * AND whose agent group would inject the secret. The injection predicate
 * mirrors `resolveInjectableSecrets` for the configurations the UI can
 * actually create:
 *   - scoped secret  → matches its parent group (`s.agent_group_id = g.id`)
 *   - global secret  → matches any group with `secret_mode='all'` OR an
 *                      explicit `secret_assignments` row
 *
 * Note on a subtle asymmetry: `resolveInjectableSecrets` additionally gates
 * scoped secrets through `(secret_mode='all' OR assignment row exists)` on
 * the recipient group. The SQL here accepts the scoped match unconditionally.
 * The asymmetry is benign — the only configs where it would diverge (a
 * scoped secret paired with its parent group in `selective` mode and no
 * assignment row) are unreachable via the UI, which always seeds an
 * assignment row when scoping. If a future code path makes that config
 * reachable, tighten the SQL to add the same gate.
 *
 * The host injects env vars at spawn time only — there is no in-process
 * update path. This helper powers the post-save banner that prompts the
 * operator to restart the specific sessions that need to see the change.
 *
 * Returns empty when the secret doesn't exist (caller handles 404).
 */
export function findStaleSessionsForSecret(secretId: string): StaleSession[] {
  const rows = db()
    .prepare<{
      session_id: string;
      agent_group_id: string;
      agent_group_name: string;
      agent_group_folder: string;
      session_created_at: string;
      secret_updated_at: string;
    }>(
      `SELECT
          sess.id           AS session_id,
          g.id              AS agent_group_id,
          g.name            AS agent_group_name,
          g.folder          AS agent_group_folder,
          sess.created_at   AS session_created_at,
          s.updated_at      AS secret_updated_at
        FROM secrets s
        JOIN agent_groups g
          ON s.agent_group_id = g.id
          OR s.agent_group_id IS NULL
        LEFT JOIN secret_assignments a
          ON a.secret_id = s.id AND a.agent_group_id = g.id
        JOIN sessions sess
          ON sess.agent_group_id = g.id
        WHERE s.id = @secret_id
          AND sess.container_status = 'running'
          AND sess.created_at < s.updated_at
          AND (
                s.agent_group_id = g.id
             OR (s.agent_group_id IS NULL
                 AND (g.secret_mode = 'all' OR a.secret_id IS NOT NULL))
          )
        ORDER BY sess.created_at DESC`,
    )
    .all({ secret_id: secretId });
  return rows.map((r) => ({
    sessionId: r.session_id,
    agentGroupId: r.agent_group_id,
    agentGroupName: r.agent_group_name,
    agentGroupFolder: r.agent_group_folder,
    sessionCreatedAt: r.session_created_at,
    secretUpdatedAt: r.secret_updated_at,
  }));
}

/** Metadata-only single-row read by id. Returns undefined if missing. */
export function getSecretById(id: string): SecretRow | undefined {
  return db()
    .prepare<SecretRow>(`SELECT id, name, kind, agent_group_id, created_at, updated_at FROM secrets WHERE id = ?`)
    .get(id);
}

/**
 * Why a secret lands in a particular agent group's injectable set:
 *   - `scoped`   — secret is owned by this group (`s.agent_group_id = g.id`).
 *   - `assigned` — global secret with an explicit `secret_assignments` row
 *                  pointing at this group.
 *   - `global`   — global secret with no assignment row, included only because
 *                  the recipient group is in `secret_mode='all'`.
 *
 * When a global has BOTH an assignment row AND `secret_mode='all'`, we report
 * `assigned` — the explicit row reflects deliberate operator intent, while
 * mode='all' is a blanket setting; surfacing the more-specific reason makes
 * the GroupDetail page actionable ("revoke this assignment" vs "flip to
 * selective"). See paraclaw#104.
 */
export type SecretInclusionScope = 'global' | 'scoped' | 'assigned';

export interface InjectableSecretView extends SecretRow {
  scope: SecretInclusionScope;
}

/**
 * Metadata-only mirror of `resolveInjectableSecrets` for the GroupDetail
 * "Secrets" panel. Returns the same row set (subject to the same SQL gate)
 * tagged with the inclusion reason — never decrypts. Caller is the read-only
 * `GET /api/groups/:folder/secrets` route.
 *
 * The SQL mirrors `resolveInjectableSecrets` (the `(s.agent_group_id = g.id
 * OR s.agent_group_id IS NULL)` row predicate gated by `(secret_mode='all'
 * OR assignment exists)`) so the panel cannot disagree with what the
 * container will actually receive at spawn time. Drift here would defeat
 * the entire point of #104 — keep them in lockstep. If you change either,
 * change both.
 *
 * `ORDER BY s.agent_group_id IS NULL` puts scoped rows first so the
 * dedupe-by-name loop honors the "scoped wins on collision" rule
 * `resolveInjectableSecrets` enforces.
 */
export function listInjectableSecretsForGroup(agentGroupId: string): InjectableSecretView[] {
  const rows = db()
    .prepare<{
      id: string;
      name: string;
      kind: SecretKind;
      agent_group_id: string | null;
      created_at: string;
      updated_at: string;
      assignment_present: number;
    }>(
      `SELECT s.id, s.name, s.kind, s.agent_group_id, s.created_at, s.updated_at,
              CASE WHEN a.secret_id IS NULL THEN 0 ELSE 1 END AS assignment_present
         FROM secrets s
         LEFT JOIN secret_assignments a
           ON a.secret_id = s.id
          AND a.agent_group_id = @agent_group_id
         LEFT JOIN agent_groups g
           ON g.id = @agent_group_id
        WHERE (s.agent_group_id = @agent_group_id OR s.agent_group_id IS NULL)
          AND (g.secret_mode = 'all' OR a.secret_id IS NOT NULL)
        ORDER BY s.agent_group_id IS NULL, s.name`,
    )
    .all({ agent_group_id: agentGroupId });

  const out: InjectableSecretView[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    let scope: SecretInclusionScope;
    if (row.agent_group_id === agentGroupId) scope = 'scoped';
    else if (row.assignment_present === 1) scope = 'assigned';
    else scope = 'global';
    out.push({
      id: row.id,
      name: row.name,
      kind: row.kind,
      agent_group_id: row.agent_group_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      scope,
    });
  }
  return out;
}
