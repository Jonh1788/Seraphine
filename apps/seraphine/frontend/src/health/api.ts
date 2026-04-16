import { API_BASE } from '../api';
import type {
  AuthorizationStatus,
  HealthMetric,
  HealthSnapshot,
  HealthTrendResponse,
  HealthWeeklyReport,
} from './types';

/**
 * Apple Health API — split across two surfaces:
 *
 * 1. Tauri invoke commands (`health_*`) — the macOS-side bridge that
 *    talks to HealthKit. In dev/mock mode they return synthetic data;
 *    in signed builds they'll call the real framework.
 * 2. Backend REST endpoints (`/health/*`) — once the frontend pulls
 *    data from the bridge it POSTs snapshots to the backend so the LLM
 *    tools, dashboard, habits and insights can all read the same state.
 *
 * The `syncTodaySnapshot` helper wires both halves together.
 */

// ---------------------------------------------------------------------------
// Tauri invoke wrapper — dynamic import so non-Tauri contexts (browser
// dev in Safari, Playwright) don't break at module load.
// ---------------------------------------------------------------------------

async function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const anyWindow = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  if (!anyWindow.__TAURI_INTERNALS__ && !anyWindow.__TAURI__) {
    throw new Error('Tauri not available — HealthKit bridge only runs in the desktop app');
  }
  const mod = await import('@tauri-apps/api/core');
  return await mod.invoke<T>(cmd, args);
}

/** Is the code running inside the Tauri desktop shell? */
export function isTauriAvailable(): boolean {
  if (typeof window === 'undefined') return false;
  const anyWindow = window as unknown as {
    __TAURI_INTERNALS__?: unknown;
    __TAURI__?: unknown;
  };
  return Boolean(anyWindow.__TAURI_INTERNALS__ || anyWindow.__TAURI__);
}

// ---------------------------------------------------------------------------
// HealthKit bridge
// ---------------------------------------------------------------------------

export async function requestHealthAuthorization(): Promise<AuthorizationStatus> {
  return invokeTauri<AuthorizationStatus>('health_request_authorization');
}

export interface BackgroundScheduleStatus {
  scheduled: boolean;
  message: string;
}

export async function scheduleBackgroundSync(): Promise<BackgroundScheduleStatus> {
  return invokeTauri<BackgroundScheduleStatus>('health_schedule_background');
}

export async function getTodaySummaryFromBridge(): Promise<HealthSnapshot> {
  return invokeTauri<HealthSnapshot>('health_get_today_summary');
}

export async function getRecentFromBridge(days: number): Promise<HealthSnapshot[]> {
  return invokeTauri<HealthSnapshot[]>('health_get_recent', { days });
}

// ---------------------------------------------------------------------------
// Backend REST
// ---------------------------------------------------------------------------

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`);
  }
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return undefined as unknown as T;
  }
  return (await res.json()) as T;
}

export async function postHealthSnapshot(snapshot: HealthSnapshot): Promise<HealthSnapshot> {
  const { synced_at: _ignored, ...body } = snapshot;
  const res = await request<{ snapshot: HealthSnapshot }>('/health/snapshot', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.snapshot;
}

export async function getBackendToday(): Promise<HealthSnapshot | null> {
  const res = await request<{ snapshot: HealthSnapshot | null }>('/health/today');
  return res.snapshot;
}

export async function getBackendRecent(days = 7): Promise<HealthSnapshot[]> {
  const params = new URLSearchParams({ days: String(days) });
  const res = await request<{ snapshots: HealthSnapshot[] }>(
    `/health/recent?${params.toString()}`,
  );
  return res.snapshots;
}

export async function getBackendTrend(
  metric: HealthMetric,
  days = 14,
): Promise<HealthTrendResponse> {
  const params = new URLSearchParams({ metric, days: String(days) });
  return request<HealthTrendResponse>(`/health/trend?${params.toString()}`);
}

export async function getBackendWeekly(): Promise<HealthWeeklyReport> {
  return request<HealthWeeklyReport>('/health/weekly');
}

// ---------------------------------------------------------------------------
// Glue: pull from HealthKit bridge + push to backend
// ---------------------------------------------------------------------------

/**
 * Fetch the latest data from the HealthKit bridge and push it to the
 * backend. Returns what the backend stored so callers can update UI
 * optimistically.
 *
 * If the bridge is unavailable (no Tauri, or release build without
 * entitlement) we fall back to whatever the backend already has, so
 * the UI still gets something to render.
 */
export async function syncTodaySnapshot(): Promise<HealthSnapshot | null> {
  if (!isTauriAvailable()) {
    return getBackendToday();
  }
  try {
    const snap = await getTodaySummaryFromBridge();
    return await postHealthSnapshot(snap);
  } catch (err) {
    console.warn('[health] syncTodaySnapshot failed, falling back to backend', err);
    return getBackendToday();
  }
}

/** Sync the last N days. Useful on first boot after a gap. */
export async function syncRecent(days = 7): Promise<HealthSnapshot[]> {
  if (!isTauriAvailable()) {
    return getBackendRecent(days);
  }
  try {
    const snaps = await getRecentFromBridge(days);
    for (const s of snaps) {
      try {
        await postHealthSnapshot(s);
      } catch (err) {
        console.warn('[health] postHealthSnapshot failed for', s.date, err);
      }
    }
    return getBackendRecent(days);
  } catch (err) {
    console.warn('[health] syncRecent failed, falling back to backend', err);
    return getBackendRecent(days);
  }
}
