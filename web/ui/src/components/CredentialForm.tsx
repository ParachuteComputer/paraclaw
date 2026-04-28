/**
 * Generic credential form — posts to the paraclaw-native /api/secrets.
 *
 * Repurposed from the original setup-wizard CredentialFormStep when the
 * night/ui rebirth pulled credential capture out of the wizard and into
 * its own /secrets surface. The shape is the same — name + value, optional
 * pre-flight validation against a channel API — but the backend is
 * paraclaw's encrypted-at-rest secrets store, not the OneCLI gateway.
 *
 * Modes:
 *   - `mode: 'free'`     — free-form. User picks the secret name, kind, and
 *                          (optionally) the agent_group_id. No pre-flight
 *                          validation — used for arbitrary api keys.
 *   - `mode: 'channel'`  — channel-scoped. Caller provides `channel`
 *                          ('discord' | 'telegram') and we hard-pin the
 *                          secret name (DISCORD_TOKEN / TELEGRAM_BOT_TOKEN)
 *                          and run POST /channels/<adapter>/test before
 *                          saving. Capture the validated identity via
 *                          `onValidated` so callers (the wizard) can reuse
 *                          it without making the user paste twice.
 *
 * The raw value is held in component state only as long as needed to
 * validate + submit, then dropped. We never persist it to localStorage.
 */
import { useState } from 'react';
import {
  putSecret,
  testDiscordToken,
  testTelegramToken,
  type DiscordIdentity,
  type SecretKind,
  type TelegramIdentity,
} from '../lib/api.ts';

type ChannelKind = 'discord' | 'telegram';

interface ChannelMode {
  mode: 'channel';
  channel: ChannelKind;
  /** Optional: bind the secret to a specific agent group instead of leaving it global. */
  agentGroupId?: string | null;
  /** Called once both validation + putSecret resolved. Identity is the
   *  channel API's view of the bot — caller can stash it in wizard state. */
  onValidated?: (identity: DiscordIdentity | TelegramIdentity, secretName: string) => void;
}

interface FreeMode {
  mode: 'free';
  /** Optional: pre-fill the name field. */
  defaultName?: string;
  defaultKind?: SecretKind;
  defaultAgentGroupId?: string | null;
  onCreated?: (name: string) => void;
}

type Props = (ChannelMode | FreeMode) & {
  onCancel?: () => void;
  /** Compact rendering — drops the help blurb (used inside the wizard). */
  compact?: boolean;
};

const CHANNEL_SECRET_NAME: Record<ChannelKind, string> = {
  discord: 'DISCORD_TOKEN',
  telegram: 'TELEGRAM_BOT_TOKEN',
};

export function CredentialForm(props: Props) {
  const [name, setName] = useState(
    props.mode === 'channel' ? CHANNEL_SECRET_NAME[props.channel] : props.defaultName ?? '',
  );
  const [kind, setKind] = useState<SecretKind>(
    props.mode === 'channel' ? 'channel-token' : props.defaultKind ?? 'generic',
  );
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const channelMode = props.mode === 'channel' ? props : null;
  const channel = channelMode?.channel ?? null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !value.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      // Channel mode: validate against the platform first so a bad token
      // surfaces here, not four steps later as a "no inbound message arrived".
      let identity: DiscordIdentity | TelegramIdentity | null = null;
      if (channel === 'discord') {
        const r = await testDiscordToken(value.trim());
        identity = r.identity;
      } else if (channel === 'telegram') {
        const r = await testTelegramToken(value.trim());
        identity = r.identity;
      }
      const agentGroupId =
        props.mode === 'channel' ? props.agentGroupId : props.defaultAgentGroupId;
      await putSecret({
        name: name.trim(),
        value: value.trim(),
        kind,
        agentGroupId: agentGroupId ?? null,
      });
      setValue('');
      if (channelMode?.onValidated && identity) {
        channelMode.onValidated(identity, name.trim());
      } else if (props.mode === 'free' && props.onCreated) {
        props.onCreated(name.trim());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const lockName = props.mode === 'channel';
  const helpBlurb = !props.compact && channel === 'discord' && (
    <p className="dim">
      Don't have a bot yet? Create one at{' '}
      <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
        discord.com/developers/applications
      </a>{' '}
      — New Application → Bot → Copy token.
    </p>
  );
  const telegramHelp = !props.compact && channel === 'telegram' && (
    <p className="dim">
      Don't have a bot yet? Open Telegram → message{' '}
      <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>{' '}
      → <code>/newbot</code> → name + handle → copy the token.
    </p>
  );

  return (
    <form onSubmit={onSubmit}>
      {helpBlurb}
      {telegramHelp}

      <div className="row">
        <label htmlFor="secretName">Name</label>
        <input
          id="secretName"
          type="text"
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={lockName || submitting}
          placeholder={lockName ? undefined : 'OPENAI_API_KEY'}
        />
        {lockName && (
          <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
            Pinned for the {channel} adapter — agent containers look up this exact name at spawn.
          </p>
        )}
      </div>

      {props.mode === 'free' && (
        <div className="row">
          <label htmlFor="secretKind">Kind</label>
          <select
            id="secretKind"
            value={kind}
            onChange={(e) => setKind(e.target.value as SecretKind)}
            disabled={submitting}
          >
            <option value="generic">generic</option>
            <option value="api-key">api-key</option>
            <option value="channel-token">channel-token</option>
          </select>
          <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
            Hint for the secrets list. Doesn't change behavior.
          </p>
        </div>
      )}

      <div className="row">
        <label htmlFor="secretValue">Value</label>
        <input
          id="secretValue"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          disabled={submitting}
          placeholder={
            channel === 'discord'
              ? 'MT…  (Discord bot token)'
              : channel === 'telegram'
              ? '123456789:ABCdef…'
              : 'paste secret value'
          }
        />
        <p className="dim" style={{ marginTop: '0.25rem', fontSize: '0.8rem' }}>
          Stored AES-256-GCM encrypted under <code>~/.parachute/claw/master.key</code>. Never written to your browser's storage.
        </p>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="actions" style={{ marginTop: '0.75rem' }}>
        {props.onCancel && (
          <button type="button" className="secondary" onClick={props.onCancel} disabled={submitting}>
            Cancel
          </button>
        )}
        <button type="submit" disabled={submitting || !name.trim() || !value.trim()}>
          {submitting ? (channel ? 'Validating…' : 'Saving…') : channel ? 'Validate + save' : 'Save secret'}
        </button>
      </div>
    </form>
  );
}
