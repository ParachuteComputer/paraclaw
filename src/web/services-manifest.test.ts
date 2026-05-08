/**
 * Round-trip tests for the services.json upsert. Mirrors scribe's coverage
 * — the cross-service contract here is the on-disk shape, so we verify
 * exactly that: a fresh write produces the canonical schema, a second
 * upsert with the same name replaces in-place rather than duplicating,
 * and an upsert with a different name appends.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readService, upsertService } from './services-manifest.js';

let tmp: string;
let path: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paraclaw-services-'));
  path = join(tmp, 'services.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('upsertService', () => {
  it('creates the file + writes the canonical entry shape', () => {
    upsertService(
      {
        name: 'agent',
        port: 1944,
        paths: ['/agent'],
        health: '/api/health',
        version: '0.0.6-rc.1',
        displayName: 'Parachute Agent',
        tagline: 'Manage your Parachute agent groups + vault attachments.',
        installDir: '/Users/test/parachute-agent',
      },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw).toEqual({
      services: [
        {
          name: 'agent',
          port: 1944,
          paths: ['/agent'],
          health: '/api/health',
          version: '0.0.6-rc.1',
          displayName: 'Parachute Agent',
          tagline: 'Manage your Parachute agent groups + vault attachments.',
          installDir: '/Users/test/parachute-agent',
        },
      ],
    });
  });

  it('self-registers installDir so hub can resolve `parachute restart agent`', () => {
    // Regression for paraclaw#115: pre-fix the agent registered without
    // installDir, so hub's third-party lifecycle resolution path (parachute-
    // hub#84) couldn't find a startCmd target and `parachute restart agent`
    // dead-ended. Self-registering the field here is the proper fix —
    // hub#177's graceful-degradation is the safety net.
    upsertService(
      {
        name: 'agent',
        port: 1944,
        paths: ['/agent'],
        health: '/api/health',
        version: '0.1.2-rc.2',
        installDir: '/Users/test/parachute-agent',
      },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      services: { name: string; installDir?: string }[];
    };
    expect(raw.services[0].installDir).toBe('/Users/test/parachute-agent');
  });

  it('replaces an existing entry with the same name in-place', () => {
    upsertService({ name: 'agent', port: 1944, paths: ['/agent'], health: '/api/health', version: 'a' }, path);
    upsertService({ name: 'agent', port: 1944, paths: ['/agent'], health: '/api/health', version: 'b' }, path);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { services: { version: string }[] };
    expect(raw.services).toHaveLength(1);
    expect(raw.services[0].version).toBe('b');
  });

  it('appends a different-name entry without disturbing existing rows', () => {
    upsertService({ name: 'vault', port: 1940, paths: ['/vault'], health: '/health', version: '0.3.0' }, path);
    upsertService({ name: 'agent', port: 1944, paths: ['/agent'], health: '/api/health', version: '0.0.6-rc.1' }, path);
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      services: { name: string }[];
    };
    expect(raw.services.map((s) => s.name).sort()).toEqual(['agent', 'vault']);
  });

  it('preserves fields not in the new entry on the row (merge, not replace)', () => {
    // The agent now self-registers `installDir` (paraclaw#115), but the
    // merge-not-replace behavior is still load-bearing for any field hub
    // stamps that the agent's entry doesn't carry. `publicExposure` is the
    // realistic case: it's a real first-party-schema field on hub's side
    // (set when the operator runs `parachute expose`) but absent from
    // paraclaw's `ServiceEntry` — so a self-registration round trip must
    // not drop it. Spread order is `{ ...existing, ...entry }`, so the
    // agent still wins on the fields it owns.
    writeFileSync(
      path,
      JSON.stringify({
        services: [
          {
            name: 'agent',
            port: 1944,
            paths: ['/agent'],
            health: '/api/health',
            version: '0.0.7-rc.1',
            publicExposure: 'loopback',
          },
        ],
      }),
    );
    upsertService(
      {
        name: 'agent',
        port: 1944,
        paths: ['/agent'],
        health: '/api/health',
        version: '0.0.8-rc.1',
      },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      services: { version: string; publicExposure?: string }[];
    };
    expect(raw.services).toHaveLength(1);
    expect(raw.services[0].version).toBe('0.0.8-rc.1');
    expect(raw.services[0].publicExposure).toBe('loopback');
  });

  it('throws on a malformed existing manifest (so we never silently overwrite)', () => {
    writeFileSync(path, '{"services": "not an array"}');
    expect(() =>
      upsertService({ name: 'agent', port: 1944, paths: ['/agent'], health: '/api/health', version: 'x' }, path),
    ).toThrow(/malformed/);
  });
});

describe('readService — boot-time port resolution lookup (paraclaw#145)', () => {
  it('returns null when the manifest file does not exist', () => {
    expect(readService('agent', path)).toBeNull();
  });

  it('returns null when the manifest exists but has no row for the requested name', () => {
    upsertService({ name: 'vault', port: 1940, paths: ['/vault'], health: '/health', version: '0.3.0' }, path);
    expect(readService('agent', path)).toBeNull();
  });

  it('returns the existing entry for a registered service so the boot path can read its port', () => {
    // Operator-set port (1947) — this is exactly the case #145 protects:
    // the agent must read it back instead of clobbering with its default.
    upsertService({ name: 'agent', port: 1947, paths: ['/agent'], health: '/api/health', version: '0.1.3-rc.1' }, path);
    const row = readService('agent', path);
    expect(row).not.toBeNull();
    expect(row?.port).toBe(1947);
    expect(row?.name).toBe('agent');
  });

  it('throws on a malformed manifest rather than silently returning null', () => {
    // If we returned null on a corrupt file, the boot path would fall
    // through to the default port and clobber the (still corrupt) file
    // on the next upsert — masking the real issue.
    writeFileSync(path, '{"services": "not an array"}');
    expect(() => readService('agent', path)).toThrow(/malformed/);
  });
});
