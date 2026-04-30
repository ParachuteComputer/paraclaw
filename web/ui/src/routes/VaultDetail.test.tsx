/**
 * VaultDetail tests cover the four behavior contracts the design doc calls
 * out as inviolable:
 *   1. Mint flow: form submit → mintVaultToken called with form values →
 *      plaintext shown once in the copy-card → "Copy" button writes to
 *      clipboard.
 *   2. Revoke: confirm-modal copy says "one-way", DELETE only fires on
 *      explicit confirm.
 *   3. Detach modal: two-button shape (Keep / Detach + revoke), and the
 *      "Detach + revoke" button passes `revokeToken: true`.
 *   4. Auth fallback: a 401/403 from listVaultTokens renders the
 *      auth-gate "Grant access" button, and clicking it triggers
 *      beginLogin with the narrow per-vault admin scope appended.
 *
 * Tests stub the api module so we don't need a live server or real
 * localStorage-seeded auth state. The auth module is mocked too, so we
 * can assert beginLogin was called with the right scopes without the
 * real implementation trying to navigate the jsdom window.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from '../lib/api.ts';
import * as auth from '../lib/auth.ts';
import { VaultDetail } from './VaultDetail.tsx';

vi.mock('../lib/api.ts', async () => {
  const actual = await vi.importActual<typeof api>('../lib/api.ts');
  return {
    ...actual,
    getVaultDetail: vi.fn(),
    listVaultTokens: vi.fn(),
    mintVaultToken: vi.fn(),
    revokeVaultToken: vi.fn(),
    detachVault: vi.fn(),
  };
});

vi.mock('../lib/auth.ts', async () => {
  const actual = await vi.importActual<typeof auth>('../lib/auth.ts');
  return {
    ...actual,
    beginLogin: vi.fn(),
  };
});

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/vaults/:name" element={<VaultDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

const sampleDetail: api.VaultDetail = {
  vault: { name: 'work', url: 'https://hub.example/vault/work', version: '0.4.7' },
  attachedGroups: [
    {
      folder: 'research',
      mcpName: 'parachute-vault',
      scope: 'vault:read',
      tokenLabel: 'claw-research',
      attachedAt: '2026-04-20T10:00:00Z',
    },
  ],
};

const sampleTokens: api.VaultToken[] = [
  {
    id: 't_abc',
    label: 'claw-research',
    scopes: ['vault:read'],
    created_at: '2026-04-20T10:00:00Z',
    last_used_at: '2026-04-28T10:00:00Z',
    attachedTo: [{ folder: 'research', scope: 'vault:read' }],
  },
];

beforeEach(() => {
  vi.mocked(api.getVaultDetail).mockResolvedValue(sampleDetail);
  vi.mocked(api.listVaultTokens).mockResolvedValue(sampleTokens);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('VaultDetail — mint flow', () => {
  it('mints a token, renders plaintext once, copies on click', async () => {
    const minted: api.MintedVaultToken = {
      token: 'pvt_super_secret_plaintext',
      id: 't_new',
      label: 'claw-new',
      scopes: ['vault:read'],
      created_at: '2026-04-29T10:00:00Z',
    };
    vi.mocked(api.mintVaultToken).mockResolvedValue(minted);

    // userEvent.setup() installs its own navigator.clipboard mock; reading
    // back via readText() is the canonical way to assert what got copied.
    const user = userEvent.setup();
    renderAt('/vaults/work');

    await waitFor(() => {
      expect(screen.getByText('Mint new token')).toBeInTheDocument();
    });

    const labelInput = screen.getByLabelText('Label') as HTMLInputElement;
    await user.clear(labelInput);
    await user.type(labelInput, 'claw-new');

    await user.click(screen.getByRole('button', { name: 'Mint token' }));

    await waitFor(() => {
      expect(api.mintVaultToken).toHaveBeenCalledWith('work', {
        label: 'claw-new',
        scopes: ['vault:read'],
        expires_at: null,
      });
    });

    // Plaintext appears once in the copy-card
    await waitFor(() => {
      expect(screen.getByDisplayValue('pvt_super_secret_plaintext')).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Copy to clipboard' }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Copied ✓' })).toBeInTheDocument();
    });
    expect(await navigator.clipboard.readText()).toBe('pvt_super_secret_plaintext');
  });
});

describe('VaultDetail — revoke modal', () => {
  it('opens confirm modal with one-way copy and only revokes on explicit click', async () => {
    vi.mocked(api.revokeVaultToken).mockResolvedValue(undefined);

    const user = userEvent.setup();
    renderAt('/vaults/work');

    await waitFor(() => {
      expect(screen.getByText(/Tokens \(1\)/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(screen.getByText(/one-way/i)).toBeInTheDocument();
    expect(api.revokeVaultToken).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Revoke token' }));
    await waitFor(() => {
      expect(api.revokeVaultToken).toHaveBeenCalledWith('work', 't_abc');
    });
  });
});

describe('VaultDetail — detach modal', () => {
  it('exposes Keep + Detach+revoke buttons; Detach+revoke passes revokeToken=true', async () => {
    vi.mocked(api.detachVault).mockResolvedValue({
      group: {
        id: 'g1',
        name: 'research',
        folder: 'research',
        agent_provider: null,
        created_at: '2026-04-20T10:00:00Z',
        vault: null,
        status: null,
      },
      revokedTokenId: 't_abc',
      revokeError: null,
    });

    const user = userEvent.setup();
    renderAt('/vaults/work');

    await waitFor(() => {
      expect(screen.getByText(/Attached groups \(1\)/)).toBeInTheDocument();
    });

    await user.click(screen.getByRole('button', { name: 'Detach…' }));

    expect(screen.getByRole('button', { name: 'Keep token' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Detach + revoke' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Detach + revoke' }));

    await waitFor(() => {
      expect(api.detachVault).toHaveBeenCalledWith('research', {
        mcpName: 'parachute-vault',
        revokeToken: true,
      });
    });
  });

  it('Keep token detaches without revoke', async () => {
    vi.mocked(api.detachVault).mockResolvedValue({
      group: {
        id: 'g1',
        name: 'research',
        folder: 'research',
        agent_provider: null,
        created_at: '2026-04-20T10:00:00Z',
        vault: null,
        status: null,
      },
      revokedTokenId: null,
      revokeError: null,
    });

    const user = userEvent.setup();
    renderAt('/vaults/work');

    await waitFor(() => {
      expect(screen.getByText(/Attached groups \(1\)/)).toBeInTheDocument();
    });
    await user.click(screen.getByRole('button', { name: 'Detach…' }));
    await user.click(screen.getByRole('button', { name: 'Keep token' }));

    await waitFor(() => {
      expect(api.detachVault).toHaveBeenCalledWith('research', {
        mcpName: 'parachute-vault',
        revokeToken: false,
      });
    });
  });
});

describe('VaultDetail — auth fallback', () => {
  it('renders Grant access on 403 and triggers beginLogin with narrow scope', async () => {
    vi.mocked(api.listVaultTokens).mockRejectedValue(
      new api.HttpError(403, 'missing vault:work:admin'),
    );

    const user = userEvent.setup();
    renderAt('/vaults/work');

    await waitFor(() => {
      expect(screen.getByText('Additional consent required')).toBeInTheDocument();
    });
    expect(screen.getByText(/missing vault:work:admin/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Grant access' }));
    expect(auth.beginLogin).toHaveBeenCalledWith(['vault:work:admin']);
  });

  it('renders Grant access on 401 too', async () => {
    vi.mocked(api.listVaultTokens).mockRejectedValue(
      new api.HttpError(401, 'unauthorized'),
    );

    renderAt('/vaults/work');

    await waitFor(() => {
      expect(screen.getByText('Additional consent required')).toBeInTheDocument();
    });
  });
});
