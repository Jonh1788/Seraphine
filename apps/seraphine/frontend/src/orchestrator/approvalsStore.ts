import { create } from 'zustand';
import {
  approvalsStatus, setPermissionInterception, resolvePermission, onPermissionPending,
  type RawPendingPermission,
} from './api';
import type { PendingPermission } from './types';

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
  /** Guard so `init()` and the module-level event subscription each run once. */
  subscribed: boolean;
}

interface ApprovalsActions {
  /** Idempotently hydrate `enabled` from the Rust approvals status. */
  init: () => Promise<void>;
  /** Install/remove the global hook; store the authoritative returned state. */
  setEnabled: (enable: boolean) => Promise<void>;
  /** Append a pending request (de-duped by id). */
  addPending: (p: PendingPermission) => void;
  /** Allow/deny a pending request, then drop it from the queue. */
  resolve: (id: string, allow: boolean) => Promise<void>;
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
    set((s) => (s.pending.some((x) => x.id === p.id) ? s : { pending: [...s.pending, p] }));
  },

  resolve: async (id, allow) => {
    if (get().busy) return; // one resolve in flight at a time
    set({ busy: id });
    try {
      await resolvePermission(id, allow, '');
    } catch {
      // Resolve failed — drop it from the queue anyway so the UI isn't stuck;
      // the parked session will time out / re-prompt on the Rust side.
    } finally {
      set((s) => ({ pending: s.pending.filter((p) => p.id !== id), busy: null }));
    }
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
