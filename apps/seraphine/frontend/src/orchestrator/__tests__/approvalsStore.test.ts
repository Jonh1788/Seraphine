import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the Tauri bridge BEFORE importing the store. The store wires a
// module-level `onPermissionPending` subscription at load time, so it (and the
// invoke wrappers it calls) must be stubbed or the import throws outside Tauri.
vi.mock('../api', () => ({
  approvalsStatus: vi.fn(),
  setPermissionInterception: vi.fn(),
  resolvePermission: vi.fn(),
  onPermissionPending: vi.fn().mockResolvedValue(() => {}),
  getRules: vi.fn().mockResolvedValue([]),
  setRules: vi.fn().mockResolvedValue(undefined),
}));

// The store fires a native notification on a new pending request; stub it so the
// test asserts the call without touching the Tauri / Web Notification APIs.
vi.mock('../../utils/notify', () => ({ notify: vi.fn().mockResolvedValue(undefined) }));

import * as api from '../api';
import { notify } from '../../utils/notify';
import { useApprovalsStore, mapPending } from '../approvalsStore';
import type { RawPendingPermission } from '../api';
import type { PendingPermission, PermissionRule } from '../types';

const mockApi = api as unknown as {
  approvalsStatus: ReturnType<typeof vi.fn>;
  setPermissionInterception: ReturnType<typeof vi.fn>;
  resolvePermission: ReturnType<typeof vi.fn>;
  onPermissionPending: ReturnType<typeof vi.fn>;
  getRules: ReturnType<typeof vi.fn>;
  setRules: ReturnType<typeof vi.fn>;
};
const mockNotify = notify as unknown as ReturnType<typeof vi.fn>;

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
  mockApi.getRules.mockReset().mockResolvedValue([]);
  mockApi.setRules.mockReset().mockResolvedValue(undefined);
  mockNotify.mockReset().mockResolvedValue(undefined);
  // Reset the store to a clean slate (subscribed:false so init() can re-run the
  // one-time hydrate; rules cleared so each test starts from empty).
  useApprovalsStore.setState({ enabled: false, pending: [], busy: null, rules: [], subscribed: false });
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

  it('fires a notification once for a new id and NOT again for a duplicate', () => {
    useApprovalsStore.getState().addPending(pending());
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('Maestro — permissão', 'Bash aguardando · repo');
    // Same id re-emitted — no second notification.
    useApprovalsStore.getState().addPending(pending());
    expect(mockNotify).toHaveBeenCalledTimes(1);
  });
});

describe('resolve', () => {
  it('calls resolvePermission(id, true, "", false) and removes that pending', async () => {
    useApprovalsStore.setState({ pending: [pending(), pending({ id: 'p2' })] });
    mockApi.resolvePermission.mockResolvedValue(undefined);

    await useApprovalsStore.getState().resolve('p1', true);

    expect(mockApi.resolvePermission).toHaveBeenCalledWith('p1', true, '', false);
    const ids = useApprovalsStore.getState().pending.map((p) => p.id);
    expect(ids).toEqual(['p2']);
    expect(useApprovalsStore.getState().busy).toBeNull();
  });

  it('forwards remember=true to resolvePermission and removes the pending', async () => {
    useApprovalsStore.setState({ pending: [pending()] });
    mockApi.resolvePermission.mockResolvedValue(undefined);

    await useApprovalsStore.getState().resolve('p1', true, true);

    expect(mockApi.resolvePermission).toHaveBeenCalledWith('p1', true, '', true);
    expect(useApprovalsStore.getState().pending).toHaveLength(0);
  });

  it('passes allow=false for a deny', async () => {
    useApprovalsStore.setState({ pending: [pending()] });
    mockApi.resolvePermission.mockResolvedValue(undefined);
    await useApprovalsStore.getState().resolve('p1', false);
    expect(mockApi.resolvePermission).toHaveBeenCalledWith('p1', false, '', false);
  });

  it('removes the pending and clears busy even if resolvePermission rejects', async () => {
    useApprovalsStore.setState({ pending: [pending()] });
    mockApi.resolvePermission.mockRejectedValue(new Error('gone'));
    await useApprovalsStore.getState().resolve('p1', true);
    expect(useApprovalsStore.getState().pending).toHaveLength(0);
    expect(useApprovalsStore.getState().busy).toBeNull();
  });
});

describe('rules', () => {
  const rule = (over: Partial<PermissionRule> = {}): PermissionRule => ({
    pattern: 'Bash(git *)', action: 'allow', ...over,
  });

  it('loadRules populates rules from api.getRules', async () => {
    mockApi.getRules.mockResolvedValue([rule()]);
    await useApprovalsStore.getState().loadRules();
    expect(mockApi.getRules).toHaveBeenCalledTimes(1);
    expect(useApprovalsStore.getState().rules).toEqual([rule()]);
  });

  it('loadRules swallows an error and leaves rules empty', async () => {
    mockApi.getRules.mockRejectedValue(new Error('no tauri'));
    await useApprovalsStore.getState().loadRules();
    expect(useApprovalsStore.getState().rules).toEqual([]);
  });

  it('saveRules calls api.setRules and stores rules', async () => {
    const next = [rule()];
    await useApprovalsStore.getState().saveRules(next);
    expect(mockApi.setRules).toHaveBeenCalledWith(next);
    expect(useApprovalsStore.getState().rules).toEqual(next);
  });
});
