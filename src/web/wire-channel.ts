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
import type { AgentGroup, MessagingGroup } from '../types.js';

export type ChannelKind = 'discord' | 'telegram';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface WireDmInput {
  channelType: ChannelKind;
  agentGroup: AgentGroup;
  /**
   * For Discord: the BOT's own user id (snowflake) — forms `discord:@me:<id>`.
   * For Telegram: the OPERATOR's user id (positive int as string) — forms
   * `telegram:<id>` (DM chat_id == user_id in Telegram).
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

function platformIdFor(channelType: ChannelKind, userId: string): string {
  switch (channelType) {
    case 'discord':
      // Canonical Discord DM platform_id format (matches the example in
      // scripts/init-first-agent.ts: `--platform-id discord:@me:<userId>`).
      // We construct it directly because `namespacedPlatformId` would
      // short-circuit on the `@` and skip the `discord:` prefix.
      return `discord:@me:${userId}`;
    case 'telegram':
      // Canonical Telegram DM platform_id is `telegram:<chatId>` where the
      // chat_id of a bot-↔-user DM equals the user's Telegram user id.
      // Verified against src/channels/chat-sdk-bridge.ts (line 470 comment),
      // src/delivery.test.ts, and the permissions tests on main.
      return `telegram:${userId}`;
  }
}

/**
 * Wire a DM channel to an agent group. Idempotent — safe to re-run; if the
 * messaging_groups row OR the messaging_group_agents pair already exists,
 * we leave it alone and report `created: false`.
 */
export function wireDmToAgent(input: WireDmInput): WireDmResult {
  const { channelType, agentGroup, botUserId, displayName } = input;
  if (!botUserId.trim()) {
    throw new Error('botUserId is required');
  }

  const userId = botUserId.trim();
  const platformId = platformIdFor(channelType, userId);
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
