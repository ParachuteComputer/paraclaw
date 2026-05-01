/**
 * Operator-self-wire trust hint (paraclaw#67 — Proposal B).
 *
 * When the operator submits `/claw/channels/new`, we record an in-memory
 * hint keyed `(channelType, botId, operatorUserId)` saying "the operator
 * just wired this bot themselves; the next inbound from them on this bot
 * should bypass the unwired-channel approval gate and route as trusted."
 *
 * Why in-memory (no table): hints are 5-minute things. If paraclaw
 * restarts in that window, the operator who hasn't DM'd the bot yet
 * starts from a wired MGA anyway (Proposal A makes wire the spawn point);
 * no hint needed on the cold path. A persistent table would only matter
 * if we wanted hints to survive crashes mid-window — that's not worth
 * the migration cost or sweep complexity.
 *
 * Why bound to operatorUserId, not just (channel, bot): the form captures
 * the operator's user id explicitly (Telegram operatorUserId field).
 * Trusting only that user means a third-party who DMs the bot in the
 * trust window still goes through the approval flow — exactly the
 * cautious behavior we want.
 *
 * Discord: the form doesn't capture an operator user id (sender_scope
 * 'all' on the wire MGA already covers that case at the routing layer),
 * so Discord wires record no hint and the router check is a no-op for
 * Discord inbounds.
 */
const TTL_MS = 5 * 60 * 1000;

type HintKey = string;

function key(channelType: string, botId: string, operatorUserId: string): HintKey {
  return `${channelType}\0${botId}\0${operatorUserId}`;
}

const hints = new Map<HintKey, number>();

function sweep(now: number): void {
  for (const [k, expiresAt] of hints) {
    if (expiresAt <= now) hints.delete(k);
  }
}

/**
 * Record that the operator just wired `botId` on `channelType` and
 * identifies as `operatorUserId`. The next inbound matching this triple
 * within {@link TTL_MS} bypasses the unwired-channel approval gate.
 *
 * No-op if `operatorUserId` is empty (Discord wires don't capture one).
 */
export function recordTrustHint(channelType: string, botId: string, operatorUserId: string): void {
  if (!operatorUserId) return;
  const now = Date.now();
  sweep(now);
  hints.set(key(channelType, botId, operatorUserId), now + TTL_MS);
}

/**
 * Single-use check: if a hint matches, returns true and removes the hint.
 * Returns false on miss or expired hint.
 */
export function consumeTrustHint(channelType: string, botId: string, operatorUserId: string): boolean {
  if (!operatorUserId) return false;
  const now = Date.now();
  sweep(now);
  const k = key(channelType, botId, operatorUserId);
  const expiresAt = hints.get(k);
  if (expiresAt === undefined) return false;
  hints.delete(k);
  return true;
}

export function _resetTrustHintsForTest(): void {
  hints.clear();
}
