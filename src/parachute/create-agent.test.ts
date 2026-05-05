/**
 * Tests for `createParachuteAgentGroup` — focused on the default vault
 * token label. The web/server `POST /api/agent-groups` path was caught in
 * the 0.1.0 sweep, but the programmatic surface in this module — used by
 * the MCP tool `create-agent-group` and any caller that hits the helper
 * directly — needs the same `agent-${folder}` default. Reviewer caught this
 * miss on PR #112.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./vault-mcp.js', async () => {
  const actual = await vi.importActual<typeof import('./vault-mcp.js')>('./vault-mcp.js');
  return {
    ...actual,
    attachVaultToGroup: vi.fn(),
    readVaultAttachment: vi.fn(() => null),
  };
});

vi.mock('../db/agent-groups.js', () => ({
  createAgentGroup: vi.fn(),
  getAgentGroupByFolder: vi.fn(() => undefined),
}));

vi.mock('../group-init.js', () => ({
  initGroupFilesystem: vi.fn(),
}));

let createParachuteAgentGroup: typeof import('./create-agent.js').createParachuteAgentGroup;
let attachVaultToGroup: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  ({ createParachuteAgentGroup } = await import('./create-agent.js'));
  ({ attachVaultToGroup } = (await import('./vault-mcp.js')) as unknown as {
    attachVaultToGroup: ReturnType<typeof vi.fn>;
  });
  attachVaultToGroup.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('createParachuteAgentGroup default vault token label', () => {
  it('defaults to `agent-${folder}` when caller omits tokenLabel', () => {
    createParachuteAgentGroup({
      name: 'Forge',
      folder: 'forge',
      vault: {
        scope: 'vault:read',
        token: 'pvt_test',
      },
    });

    expect(attachVaultToGroup).toHaveBeenCalledTimes(1);
    expect(attachVaultToGroup.mock.calls[0]![0]).toMatchObject({
      folder: 'forge',
      tokenLabel: 'agent-forge',
    });
  });

  it('respects an explicit tokenLabel override (e.g. operator-typed `claw-`)', () => {
    createParachuteAgentGroup({
      name: 'Forge',
      folder: 'forge',
      vault: {
        scope: 'vault:read',
        token: 'pvt_test',
        tokenLabel: 'claw-forge',
      },
    });

    expect(attachVaultToGroup.mock.calls[0]![0]).toMatchObject({
      tokenLabel: 'claw-forge',
    });
  });

  it('does not call attachVaultToGroup when no vault opts are passed', () => {
    createParachuteAgentGroup({ name: 'Solo', folder: 'solo' });
    expect(attachVaultToGroup).not.toHaveBeenCalled();
  });
});
