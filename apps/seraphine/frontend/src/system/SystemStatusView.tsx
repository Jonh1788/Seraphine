import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_BASE } from '../api';
import {
  ArrowLeftIcon,
  BellIcon,
  BrainIcon,
  CheckCircleIcon,
  RefreshIcon,
  SettingsIcon,
  WhatsAppIcon,
} from '../icons/Icons';

interface SystemStatusViewProps {
  onBack: () => void;
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

export function SystemStatusView({ onBack }: SystemStatusViewProps): JSX.Element {
  const [checks, setChecks] = useState<CheckItem[]>([]);
  const [jobs, setJobs] = useState<ProactiveJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningJob, setRunningJob] = useState<string | null>(null);
  const [tab, setTab] = useState<'status' | 'controls'>('status');

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
    setChecks(next);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const summary = useMemo(() => {
    const off = checks.filter((c) => c.level === 'off').length;
    const warn = checks.filter((c) => c.level === 'warn').length;
    if (off > 0) return `${off} offline, ${warn} atencao`;
    if (warn > 0) return `${warn} pontos de atencao`;
    return 'tudo operacional';
  }, [checks]);

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

  return (
    <div className="system-view">
      <div className="system-view__header">
        <button className="system-view__back" type="button" onClick={onBack}>
          <ArrowLeftIcon size={18} />
          <span>Voltar</span>
        </button>
        <div className="system-view__title-wrap">
          <div className="system-view__icon"><SettingsIcon size={22} /></div>
          <div>
            <h2 className="system-view__title">Sistema</h2>
            <p className="system-view__subtitle">{summary}</p>
          </div>
        </div>
        <button className="system-view__refresh" type="button" onClick={() => void refresh()} disabled={loading}>
          <RefreshIcon size={16} />
          <span>{loading ? 'Atualizando' : 'Atualizar'}</span>
        </button>
      </div>

      <div className="system-tabs">
        <button type="button" className={tab === 'status' ? 'is-active' : ''} onClick={() => setTab('status')}>
          Status
        </button>
        <button type="button" className={tab === 'controls' ? 'is-active' : ''} onClick={() => setTab('controls')}>
          Controles
        </button>
      </div>

      {tab === 'status' && (
        <div className="system-grid">
          <section className="system-panel system-panel--wide">
            <h3>Diagnostico</h3>
            <div className="system-checks">
              {checks.map((item) => (
                <div key={item.id} className="system-check">
                  <span className={`system-check__dot system-check__dot--${item.level}`} />
                  <div>
                    <strong>{item.label}</strong>
                    <span>{item.detail}</span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {tab === 'controls' && (
        <div className="system-grid">
          <section className="system-panel">
            <h3>Atalhos operacionais</h3>
            <div className="system-actions">
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

          <section className="system-panel system-panel--wide">
            <h3>Proatividade</h3>
            {jobs.length === 0 && <div className="system-empty">Scheduler indisponivel ou sem jobs.</div>}
            {jobs.map((job) => (
              <div key={job.id || job.name} className="system-job">
                <div className="system-job__main">
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
                <div className="system-job__actions">
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
          </section>
        </div>
      )}
    </div>
  );
}
