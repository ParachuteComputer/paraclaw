/**
 * BYOC client config DB layer — one row per provider.
 *
 * `client_secret` is encrypted at rest. The plaintext is materialized
 * only at authorize-URL build time (`buildAuthorizeUrl`) and at token
 * exchange (`exchangeCode`); never returned through the API.
 */
import crypto from 'crypto';

import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';
import { decryptOauthClient, encryptOauthClient } from './crypto.js';

export interface AppConfigRow {
  id: string;
  provider: string;
  client_id: string;
  scopes_default: string;
  created_at: string;
  updated_at: string;
}

interface RawAppConfigRow extends AppConfigRow {
  client_secret_encrypted: string;
}

function db(): Database {
  return getDb();
}

function nowIso(): string {
  return new Date().toISOString();
}

const PUBLIC_COLS = `id, provider, client_id, scopes_default, created_at, updated_at`;

/** Returns the public (non-secret) shape; never decrypts. */
export function getAppConfig(provider: string): AppConfigRow | undefined {
  return db()
    .prepare<AppConfigRow>(`SELECT ${PUBLIC_COLS} FROM app_configs WHERE provider = @provider`)
    .get({ provider });
}

/** Returns the decrypted client_secret + public fields. Internal use only. */
export function getAppConfigWithSecret(provider: string): (AppConfigRow & { client_secret: string }) | undefined {
  const row = db().prepare<RawAppConfigRow>(`SELECT * FROM app_configs WHERE provider = @provider`).get({ provider });
  if (!row) return undefined;
  const { client_secret_encrypted, ...rest } = row;
  return { ...rest, client_secret: decryptOauthClient(client_secret_encrypted) };
}

export function listAppConfigs(): AppConfigRow[] {
  return db().prepare<AppConfigRow>(`SELECT ${PUBLIC_COLS} FROM app_configs ORDER BY provider`).all();
}

export interface PutAppConfigOpts {
  client_id: string;
  client_secret: string;
  scopes_default?: string;
}

/** Insert or update a provider's client config. Returns the row's id. */
export function putAppConfig(provider: string, opts: PutAppConfigOpts): string {
  const ct = encryptOauthClient(opts.client_secret);
  const scopes = opts.scopes_default ?? '';
  const existing = db()
    .prepare<{ id: string }>(`SELECT id FROM app_configs WHERE provider = @provider`)
    .get({ provider });

  const now = nowIso();
  if (existing) {
    db()
      .prepare(
        `UPDATE app_configs
            SET client_id               = @client_id,
                client_secret_encrypted = @client_secret_encrypted,
                scopes_default          = @scopes_default,
                updated_at              = @updated_at
          WHERE id = @id`,
      )
      .run({
        id: existing.id,
        client_id: opts.client_id,
        client_secret_encrypted: ct,
        scopes_default: scopes,
        updated_at: now,
      });
    return existing.id;
  }

  const id = crypto.randomUUID();
  db()
    .prepare(
      `INSERT INTO app_configs
         (id, provider, client_id, client_secret_encrypted, scopes_default, created_at, updated_at)
       VALUES
         (@id, @provider, @client_id, @client_secret_encrypted, @scopes_default, @created_at, @updated_at)`,
    )
    .run({
      id,
      provider,
      client_id: opts.client_id,
      client_secret_encrypted: ct,
      scopes_default: scopes,
      created_at: now,
      updated_at: now,
    });
  return id;
}

export function deleteAppConfig(provider: string): boolean {
  const r = db().prepare(`DELETE FROM app_configs WHERE provider = @provider`).run({ provider });
  return r.changes > 0;
}
