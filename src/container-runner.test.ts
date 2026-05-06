import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getHubOriginForContainer, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over group and container.json', () => {
    expect(resolveProviderName('codex', 'opencode', 'claude')).toBe('codex');
  });

  it('falls back to group when session is null', () => {
    expect(resolveProviderName(null, 'codex', 'claude')).toBe('codex');
  });

  it('falls back to container.json when session and group are null', () => {
    expect(resolveProviderName(null, null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null, null)).toBe('codex');
    expect(resolveProviderName(null, 'OpenCode', null)).toBe('opencode');
    expect(resolveProviderName(null, null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'codex', null)).toBe('codex');
    expect(resolveProviderName(null, '', 'opencode')).toBe('opencode');
  });
});

describe('getHubOriginForContainer', () => {
  // The host injects PARACHUTE_HUB_ORIGIN into every container as a
  // *rewritten* form: getHubOrigin() composed with localhostToContainerHost
  // so loopback origins resolve via the host gateway from inside Docker.
  // Surfaced by paraclaw#142 review (#143) — pre-fix, skills doing
  // `curl ${PARACHUTE_HUB_ORIGIN}/...` from inside a container hit the
  // container's own loopback when the hub was local. Tailnet/LAN origins
  // already container-reachable so they pass through unchanged.
  let prevAgent: string | undefined;
  let prevParaclaw: string | undefined;
  let prevParachute: string | undefined;

  beforeEach(() => {
    prevAgent = process.env.PARACHUTE_AGENT_HUB_ORIGIN;
    prevParaclaw = process.env.PARACLAW_HUB_ORIGIN;
    prevParachute = process.env.PARACHUTE_HUB_ORIGIN;
    delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
    delete process.env.PARACLAW_HUB_ORIGIN;
    delete process.env.PARACHUTE_HUB_ORIGIN;
  });

  afterEach(() => {
    if (prevAgent === undefined) delete process.env.PARACHUTE_AGENT_HUB_ORIGIN;
    else process.env.PARACHUTE_AGENT_HUB_ORIGIN = prevAgent;
    if (prevParaclaw === undefined) delete process.env.PARACLAW_HUB_ORIGIN;
    else process.env.PARACLAW_HUB_ORIGIN = prevParaclaw;
    if (prevParachute === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
    else process.env.PARACHUTE_HUB_ORIGIN = prevParachute;
  });

  it('rewrites loopback PARACHUTE_HUB_ORIGIN to host.docker.internal', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'http://127.0.0.1:1939';
    expect(getHubOriginForContainer()).toBe('http://host.docker.internal:1939');
  });

  it('rewrites localhost PARACHUTE_HUB_ORIGIN to host.docker.internal', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'http://localhost:1939';
    expect(getHubOriginForContainer()).toBe('http://host.docker.internal:1939');
  });

  it('passes tailnet origins through unchanged (already container-reachable)', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.taildf9ce2.ts.net';
    expect(getHubOriginForContainer()).toBe('https://parachute.taildf9ce2.ts.net');
  });

  it('falls back to rewritten loopback default when no env is set', () => {
    // getHubOrigin defaults to http://127.0.0.1:1939; the rewrite must
    // catch the default too, otherwise containers in a stock dev install
    // (no PARACHUTE_HUB_ORIGIN set by hub lifecycle) get an unreachable URL.
    expect(getHubOriginForContainer()).toBe('http://host.docker.internal:1939');
  });

  it('respects PARACHUTE_AGENT_HUB_ORIGIN override and rewrites if loopback', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'https://parachute.taildf9ce2.ts.net';
    process.env.PARACHUTE_AGENT_HUB_ORIGIN = 'http://localhost:9999';
    expect(getHubOriginForContainer()).toBe('http://host.docker.internal:9999');
  });

  it('strips trailing slash from explicit env (avoids double slash in `${origin}/path`)', () => {
    process.env.PARACHUTE_HUB_ORIGIN = 'http://127.0.0.1:1939/';
    const origin = getHubOriginForContainer();
    expect(origin.endsWith('/')).toBe(false);
    expect(origin).toBe('http://host.docker.internal:1939');
  });
});
