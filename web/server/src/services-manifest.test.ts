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

import { upsertService } from './services-manifest.js';

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
        name: 'claw',
        port: 1944,
        paths: ['/claw'],
        health: '/api/health',
        version: '0.0.6-rc.1',
        displayName: 'Paraclaw',
        tagline: 'Manage your Parachute agent groups + vault attachments.',
      },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw).toEqual({
      services: [
        {
          name: 'claw',
          port: 1944,
          paths: ['/claw'],
          health: '/api/health',
          version: '0.0.6-rc.1',
          displayName: 'Paraclaw',
          tagline: 'Manage your Parachute agent groups + vault attachments.',
        },
      ],
    });
  });

  it('replaces an existing entry with the same name in-place', () => {
    upsertService(
      { name: 'claw', port: 1944, paths: ['/claw'], health: '/api/health', version: 'a' },
      path,
    );
    upsertService(
      { name: 'claw', port: 1944, paths: ['/claw'], health: '/api/health', version: 'b' },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { services: { version: string }[] };
    expect(raw.services).toHaveLength(1);
    expect(raw.services[0].version).toBe('b');
  });

  it('appends a different-name entry without disturbing existing rows', () => {
    upsertService(
      { name: 'vault', port: 1940, paths: ['/vault'], health: '/health', version: '0.3.0' },
      path,
    );
    upsertService(
      { name: 'claw', port: 1944, paths: ['/claw'], health: '/api/health', version: '0.0.6-rc.1' },
      path,
    );
    const raw = JSON.parse(readFileSync(path, 'utf8')) as {
      services: { name: string }[];
    };
    expect(raw.services.map((s) => s.name).sort()).toEqual(['claw', 'vault']);
  });

  it('throws on a malformed existing manifest (so we never silently overwrite)', () => {
    writeFileSync(path, '{"services": "not an array"}');
    expect(() =>
      upsertService(
        { name: 'claw', port: 1944, paths: ['/claw'], health: '/api/health', version: 'x' },
        path,
      ),
    ).toThrow(/malformed/);
  });
});
