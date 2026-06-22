import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri bridge BEFORE importing the store. The store wires a
// module-level `onPermissionPending` subscription at load time, so it (and the
// invoke wrappers it calls) must be stubbed or the import throws outside Tauri.
vi.mock('../api', () => ({
  approvalsStatus: vi.fn(),
  setPermissionInterception: vi.fn(),
  resolvePermission: vi.fn(),
  onPermissionPending: vi.fn().mockResolvedValue(() => {}),
}));

import * as api from '../api';
import { useApprovalsStore, mapPending } from '../approvalsStore';
import type { RawPendingPermission } from '../api';
import type { PendingPermission } from '../types';

const mockApi = api as unknown as {
  approvalsStatus: ReturnType<typeof vi.fn>;
  setPermissionInterception: ReturnType<typeof vi.fn>;
  resolvePermission: ReturnType<typeof vi.fn>;
  onPermissionPending: ReturnType<typeof vi.fn>;
};

const raw = (over: Partial<RawPendingPermission> = {}): RawPendingPermission => ({
  id: 'p1',
  session_id: 's-abc',
  cwd: '/Users/x/Dev/repo',
  tool_name: 'Bash',
  tool_input: 'rm -rf node_modules',
  ...over,
});

const pending = (over: Partial<PendingPermission> = {}): PendingPermission => ({
  id: 'p1',
  sessionId: 's-abc',
  cwd: '/Users/x/Dev/repo',
  toolName: 'Bash',
  toolInput: 'rm -rf node_modules',
  ...over,
});

beforeEach(() => {
  mockApi.approvalsStatus.mockReset();
  mockApi.setPermissionInterception.mockReset();
  mockApi.resolvePermission.mockReset();
  // Reset the store to a clean slate (subscribed:true so init() doesn't re-run
  // the one-time hydrate from a prior test's state).
  useApprovalsStore.setState({ enabled: false, pending: [], busy: null, subscribed: false });
});

describe('mapPending', () => {
  it('maps the snake_case event payload to the camelCase PendingPermission', () => {
    expect(mapPending(raw())).toEqual(pending());
  });
});

describe('init', () => {
  it('hydrates enabled from approvalsStatus and is idempotent', async () => {
    mockApi.approvalsStatus.mockResolvedValue({ enabled: true, port: 8765 });
    await useApprovalsStore.getState().init();
    expect(useApprovalsStore.getState().enabled).toBe(true);
    expect(mockApi.approvalsStatus).toHaveBeenCalledTimes(1);
    // Second call is guarded by the `subscribed` flag — no second status read.
    await useApprovalsStore.getState().init();
    expect(mockApi.approvalsStatus).toHaveBeenCalledTimes(1);
  });

  it('swallows a status error and leaves enabled off', async () => {
    mockApi.approvalsStatus.mockRejectedValue(new Error('no tauri'));
    await useApprovalsStore.getState().init();
    expect(useApprovalsStore.getState().enabled).toBe(false);
  });
});

describe('setEnabled', () => {
  it('calls setPermissionInterception(true) and stores the returned enabled', async () => {
    mockApi.setPermissionInterception.mockResolvedValue(true);
    await useApprovalsStore.getState().setEnabled(true);
    expect(mockApi.setPermissionInterception).toHaveBeenCalledWith(true);
    expect(useApprovalsStore.getState().enabled).toBe(true);
  });

  it('stores the authoritative returned state even if it differs from the request', async () => {
    // Hook install failed server-side and returned `false` despite enable:true.
    mockApi.setPermissionInterception.mockResolvedValue(false);
    await useApprovalsStore.getState().setEnabled(true);
    expect(useApprovalsStore.getState().enabled).toBe(false);
  });

  it('leaves enabled unchanged when the toggle throws', async () => {
    useApprovalsStore.setState({ enabled: true });
    mockApi.setPermissionInterception.mockRejectedValue(new Error('boom'));
    await useApprovalsStore.getState().setEnabled(false);
    expect(useApprovalsStore.getState().enabled).toBe(true);
  });
});

describe('addPending', () => {
  it('appends a pending request', () => {
    useApprovalsStore.getState().addPending(pending());
    expect(useApprovalsStore.getState().pending).toEqual([pending()]);
  });

  it('de-dupes by id (the hook may re-emit)', () => {
    useApprovalsStore.getState().addPending(pending());
    useApprovalsStore.getState().addPending(pending());
    expect(useApprovalsStore.getState().pending).toHaveLength(1);
  });
});

describe('resolve', () => {
  it('calls resolvePermission(id, true, "") and removes that pending', async () => {
    useApprovalsStore.setState({ pending: [pending(), pending({ id: 'p2' })] });
    mockApi.resolvePermission.mockResolvedValue(undefined);

    await useApprovalsStore.getState().resolve('p1', true);

    expect(mockApi.resolvePermission).toHaveBeenCalledWith('p1', true, '');
    const ids = useApprovalsStore.getState().pending.map((p) => p.id);
    expect(ids).toEqual(['p2']);
    expect(useApprovalsStore.getState().busy).toBeNull();
  });

  it('passes allow=false for a deny', async () => {
    useApprovalsStore.setState({ pending: [pending()] });
    mockApi.resolvePermission.mockResolvedValue(undefined);
    await useApprovalsStore.getState().resolve('p1', false);
    expect(mockApi.resolvePermission).toHaveBeenCalledWith('p1', false, '');
  });

  it('removes the pending and clears busy even if resolvePermission rejects', async () => {
    useApprovalsStore.setState({ pending: [pending()] });
    mockApi.resolvePermission.mockRejectedValue(new Error('gone'));
    await useApprovalsStore.getState().resolve('p1', true);
    expect(useApprovalsStore.getState().pending).toHaveLength(0);
    expect(useApprovalsStore.getState().busy).toBeNull();
  });
});
