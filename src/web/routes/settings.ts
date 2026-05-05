/**
 * /api/settings/approval-routing — read + write the channel-default bot
 * for approval delivery.
 *
 * Backs the `/agent/settings/approvals` page. The shape it exposes is
 * one row per (approver, channel) pair: which bot's DM currently sits
 * in the `bot_id = ''` slot of `user_dms`, and which other bots on
 * that channel are reachable.
 *
 * Why a per-(approver, channel) view: the channel-default cache is
 * keyed on `(user_id, channel_type, '')`, so each owner / admin has
 * their own configurable default. With one owner today (Aaron's
 * install) it collapses to "my settings"; with future co-admins it
 * naturally extends without a schema change.
 *
 * Available bots are sourced from active adapters only — operators
 * can't route through a bot whose token is in secrets but never
 * spawned (orphan secret rule, see channel-registry.spawnSecretsBackedBots).
 */
import http from 'node:http';

import { getActiveAdapters } from '../../channels/channel-registry.js';
import { decodePlatformIdAs } from '../../platform-id.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { ensureUserDm } from '../../modules/permissions/user-dm.js';
import { getUserDm, getUserDmsForUser, upsertUserDm } from '../../modules/permissions/db/user-dms.js';
import { getGlobalAdmins, getOwners } from '../../modules/permissions/db/user-roles.js';

/**
 * Per-channel native id for the install's primary operator. Backs the
 * `/channels/new` form's "bot admin user" pre-fill so an operator wiring
 * a second telegram bot doesn't have to look up their user id again.
 *
 * The "operator" is the oldest global owner (from `user_roles`); their
 * `users.id` carries the channel-prefixed identity already (`telegram:1190596288`),
 * so the lookup is just "split on first colon, group by channel". No new
 * schema needed — the row already represents the privileged user for
 * approvals, which is the same user the form is asking to capture.
 *
 * Returns the FIRST owner identity per channel — multi-owner installs
 * settle to whichever owner was granted first. Edge case: a fresh install
 * with no owner yet returns an empty record, and the form falls back to
 * the empty input.
 */
export function listOperatorIdentities(): Record<string, string> {
  const owners = getOwners();
  const byChannel: Record<string, string> = {};
  for (const owner of owners) {
    const sep = owner.user_id.indexOf(':');
    if (sep < 0) continue;
    const channelType = owner.user_id.slice(0, sep);
    const nativeId = owner.user_id.slice(sep + 1);
    if (!byChannel[channelType]) byChannel[channelType] = nativeId;
  }
  return byChannel;
}

interface BotChoice {
  botId: string;
  /** Adapter `name` field — usually `<channelType>:<botId>` for multi-bot or just `<channelType>`. */
  label: string;
}

interface ApprovalRoutingRow {
  /** Namespaced approver user id (`<channel>:<handle>`). */
  userId: string;
  /** Channel-type the row applies to (`telegram`, `discord`, …). */
  channelType: string;
  /**
   * Bot id currently sitting in the channel-default slot. Decoded from
   * the `messaging_groups.platform_id` of the row at `bot_id = ''`.
   * Null when no channel-default is set (no `pickApprovalDelivery`
   * fallback exists for this user yet).
   */
  currentBotId: string | null;
  /** Active bots on this channel the operator can route through. */
  availableBots: BotChoice[];
}

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const error = (res: http.ServerResponse, status: number, message: string): void =>
  json(res, status, { error: message });

async function readJsonBody<T>(req: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {} as T;
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
}

/**
 * Approver users today are the union of owners + global admins. Scoped
 * admins are excluded — their channel-default is per-agent-group at
 * the call site, not a global routing concern.
 */
function listApproverUserIds(): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };
  for (const r of getOwners()) add(r.user_id);
  for (const r of getGlobalAdmins()) add(r.user_id);
  return ordered;
}

export function listSettings(): ApprovalRoutingRow[] {
  // Pre-bucket active adapters by channel type so we can query once per
  // (user, channel) row without re-scanning the registry.
  const adaptersByChannel = new Map<string, BotChoice[]>();
  for (const adapter of getActiveAdapters()) {
    const list = adaptersByChannel.get(adapter.channelType) ?? [];
    list.push({ botId: adapter.botId ?? '', label: adapter.name });
    adaptersByChannel.set(adapter.channelType, list);
  }

  const rows: ApprovalRoutingRow[] = [];
  for (const userId of listApproverUserIds()) {
    // Channel set for this user = channels they have ANY DM cached on,
    // unioned with channels that have at least one active adapter (so
    // an approver who's never been DMed yet still appears in the UI
    // and the operator can pre-configure routing).
    const channelTypes = new Set<string>();
    for (const dm of getUserDmsForUser(userId)) channelTypes.add(dm.channel_type);
    for (const channelType of adaptersByChannel.keys()) channelTypes.add(channelType);

    for (const channelType of channelTypes) {
      const defaultDm = getUserDm(userId, channelType, '');
      let currentBotId: string | null = null;
      if (defaultDm) {
        const mg = getMessagingGroup(defaultDm.messaging_group_id);
        if (mg) {
          // platform_id is v2-shaped after startup-bootstrap. For v1 rows
          // the decoder returns botId=null, which surfaces as "default
          // not pinned to a specific bot" in the UI.
          currentBotId = decodePlatformIdAs(mg.platform_id, 'v2').botId;
        }
      }
      const availableBots = adaptersByChannel.get(channelType) ?? [];
      rows.push({ userId, channelType, currentBotId, availableBots });
    }
  }
  return rows;
}

interface SetDefaultBody {
  userId?: string;
  channelType?: string;
  botId?: string;
}

export async function setDefault(
  body: SetDefaultBody,
): Promise<{ ok: true; row: ApprovalRoutingRow } | { ok: false; status: number; message: string }> {
  const { userId, channelType, botId } = body;
  if (!userId || !channelType || !botId) {
    return { ok: false, status: 400, message: 'userId, channelType, and botId are required' };
  }
  if (!listApproverUserIds().includes(userId)) {
    return { ok: false, status: 404, message: `not an approver: ${userId}` };
  }

  // Cold-resolve via the requested bot. Two purposes: confirms the bot
  // can actually DM this user (catches Telegram's "bots can't initiate"
  // before we silently re-point routing at a dead bot) and, on success,
  // produces the messaging_group whose id we'll write into the
  // channel-default slot.
  const mg = await ensureUserDm(userId, { botId });
  if (!mg) {
    return {
      ok: false,
      status: 422,
      message:
        `Bot ${botId} cannot DM ${userId}. The user may need to message the bot first ` +
        `(common on Telegram), or the adapter for that bot may not be running.`,
    };
  }
  upsertUserDm({
    user_id: userId,
    channel_type: channelType,
    bot_id: '',
    messaging_group_id: mg.id,
    resolved_at: new Date().toISOString(),
  });

  // Recompute the row so the client gets a fresh view without a second
  // round-trip — same shape the list endpoint emits.
  const all = listSettings();
  const updated = all.find((r) => r.userId === userId && r.channelType === channelType);
  if (!updated) {
    // Defensive: shouldn't happen since we just wrote the row.
    return { ok: false, status: 500, message: 'row written but disappeared on re-list' };
  }
  return { ok: true, row: updated };
}

export interface SettingsRouteContext {
  pathname: string;
  method: string;
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

export async function handleSettingsRoute(ctx: SettingsRouteContext): Promise<boolean> {
  const { pathname, method, req, res } = ctx;

  if (pathname === '/api/settings/approval-routing' && method === 'GET') {
    json(res, 200, { rows: listSettings() });
    return true;
  }

  if (pathname === '/api/settings/operator-identity' && method === 'GET') {
    json(res, 200, { byChannel: listOperatorIdentities() });
    return true;
  }

  if (pathname === '/api/settings/approval-routing' && method === 'POST') {
    let body: SetDefaultBody;
    try {
      body = await readJsonBody<SetDefaultBody>(req);
    } catch {
      error(res, 400, 'invalid JSON body');
      return true;
    }
    const result = await setDefault(body);
    if (!result.ok) {
      error(res, result.status, result.message);
      return true;
    }
    log.info('approval-routing default updated', {
      userId: body.userId,
      channelType: body.channelType,
      botId: body.botId,
    });
    json(res, 200, { row: result.row });
    return true;
  }

  return false;
}
