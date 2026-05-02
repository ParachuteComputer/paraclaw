/**
 * Tests for `/api/settings/operator-identity` and the underlying
 * `listOperatorIdentities` helper. Exercises the "first owner per
 * channel" derivation against a real in-memory DB seeded with
 * representative `users` + `user_roles` rows.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { upsertUser } from '../../modules/permissions/db/users.js';
import { grantRole } from '../../modules/permissions/db/user-roles.js';
import { listOperatorIdentities } from './settings.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

const now = (): string => new Date().toISOString();

function seedUser(id: string, kind: string): void {
  upsertUser({ id, kind, display_name: null, created_at: now() });
}

describe('listOperatorIdentities', () => {
  it('returns empty record on a fresh install with no owners', () => {
    expect(listOperatorIdentities()).toEqual({});
  });

  it('returns the owner native id for each channel', () => {
    seedUser('telegram:1190596288', 'telegram');
    grantRole({
      user_id: 'telegram:1190596288',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    expect(listOperatorIdentities()).toEqual({
      telegram: '1190596288',
    });
  });

  it('returns oldest owner per channel when multiple owners exist', () => {
    seedUser('telegram:1111', 'telegram');
    seedUser('telegram:2222', 'telegram');
    grantRole({
      user_id: 'telegram:1111',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: '2026-01-01T00:00:00.000Z',
    });
    grantRole({
      user_id: 'telegram:2222',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: '2026-02-01T00:00:00.000Z',
    });

    expect(listOperatorIdentities()).toEqual({ telegram: '1111' });
  });

  it('groups one identity per channel when owner has multi-channel presence', () => {
    seedUser('telegram:1190596288', 'telegram');
    seedUser('discord:9876543210', 'discord');
    grantRole({
      user_id: 'telegram:1190596288',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: '2026-01-01T00:00:00.000Z',
    });
    grantRole({
      user_id: 'discord:9876543210',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: '2026-01-02T00:00:00.000Z',
    });

    expect(listOperatorIdentities()).toEqual({
      telegram: '1190596288',
      discord: '9876543210',
    });
  });

  it('ignores admins (only owners count as the install operator)', () => {
    seedUser('telegram:7777', 'telegram');
    grantRole({
      user_id: 'telegram:7777',
      role: 'admin',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });

    expect(listOperatorIdentities()).toEqual({});
  });
});
