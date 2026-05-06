import os from 'os';
import path from 'path';

import { readEnvFile, readEnvWithLegacy } from './env.js';
import { getContainerImageBase, getDefaultContainerImage, getInstallSlug } from './install-slug.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER', 'TZ']);

export const ASSISTANT_NAME = process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER || envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';

// Absolute paths needed for container mounts. Captured once at module load
// (process.cwd() at boot — the right value for the install dir) so every
// downstream consumer agrees on a single resolved root, and tests that
// chdir() can't desync against it. Exported for surfaces that need to
// self-register the install path (e.g. services.json `installDir`,
// paraclaw#115).
export const PROJECT_ROOT = process.cwd();
// Operator's home dir. Resolved once at module load — every downstream
// consumer that needs to expand `~` or derive a HOME-relative path imports
// this rather than calling `os.homedir()` itself, so a future precedence
// change (e.g. add a `PARACHUTE_AGENT_HOME` override) is one edit. Honors
// `HOME` env var first (sandbox-friendly, matches POSIX convention) before
// falling back to the real home dir.
export const HOME_DIR = process.env.HOME || os.homedir();

// Parachute ecosystem root. Convention shared with parachute-hub, vault,
// scribe — every module's persistent state lands under this directory
// (`<PARACHUTE_DIR>/<module>/`). Override via `PARACHUTE_HOME` for sandboxes
// or Docker. Default: `~/.parachute/`. See docs/sandbox-isolation.md.
export const PARACHUTE_DIR = process.env.PARACHUTE_HOME || path.join(HOME_DIR, '.parachute');

// Mount security: allowlist stored OUTSIDE project root, never mounted into
// containers. The directory was renamed paraclaw → parachute-agent in 0.1.0.
// `migrateLegacyAllowlistDir` (src/modules/mount-security/index.ts) moves any
// pre-existing files from the legacy dir on first 0.1.0 boot. The legacy
// constants are exported for the migration to consult; nothing else should
// read them. Drop in 0.2.0.
//
// Note (paraclaw#99): the allowlist sits at `<HOME>/.config/parachute-agent/`,
// NOT under `PARACHUTE_DIR`. This is intentional — the file is operator-host
// policy ("which paths can the agent ever mount on this host"), not runtime
// state of any one install. Two installs sharing a host should agree on the
// allowlist; a sandbox at `PARACHUTE_HOME=/tmp/sandbox` deliberately reads
// the same file the live install does. Runtime state (central DB +
// master.key) routes through `PARACHUTE_DIR` instead — see CENTRAL_DB_DIR
// below and the sandbox-isolation block in CLAUDE.md.
export const ALLOWLIST_DIR = path.join(HOME_DIR, '.config', 'parachute-agent');
export const LEGACY_ALLOWLIST_DIR = path.join(HOME_DIR, '.config', 'paraclaw');
export const MOUNT_ALLOWLIST_PATH = path.join(ALLOWLIST_DIR, 'mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = path.join(ALLOWLIST_DIR, 'sender-allowlist.json');
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// Central DB lives outside the project tree so that:
//   1. `git clean` / fresh checkouts can never wipe operator-owned state.
//   2. Multiple project checkouts on the same host share one source of truth.
//   3. The DB sits next to `master.key` under `<PARACHUTE_DIR>/agent/` so a
//      single backup of that directory captures both crypto material and DB
//      state.
//
// Two legacy locations exist and are both migrated-on-startup
// (see `migrateCentralDbLocation` in src/db/connection.ts):
//   - `<PROJECT_ROOT>/data/v2.db` (pre-0.0.6 in-tree path)
//   - `<PARACHUTE_DIR>/claw/paraclaw.db` (pre-0.1.0, before the
//     paraclaw → parachute-agent rename)
// `PARACHUTE_AGENT_CENTRAL_DB_PATH` is the canonical override; the legacy
// `PARACLAW_CENTRAL_DB_PATH` name is read for one cycle (0.1.x) with a
// one-shot warning so operator scripts and `.env` files still resolve.
// Drop the legacy read in 0.2.0.
export const CENTRAL_DB_DIR = path.join(PARACHUTE_DIR, 'agent');
export const CENTRAL_DB_PATH =
  readEnvWithLegacy('PARACHUTE_AGENT_CENTRAL_DB_PATH', 'PARACLAW_CENTRAL_DB_PATH') ||
  path.join(CENTRAL_DB_DIR, 'agent.db');
export const LEGACY_CENTRAL_DB_PATH = path.join(DATA_DIR, 'v2.db');
export const LEGACY_PARACLAW_DB_DIR = path.join(PARACHUTE_DIR, 'claw');
export const LEGACY_PARACLAW_DB_PATH = path.join(LEGACY_PARACLAW_DB_DIR, 'paraclaw.db');

// Per-checkout image tag so two installs on the same host don't share
// `parachute-agent-image:latest` and clobber each other on rebuild.
export const CONTAINER_IMAGE_BASE = process.env.CONTAINER_IMAGE_BASE || getContainerImageBase(PROJECT_ROOT);
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE || getDefaultContainerImage(PROJECT_ROOT);
// Install slug — stamped onto every spawned container via --label so
// cleanupOrphans only reaps containers from this install, not peers.
export const INSTALL_SLUG = getInstallSlug(PROJECT_ROOT);
export const CONTAINER_INSTALL_LABEL = `parachute-agent-install=${INSTALL_SLUG}`;
// Pre-0.1.0 label, before the paraclaw → parachute-agent rename. Kept in the
// reap query for one cycle so containers spawned by an older host process get
// cleaned up when this one starts. Drop in 0.2.0 (tracked as a follow-up
// issue at PR open time).
export const LEGACY_PARACLAW_INSTALL_LABEL = `paraclaw-install=${INSTALL_SLUG}`;
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT || '1800000', 10);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760', 10); // 10MB default
export const MAX_MESSAGES_PER_PROMPT = Math.max(1, parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10);
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(1, parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [process.env.TZ, envConfig.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
