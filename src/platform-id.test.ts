import { describe, expect, it } from 'vitest';

import { decodePlatformIdAs, encodePlatformId, namespacedPlatformId } from './platform-id.js';

describe('encodePlatformId — v2 format', () => {
  it('joins <channel>:<botId>:<native>', () => {
    expect(encodePlatformId('telegram', '8792496425', '1190596288')).toBe('telegram:8792496425:1190596288');
  });

  it('preserves colons inside native (Discord guildId:channelId)', () => {
    // Discord native ids are themselves colon-separated; the v2 encoder must
    // not normalize them — splitting back out happens at the first two
    // colons only.
    expect(encodePlatformId('discord', 'bot123', 'guild999:chan111')).toBe('discord:bot123:guild999:chan111');
  });

  it('preserves @me prefix in DM native (Discord)', () => {
    expect(encodePlatformId('discord', 'bot123', '@me:user456')).toBe('discord:bot123:@me:user456');
  });

  it('handles negative chat ids (Telegram groups)', () => {
    // Telegram group chat ids start with a hyphen — the v2 form has to leave
    // them untouched.
    expect(encodePlatformId('telegram', '8792496425', '-100123456789')).toBe('telegram:8792496425:-100123456789');
  });
});

describe('decodePlatformIdAs(prefixed, "v2")', () => {
  it('parses v2 telegram form', () => {
    expect(decodePlatformIdAs('telegram:8792496425:1190596288', 'v2')).toEqual({
      channel: 'telegram',
      botId: '8792496425',
      native: '1190596288',
    });
  });

  it('parses v2 discord with colon-bearing native', () => {
    expect(decodePlatformIdAs('discord:bot123:guild999:chan111', 'v2')).toEqual({
      channel: 'discord',
      botId: 'bot123',
      native: 'guild999:chan111',
    });
  });

  it('parses v2 discord DM with @me prefix in native', () => {
    expect(decodePlatformIdAs('discord:bot123:@me:user456', 'v2')).toEqual({
      channel: 'discord',
      botId: 'bot123',
      native: '@me:user456',
    });
  });

  it('returns botId=null for legacy v1 form (single colon only)', () => {
    // v1 `telegram:<chatId>` cannot be safely upgraded by the decoder alone;
    // the caller must check `botId === null` and either backfill or skip.
    expect(decodePlatformIdAs('telegram:1190596288', 'v2')).toEqual({
      channel: 'telegram',
      botId: null,
      native: '1190596288',
    });
  });

  it('returns botId=null for empty / channel-only string', () => {
    expect(decodePlatformIdAs('telegram', 'v2')).toEqual({
      channel: 'telegram',
      botId: null,
      native: '',
    });
  });
});

describe('encode/decode round-trip', () => {
  it.each([
    ['telegram', '8792496425', '1190596288'],
    ['telegram', '8792496425', '-100123456789'],
    ['discord', 'bot123', 'guild999:chan111'],
    ['discord', 'bot123', '@me:user456'],
    ['slack', '123', 'C12345:thread:ts'],
  ] as const)('round-trips %s/%s/%s', (channel, botId, native) => {
    const encoded = encodePlatformId(channel, botId, native);
    expect(decodePlatformIdAs(encoded, 'v2')).toEqual({ channel, botId, native });
  });
});

describe('namespacedPlatformId — backward-compat shim', () => {
  // Existing helper retained as-is so callers that don't know a botId yet
  // (CLI admin transport, native adapters that don't need v2) keep working.
  it('prefixes raw chat ids that lack the channel tag', () => {
    expect(namespacedPlatformId('telegram', '1190596288')).toBe('telegram:1190596288');
  });

  it('leaves already-prefixed ids alone', () => {
    expect(namespacedPlatformId('telegram', 'telegram:foo')).toBe('telegram:foo');
  });

  it('leaves @-bearing ids (WhatsApp JIDs, iMessage) alone', () => {
    expect(namespacedPlatformId('imessage', 'a@example.com')).toBe('a@example.com');
  });

  it('leaves +phone and group: ids (Signal) alone', () => {
    expect(namespacedPlatformId('signal', '+15551234567')).toBe('+15551234567');
    expect(namespacedPlatformId('signal', 'group:abc')).toBe('group:abc');
  });
});
