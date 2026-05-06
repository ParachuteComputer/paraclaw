/**
 * GroupDetail "Secrets" panel — paraclaw#104.
 *
 * Asserts the three contracts the panel must hold:
 *   1. Each row's `scope` field renders a visible badge (`scoped` / `assigned`
 *      / `global`). Drift between badge text and panel intent would defeat
 *      the entire point of #104.
 *   2. Empty state distinguishes between mode='selective' (read as "by
 *      design") and mode='all' (read as "create a secret").
 *   3. Click-through builds `/secrets?edit=<id>`. SecretsList's deep-link
 *      handler is exercised separately; we just check the link target.
 *
 * Tests mock the api module — no live server, no auth state needed.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../lib/api.ts';
import { GroupDetail } from './GroupDetail.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof api>('../lib/api.ts');
  return {
    ...actual,
    getGroup: vi.fn(),
    getGroupAgentProvider: vi.fn(),
    listGroupInjectableSecrets: vi.fn(),
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/groups/:folder" element={<GroupDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseGroup: api.AgentGroupView = {
  id: 'g1',
  name: 'research',
  folder: 'research',
  agent_provider: null,
  secret_mode: 'all',
  created_at: '2026-04-20T10:00:00Z',
  vault: null,
  status: null,
};

const emptyProvider: api.AgentProviderView = {
  source: null,
  hasApiKey: false,
  serverUrl: null,
  updatedAt: null,
};

beforeEach(() => {
  vi.mocked(api.getGroupAgentProvider).mockResolvedValue({
    agentGroupId: 'g1',
    overridden: false,
    override: emptyProvider,
    effective: emptyProvider,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('GroupDetail — Secrets panel (paraclaw#104)', () => {
  it('renders one badge per scope (scoped / assigned / global)', async () => {
    vi.mocked(api.getGroup).mockResolvedValue({ ...baseGroup, secret_mode: 'all' });
    vi.mocked(api.listGroupInjectableSecrets).mockResolvedValue([
      {
        id: 'sec-scoped',
        name: 'SCOPED_TOKEN',
        kind: 'channel-token',
        agentGroupId: 'g1',
        scope: 'scoped',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'sec-assigned',
        name: 'ASSIGNED_TOKEN',
        kind: 'api-key',
        agentGroupId: null,
        scope: 'assigned',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
      {
        id: 'sec-global',
        name: 'GLOBAL_TOKEN',
        kind: 'generic',
        agentGroupId: null,
        scope: 'global',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    renderAt('/groups/research');

    await waitFor(() => {
      expect(screen.getByText('SCOPED_TOKEN')).toBeInTheDocument();
    });

    expect(screen.getByText('SCOPED_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('ASSIGNED_TOKEN')).toBeInTheDocument();
    expect(screen.getByText('GLOBAL_TOKEN')).toBeInTheDocument();

    // Each scope label appears exactly once — the badge text must match the
    // wire `scope` field one-to-one.
    expect(screen.getByText('scoped')).toBeInTheDocument();
    expect(screen.getByText('assigned')).toBeInTheDocument();
    expect(screen.getByText('global')).toBeInTheDocument();
  });

  it('click-through targets /secrets?edit=<id>', async () => {
    vi.mocked(api.getGroup).mockResolvedValue({ ...baseGroup, secret_mode: 'all' });
    vi.mocked(api.listGroupInjectableSecrets).mockResolvedValue([
      {
        id: 'sec-1',
        name: 'TOKEN',
        kind: 'generic',
        agentGroupId: 'g1',
        scope: 'scoped',
        createdAt: '2026-05-01T00:00:00Z',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    renderAt('/groups/research');

    await waitFor(() => {
      expect(screen.getByText('TOKEN')).toBeInTheDocument();
    });

    const link = screen.getByText('TOKEN').closest('a');
    expect(link).toHaveAttribute('href', '/secrets?edit=sec-1');
  });

  it('empty state under selective mode reads as by-design, not broken', async () => {
    vi.mocked(api.getGroup).mockResolvedValue({ ...baseGroup, secret_mode: 'selective' });
    vi.mocked(api.listGroupInjectableSecrets).mockResolvedValue([]);

    renderAt('/groups/research');

    await waitFor(() => {
      expect(screen.getByText(/No secrets reach this group/)).toBeInTheDocument();
    });

    // selective-mode copy mentions assignment rows, not "create a secret".
    expect(screen.getByText(/explicit assignment row/)).toBeInTheDocument();
  });

  it('empty state under mode=all suggests creating a secret', async () => {
    vi.mocked(api.getGroup).mockResolvedValue({ ...baseGroup, secret_mode: 'all' });
    vi.mocked(api.listGroupInjectableSecrets).mockResolvedValue([]);

    renderAt('/groups/research');

    await waitFor(() => {
      expect(screen.getByText(/No secrets reach this group/)).toBeInTheDocument();
    });

    expect(screen.getByText(/Create a scoped secret/)).toBeInTheDocument();
  });

  it('error state surfaces a Retry button that re-invokes the fetch (paraclaw#128)', async () => {
    vi.mocked(api.getGroup).mockResolvedValue({ ...baseGroup, secret_mode: 'all' });
    vi.mocked(api.listGroupInjectableSecrets)
      .mockRejectedValueOnce(new Error('boom: transient 500'))
      .mockResolvedValueOnce([
        {
          id: 'sec-1',
          name: 'TOKEN',
          kind: 'generic',
          agentGroupId: 'g1',
          scope: 'scoped',
          createdAt: '2026-05-01T00:00:00Z',
          updatedAt: '2026-05-01T00:00:00Z',
        },
      ]);

    renderAt('/groups/research');

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load secrets/)).toBeInTheDocument();
    });
    expect(screen.getByText('boom: transient 500')).toBeInTheDocument();

    const retry = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(screen.getByText('TOKEN')).toBeInTheDocument();
    });
    expect(screen.queryByText(/Couldn't load secrets/)).not.toBeInTheDocument();
    expect(api.listGroupInjectableSecrets).toHaveBeenCalledTimes(2);
  });
});
