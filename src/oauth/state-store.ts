/**
 * DB-backed OAuth state store. The `state` parameter passed in the
 * authorize redirect is a CSPRNG-random opaque string mapped here to
 * the originating context (provider, optional agentGroupId, redirect
 * URI, expires_at). Single-use: a state consumed at callback can never
 * be replayed.
 *
 * DB-backed (vs in-memory) so that a daemon restart between authorize
 * and callback doesn't drop the user's flow — they finish in their
 * browser, the callback hits a fresh process, and the row is still
 * there.
 */
import crypto from 'crypto';

import { getDb } from '../db/connection.js';
import type { Database } from '../db/connection.js';

const TTL_MS = 10 * 60 * 1000;

export interface OauthStateContext {
  provider: string;
  agentGroupId: string | null;
  redirectUri: string;
  expiresAt: string;
}

interface PendingStateRow {
  state: string;
  provider: string;
  agent_group_id: string | null;
  redirect_uri: string;
  created_at: string;
  expires_at: string;
}

function db(): Database {
  return getDb();
}

export function mintState(ctx: { provider: string; agentGroupId?: string | null; redirectUri: string }): string {
  const state = crypto.randomBytes(24).toString('base64url');
  const now = new Date();
  const expires = new Date(now.getTime() + TTL_MS);
  db()
    .prepare(
      `INSERT INTO pending_oauth_states
         (state, provider, agent_group_id, redirect_uri, created_at, expires_at)
       VALUES
         (@state, @provider, @agent_group_id, @redirect_uri, @created_at, @expires_at)`,
    )
    .run({
      state,
      provider: ctx.provider,
      agent_group_id: ctx.agentGroupId ?? null,
      redirect_uri: ctx.redirectUri,
      created_at: now.toISOString(),
      expires_at: expires.toISOString(),
    });
  return state;
}

/** Single-use: returns the context and atomically removes the row. Expired rows return undefined. */
export function consumeState(state: string): OauthStateContext | undefined {
  const row = db().prepare<PendingStateRow>(`SELECT * FROM pending_oauth_states WHERE state = @state`).get({ state });
  if (!row) return undefined;
  db().prepare(`DELETE FROM pending_oauth_states WHERE state = @state`).run({ state });
  if (new Date(row.expires_at).getTime() < Date.now()) return undefined;
  return {
    provider: row.provider,
    agentGroupId: row.agent_group_id,
    redirectUri: row.redirect_uri,
    expiresAt: row.expires_at,
  };
}

/** Sweeper — deletes any state past its TTL. Returns rows removed. Called from host-sweep. */
export function sweepExpiredStates(): number {
  const r = db()
    .prepare(`DELETE FROM pending_oauth_states WHERE expires_at < @now`)
    .run({ now: new Date().toISOString() });
  return r.changes;
}

/** Test seam: drop everything. */
export function clearStateStore(): void {
  db().prepare(`DELETE FROM pending_oauth_states`).run();
}

/** Test seam: how many live entries (for assertion). */
export function stateStoreSize(): number {
  const r = db().prepare<{ n: number }>(`SELECT COUNT(*) AS n FROM pending_oauth_states`).get();
  return r?.n ?? 0;
}
