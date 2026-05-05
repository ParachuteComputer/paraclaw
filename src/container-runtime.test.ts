import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  ensureContainerImage,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_IMAGE, CONTAINER_INSTALL_LABEL, LEGACY_PARACLAW_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('parachute-agent-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 parachute-agent-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- ensureContainerImage ---

describe('ensureContainerImage', () => {
  // Each test enumerates its own queue rather than going through a helper —
  // throwing scenarios skip the retag call, so a generic helper would queue
  // a `mockReturnValueOnce` that never gets consumed and leaks into the next
  // test (vi.clearAllMocks doesn't drain the response queue).
  const inspectFailed = () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('No such image');
    });
  };

  it('no-ops when the expected image is already present', () => {
    mockExecSync.mockReturnValueOnce('{}'); // inspect — image exists

    ensureContainerImage();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} image inspect ${CONTAINER_IMAGE}`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('retags from a current-prefix peer when the expected image is missing', () => {
    // Operator dir-rename case: the previously-built image carries the old
    // INSTALL_SLUG (cafef00d); the daemon now boots under a new slug.
    const peer = 'parachute-agent-image-cafef00d:latest';
    inspectFailed();
    mockExecSync.mockReturnValueOnce(`${peer}\nnode:24-bookworm-slim\n`); // list
    mockExecSync.mockReturnValueOnce(''); // tag

    ensureContainerImage();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} tag ${peer} ${CONTAINER_IMAGE}`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(log.warn).toHaveBeenCalledWith(
      'Container image missing for current install slug — retagging from peer',
      expect.objectContaining({ expected: CONTAINER_IMAGE, peer }),
    );
  });

  it('retags from a pre-0.1.0 paraclaw-agent peer (one cycle of back-compat)', () => {
    // Operator upgrades a pre-0.1.0 install: their on-disk image is named
    // `paraclaw-agent-<slug>:latest`. Auto-retag rather than forcing a
    // 5-minute rebuild they didn't ask for.
    const legacyPeer = 'paraclaw-agent-cafef00d:latest';
    inspectFailed();
    mockExecSync.mockReturnValueOnce(legacyPeer);
    mockExecSync.mockReturnValueOnce('');

    ensureContainerImage();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} tag ${legacyPeer} ${CONTAINER_IMAGE}`,
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('throws an actionable error when no peer exists (fresh install, no build yet)', () => {
    // No matching prefix on disk: only unrelated base images. Better to fail
    // visibly at startup than crashloop code=125 on every container spawn.
    inspectFailed();
    mockExecSync.mockReturnValueOnce('node:24-bookworm-slim\nubuntu:22.04\n');

    expect(() => ensureContainerImage()).toThrow(/build\.sh/);
    expect(mockExecSync).toHaveBeenCalledTimes(2); // inspect + list, no tag
  });

  it('skips the (missing) expected name when picking a peer from the listing', () => {
    // Belt-and-suspenders: the inspect already confirmed the expected name
    // is absent, but the peer-search guard against picking it back up keeps
    // the function safe if a future caller pre-checks a different way.
    inspectFailed();
    mockExecSync.mockReturnValueOnce(`${CONTAINER_IMAGE}\nparachute-agent-image-cafef00d:latest\n`);
    mockExecSync.mockReturnValueOnce('');

    ensureContainerImage();

    const tagCall = mockExecSync.mock.calls.find((call) => String(call[0]).startsWith(`${CONTAINER_RUNTIME_BIN} tag`));
    expect(tagCall).toBeDefined();
    expect(String(tagCall![0])).toContain('parachute-agent-image-cafef00d:latest');
  });

  it('ignores arbitrary non-matching tags (e.g. base images, unrelated projects)', () => {
    inspectFailed();
    mockExecSync.mockReturnValueOnce('node:24-bookworm-slim\nparachute-vault:latest\nrandomthing:v2\n');

    expect(() => ensureContainerImage()).toThrow(/build\.sh/);
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by both the new and legacy install labels so peers are not reaped', () => {
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenNthCalledWith(
      1,
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${LEGACY_PARACLAW_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned containers from both labels and de-dupes', () => {
    // First ps (new label) returns one container; second ps (legacy label) returns two —
    // one duplicates the first, simulating a container that carries both labels during
    // upgrade.
    mockExecSync.mockReturnValueOnce('parachute-agent-group1-111\n');
    mockExecSync.mockReturnValueOnce('parachute-agent-group1-111\nparaclaw-group2-222\n');
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // 2 ps + 2 unique stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(4);
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 parachute-agent-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(4, `${CONTAINER_RUNTIME_BIN} stop -t 1 paraclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['parachute-agent-group1-111', 'paraclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist on either label', () => {
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(2); // both label queries
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('parachute-agent-a-1\nparachute-agent-b-2\n');
    mockExecSync.mockReturnValueOnce(''); // legacy label query empty
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(4);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['parachute-agent-a-1', 'parachute-agent-b-2'],
    });
  });
});
