/**
 * Tests for `localhostToContainerHost` + `rewriteMcpUrlsForContainer`.
 *
 * The translation runs at container-spawn time so an HTTP MCP server
 * with a loopback URL on the host (`127.0.0.1`, `localhost`, …) becomes
 * reachable from inside the Docker container, where loopback would
 * otherwise resolve to the container itself.
 */
import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { GROUPS_DIR } from '../config.js';
import type { ContainerConfig } from '../container-config.js';
import { listVaultAttachments, localhostToContainerHost, rewriteMcpUrlsForContainer } from './vault-mcp.js';

describe('localhostToContainerHost', () => {
  it('rewrites 127.0.0.1 → host.docker.internal, preserving port + path + scheme', () => {
    expect(localhostToContainerHost('http://127.0.0.1:1940/vault/default/mcp')).toBe(
      'http://host.docker.internal:1940/vault/default/mcp',
    );
  });

  it('rewrites localhost', () => {
    expect(localhostToContainerHost('http://localhost:1942/notes/api')).toBe(
      'http://host.docker.internal:1942/notes/api',
    );
  });

  it('rewrites 0.0.0.0 (treat as loopback for our purposes)', () => {
    expect(localhostToContainerHost('http://0.0.0.0:1940/mcp')).toBe('http://host.docker.internal:1940/mcp');
  });

  it('rewrites IPv6 [::1]', () => {
    expect(localhostToContainerHost('http://[::1]:1940/mcp')).toBe('http://host.docker.internal:1940/mcp');
  });

  it('rewrites localhost.localdomain', () => {
    expect(localhostToContainerHost('http://localhost.localdomain:1940/mcp')).toBe(
      'http://host.docker.internal:1940/mcp',
    );
  });

  it('rewrites https scheme + preserves query string', () => {
    expect(localhostToContainerHost('https://127.0.0.1:8443/mcp?session=abc')).toBe(
      'https://host.docker.internal:8443/mcp?session=abc',
    );
  });

  it('passes through tailnet hosts unchanged', () => {
    const url = 'https://parachute.taildf9ce2.ts.net/vault/default/mcp';
    expect(localhostToContainerHost(url)).toBe(url);
  });

  it('passes through public domains unchanged', () => {
    const url = 'https://api.example.com/mcp';
    expect(localhostToContainerHost(url)).toBe(url);
  });

  it('passes through LAN IPs unchanged (Docker bridge can route them)', () => {
    expect(localhostToContainerHost('http://192.168.1.5:1940/mcp')).toBe('http://192.168.1.5:1940/mcp');
    expect(localhostToContainerHost('http://10.0.0.5/mcp')).toBe('http://10.0.0.5/mcp');
  });

  it('passes through host.docker.internal (already translated)', () => {
    const url = 'http://host.docker.internal:1940/mcp';
    expect(localhostToContainerHost(url)).toBe(url);
  });

  it('returns malformed URL unchanged', () => {
    expect(localhostToContainerHost('not-a-url')).toBe('not-a-url');
    expect(localhostToContainerHost('')).toBe('');
  });
});

describe('rewriteMcpUrlsForContainer', () => {
  function baseConfig(): ContainerConfig {
    return {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all',
    };
  }

  it('rewrites URL on http MCP entries, leaves stdio entries alone', () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        'parachute-vault': {
          type: 'http',
          url: 'http://127.0.0.1:1940/vault/default/mcp',
          headers: { Authorization: 'Bearer pvt_test' },
        },
        'local-tool': {
          type: 'stdio',
          command: 'node',
          args: ['/app/tool.js'],
        },
      },
    };

    const out = rewriteMcpUrlsForContainer(cfg);

    expect(out.mcpServers['parachute-vault']).toMatchObject({
      type: 'http',
      url: 'http://host.docker.internal:1940/vault/default/mcp',
      headers: { Authorization: 'Bearer pvt_test' },
    });
    expect(out.mcpServers['local-tool']).toEqual({
      type: 'stdio',
      command: 'node',
      args: ['/app/tool.js'],
    });
  });

  it('does not mutate the input config', () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        v: { type: 'http', url: 'http://127.0.0.1:1940/mcp' },
      },
    };
    const before = JSON.stringify(cfg);
    rewriteMcpUrlsForContainer(cfg);
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it('passes already-tailnet entries through unchanged', () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        v: { type: 'http', url: 'https://parachute.taildf9ce2.ts.net/vault/default/mcp' },
      },
    };
    const out = rewriteMcpUrlsForContainer(cfg);
    expect((out.mcpServers.v as { url: string }).url).toBe('https://parachute.taildf9ce2.ts.net/vault/default/mcp');
  });

  it('handles multiple http entries independently', () => {
    const cfg: ContainerConfig = {
      ...baseConfig(),
      mcpServers: {
        vault: { type: 'http', url: 'http://127.0.0.1:1940/vault/default/mcp' },
        notes: { type: 'http', url: 'http://localhost:1942/notes/mcp' },
        public: { type: 'http', url: 'https://api.example.com/mcp' },
      },
    };
    const out = rewriteMcpUrlsForContainer(cfg);
    expect((out.mcpServers.vault as { url: string }).url).toBe('http://host.docker.internal:1940/vault/default/mcp');
    expect((out.mcpServers.notes as { url: string }).url).toBe('http://host.docker.internal:1942/notes/mcp');
    expect((out.mcpServers.public as { url: string }).url).toBe('https://api.example.com/mcp');
  });
});

describe('listVaultAttachments', () => {
  const created: string[] = [];

  function makeGroup(folder: string, parachuteJson: object | null): string {
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    if (parachuteJson !== null) {
      fs.writeFileSync(path.join(dir, 'parachute.json'), JSON.stringify(parachuteJson, null, 2));
    }
    created.push(dir);
    return folder;
  }

  afterEach(() => {
    while (created.length > 0) {
      const dir = created.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns one entry per (folder, mcpName) for folders with attachments', () => {
    const a = makeGroup(`vmtest-a-${Date.now()}`, {
      vault: {
        'parachute-vault': {
          vaultBaseUrl: 'https://h/vault/work',
          scope: 'vault:read',
          tokenLabel: 'claw-a',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
    });
    const b = makeGroup(`vmtest-b-${Date.now()}`, {
      vault: {
        'parachute-vault': {
          vaultBaseUrl: 'https://h/vault/personal',
          scope: 'vault:write',
          tokenLabel: 'claw-b',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
    });
    const entries = listVaultAttachments([a, b]);
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.folder === a)?.attachment.tokenLabel).toBe('claw-a');
    expect(entries.find((e) => e.folder === b)?.attachment.tokenLabel).toBe('claw-b');
  });

  it('skips folders without parachute.json (forgiveness for unattached groups)', () => {
    const a = makeGroup(`vmtest-noattach-${Date.now()}`, null);
    const b = makeGroup(`vmtest-attach-${Date.now()}`, {
      vault: {
        'parachute-vault': {
          vaultBaseUrl: 'https://h/vault/work',
          scope: 'vault:read',
          tokenLabel: 'claw-x',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
    });
    const entries = listVaultAttachments([a, b]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.folder).toBe(b);
  });

  it('silently skips malformed parachute.json — never throws', () => {
    const folder = `vmtest-bad-${Date.now()}`;
    const dir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'parachute.json'), 'not json {{{');
    created.push(dir);
    expect(listVaultAttachments([folder])).toEqual([]);
  });

  it('returns one entry per mcpName when a folder has multiple attachments', () => {
    const folder = makeGroup(`vmtest-multi-${Date.now()}`, {
      vault: {
        'parachute-vault': {
          vaultBaseUrl: 'https://h/vault/work',
          scope: 'vault:read',
          tokenLabel: 'claw-work',
          attachedAt: '2026-04-29T00:00:00Z',
        },
        'parachute-vault-personal': {
          vaultBaseUrl: 'https://h/vault/personal',
          scope: 'vault:write',
          tokenLabel: 'claw-personal',
          attachedAt: '2026-04-29T00:00:00Z',
        },
      },
    });
    const entries = listVaultAttachments([folder]);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.mcpName).sort()).toEqual(['parachute-vault', 'parachute-vault-personal']);
  });
});
