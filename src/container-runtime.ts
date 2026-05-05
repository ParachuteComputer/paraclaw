/**
 * Container runtime abstraction for parachute-agent.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL, LEGACY_PARACLAW_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

// Per-install image tag schemas:
//   - 0.1.0+:    `parachute-agent-image-<8-hex-slug>:latest`
//   - pre-0.1.0: `paraclaw-agent-<8-hex-slug>:latest` (kept for one cycle of
//                back-compat so an operator who upgrades into a 0.1.x checkout
//                without rebuilding the image still gets a working spawn;
//                drop in 0.2.0 — same lifecycle as LEGACY_PARACLAW_INSTALL_LABEL).
// Both prefixes are stable + content-equivalent — Dockerfile baseline
// matches across slugs — so a `docker tag` of any peer is safe.
const PEER_IMAGE_PATTERN = /^(parachute-agent-image|paraclaw-agent)-[0-9a-f]{8}:latest$/;

/** The container runtime binary name. */
export const CONTAINER_RUNTIME_BIN = 'docker';

/** CLI args needed for the container to resolve the host gateway. */
export function hostGatewayArgs(): string[] {
  // On Linux, host.docker.internal isn't built-in — add it explicitly
  if (os.platform() === 'linux') {
    return ['--add-host=host.docker.internal:host-gateway'];
  }
  return [];
}

/** Returns CLI args for a readonly bind mount. */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  return ['-v', `${hostPath}:${containerPath}:ro`];
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart parachute-agent                                    ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Ensure the per-install container image is reachable before we start
 * spawning sessions.
 *
 * INSTALL_SLUG = sha1(process.cwd())[:8], so an operator dir-rename
 * (paraclaw#114: `mv paraclaw parachute-agent` was the trigger) flips the
 * slug. The previously-built image carries the OLD slug; the daemon goes
 * to spawn against the NEW slug; `docker run` returns code=125 ("image
 * not found") and every container spawn crashloops silently.
 *
 * Resolution path, ordered fail-fast → cheap → loud:
 *   1. Expected tag present → no-op.
 *   2. Any peer image (`parachute-agent-image-*` or pre-0.1.0
 *      `paraclaw-agent-*`) present → `docker tag` it to the expected
 *      name. Safe because the Dockerfile baseline doesn't fork per slug.
 *   3. No peer found → throw with an actionable hint. The daemon was
 *      going to crashloop anyway; failing visibly at startup is strictly
 *      better than silent code=125 on every Telegram message.
 */
export function ensureContainerImage(): void {
  if (imageExists(CONTAINER_IMAGE)) {
    log.debug('Container image present', { image: CONTAINER_IMAGE });
    return;
  }
  const peer = findPeerImage(CONTAINER_IMAGE);
  if (peer) {
    // The dir-rename / upgrade case. Loud-warn so the operator can see in
    // the log what happened — silent retags become folklore.
    log.warn('Container image missing for current install slug — retagging from peer', {
      expected: CONTAINER_IMAGE,
      peer,
      hint: 'Operator dir-rename or upgrade likely changed INSTALL_SLUG. Auto-retagging is safe; rebuild via ./container/build.sh next time you want to refresh dependencies.',
    });
    execSync(`${CONTAINER_RUNTIME_BIN} tag ${peer} ${CONTAINER_IMAGE}`, { stdio: 'pipe' });
    return;
  }
  throw new Error(
    `No parachute-agent container image found. Build one with: ./container/build.sh\n` +
      `Expected image: ${CONTAINER_IMAGE}`,
  );
}

function imageExists(ref: string): boolean {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} image inspect ${ref}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function findPeerImage(exclude: string): string | null {
  const output = execSync(`${CONTAINER_RUNTIME_BIN} images --format '{{.Repository}}:{{.Tag}}'`, {
    stdio: ['pipe', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  // `docker images` lists newest-created first by default. Take the first
  // matching peer so a recent rebuild wins over a stale legacy tag.
  for (const ref of output.trim().split('\n').filter(Boolean)) {
    if (ref === exclude) continue;
    if (PEER_IMAGE_PATTERN.test(ref)) return ref;
  }
  return null;
}

/**
 * Kill orphaned parachute-agent containers from THIS install's previous runs.
 *
 * Scoped by the `parachute-agent-install=<slug>` label (and the pre-0.1.0
 * `paraclaw-install=<slug>` label for one upgrade cycle) so a crash-looping
 * peer install cannot reap our containers, and we cannot reap theirs. The
 * label is stamped onto every container at spawn time — see
 * container-runner.ts. Old-label compat reap is queued to drop in 0.2.0.
 */
export function cleanupOrphans(): void {
  try {
    const namesByLabel = [CONTAINER_INSTALL_LABEL, LEGACY_PARACLAW_INSTALL_LABEL].flatMap((label) => {
      const output = execSync(`${CONTAINER_RUNTIME_BIN} ps --filter label=${label} --format '{{.Names}}'`, {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      });
      return output.trim().split('\n').filter(Boolean);
    });
    const orphans = Array.from(new Set(namesByLabel));
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
