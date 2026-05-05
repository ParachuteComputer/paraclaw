/**
 * MessagingGroupDetail tests cover the contracts the design doc names:
 *   1. The 3-radio renders all policies; the row matching the DB is selected.
 *   2. Picking a different radio triggers updateMessagingGroupPolicy and
 *      reflects the new value back in the radio state.
 *   3. Server 404 surfaces as the "no channel" empty state with a Back CTA
 *      (no Retry — there's nothing to come back from).
 *   4. Unknown errors surface as the load-error banner with a Retry button.
 *   5. Wired-agents block renders one row per MGA and links to the agent
 *      group's folder.
 *
 * The api module is mocked so we don't need a live server.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../lib/api.ts';
import { MessagingGroupDetail } from './MessagingGroupDetail.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof api>('../lib/api.ts');
  return {
    ...actual,
    getMessagingGroupDetail: vi.fn(),
    updateMessagingGroupPolicy: vi.fn(),
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/channels/mg/:id" element={<MessagingGroupDetail />} />
        <Route path="/channels" element={<div>channels list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseDetail: api.MessagingGroupDetailView = {
  id: 'mg_1',
  channelType: 'telegram',
  platformId: 'telegram:111111:222222',
  displayName: 'Aaron DM',
  isGroup: false,
  unknownSenderPolicy: 'request_approval',
  deniedAt: null,
  createdAt: '2026-04-20T10:00:00Z',
  wiredAgents: [
    {
      messagingGroupAgentId: 'mga_1',
      agentGroupId: 'ag_1',
      agentGroupFolder: 'main',
      agentGroupName: 'Main agent',
      engageMode: 'mention',
      engagePattern: null,
      senderScope: 'unrestricted',
      ignoredMessagePolicy: 'drop',
      priority: 0,
      createdAt: '2026-04-20T10:00:00Z',
    },
  ],
};

beforeEach(() => {
  vi.mocked(api.getMessagingGroupDetail).mockResolvedValue(baseDetail);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('MessagingGroupDetail — render', () => {
  it('renders the 3-radio policy editor with the DB value selected', async () => {
    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByText('Unknown-sender policy')).toBeInTheDocument();
    });

    const requestRadio = screen.getByRole('radio', { name: /Request approval/ });
    const strictRadio = screen.getByRole('radio', { name: /Strict/ });
    const publicRadio = screen.getByRole('radio', { name: /Public/ });

    expect(requestRadio).toBeChecked();
    expect(strictRadio).not.toBeChecked();
    expect(publicRadio).not.toBeChecked();
  });

  it('renders MG metadata block', async () => {
    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByText('Group details')).toBeInTheDocument();
    });

    expect(screen.getByText('telegram:111111:222222')).toBeInTheDocument();
    expect(screen.getByText('direct message')).toBeInTheDocument();
    expect(screen.getByText('Aaron DM')).toBeInTheDocument();
  });

  it('renders wired-agents section with link to agent group folder', async () => {
    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByText('Wired agents (1)')).toBeInTheDocument();
    });

    const link = screen.getByRole('link', { name: 'Main agent' });
    expect(link).toHaveAttribute('href', '/groups/main');
  });

  it('renders empty wired-agents state when none exist', async () => {
    vi.mocked(api.getMessagingGroupDetail).mockResolvedValue({
      ...baseDetail,
      wiredAgents: [],
    });

    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByText('Wired agents (0)')).toBeInTheDocument();
    });
    expect(screen.getByText(/No agents wired to this group yet/)).toBeInTheDocument();
  });

  it('shows the denied-at banner when set', async () => {
    vi.mocked(api.getMessagingGroupDetail).mockResolvedValue({
      ...baseDetail,
      deniedAt: '2026-04-25T00:00:00Z',
    });

    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByText(/Denied channel\./)).toBeInTheDocument();
    });
    expect(screen.getByText('2026-04-25T00:00:00Z')).toBeInTheDocument();
  });
});

describe('MessagingGroupDetail — policy edit', () => {
  it('calls updateMessagingGroupPolicy and updates the radio when the operator picks a new value', async () => {
    vi.mocked(api.updateMessagingGroupPolicy).mockResolvedValue({
      ...baseDetail,
      unknownSenderPolicy: 'public',
    });

    const user = userEvent.setup();
    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Request approval/ })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Public/ }));

    await waitFor(() => {
      expect(api.updateMessagingGroupPolicy).toHaveBeenCalledWith('mg_1', 'public');
    });

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Public/ })).toBeChecked();
    });
    expect(screen.getByRole('radio', { name: /Request approval/ })).not.toBeChecked();
  });

  it('does not call the API when the operator clicks the already-selected policy', async () => {
    const user = userEvent.setup();
    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Request approval/ })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Request approval/ }));

    // Give any async work a tick to fire — none should.
    await new Promise((r) => setTimeout(r, 0));
    expect(api.updateMessagingGroupPolicy).not.toHaveBeenCalled();
  });

  it('surfaces an error banner when the PATCH fails', async () => {
    vi.mocked(api.updateMessagingGroupPolicy).mockRejectedValue(
      new api.HttpError(400, 'invalid unknownSenderPolicy: open'),
    );

    const user = userEvent.setup();
    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Request approval/ })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Strict/ }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn't save:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/invalid unknownSenderPolicy: open/)).toBeInTheDocument();
    // The radio should still reflect the DB value, not the rejected pick.
    expect(screen.getByRole('radio', { name: /Request approval/ })).toBeChecked();
  });
});

describe('MessagingGroupDetail — error states', () => {
  it('renders 404 empty state with Back CTA only', async () => {
    vi.mocked(api.getMessagingGroupDetail).mockRejectedValue(
      new api.HttpError(404, 'messaging group not found: mg_missing'),
    );

    renderAt('/channels/mg/mg_missing');

    await waitFor(() => {
      expect(screen.getByText(/No channel with id/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Back to channels' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders generic load error with Retry button on non-404', async () => {
    vi.mocked(api.getMessagingGroupDetail).mockRejectedValue(new api.HttpError(500, 'internal'));

    renderAt('/channels/mg/mg_1');

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load this channel/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
