/**
 * OAuth grant DB layer — one row per (provider × authorized account).
 *
 * `provider` is denormalized onto this table (mig 022) for query speed
 * and to avoid a join on every list call. `app_config_id` remains the
 * authoritative FK; provider is just a copy of `app_configs.provider`
 * filled at upsert time.
 *
 * Token columns are AES-GCM ciphertext at rest, encrypted under
 * domain-separated keys (`paraclaw.oauth.access.v1` /
 * `paraclaw.oauth.refresh.v1` — see oauth/crypto.ts). The list/get
 * views in this module strip those columns; only
 * `getAppConnectionWithTokens` (used by the runtime injection seam,
 * not the API) decrypts them.
 */
import crypto from 'crypto';

import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { decryptOauthAccess, decryptOauthRefresh, encryptOauthAccess, encryptOauthRefresh } from './crypto.js';

export interface AppConnectionRow {
  id: string;
  app_config_id: string;
  provider: string;
  account_email: string | null;
  account_id: string;
  scopes_granted: string;
  expires_at: string | null;
  label: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppConnectionWithTokens extends AppConnectionRow {
  access_token: string;
  refresh_token: string | null;
}

interface RawAppConnectionRow extends AppConnectionRow {
  access_token_encrypted: string;
  refresh_token_encrypted: string | null;
}

function db(): Database {
  return getDb();
}

function nowIso(): string {
  return new Date().toISOString();
}

const PUBLIC_COLS = `
  id, app_config_id, provider, account_email, account_id, scopes_granted,
  expires_at, label, metadata_json, created_at, updated_at
`;

export function listAppConnections(): AppConnectionRow[] {
  return db().prepare<AppConnectionRow>(`SELECT ${PUBLIC_COLS} FROM app_connections ORDER BY created_at DESC`).all();
}

export function getAppConnection(id: string): AppConnectionRow | undefined {
  return db().prepare<AppConnectionRow>(`SELECT ${PUBLIC_COLS} FROM app_connections WHERE id = @id`).get({ id });
}

/** Internal: returns decrypted tokens. Callers MUST NOT serialize the result. */
export function getAppConnectionWithTokens(id: string): AppConnectionWithTokens | undefined {
  const row = db().prepare<RawAppConnectionRow>(`SELECT * FROM app_connections WHERE id = @id`).get({ id });
  if (!row) return undefined;
  const { access_token_encrypted, refresh_token_encrypted, ...rest } = row;
  return {
    ...rest,
    access_token: decryptOauthAccess(access_token_encrypted),
    refresh_token: refresh_token_encrypted ? decryptOauthRefresh(refresh_token_encrypted) : null,
  };
}

export interface UpsertConnectionOpts {
  app_config_id: string;
  provider: string;
  account_id: string;
  account_email?: string | null;
  access_token: string;
  refresh_token?: string | null;
  scopes_granted?: string;
  expires_at?: string | null;
  label: string;
  metadata_json?: string | null;
}

/**
 * Upsert a connection keyed on (app_config_id, account_id). Re-authorizing
 * the same account refreshes tokens + scopes in place rather than creating
 * a duplicate row.
 */
export function upsertAppConnection(opts: UpsertConnectionOpts): string {
  const accessCt = encryptOauthAccess(opts.access_token);
  const refreshCt = opts.refresh_token ? encryptOauthRefresh(opts.refresh_token) : null;
  const scopes = opts.scopes_granted ?? '';
  const accountEmail = opts.account_email ?? null;
  const expiresAt = opts.expires_at ?? null;
  const metadata = opts.metadata_json ?? null;

  const existing = db()
    .prepare<{ id: string }>(
      `SELECT id FROM app_connections
        WHERE app_config_id = @app_config_id AND account_id = @account_id`,
    )
    .get({ app_config_id: opts.app_config_id, account_id: opts.account_id });

  const now = nowIso();
  if (existing) {
    db()
      .prepare(
        `UPDATE app_connections
            SET provider                = @provider,
                account_email           = @account_email,
                access_token_encrypted  = @access_token_encrypted,
                refresh_token_encrypted = @refresh_token_encrypted,
                scopes_granted          = @scopes_granted,
                expires_at              = @expires_at,
                label                   = @label,
                metadata_json           = @metadata_json,
                updated_at              = @updated_at
          WHERE id = @id`,
      )
      .run({
        id: existing.id,
        provider: opts.provider,
        account_email: accountEmail,
        access_token_encrypted: accessCt,
        refresh_token_encrypted: refreshCt,
        scopes_granted: scopes,
        expires_at: expiresAt,
        label: opts.label,
        metadata_json: metadata,
        updated_at: now,
      });
    return existing.id;
  }

  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO app_connections
         (id, app_config_id, provider, account_email, account_id,
          access_token_encrypted, refresh_token_encrypted,
          scopes_granted, expires_at, label, metadata_json,
          created_at, updated_at)
       VALUES
         (@id, @app_config_id, @provider, @account_email, @account_id,
          @access_token_encrypted, @refresh_token_encrypted,
          @scopes_granted, @expires_at, @label, @metadata_json,
          @created_at, @updated_at)`,
    )
    .run({
      id,
      app_config_id: opts.app_config_id,
      provider: opts.provider,
      account_email: accountEmail,
      account_id: opts.account_id,
      access_token_encrypted: accessCt,
      refresh_token_encrypted: refreshCt,
      scopes_granted: scopes,
      expires_at: expiresAt,
      label: opts.label,
      metadata_json: metadata,
      created_at: now,
      updated_at: now,
    });
  return id;
}

export function deleteAppConnection(id: string): boolean {
  const r = db().prepare(`DELETE FROM app_connections WHERE id = @id`).run({ id });
  return r.changes > 0;
}
