/**
 * Ephemeral OAuth state store. The `state` parameter passed in the
 * authorize redirect is a CSPRNG-random opaque string mapped here to
 * the originating context (provider, optional agentGroupId, redirect
 * URI, expires_at). Single-use: a state consumed at callback can never
 * be replayed.
 *
 * Lives in process memory by design — a paraclaw restart mid-flow
 * forces the user to retry "Connect <provider>", which is acceptable
 * for a self-hosted single-process daemon. Avoids a fourth migration
 * + a stale-row sweeper.
 */
import crypto from 'crypto';

const TTL_MS = 10 * 60 * 1000;

export interface OauthStateContext {
  provider: string;
  agentGroupId?: string | null;
  redirectUri: string;
  expiresAt: number;
}

const store = new Map<string, OauthStateContext>();

export function mintState(ctx: Omit<OauthStateContext, 'expiresAt'>): string {
  const state = crypto.randomBytes(24).toString('base64url');
  store.set(state, { ...ctx, expiresAt: Date.now() + TTL_MS });
  return state;
}

/** Single-use: returns the context and atomically removes it. */
export function consumeState(state: string): OauthStateContext | undefined {
  const ctx = store.get(state);
  if (!ctx) return undefined;
  store.delete(state);
  if (ctx.expiresAt < Date.now()) return undefined;
  return ctx;
}

/** Test seam: drop everything. */
export function clearStateStore(): void {
  store.clear();
}

/** Test seam: how many live entries (for assertion). */
export function stateStoreSize(): number {
  return store.size;
}
