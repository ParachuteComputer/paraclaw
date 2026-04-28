/**
 * Shared types for the setup wizard step components.
 *
 * The wizard's state is the union of:
 *   - what we've collected from the operator (agent group folder, bot user
 *     id from /channels/discord/test, messaging_group_id from wire-channel)
 *   - which steps have been confirmed done (so a refresh resumes mid-flow
 *     rather than restarting at step 1)
 *
 * We persist `SetupState` to localStorage under SETUP_STORAGE_KEY so a tab
 * close mid-install survives. The state is intentionally NOT durable on the
 * server — the server's state is the canonical filesystem and DB, and the
 * wizard re-derives readiness from /api/setup/status on every load.
 * localStorage is purely a UX aid for the in-flight session.
 *
 * Tokens are NEVER persisted here. Credential capture moved out of the
 * wizard to the /secrets page (night/ui rebirth) — the wizard now reads
 * names of saved secrets via /api/setup/status to decide whether to
 * prompt the operator to add one.
 */
export type SetupStepKey =
  | 'prereqs'
  | 'channel-pick'
  | 'install'
  | 'test-connection'
  | 'agent-group'
  | 'wire-channel'
  | 'test-message'
  | 'done';

export const SETUP_STEPS: { key: SetupStepKey; label: string }[] = [
  { key: 'prereqs', label: '1. Prerequisites' },
  { key: 'channel-pick', label: '2. Pick channel' },
  { key: 'install', label: '3. Install adapter' },
  { key: 'test-connection', label: '4. Test connection' },
  { key: 'agent-group', label: '5. Agent group' },
  { key: 'wire-channel', label: '6. Wire channel' },
  { key: 'test-message', label: '7. Test message' },
  { key: 'done', label: '8. Done' },
];

export type ChannelAdapter = 'discord' | 'telegram';

export interface SetupState {
  /** Latest step the wizard has reached (resume point on reload). */
  furthestStep: SetupStepKey;
  /** Active step the user is currently viewing (may differ if they backed up). */
  currentStep: SetupStepKey;
  /** Channel adapter selected (Phase 1: discord OR telegram). */
  adapter: ChannelAdapter | null;
  /** Bot identity captured from POST /channels/<adapter>/test.
   *  - discord : the bot's snowflake (used directly to synthesize discord:@me:<id>)
   *  - telegram: the bot's user id (used for the "DM @<botUsername>" copy only;
   *              telegram wiring uses operatorUserId, not this) */
  botUserId: string | null;
  /** Username of the bot — used in 'DM @<bot> now' copy on test-message step. */
  botUsername: string | null;
  /** Telegram-only: the OPERATOR's Telegram user id (from @userinfobot). This
   *  is what wire-channel uses to synthesize telegram:<id> — DMs are
   *  chat-routed in Telegram so per-operator wiring is required. Captured in
   *  the credentials step alongside the bot token. */
  operatorUserId: string | null;
  /** Folder slug of the agent group created in step 6 (or selected if pre-existing). */
  agentGroupFolder: string | null;
  /** Display name of that agent group — for confirmation copy. */
  agentGroupName: string | null;
  /** ISO timestamp of the most recent inbound message at wire-channel time.
   * test-message step polls /api/groups/:folder and advances when
   * status.lastMessageInAt > this baseline. */
  lastInboundBaseline: string | null;
  /** Background install task we're polling, if any. */
  installTaskId: string | null;
}

export const DEFAULT_SETUP_STATE: SetupState = {
  furthestStep: 'prereqs',
  currentStep: 'prereqs',
  adapter: null,
  botUserId: null,
  botUsername: null,
  operatorUserId: null,
  agentGroupFolder: null,
  agentGroupName: null,
  lastInboundBaseline: null,
  installTaskId: null,
};

export const ADAPTER_LABELS: Record<ChannelAdapter, string> = {
  discord: 'Discord',
  telegram: 'Telegram',
};

export const SETUP_STORAGE_KEY = 'paraclaw.setupWizard.v1';

export interface StepProps {
  state: SetupState;
  /** Patch state and persist. Caller should treat this as "save what I learned." */
  patchState: (patch: Partial<SetupState>) => void;
  /** Advance to the next step (stamping furthestStep). */
  next: () => void;
  /** Go back one step (no state mutation). */
  back: () => void;
  /** Jump directly to a step by key. */
  goto: (step: SetupStepKey) => void;
}
