import { useCallback, useEffect, useMemo, useState } from 'react';
import './obsidian.css';
import { API_BASE } from '../api';
import { useChatStore } from '../stores/chatStore';
import { useRealtimeStore } from '../stores/realtimeStore';
import { useAppRefs } from '../stores/RefsContext';
import {
  BellIcon,
  BrainIcon,
  CheckCircleIcon,
  RefreshIcon,
  WhatsAppIcon,
} from '../icons/Icons';

interface SystemStatusViewProps {
  onBack: () => void;
}

type MicState = 'granted' | 'denied' | 'prompt' | 'unknown';

interface AppMeta {
  version: string;
  platform: string;
}

interface SystemStatusResponse {
  status?: string;
  version?: string;
  started_at?: string | null;
  uptime_seconds?: number;
  platform?: string;
}

interface StorageSegment {
  key: string;
  label: string;
  bytes: number;
}

interface StorageResponse {
  segments?: StorageSegment[];
  total_bytes?: number;
  quota_bytes?: number | null;
}

type Level = 'ok' | 'warn' | 'off';

interface CheckItem {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

interface ProactiveJob {
  id: string;
  name: string;
  next_run_time?: string | null;
  trigger?: string;
  paused?: boolean;
  last_run?: {
    finished_at?: string | null;
    ok?: boolean;
    error?: string | null;
  } | null;
}

interface ServiceCard {
  id: string;
  label: string;
  level: Level;
  detail: string;
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function fmtDate(value?: string | null): string {
  if (!value) return 'sem registro';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  const text = value >= 100 || i === 0 ? value.toFixed(0) : value.toFixed(1);
  return `${text.replace('.', ',')} ${units[i]}`;
}

function fmtUptime(seconds?: number): string {
  if (!seconds || seconds < 0) return 'sem registro';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${Math.floor(seconds)} s`;
}

function detectPlatformFromUA(): string {
  const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS';
  if (/Android/i.test(ua)) return 'Android';
  if (/Mac OS X|Macintosh/i.test(ua)) {
    return /arm|apple silicon/i.test(ua) ? 'macOS · Apple Silicon' : 'macOS';
  }
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'Web';
}

export function SystemStatusView({ onBack }: SystemStatusViewProps): JSX.Element {
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [jobs, setJobs] = useState<ProactiveJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [sysInfo, setSysInfo] = useState<SystemStatusResponse | null>(null);
  const [storage, setStorage] = useState<StorageResponse | null>(null);
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [appMeta, setAppMeta] = useState<AppMeta>({
    version: 'web',
    platform: detectPlatformFromUA(),
  });
  const [micState, setMicState] = useState<MicState>('unknown');
  const [avatarReady, setAvatarReady] = useState(false);

  // Live WS connection state (set by AppBootstrap from ws.onStatus) and
  // realtime/mic state — these are the REAL client-side signals the
  // WebSocket / Voz service cards should reflect.
  const wsStatus = useChatStore((s) => s.status);
  const realtimeActive = useRealtimeStore((s) => s.realtimeActive);
  const manualMute = useRealtimeStore((s) => s.manualMute);
  const { avatarCtrlRef } = useAppRefs();

  const refresh = useCallback(async () => {
    setLoading(true);
    const next: CheckItem[] = [];
    const add = async (
      id: string,
      label: string,
      path: string,
      parse: (body: unknown) => CheckItem,
    ): Promise<void> => {
      try {
        next.push(parse(await fetchJson(path)));
      } catch (e) {
        next.push({
          id,
          label,
          level: 'off',
          detail: e instanceof Error ? e.message : 'indisponivel',
        });
      }
    };

    await Promise.all([
      add('backend', 'Backend', '/health', () => ({
        id: 'backend',
        label: 'Backend',
        level: 'ok',
        detail: 'online',
      })),
      add('memory', 'Memoria semantica', '/memory/health', (body) => {
        const b = body as {
          ok?: boolean;
          chroma?: { reachable?: boolean; count?: number };
          facts?: { active?: number; total?: number };
          warnings_24h?: number;
        };
        return {
          id: 'memory',
          label: 'Memoria semantica',
          level: b.ok ? 'ok' : 'warn',
          detail: `${b.facts?.active ?? 0}/${b.facts?.total ?? 0} fatos ativos, ${b.chroma?.count ?? 0} vetores, ${b.warnings_24h ?? 0} avisos`,
        };
      }),
      add('google', 'Google', '/google/oauth/status', (body) => {
        const b = body as { authed?: boolean; email?: string };
        return {
          id: 'google',
          label: 'Google',
          level: b.authed ? 'ok' : 'warn',
          detail: b.authed ? (b.email || 'conectado') : 'nao conectado',
        };
      }),
      add('whatsapp', 'WhatsApp', '/whatsapp/status', (body) => {
        const b = body as { ready?: boolean; connected?: boolean; status?: string };
        const ok = Boolean(b.ready || b.connected || b.status === 'ready');
        return {
          id: 'whatsapp',
          label: 'WhatsApp',
          level: ok ? 'ok' : 'warn',
          detail: b.status || (ok ? 'conectado' : 'aguardando'),
        };
      }),
      add('push', 'Web Push', '/push/status', (body) => {
        const b = body as { configured?: boolean; subscription_count?: number };
        return {
          id: 'push',
          label: 'Web Push',
          level: b.configured ? 'ok' : 'warn',
          detail: b.configured ? `${b.subscription_count || 0} dispositivos` : 'nao configurado',
        };
      }),
      add('background', 'Background tasks', '/background_tasks', (body) => {
        const b = body as { tasks?: unknown[] };
        return {
          id: 'background',
          label: 'Background tasks',
          level: 'ok',
          detail: `${b.tasks?.length ?? 0} tarefas registradas`,
        };
      }),
    ]);

    try {
      const body = await fetchJson('/proactive/jobs') as { jobs?: ProactiveJob[] };
      setJobs(body.jobs || []);
    } catch {
      setJobs([]);
    }

    // Backend process status (version/uptime) + real on-disk storage.
    try {
      const body = await fetchJson('/system/status') as SystemStatusResponse;
      setSysInfo(body);
    } catch {
      setSysInfo(null);
    }
    try {
      const body = await fetchJson('/system/storage') as StorageResponse;
      setStorage(body);
    } catch {
      setStorage(null);
    }

    setChecks(next);
    setLastSyncAt(new Date().toISOString());
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Preserve the back affordance (and the onBack prop) by mapping Escape → onBack.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Real microphone permission state for the Voz card. The Permissions
  // API is not universal (Safari/iOS lacks the 'microphone' name), so we
  // fall back to 'unknown' and let the realtime/mute flags carry the
  // detail. We never trigger a permission prompt here.
  useEffect(() => {
    let cancelled = false;
    let permObj: PermissionStatus | null = null;
    const onChange = (): void => {
      if (permObj && !cancelled) setMicState(permObj.state as MicState);
    };
    (async () => {
      try {
        const perms = navigator.permissions;
        if (!perms?.query) return;
        permObj = await perms.query({ name: 'microphone' as PermissionName });
        if (cancelled) return;
        setMicState(permObj.state as MicState);
        permObj.addEventListener?.('change', onChange);
      } catch {
        if (!cancelled) setMicState('unknown');
      }
    })();
    return () => {
      cancelled = true;
      permObj?.removeEventListener?.('change', onChange);
    };
  }, []);

  // Avatar readiness: the VRM controller is published on avatarCtrlRef
  // once the model finishes loading (AppBootstrap listens for
  // 'seraphine:avatar-ready'). Reflect its presence in the Avatar card.
  useEffect(() => {
    if (avatarCtrlRef.current) setAvatarReady(true);
    const onReady = (): void => setAvatarReady(true);
    window.addEventListener('seraphine:avatar-ready', onReady);
    return () => window.removeEventListener('seraphine:avatar-ready', onReady);
  }, [avatarCtrlRef]);

  // Real app version (Tauri) + platform. getVersion() exists only inside
  // the Tauri shell; in the browser build we keep the navigator-derived
  // values. Platform falls back to the OS plugin if present, else UA.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { getVersion } = await import('@tauri-apps/api/app');
        const version = await getVersion();
        if (!cancelled && version) {
          setAppMeta((prev) => ({ ...prev, version: `${version} (Tauri)` }));
        }
      } catch {
        // Not running inside Tauri — keep the navigator-derived defaults.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const checkById = useCallback(
    (id: string): CheckItem | undefined => checks.find((c) => c.id === id),
    [checks],
  );

  // Map the live health checks onto the 6 canonical Obsidian service cards.
  // Backend / push / Banco local are backed by HTTP checks; WebSocket /
  // Avatar 3D / Voz are driven by real client-side signals (live socket
  // state, VRM-loaded flag, realtime + mic-permission state).
  const services = useMemo<ServiceCard[]>(() => {
    const backend = checkById('backend');
    const push = checkById('push');
    const memory = checkById('memory');

    const wsConnected = wsStatus === 'connected';

    // Voz: warn only when the browser explicitly denied the mic. Otherwise
    // report realtime activity / readiness from the realtime store.
    const micDenied = micState === 'denied';
    const voiceLevel: Level = micDenied ? 'warn' : 'ok';
    const voiceDetail = micDenied
      ? 'mic bloqueado'
      : realtimeActive
        ? (manualMute ? 'realtime ativo · mic mudo' : 'realtime ativo · ouvindo')
        : micState === 'granted'
          ? 'pronto · mic ok'
          : 'pronto';

    const list: ServiceCard[] = [
      {
        id: 'backend',
        label: 'Backend',
        level: backend?.level ?? 'off',
        detail: backend ? (backend.level === 'ok' ? 'Online' : backend.detail) : 'verificando',
      },
      {
        id: 'websocket',
        label: 'WebSocket',
        level: wsConnected ? 'ok' : 'off',
        detail: wsConnected ? 'Conectado · tempo real' : 'desconectado',
      },
      {
        id: 'avatar',
        label: 'Avatar 3D (VRM)',
        level: avatarReady ? 'ok' : 'warn',
        detail: avatarReady ? 'Carregado' : 'carregando',
      },
      {
        id: 'voice',
        label: 'Voz (realtime)',
        level: voiceLevel,
        detail: voiceDetail,
      },
      {
        id: 'push',
        label: 'Notificações push',
        level: push?.level ?? 'warn',
        detail: push ? push.detail : 'Aguardando permissão',
      },
      {
        id: 'db',
        label: 'Banco local',
        level: memory?.level ?? 'ok',
        detail: memory ? memory.detail : 'SQLite · sincronizado',
      },
    ];
    // Keep any remaining live diagnostics (Google / WhatsApp / Background) visible
    // so no real status data is lost relative to the previous diagnostics list.
    for (const extra of checks) {
      if (!['backend', 'push', 'memory'].includes(extra.id)) {
        list.push({ id: extra.id, label: extra.label, level: extra.level, detail: extra.detail });
      }
    }
    return list;
  }, [checkById, checks, wsStatus, avatarReady, micState, realtimeActive, manualMute]);

  const overall = useMemo<{ level: Level; label: string }>(() => {
    const off = services.filter((s) => s.level === 'off').length;
    const warn = services.filter((s) => s.level === 'warn').length;
    if (off > 0) return { level: 'off', label: `${off} serviço${off > 1 ? 's' : ''} offline` };
    if (warn > 0) return { level: 'warn', label: `${warn} ponto${warn > 1 ? 's' : ''} de atenção` };
    return { level: 'ok', label: 'Tudo operacional' };
  }, [services]);

  // Real storage segments. Bar widths are scaled to the LARGEST segment so
  // the relative on-disk footprint is visible even when total usage is a
  // few MB (a percent-of-5GB scale would render every bar near-zero).
  const SEG_COLORS: Record<string, string> = {
    conversas: '#42a5f5',
    imagens: '#ab47bc',
    memoria: '#4ade80',
  };
  const storageView = useMemo(() => {
    const segments = storage?.segments ?? [];
    const total = storage?.total_bytes ?? segments.reduce((s, x) => s + (x.bytes || 0), 0);
    const max = Math.max(1, ...segments.map((s) => s.bytes || 0));
    return {
      total,
      hasData: storage !== null,
      bars: segments.map((s) => ({
        key: s.key,
        label: s.label,
        bytes: s.bytes || 0,
        widthPct: Math.round(((s.bytes || 0) / max) * 100),
        color: SEG_COLORS[s.key] ?? '#42a5f5',
      })),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storage]);

  const runJob = async (job: ProactiveJob): Promise<void> => {
    const name = job.id || job.name;
    setRunningJob(name);
    try {
      await fetch(`${API_BASE}/proactive/jobs/${encodeURIComponent(name)}/run`, { method: 'POST' });
      await refresh();
    } finally {
      setRunningJob(null);
    }
  };

  const setJobPaused = async (job: ProactiveJob, paused: boolean): Promise<void> => {
    const name = job.id || job.name;
    setRunningJob(name);
    try {
      await fetch(`${API_BASE}/proactive/jobs/${encodeURIComponent(name)}/${paused ? 'pause' : 'resume'}`, { method: 'POST' });
      await refresh();
    } finally {
      setRunningJob(null);
    }
  };

  const testPush = async (): Promise<void> => {
    await fetch(`${API_BASE}/push/test`, { method: 'POST' });
  };

  const pillClass =
    overall.level === 'off'
      ? 'sys-status-pill sys-status-pill--off'
      : overall.level === 'warn'
        ? 'sys-status-pill sys-status-pill--warn'
        : 'sys-status-pill';

  return (
    <div className="obs-screen system-view">
      <div className="obs-screen__header">
        <div className="obs-screen__titles">
          <h2 className="obs-screen__title">Sistema</h2>
          <p className="obs-screen__sub">Status dos serviços da Seraphine</p>
        </div>
        <div className="obs-screen__actions">
          <button
            className="sys-refresh"
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            title="Atualizar status"
          >
            <RefreshIcon size={14} />
            <span>{loading ? 'Atualizando' : 'Atualizar'}</span>
          </button>
          <span className={pillClass}>
            <span className="sys-status-pill__dot" />
            {overall.label}
          </span>
        </div>
      </div>

      <div className="obs-screen__body">
        <div className="sys-services">
          {services.map((item) => (
            <div key={item.id} className="sys-service">
              <div className="sys-service__top">
                <span className="sys-service__name">{item.label}</span>
                <span className={`sys-service__dot sys-service__dot--${item.level}`} />
              </div>
              <div className="sys-service__detail">{item.detail}</div>
            </div>
          ))}
        </div>

        <div className="sys-cards-row">
          <section className="sys-card">
            <div className="sys-card__title">Armazenamento</div>
            <div className="sys-storage-meta">
              <span>{fmtBytes(storageView.total)} usados</span>
              <span>{storageView.hasData ? 'em disco local' : 'verificando'}</span>
            </div>
            <div className="sys-storage-bar">
              {storageView.bars.map((b) => (
                <div
                  key={b.key}
                  className="sys-storage-seg"
                  style={{ width: `${b.widthPct}%`, background: b.color }}
                  title={`${b.label}: ${fmtBytes(b.bytes)}`}
                />
              ))}
            </div>
            <div className="sys-legend">
              {(storageView.bars.length > 0
                ? storageView.bars
                : [
                    { key: 'conversas', label: 'Conversas', color: SEG_COLORS.conversas, bytes: 0 },
                    { key: 'imagens', label: 'Imagens', color: SEG_COLORS.imagens, bytes: 0 },
                    { key: 'memoria', label: 'Memória', color: SEG_COLORS.memoria, bytes: 0 },
                  ]
              ).map((b) => (
                <span key={b.key}>
                  <i style={{ background: b.color }} />
                  {b.label}
                  {storageView.hasData ? ` · ${fmtBytes(b.bytes)}` : ''}
                </span>
              ))}
            </div>
          </section>

          <section className="sys-card">
            <div className="sys-card__title">Aplicativo</div>
            <div className="sys-info-row">
              <span className="k">Versão</span>
              <span className="v">
                {appMeta.version}
                {sysInfo?.version ? ` · API ${sysInfo.version}` : ''}
              </span>
            </div>
            <div className="sys-info-row">
              <span className="k">Plataforma</span>
              <span className="v">{appMeta.platform}</span>
            </div>
            <div className="sys-info-row">
              <span className="k">Uptime</span>
              <span className="v">{fmtUptime(sysInfo?.uptime_seconds)}</span>
            </div>
            <div className="sys-info-row">
              <span className="k">Última sync</span>
              <span className="v v--ok">{lastSyncAt ? fmtDate(lastSyncAt) : 'sem registro'}</span>
            </div>
          </section>
        </div>

        <section className="sys-card">
          <div className="sys-card__title">Atalhos operacionais</div>
          <div className="sys-actions">
            <button type="button" onClick={() => void testPush()}>
              <BellIcon size={16} />
              Testar push
            </button>
            <button type="button" onClick={() => window.open(`${API_BASE}/wa`, '_blank', 'noopener,noreferrer')}>
              <WhatsAppIcon size={16} />
              Abrir WhatsApp QR
            </button>
            <button type="button" onClick={() => window.open(`${API_BASE}/memory/export`, '_blank', 'noopener,noreferrer')}>
              <BrainIcon size={16} />
              Exportar memoria
            </button>
          </div>
        </section>

        <section className="sys-card">
          <div className="sys-card__title">Proatividade</div>
          {jobs.length === 0 && <div className="sys-empty">Scheduler indisponivel ou sem jobs.</div>}
          <div className="sys-jobs">
            {jobs.map((job) => (
              <div key={job.id || job.name} className="sys-job">
                <div className="sys-job__main">
                  <strong>{job.name || job.id}</strong>
                  <span>{job.trigger || 'job'} · {job.paused ? 'pausado' : `proxima: ${fmtDate(job.next_run_time)}`}</span>
                  <span>
                    ultimo: {fmtDate(job.last_run?.finished_at)}
                    {job.last_run && (
                      <>
                        {' '}
                        <CheckCircleIcon size={13} />
                        {job.last_run.ok ? 'ok' : job.last_run.error || 'falhou'}
                      </>
                    )}
                  </span>
                </div>
                <div className="sys-job__actions">
                  <button
                    type="button"
                    onClick={() => void runJob(job)}
                    disabled={runningJob === (job.id || job.name)}
                  >
                    Executar
                  </button>
                  <button
                    type="button"
                    onClick={() => void setJobPaused(job, !job.paused)}
                    disabled={runningJob === (job.id || job.name)}
                  >
                    {job.paused ? 'Retomar' : 'Pausar'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
