/**
 * Channel adapter descriptors.
 *
 * The /channels/new page and the setup wizard both need the same handful of
 * facts about each supported adapter: how to validate a bot token, what the
 * platform_id looks like, what to ask the operator for, and where to send
 * them for token-procurement docs. This table is the single source of those
 * facts so a new adapter (slack, whatsapp, …) lands as a one-file addition,
 * not a sprawl of switch statements across components.
 *
 * Two arrays:
 *   SUPPORTED_ADAPTERS   — currently installable on the trunk install
 *   COMING_SOON_ADAPTERS — visible in the picker as "coming soon" affordances
 *                          per design 2026-04-30 §"adapter parity"
 *
 * If you add a row here you also need to extend the wire-channel + validator
 * routes server-side; the descriptor is the *UI* contract, not the schema.
 */
import {
  testDiscordToken,
  testTelegramToken,
  type DiscordIdentity,
  type TelegramIdentity,
} from './api.ts';

export type ChannelAdapter = 'discord' | 'telegram';

export interface ResolvedIdentity {
  /** Bot's user id at the upstream platform, normalized to string. */
  id: string;
  /** Bot's @-handle / username for "DM @<bot>" copy. */
  username: string;
}

/**
 * What the operator needs to provide on the new-channel page in addition to
 * the bot token. Today only Telegram has a non-empty list (the operator's
 * own user id is needed because Telegram DMs are chat-routed).
 */
export interface OperatorInputField {
  key: 'operatorUserId';
  label: string;
  hint: string;
  /** Where to send the operator to find this value, if anywhere. */
  helpHref?: string;
  /** Pattern for client-side validation (kept loose; server is the gate). */
  pattern: RegExp;
}

export interface ChannelAdapterDescriptor {
  key: ChannelAdapter;
  label: string;
  blurb: string;
  /** Path on the upstream platform's API the validator hits — for display copy. */
  upstreamProbePath: string;
  /** Where the operator gets the bot token. */
  tokenHelp: { title: string; href: string };
  /** Validate a token; throws on rejection. The body in the throw carries the user-facing error. */
  validate: (token: string) => Promise<ResolvedIdentity>;
  /** Adapter-specific extra fields the wiring step needs from the operator. */
  operatorFields: OperatorInputField[];
  /**
   * Build the messaging-group `platform_id` shown as a preview before wiring.
   * `botUserId` is the validate() id; `operatorUserId` is from operatorFields.
   */
  platformIdPreview: (args: { botUserId: string | null; operatorUserId: string | null }) => string;
  /**
   * The id that gets POST-ed to /groups/:folder/wire-channel as `botUserId`.
   * Discord uses the bot's snowflake (DMs are addressee-routed). Telegram
   * uses the OPERATOR's user id (DMs are chat-routed). Both ride the same
   * wire field name — the server's wire-channel.ts knows which one is which
   * based on `channelType`.
   */
  wireIdFor: (args: { botUserId: string | null; operatorUserId: string | null }) => string | null;
}

export interface ComingSoonAdapter {
  key: string;
  label: string;
  blurb: string;
}

export const SUPPORTED_ADAPTERS: ChannelAdapterDescriptor[] = [
  {
    key: 'telegram',
    label: 'Telegram',
    blurb: 'Easiest first run — BotFather + @userinfobot, ~1 minute.',
    upstreamProbePath: '/getMe',
    tokenHelp: { title: '@BotFather → /newbot', href: 'https://t.me/BotFather' },
    validate: async (token: string): Promise<ResolvedIdentity> => {
      const r: { identity: TelegramIdentity } = await testTelegramToken(token);
      return { id: String(r.identity.id), username: r.identity.username };
    },
    operatorFields: [
      {
        key: 'operatorUserId',
        label: 'Telegram admin user ID',
        hint:
          'The user this bot serves — usually you. Telegram routes DMs by chat id (= your user id); ' +
          'this is the user whose DMs reach your agent. New here? DM @userinfobot to get your ID.',
        helpHref: 'https://t.me/userinfobot',
        pattern: /^[0-9]+$/,
      },
    ],
    platformIdPreview: ({ operatorUserId }) =>
      `telegram:${operatorUserId ?? '(no user id)'}`,
    wireIdFor: ({ operatorUserId }) => operatorUserId,
  },
  {
    key: 'discord',
    label: 'Discord',
    blurb: 'DM your bot or @-mention it in a server.',
    upstreamProbePath: '/users/@me',
    tokenHelp: {
      title: 'Discord developer portal → Bot → Token',
      href: 'https://discord.com/developers/applications',
    },
    validate: async (token: string): Promise<ResolvedIdentity> => {
      const r: { identity: DiscordIdentity } = await testDiscordToken(token);
      return { id: r.identity.id, username: r.identity.username };
    },
    operatorFields: [],
    platformIdPreview: ({ botUserId }) => `discord:@me:${botUserId ?? '(no bot id)'}`,
    wireIdFor: ({ botUserId }) => botUserId,
  },
];

export const COMING_SOON_ADAPTERS: ComingSoonAdapter[] = [
  { key: 'slack', label: 'Slack', blurb: 'Workspace bot — coming soon.' },
  { key: 'whatsapp', label: 'WhatsApp', blurb: 'Cloud API — coming soon.' },
  { key: 'teams', label: 'Microsoft Teams', blurb: 'Coming soon.' },
];

export function findAdapter(key: string): ChannelAdapterDescriptor | null {
  return SUPPORTED_ADAPTERS.find((a) => a.key === key) ?? null;
}
