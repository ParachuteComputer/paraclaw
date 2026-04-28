/**
 * Per-checkout install identifiers. Lets two Paraclaw installs coexist on
 * one host without clobbering each other's service registration or the
 * shared agent image tag.
 *
 * Slug is sha1(projectRoot)[:8] — deterministic per checkout path, stable
 * across re-runs, unique enough across installs.
 */
import { createHash } from 'crypto';

export function getInstallSlug(projectRoot: string = process.cwd()): string {
  return createHash('sha1').update(projectRoot).digest('hex').slice(0, 8);
}

/** launchd Label + plist basename. e.g. `computer.parachute.claw-ab12cd34`. */
export function getLaunchdLabel(projectRoot?: string): string {
  return `computer.parachute.claw-${getInstallSlug(projectRoot)}`;
}

/** systemd unit name (no .service suffix). e.g. `paraclaw-ab12cd34`. */
export function getSystemdUnit(projectRoot?: string): string {
  return `paraclaw-${getInstallSlug(projectRoot)}`;
}

/** Docker image base (no tag). e.g. `paraclaw-agent-ab12cd34`. */
export function getContainerImageBase(projectRoot?: string): string {
  return `paraclaw-agent-${getInstallSlug(projectRoot)}`;
}

/** Default full container image reference with `:latest` tag. */
export function getDefaultContainerImage(projectRoot?: string): string {
  return `${getContainerImageBase(projectRoot)}:latest`;
}
