import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIcon,
  BedIcon,
  FlameIcon,
  FootprintsIcon,
  HeartPulseIcon,
  RefreshIcon,
  ScaleIcon,
} from '../icons/Icons';
import {
  getBackendToday,
  isTauriAvailable,
  requestHealthAuthorization,
  syncTodaySnapshot,
} from './api';
import type { HealthSnapshot } from './types';

const STEPS_GOAL = 10_000;

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return Math.round(value).toLocaleString('pt-BR');
}

function formatMinutes(value: number | null | undefined): string {
  if (value === null || value === undefined || value <= 0) return '—';
  const total = Math.round(value);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function goalColor(pct: number): string {
  if (pct >= 100) return '#4ade80';
  if (pct >= 60) return '#f59e0b';
  return '#ef4444';
}

export function HealthWidget(): JSX.Element {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [syncing, setSyncing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef<boolean>(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadFromBackend = useCallback(async (): Promise<void> => {
    try {
      const snap = await getBackendToday();
      if (!mountedRef.current) return;
      setSnapshot(snap);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, []);

  const sync = useCallback(async (): Promise<void> => {
    if (syncing) return;
    setSyncing(true);
    setError(null);
    try {
      const snap = await syncTodaySnapshot();
      if (!mountedRef.current) return;
      setSnapshot(snap);
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (mountedRef.current) {
        setSyncing(false);
        setLoading(false);
      }
    }
  }, [syncing]);

  // Initial load: backend first (instant), then bridge sync (may be slow).
  useEffect(() => {
    void (async () => {
      await loadFromBackend();
      setLoading(false);
      if (isTauriAvailable()) {
        try {
          await requestHealthAuthorization();
        } catch {
          // Non-fatal — bridge may be in mock or disabled mode.
        }
        void sync();
      }
    })();
    // sync / loadFromBackend are stable via useCallback
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic re-sync every 10 min while the widget is mounted.
  useEffect(() => {
    if (!isTauriAvailable()) return;
    const id = window.setInterval(() => {
      void sync();
    }, 10 * 60 * 1000);
    return () => window.clearInterval(id);
  }, [sync]);

  const steps = snapshot?.steps ?? 0;
  const pct = Math.min(100, Math.round((steps / STEPS_GOAL) * 100));
  const barColor = goalColor(Math.round((steps / STEPS_GOAL) * 100));

  const workouts = snapshot?.workouts ?? [];
  const workoutSummary = (() => {
    if (workouts.length === 0) return 'Nenhum';
    const totalMin = Math.round(
      workouts.reduce((acc, w) => acc + (w.duration_min || 0), 0),
    );
    if (workouts.length === 1) {
      const w = workouts[0];
      return `${w.type} · ${Math.round(w.duration_min || 0)}min`;
    }
    return `${workouts.length} treinos · ${totalMin}min`;
  })();

  return (
    <div className="health-widget">
      <div className="health-widget__header">
        <span className="health-widget__title">
          <HeartPulseIcon size={16} />
          Saude hoje
        </span>
        <button
          type="button"
          className="health-widget__sync"
          onClick={() => void sync()}
          disabled={syncing || !isTauriAvailable()}
          title={isTauriAvailable() ? 'Sincronizar com Apple Saude' : 'Bridge disponivel so no desktop'}
          aria-label="Sincronizar"
        >
          <RefreshIcon size={14} />
        </button>
      </div>

      {loading ? (
        <div className="health-widget__empty">Carregando...</div>
      ) : !snapshot ? (
        <div className="health-widget__empty">
          <p className="health-widget__empty-title">Sem dados ainda</p>
          <p className="health-widget__empty-hint">
            {isTauriAvailable()
              ? 'Clique em sincronizar pra trazer do Apple Saude.'
              : 'Abra o app desktop pra sincronizar com o Apple Saude.'}
          </p>
          {isTauriAvailable() && (
            <button
              type="button"
              className="btn-confirm"
              onClick={() => void sync()}
              disabled={syncing}
            >
              {syncing ? 'Sincronizando...' : 'Sincronizar agora'}
            </button>
          )}
        </div>
      ) : (
        <div className="health-widget__body">
          <div className="health-widget__steps">
            <div className="health-widget__steps-head">
              <span className="health-widget__metric-icon" style={{ color: '#22d3ee' }}>
                <FootprintsIcon size={16} />
              </span>
              <div className="health-widget__steps-label">Passos</div>
              <div className="health-widget__steps-value">
                {formatNumber(steps)} / {formatNumber(STEPS_GOAL)}
              </div>
            </div>
            <div className="health-widget__bar">
              <div
                className="health-widget__bar-fill"
                style={{ width: `${pct}%`, background: barColor }}
              />
            </div>
          </div>

          <div className="health-widget__grid">
            <div className="health-widget__cell" title="Calorias ativas">
              <span className="health-widget__metric-icon" style={{ color: '#f97316' }}>
                <FlameIcon size={14} />
              </span>
              <div className="health-widget__cell-body">
                <div className="health-widget__cell-label">Calorias</div>
                <div className="health-widget__cell-value">
                  {formatNumber(snapshot.active_calories)} kcal
                </div>
              </div>
            </div>

            <div className="health-widget__cell" title="Sono">
              <span className="health-widget__metric-icon" style={{ color: '#9a93ff' }}>
                <BedIcon size={14} />
              </span>
              <div className="health-widget__cell-body">
                <div className="health-widget__cell-label">Sono</div>
                <div className="health-widget__cell-value">
                  {formatMinutes(snapshot.sleep_minutes)}
                  {snapshot.sleep_quality && snapshot.sleep_minutes
                    ? ` · ${snapshot.sleep_quality}`
                    : ''}
                </div>
              </div>
            </div>

            <div className="health-widget__cell" title="Treinos">
              <span className="health-widget__metric-icon" style={{ color: '#4ade80' }}>
                <ActivityIcon size={14} />
              </span>
              <div className="health-widget__cell-body">
                <div className="health-widget__cell-label">Treinos</div>
                <div className="health-widget__cell-value">{workoutSummary}</div>
              </div>
            </div>

            <div className="health-widget__cell" title="Frequencia cardiaca de repouso">
              <span className="health-widget__metric-icon" style={{ color: '#ef4444' }}>
                <HeartPulseIcon size={14} />
              </span>
              <div className="health-widget__cell-body">
                <div className="health-widget__cell-label">FC repouso</div>
                <div className="health-widget__cell-value">
                  {snapshot.resting_heart_rate
                    ? `${Math.round(snapshot.resting_heart_rate)} bpm`
                    : '—'}
                </div>
              </div>
            </div>

            {snapshot.weight_kg != null && (
              <div className="health-widget__cell" title="Peso">
                <span className="health-widget__metric-icon" style={{ color: '#22d3ee' }}>
                  <ScaleIcon size={14} />
                </span>
                <div className="health-widget__cell-body">
                  <div className="health-widget__cell-label">Peso</div>
                  <div className="health-widget__cell-value">
                    {snapshot.weight_kg.toFixed(1)} kg
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {error && <div className="health-widget__error">{error}</div>}
    </div>
  );
}
