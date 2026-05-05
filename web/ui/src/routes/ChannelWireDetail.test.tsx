/**
 * ChannelWireDetail tests cover the contracts the design doc names for
 * the per-MGA route:
 *   1. The 3-radio engage-mode editor renders all options; the row matching
 *      the DB is selected. "Only when mentioned" is the surface for Aaron's
 *      "respond only to mentions" toggle.
 *   2. Saving the form calls updateChannelWire with the right input shape
 *      and reflects the new wire state back in the form.
 *   3. Server 404 surfaces as the "no wire" empty state with a Back CTA
 *      (no Retry — there's nothing to come back from).
 *   4. Unknown errors surface as the load-error banner with a Retry button.
 *   5. Metadata block links back to the parent /channels/mg/:id route and
 *      to the /groups/:folder route.
 *   6. Delete confirms via window.confirm and calls deleteChannelWire.
 *
 * The api module is mocked so we don't need a live server.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../lib/api.ts';
import { ChannelWireDetail } from './ChannelWireDetail.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof api>('../lib/api.ts');
  return {
    ...actual,
    getChannelWireDetail: vi.fn(),
    updateChannelWire: vi.fn(),
    deleteChannelWire: vi.fn(),
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/channels/mga/:id" element={<ChannelWireDetail />} />
        <Route path="/channels" element={<div>channels list</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

const baseWire: api.ChannelWireView = {
  id: 'mga_1',
  channelType: 'telegram',
  messagingGroupId: 'mg_1',
  platformId: 'telegram:111111:222222',
  displayName: 'Aaron DM',
  agentGroupId: 'ag_1',
  agentGroupFolder: 'main',
  agentGroupName: 'Main agent',
  engageMode: 'mention',
  engagePattern: null,
  senderScope: 'unrestricted',
  ignoredMessagePolicy: 'drop',
  priority: 0,
  createdAt: '2026-04-20T10:00:00Z',
};

beforeEach(() => {
  vi.mocked(api.getChannelWireDetail).mockResolvedValue(baseWire);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ChannelWireDetail — render', () => {
  it('renders the engage-mode radios with the DB value selected', async () => {
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByText('Routing rules')).toBeInTheDocument();
    });

    const mention = screen.getByRole('radio', { name: /Only when mentioned/ });
    const all = screen.getByRole('radio', { name: /Every message/ });
    const pattern = screen.getByRole('radio', { name: /Pattern match/ });

    expect(mention).toBeChecked();
    expect(all).not.toBeChecked();
    expect(pattern).not.toBeChecked();
  });

  it('shows the regex input only when pattern mode is selected', async () => {
    vi.mocked(api.getChannelWireDetail).mockResolvedValue({
      ...baseWire,
      engageMode: 'pattern',
      engagePattern: '^/ask\\b',
    });
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByLabelText(/Engage pattern/)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/Engage pattern/)).toHaveValue('^/ask\\b');
  });

  it('renders the metadata block with links back to MG and to the agent group', async () => {
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByText('Wire details')).toBeInTheDocument();
    });

    const mgLink = screen.getByRole('link', { name: 'mg_1' });
    expect(mgLink).toHaveAttribute('href', '/channels/mg/mg_1');

    const groupLinks = screen.getAllByRole('link', { name: 'Main agent' });
    expect(groupLinks[0]).toHaveAttribute('href', '/groups/main');
  });
});

describe('ChannelWireDetail — save', () => {
  it('calls updateChannelWire with the engage-mode change', async () => {
    vi.mocked(api.updateChannelWire).mockResolvedValue({
      ...baseWire,
      engageMode: 'all',
    });

    const user = userEvent.setup();
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Only when mentioned/ })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Every message/ }));
    await user.click(screen.getByRole('button', { name: /Save routing rules/ }));

    await waitFor(() => {
      expect(api.updateChannelWire).toHaveBeenCalledWith('mga_1', {
        engageMode: 'all',
        engagePattern: null,
        senderScope: 'unrestricted',
        ignoredMessagePolicy: 'drop',
        priority: 0,
      });
    });

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Every message/ })).toBeChecked();
    });
  });

  it('surfaces an error banner when the PATCH fails', async () => {
    vi.mocked(api.updateChannelWire).mockRejectedValue(new api.HttpError(400, 'invalid engageMode: xyz'));

    const user = userEvent.setup();
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /Only when mentioned/ })).toBeChecked();
    });

    await user.click(screen.getByRole('radio', { name: /Every message/ }));
    await user.click(screen.getByRole('button', { name: /Save routing rules/ }));

    await waitFor(() => {
      expect(screen.getByText(/Couldn't save:/)).toBeInTheDocument();
    });
    expect(screen.getByText(/invalid engageMode: xyz/)).toBeInTheDocument();
  });
});

describe('ChannelWireDetail — delete', () => {
  it('calls deleteChannelWire after confirm', async () => {
    vi.mocked(api.deleteChannelWire).mockResolvedValue(undefined);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove wire/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Remove wire/ }));

    await waitFor(() => {
      expect(api.deleteChannelWire).toHaveBeenCalledWith('mga_1');
    });

    confirmSpy.mockRestore();
  });

  it('does not call deleteChannelWire when confirm is dismissed', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    const user = userEvent.setup();
    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Remove wire/ })).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: /Remove wire/ }));

    expect(api.deleteChannelWire).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});

describe('ChannelWireDetail — error states', () => {
  it('renders 404 empty state with Back CTA only', async () => {
    vi.mocked(api.getChannelWireDetail).mockRejectedValue(
      new api.HttpError(404, 'channel wire not found: mga_missing'),
    );

    renderAt('/channels/mga/mga_missing');

    await waitFor(() => {
      expect(screen.getByText(/No wire with id/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Back to channels' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('renders generic load error with Retry button on non-404', async () => {
    vi.mocked(api.getChannelWireDetail).mockRejectedValue(new api.HttpError(500, 'internal'));

    renderAt('/channels/mga/mga_1');

    await waitFor(() => {
      expect(screen.getByText(/Couldn't load this wire/)).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
