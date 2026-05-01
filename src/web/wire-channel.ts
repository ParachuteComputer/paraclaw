/**
 * Proactively wire a DM channel (Discord OR Telegram) to an agent group BEFORE
 * the first inbound message arrives.
 *
 * ## Why proactive
 *
 * The reactive flow (`src/modules/permissions/channel-approval.ts`) escalates
 * any unwired-channel mention to the owner via DM card. Two problems for a
 * fresh-install setup wizard:
 *
 *   1. `messaging_groups` rows do not exist until the first inbound arrives,
 *      so an operator finishing setup has no DM to send to themselves.
 *   2. `channel-approval.ts:73-77` silently drops if `getAllAgentGroups()
 *      .length === 0`. Even after the wizard creates the agent group, the
 *      first message would be dropped because the wiring path never runs
 *      until an unwired mention reaches the router.
 *
 * The Discord fix mirrors `scripts/init-first-agent.ts`'s `wireIfMissing`
 * exactly (lines 155-166): synthesize the DM platform_id, INSERT
 * messaging_groups + messaging_group_agents with the same defaults
 * init-first-agent.ts uses. Any deviation from those defaults silently
 * changes engage/sender behavior — keep behavior parity, do not "improve"
 * them here.
 *
 * Telegram uses the same canonical defaults; only the platform_id shape
 * differs:
 *
 *   - Discord:   `discord:@me:<botUserId>` — addressee-routed; ANY user DM
 *     to the bot lands on the bot's own @me channel. The wizard wires the
 *     bot's user id once and every operator who DMs the bot is matched by
 *     the same MGA's `sender_scope: 'all'`.
 *   - Telegram:  `telegram:<userId>` — chat-id-routed; the chat_id of a DM
 *     between the bot and a user equals the user's Telegram user id
 *     (positive int; group/channel ids are negative). The wizard wires the
 *     OPERATOR's user id, so only that specific user's DMs match.
 *
 * The architectural fix is documented in PR #31 (paraclaw#27 phase 1) and a
 * follow-up issue against the channel-approval silent-drop bug (NanoClaw
 * upstream).
 */
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { encodePlatformId } from '../platform-id.js';
import type { AgentGroup, MessagingGroup } from '../types.js';

export type ChannelKind = 'discord' | 'telegram';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WireDmInput {
  channelType: ChannelKind;
  agentGroup: AgentGroup;
  /**
   * Bot identity used as the second segment of the v2 platform_id
   * (`<channel>:<botId>:<native>`). For Discord this is the bot
   * application id (DISCORD_APPLICATION_ID). For Telegram this is the
   * `id` returned by `getMe`. Resolved by the caller from the active
   * adapter at wire time.
   */
  botId: string;
  /**
   * For Discord: the BOT's own user id (snowflake) — forms the native
   * segment `@me:<botUserId>` of `discord:<botId>:@me:<botUserId>`. For most
   * Discord bots this equals `botId`, but it is kept distinct because
   * application-id and user-id can diverge for legacy bot accounts.
   *
   * For Telegram: the OPERATOR's user id (positive int as string). The
   * native segment is the chat_id, and Telegram DM chat_id == user_id, so
   * this is what we wire as the third segment of `telegram:<botId>:<id>`.
   */
  botUserId: string;
  /** Optional display name for the messaging_groups row. */
  displayName?: string;
}

export interface WireDmResult {
  channelType: ChannelKind;
  messagingGroupId: string;
  messagingGroupAgentId: string;
  platformId: string;
  created: { messagingGroup: boolean; wiring: boolean };
}

function platformIdFor(channelType: ChannelKind, botId: string, userId: string): string {
  switch (channelType) {
    case 'discord':
      // v2 Discord DM platform_id: `discord:<botId>:@me:<botUserId>`. The
      // native segment (`@me:<botUserId>`) is what the Chat SDK adapter
      // produces from `channelIdFromThreadId` for a bot DM channel; the
      // bridge prepends `<botId>` so messaging_groups keys per-bot.
      return encodePlatformId('discord', botId, `@me:${userId}`);
    case 'telegram':
      // v2 Telegram DM platform_id: `telegram:<botId>:<chatId>` where the
      // chat_id of a bot-↔-user DM equals the user's Telegram user id.
      // Encoding the bot id as the second segment is what makes two
      // Telegram bots' identical DM chat_ids resolve to distinct
      // messaging_groups rows (see src/platform-id.ts module comment).
      return encodePlatformId('telegram', botId, userId);
  }
}

/**
 * Wire a DM channel to an agent group. Idempotent — safe to re-run; if the
 * messaging_groups row OR the messaging_group_agents pair already exists,
 * we leave it alone and report `created: false`.
 */
export function wireDmToAgent(input: WireDmInput): WireDmResult {
  const { channelType, agentGroup, botId, botUserId, displayName } = input;
  if (!botUserId.trim()) {
    throw new Error('botUserId is required');
  }
  if (!botId.trim()) {
    throw new Error('botId is required');
  }

  const userId = botUserId.trim();
  const platformId = platformIdFor(channelType, botId.trim(), userId);
  const now = new Date().toISOString();

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(channelType, platformId);
  let createdMg = false;
  if (!mg) {
    const mgId = generateId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: displayName ?? null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(channelType, platformId);
    if (!mg) {
      throw new Error(`failed to read back messaging_groups row after insert (platform_id=${platformId})`);
    }
    createdMg = true;
  }

  const existing = getMessagingGroupAgentByPair(mg.id, agentGroup.id);
  if (existing) {
    return {
      channelType,
      messagingGroupId: mg.id,
      messagingGroupAgentId: existing.id,
      platformId,
      created: { messagingGroup: createdMg, wiring: false },
    };
  }

  const mgaId = generateId('mga');
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: mg.id,
    agent_group_id: agentGroup.id,
    // Defaults below MUST match scripts/init-first-agent.ts:155-166. DM rows
    // (is_group=0) are always 'pattern' + '.' so the agent responds to every
    // message; group rows would be 'mention'. We only create DM rows here.
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });

  return {
    channelType,
    messagingGroupId: mg.id,
    messagingGroupAgentId: mgaId,
    platformId,
    created: { messagingGroup: createdMg, wiring: true },
  };
}
