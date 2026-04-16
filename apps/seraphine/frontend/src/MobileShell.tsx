/**
 * Mobile (iOS/iPad) shell — SDD 018.
 *
 * The desktop App is dense with Mac-only affordances: sidebar, tray,
 * multi-window, VRM avatar stage, keyboard shortcuts. On iOS we ignore
 * all of that and ship a focused shell whose only job today is to sync
 * Apple HealthKit snapshots to the Seraphine backend.
 *
 * Over time, this component will grow to a real iOS experience (chat,
 * tasks, notes) but for now it's intentionally minimal.
 */

import { useEffect, useRef, useState } from 'react';
import { API_BASE } from './api';
import {
  ActivityIcon,
  BedIcon,
  FootprintsIcon,
  HeartPulseIcon,
  RefreshIcon,
} from './icons/Icons';
import {
  getBackendToday,
  isTauriAvailable,
  requestHealthAuthorization,
  scheduleBackgroundSync,
  syncTodaySnapshot,
} from './health/api';
import type { AuthorizationStatus, HealthSnapshot } from './health/types';

type SyncState = 'idle' | 'requesting-auth' | 'syncing' | 'ok' | 'error';

function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return '—';
  const total = Math.round(value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Math.round(value).toLocaleString('pt-BR');
}

export function MobileShell(): JSX.Element {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [state, setState] = useState<SyncState>('idle');
  const [authMsg, setAuthMsg] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [lastSyncedAt, setLastSyncedAt] = useState<string>('');
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSync = async (): Promise<void> => {
    if (!isTauriAvailable()) {
      setState('error');
      setErrorMsg('Tauri runtime nao disponivel (abra pelo app instalado).');
      return;
    }
    setErrorMsg('');
    setState('requesting-auth');
    let auth: AuthorizationStatus | null = null;
    try {
      auth = await requestHealthAuthorization();
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!mountedRef.current) return;
    setAuthMsg(auth?.message ?? '');
    if (!auth?.authorized) {
      setState('error');
      setErrorMsg(
        auth?.message ?? 'Apple Saude nao autorizou. Verifique Ajustes → Saude.',
      );
      return;
    }
    setState('syncing');
    try {
      const snap = await syncTodaySnapshot();
      if (!mountedRef.current) return;
      setSnapshot(snap);
      setLastSyncedAt(new Date().toLocaleTimeString('pt-BR'));
      setState('ok');
      // Best-effort: ask iOS to keep syncing in the background. Safe to
      // call every sync — BGTaskScheduler.submit is idempotent.
      try {
        await scheduleBackgroundSync();
      } catch {
        /* non-fatal */
      }
    } catch (err) {
      if (mountedRef.current) {
        setState('error');
        setErrorMsg(err instanceof Error ? err.message : String(err));
      }
    }
  };

  useEffect(() => {
    void (async () => {
      try {
        const prev = await getBackendToday();
        if (mountedRef.current) setSnapshot(prev);
      } catch {
        // ignore — fresh install
      }
    })();
  }, []);

  // Foreground auto-sync: whenever iOS re-surfaces the app we trigger a
  // fresh HealthKit fetch + push. Keeps the dashboard warm without the
  // user ever touching the refresh button. Paired with the background
  // task registered in Swift for truly passive updates.
  useEffect(() => {
    if (!isTauriAvailable()) return;
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') {
        void runSync();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="mobile-shell">
      <header className="mobile-shell__header">
        <div className="mobile-shell__brand">
          <HeartPulseIcon size={22} />
          <h1>Seraphine</h1>
        </div>
        <button
          type="button"
          className="mobile-shell__sync-btn"
          onClick={() => void runSync()}
          disabled={state === 'syncing' || state === 'requesting-auth'}
          aria-label="Sincronizar Apple Saude"
        >
          <RefreshIcon size={18} />
        </button>
      </header>

      <section className="mobile-shell__status">
        {state === 'requesting-auth' && <p>Solicitando autorizacao do Apple Saude...</p>}
        {state === 'syncing' && <p>Sincronizando dados...</p>}
        {state === 'ok' && lastSyncedAt && (
          <p className="mobile-shell__status--ok">
            Sincronizado as {lastSyncedAt} · API {API_BASE.replace(/^https?:\/\//, '')}
          </p>
        )}
        {state === 'error' && (
          <p className="mobile-shell__status--err">{errorMsg}</p>
        )}
        {authMsg && state === 'ok' && (
          <p className="mobile-shell__status--auth">{authMsg}</p>
        )}
      </section>

      {snapshot ? (
        <section className="mobile-shell__card">
          <div className="mobile-shell__row">
            <FootprintsIcon size={20} />
            <div>
              <div className="mobile-shell__label">Passos</div>
              <div className="mobile-shell__value">{formatNumber(snapshot.steps)}</div>
            </div>
          </div>
          <div className="mobile-shell__row">
            <ActivityIcon size={20} />
            <div>
              <div className="mobile-shell__label">Calorias ativas</div>
              <div className="mobile-shell__value">
                {formatNumber(snapshot.active_calories)} kcal
              </div>
            </div>
          </div>
          <div className="mobile-shell__row">
            <BedIcon size={20} />
            <div>
              <div className="mobile-shell__label">Sono</div>
              <div className="mobile-shell__value">
                {formatMinutes(snapshot.sleep_minutes)}
                {snapshot.sleep_quality ? ` · ${snapshot.sleep_quality}` : ''}
              </div>
            </div>
          </div>
          <div className="mobile-shell__row">
            <HeartPulseIcon size={20} />
            <div>
              <div className="mobile-shell__label">FC repouso</div>
              <div className="mobile-shell__value">
                {snapshot.resting_heart_rate
                  ? `${Math.round(snapshot.resting_heart_rate)} bpm`
                  : '—'}
              </div>
            </div>
          </div>
          <div className="mobile-shell__row">
            <ActivityIcon size={20} />
            <div>
              <div className="mobile-shell__label">Treinos</div>
              <div className="mobile-shell__value">
                {snapshot.workouts.length === 0
                  ? 'Nenhum'
                  : snapshot.workouts
                      .map(
                        (w) =>
                          `${w.type} ${Math.round(w.duration_min || 0)}min`,
                      )
                      .join(' · ')}
              </div>
            </div>
          </div>
        </section>
      ) : (
        <section className="mobile-shell__empty">
          <p>Sem dados ainda. Toque em sincronizar.</p>
        </section>
      )}
    </div>
  );
}
