/**
 * Discord channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';

import { readEnvFile } from '../env.js';
import type { ChannelAdapter } from './adapter.js';
import { createChatSdkBridge, type ReplyContext } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractReplyContext(raw: Record<string, any>): ReplyContext | null {
  if (!raw.referenced_message) return null;
  const reply = raw.referenced_message;
  return {
    text: reply.content || '',
    sender: reply.author?.global_name || reply.author?.username || 'Unknown',
  };
}

export interface DiscordSpawnInput {
  botToken: string;
  applicationId: string;
  publicKey?: string;
}

/**
 * Build (but don't `setup()`) a Discord channel adapter for the given bot
 * credentials. Discord doesn't expose a getMe-equivalent for the bot user
 * itself, so the bot's identity (`applicationId`) must be passed in by the
 * caller — read from `.env`'s `DISCORD_APPLICATION_ID` for the primary
 * adapter, or from the secret/operator input for dynamic per-bot adds.
 *
 * Used by:
 *   - the channel-registry's startup factory below (single bot via `.env`)
 *   - `registerBotAdapter('discord', { ... })` (dynamic per-bot adds)
 *   - the secrets-backed startup scan
 */
export function spawnDiscordAdapter(input: DiscordSpawnInput): ChannelAdapter {
  const { botToken, applicationId, publicKey } = input;
  const botId = applicationId;
  const discordAdapter = createDiscordAdapter({
    botToken,
    publicKey,
    applicationId,
  });
  const bridge = createChatSdkBridge({
    adapter: discordAdapter,
    botId,
    concurrency: 'concurrent',
    botToken,
    extractReplyContext,
    supportsThreads: true,
  });
  return { ...bridge, botId };
}

registerChannelAdapter('discord', {
  factory: () => {
    const env = readEnvFile(['DISCORD_BOT_TOKEN', 'DISCORD_PUBLIC_KEY', 'DISCORD_APPLICATION_ID']);
    if (!env.DISCORD_BOT_TOKEN) return null;
    if (!env.DISCORD_APPLICATION_ID) return null;
    return spawnDiscordAdapter({
      botToken: env.DISCORD_BOT_TOKEN,
      applicationId: env.DISCORD_APPLICATION_ID,
      publicKey: env.DISCORD_PUBLIC_KEY,
    });
  },
});
