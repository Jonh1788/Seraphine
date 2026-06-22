import { create } from 'zustand';
import {
  approvalsStatus, setPermissionInterception, resolvePermission, onPermissionPending,
  getRules, setRules,
  type RawPendingPermission,
} from './api';
import type { PendingPermission, PermissionRule } from './types';
import { notify } from '../utils/notify';

/** Last path segment of a path (the repo/folder name), falling back to the whole
 *  string when there's no separator. Used in the new-pending notification body. */
function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() || p;
}

/** Map a raw `maestro:permission-pending` payload (snake_case, from Rust) to the
 *  camelCase `PendingPermission` the UI consumes. Exported so the mapping is
 *  unit-testable without driving a Tauri event. */
export function mapPending(raw: RawPendingPermission): PendingPermission {
  return {
    id: raw.id,
    sessionId: raw.session_id,
    cwd: raw.cwd,
    toolName: raw.tool_name,
    toolInput: raw.tool_input,
  };
}

interface ApprovalsState {
  /** Whether the global Claude Code permission hook is installed (interception on). */
  enabled: boolean;
  /** Requests the hook has paused, awaiting the user's allow/deny. */
  pending: PendingPermission[];
  /** id of the request currently being resolved (in-flight), else null. */
  busy: string | null;
  /** Persisted allow/deny rules (loaded from / saved to Rust). */
  rules: PermissionRule[];
  /** Guard so `init()` and the module-level event subscription each run once. */
  subscribed: boolean;
}

interface ApprovalsActions {
  /** Idempotently hydrate `enabled` (and rules) from the Rust approvals status. */
  init: () => Promise<void>;
  /** Install/remove the global hook; store the authoritative returned state. */
  setEnabled: (enable: boolean) => Promise<void>;
  /** Append a pending request (de-duped by id); notify on a genuinely-new one. */
  addPending: (p: PendingPermission) => void;
  /** Allow/deny a pending request, then drop it from the queue. When
   *  `remember` + `allow`, the server auto-allows that session+tool from then on. */
  resolve: (id: string, allow: boolean, remember?: boolean) => Promise<void>;
  /** Load the persisted rules from Rust into `rules`. */
  loadRules: () => Promise<void>;
  /** Persist `rules` to Rust, then mirror them into state. */
  saveRules: (rules: PermissionRule[]) => Promise<void>;
}

/**
 * Non-persisted store for Maestro permission interception. The toggle reflects
 * whether the global hook is installed; the queue holds requests the hook has
 * BLOCKED (the calling session is parked until the user resolves). Nothing here
 * is persisted — pending requests are live (a parked session) and the enabled
 * flag is re-read from Rust on mount via `init()`.
 */
export const useApprovalsStore = create<ApprovalsState & ApprovalsActions>((set, get) => ({
  enabled: false,
  pending: [],
  busy: null,
  rules: [],
  subscribed: false,

  init: async () => {
    if (get().subscribed) return;
    set({ subscribed: true });
    try {
      const { enabled } = await approvalsStatus();
      set({ enabled });
    } catch {
      // Outside Tauri (or server down) — leave enabled at its default (off).
    }
    await get().loadRules();
  },

  setEnabled: async (enable) => {
    try {
      const next = await setPermissionInterception(enable);
      set({ enabled: next });
    } catch {
      // Install/remove failed — leave the toggle reflecting the prior state.
    }
  },

  addPending: (p) => {
    if (get().pending.some((x) => x.id === p.id)) return; // de-dupe re-emits
    set((s) => ({ pending: [...s.pending, p] }));
    // Fire a native notification only for a genuinely-new request so a duplicate
    // emit can't double-notify (the early return above guards that).
    void notify('Maestro — permissão', `${p.toolName} aguardando · ${basename(p.cwd)}`);
  },

  resolve: async (id, allow, remember = false) => {
    if (get().busy) return; // one resolve in flight at a time
    set({ busy: id });
    try {
      await resolvePermission(id, allow, '', remember);
    } catch {
      // Resolve failed — drop it from the queue anyway so the UI isn't stuck;
      // the parked session will time out / re-prompt on the Rust side.
    } finally {
      set((s) => ({ pending: s.pending.filter((p) => p.id !== id), busy: null }));
    }
  },

  loadRules: async () => {
    try {
      const rules = await getRules();
      set({ rules });
    } catch {
      // Outside Tauri (or server down) — leave rules at their default (empty).
    }
  },

  saveRules: async (rules) => {
    await setRules(rules);
    set({ rules });
  },
}));

// Subscribe once at module load to the global permission-pending stream so a
// request raised while the Maestro view is unmounted is still queued (mirrors
// agentStreamStore / skillsStore). Wrapped in try/catch because `listen` rejects
// outside a Tauri runtime (e.g. in unit tests / plain web), and the callback is
// guarded so a malformed payload can never abort the subscription.
try {
  void onPermissionPending((raw) => {
    try {
      useApprovalsStore.getState().addPending(mapPending(raw));
    } catch {
      // ignore a malformed event
    }
  });
} catch {
  // not in Tauri — no global hook stream available
}
