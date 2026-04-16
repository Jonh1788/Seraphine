import { useCallback, useEffect, useRef, useState } from 'react';
import { DropletIcon, SettingsIcon, TrashIcon } from '../icons/Icons';
import {
  addWaterIntake,
  deleteWaterLog,
  getWaterProfile,
  getWaterToday,
  saveWaterProfile,
} from './api';
import { WaterGlass } from './WaterGlass';
import { WaterSetupModal } from './WaterSetupModal';
import type { WaterLog, WaterProfile, WaterProfileInput, WaterToday } from './types';

export interface WaterWidgetProps {
  compact?: boolean;
  /** Fired when the user chooses to open the setup modal via the CTA. If
   *  omitted, the widget opens its own internal modal. */
  onSetupClick?: () => void;
}

const PROFILE_CACHE_KEY = 'seraphine.water.profile';

const QUICK_ADD: { ml: number; label: string }[] = [
  { ml: 250, label: '+250ml Copo' },
  { ml: 500, label: '+500ml Garrafa' },
  { ml: 1000, label: '+1000ml Garrafao' },
];

function loadCachedProfile(): WaterProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as WaterProfile;
  } catch {
    return null;
  }
}

function saveCachedProfile(p: WaterProfile | null): void {
  try {
    if (p) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(p));
    else localStorage.removeItem(PROFILE_CACHE_KEY);
  } catch {
    // best-effort cache; ignore
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  } catch {
    return iso;
  }
}

export function WaterWidget({ compact = false, onSetupClick }: WaterWidgetProps): JSX.Element {
  const [profile, setProfile] = useState<WaterProfile | null>(() => loadCachedProfile());
  const [profileLoaded, setProfileLoaded] = useState<boolean>(false);
  const [today, setToday] = useState<WaterToday | null>(null);
  const [busyAmount, setBusyAmount] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [setupOpen, setSetupOpen] = useState<boolean>(false);
  const [setupBusy, setSetupBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshToday = useCallback(async (): Promise<void> => {
    try {
      const data = await getWaterToday();
      if (!mountedRef.current) return;
      setToday(data);
    } catch (e) {
      if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // Fetch profile + today on mount. Profile from localStorage gives instant UI;
  // network result reconciles.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const p = await getWaterProfile();
        if (cancelled || !mountedRef.current) return;
        setProfile(p);
        saveCachedProfile(p);
      } catch (e) {
        if (!cancelled && mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled && mountedRef.current) setProfileLoaded(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (profile) void refreshToday();
  }, [profile, refreshToday]);

  const handleAdd = useCallback(
    async (amount: number): Promise<void> => {
      if (!profile || busyAmount != null) return;
      setBusyAmount(amount);
      setError(null);

      // Optimistic update. We prepend a fake log with a negative id so we can
      // swap it out once the server responds.
      const optimisticLog: WaterLog = {
        id: -Date.now(),
        amount_ml: amount,
        date: new Date().toISOString().slice(0, 10),
        logged_at: new Date().toISOString(),
      };
      const goal = today?.goal ?? profile.daily_goal_ml;
      const newTotal = (today?.total ?? 0) + amount;
      setToday((prev) => ({
        total: newTotal,
        goal,
        percent: goal > 0 ? Math.round((newTotal / goal) * 100) : 0,
        logs: [optimisticLog, ...(prev?.logs ?? [])],
      }));

      try {
        const res = await addWaterIntake(amount);
        if (!mountedRef.current) return;
        setToday((prev) => ({
          total: res.total_today,
          goal: res.goal,
          percent: res.percent,
          logs: [
            res.log,
            ...((prev?.logs ?? []).filter((l) => l.id !== optimisticLog.id)),
          ],
        }));
      } catch (e) {
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          // Roll back optimistic update by refetching.
          void refreshToday();
        }
      } finally {
        if (mountedRef.current) setBusyAmount(null);
      }
    },
    [profile, busyAmount, today, refreshToday],
  );

  const handleDelete = useCallback(
    async (id: number): Promise<void> => {
      if (deletingId != null) return;
      setDeletingId(id);
      setError(null);
      // Optimistic removal.
      const prevState = today;
      setToday((prev) => {
        if (!prev) return prev;
        const removed = prev.logs.find((l) => l.id === id);
        const newTotal = Math.max(0, prev.total - (removed?.amount_ml ?? 0));
        return {
          total: newTotal,
          goal: prev.goal,
          percent: prev.goal > 0 ? Math.round((newTotal / prev.goal) * 100) : 0,
          logs: prev.logs.filter((l) => l.id !== id),
        };
      });
      try {
        await deleteWaterLog(id);
      } catch (e) {
        if (mountedRef.current) {
          setError(e instanceof Error ? e.message : String(e));
          setToday(prevState);
        }
      } finally {
        if (mountedRef.current) setDeletingId(null);
      }
    },
    [deletingId, today],
  );

  const handleSaveProfile = useCallback(
    async (value: WaterProfileInput): Promise<void> => {
      setSetupBusy(true);
      setError(null);
      try {
        const saved = await saveWaterProfile(value);
        if (!mountedRef.current) return;
        setProfile(saved);
        saveCachedProfile(saved);
        setSetupOpen(false);
        await refreshToday();
      } catch (e) {
        if (mountedRef.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (mountedRef.current) setSetupBusy(false);
      }
    },
    [refreshToday],
  );

  const openSetup = (): void => {
    if (onSetupClick) onSetupClick();
    else setSetupOpen(true);
  };

  // --- Render: no profile yet ---
  if (profileLoaded && !profile) {
    return (
      <div className={`water-widget${compact ? ' water-widget--compact' : ''}`}>
        <div className="water-widget__header">
          <span className="water-widget__title">
            <DropletIcon size={16} />
            Hidratacao
          </span>
        </div>
        <div className="water-widget__empty">
          <div className="water-widget__empty-icon">
            <DropletIcon size={32} />
          </div>
          <p className="water-widget__empty-title">Configure seu perfil</p>
          <p className="water-widget__empty-hint">
            Seu peso e nivel de atividade calculam a meta diaria.
          </p>
          <button type="button" className="btn-confirm" onClick={openSetup}>
            Configurar
          </button>
        </div>
        {setupOpen && (
          <WaterSetupModal
            busy={setupBusy}
            onClose={() => setSetupOpen(false)}
            onSubmit={(v) => void handleSaveProfile(v)}
          />
        )}
      </div>
    );
  }

  // --- Render: with profile (possibly stale) ---
  const goal = today?.goal ?? profile?.daily_goal_ml ?? 2000;
  const total = today?.total ?? 0;
  const percent = today?.percent ?? (goal > 0 ? Math.round((total / goal) * 100) : 0);
  const recentLogs = (today?.logs ?? []).slice(0, 5);
  const glassSize = compact ? 130 : 170;

  return (
    <div className={`water-widget${compact ? ' water-widget--compact' : ''}`}>
      <div className="water-widget__header">
        <span className="water-widget__title">
          <DropletIcon size={16} />
          Hidratacao
        </span>
        <button
          type="button"
          className="water-widget__settings"
          onClick={openSetup}
          title="Editar perfil"
          aria-label="Editar perfil"
        >
          <SettingsIcon size={14} />
        </button>
      </div>

      <div className="water-widget__hero">
        <WaterGlass percent={percent} total={total} goal={goal} size={glassSize} />
      </div>

      <div className="water-widget__buttons">
        {QUICK_ADD.map((opt) => {
          const busy = busyAmount === opt.ml;
          return (
            <button
              key={opt.ml}
              type="button"
              className="water-widget__btn"
              onClick={() => void handleAdd(opt.ml)}
              disabled={busyAmount != null || !profile}
              title={opt.label}
            >
              {busy ? '...' : opt.label}
            </button>
          );
        })}
      </div>

      {recentLogs.length > 0 && (
        <div className="water-widget__logs">
          <div className="water-widget__logs-title">Ultimas doses</div>
          {recentLogs.map((log) => (
            <div key={log.id} className="water-widget__log">
              <span className="water-widget__log-time">{formatTime(log.logged_at)}</span>
              <span className="water-widget__log-amount">{log.amount_ml}ml</span>
              <button
                type="button"
                className="water-widget__log-delete"
                onClick={() => void handleDelete(log.id)}
                disabled={deletingId === log.id || log.id < 0}
                title="Remover"
                aria-label="Remover registro"
              >
                <TrashIcon size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {error && <div className="water-widget__error">{error}</div>}

      {setupOpen && (
        <WaterSetupModal
          profile={profile ?? null}
          busy={setupBusy}
          onClose={() => setSetupOpen(false)}
          onSubmit={(v) => void handleSaveProfile(v)}
        />
      )}
    </div>
  );
}
