// Channel self-registration barrel.
// Each import triggers the channel module's registerChannelAdapter() call.
//
// Trunk now ships three permanent channels:
//   - cli — always-on local-terminal channel (no credentials)
//   - discord — Chat-SDK bridge, gated on DISCORD_BOT_TOKEN
//   - telegram — Chat-SDK bridge with the pairing interceptor, gated on
//     TELEGRAM_BOT_TOKEN
//
// Each adapter is dormant until its env credentials are present, so an
// install with no credentials still boots cleanly. Additional channels
// (Slack, WhatsApp, etc.) remain skill-installed from the `channels`
// branch and append their import below.

import './cli.js';
import './discord.js';
import './telegram.js';
