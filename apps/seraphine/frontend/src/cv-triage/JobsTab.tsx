import { useEffect, useState } from 'react';
import './obsidian.css';
import { API_BASE } from '../api';
import { listJobs } from './api';
import type { JobSummary } from './types';
import { JobDetailPanel } from './JobDetailPanel';
import { SparkleIcon } from '../icons/Icons';

/**
 * Task 19 — JobsTab
 *
 * Top-level "Trabalhos" view. Shows a chronological list of every CV
 * triage job grouped by day. Clicking a row drills into
 * `<JobDetailPanel>`. The selected job id is session-local — not
 * persisted to the URL or storage — so reloading the tab returns the
 * user to the list.
 */

interface Props {
  /** When provided, the panel mounts directly on the detail view for
   *  this job. Used to deep-link from the in-chat progress card. */
  initialJobId?: number | null;
  /** Reset hook so the parent can clear `initialJobId` after we
   *  consume it once — re-mounting Trabalhos shouldn't auto-open the
   *  same job again. */
  onInitialJobConsumed?: () => void;
}

interface WorkProject {
  id: string;
  name: string;
  description: string;
  area: string;
  status: 'active' | 'paused' | 'done' | 'archived';
  priority: 'low' | 'medium' | 'high';
  tags: string[];
  due_date?: string | null;
  updated_at: string;
}

interface WorkProjectLink {
  id: string;
  project_id: string;
  target_type: string;
  target_id: string;
  title: string;
  created_at: string;
}

interface WorkProjectDetail {
  project: WorkProject;
  links: WorkProjectLink[];
  items?: Array<{
    target_type: string;
    target_id: string;
    title: string;
    data?: Record<string, unknown> | null;
  }>;
  summary: {
    linked_tasks: number;
    linked_triages: number;
    linked_notes: number;
    overdue: boolean;
    attention: boolean;
  };
}

export function JobsTab({
  initialJobId,
  onInitialJobConsumed,
}: Props): JSX.Element {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  // The triage-run board renders real cv_triage jobs (see vagaFromJob).
  // Work projects are still fetched so the create flow can prepend new
  // ones; the previously-fetched-but-discarded /tasks and /work/briefing
  // calls were removed (dead data on this surface).
  const [, setProjects] = useState<WorkProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectDetail, setProjectDetail] = useState<WorkProjectDetail | null>(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: '',
    area: '',
    priority: 'medium',
    due_date: '',
    description: '',
  });
  const [selectedId, setSelectedId] = useState<number | null>(
    initialJobId ?? null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Consume the deep-link target exactly once.
  useEffect(() => {
    if (initialJobId != null) {
      setSelectedId(initialJobId);
      onInitialJobConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJobId]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      listJobs(),
      fetch(`${API_BASE}/work/projects`).then((r) =>
        r.ok ? r.json() as Promise<{ projects: WorkProject[] }> : { projects: [] },
      ),
    ])
      .then(([jobsResult, projectsResult]) => {
        if (cancelled) return;
        if (jobsResult.status === 'fulfilled') {
          setJobs(jobsResult.value);
        } else {
          setError(jobsResult.reason instanceof Error ? jobsResult.reason.message : String(jobsResult.reason));
        }
        if (projectsResult.status === 'fulfilled') {
          setProjects(projectsResult.value.projects || []);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectDetail(null);
      return;
    }
    let cancelled = false;
    fetch(`${API_BASE}/work/projects/${selectedProjectId}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<WorkProjectDetail>;
      })
      .then((detail) => {
        if (!cancelled) setProjectDetail(detail);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  async function createProject(): Promise<void> {
    const name = projectForm.name.trim();
    if (!name) return;
    setCreatingProject(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/work/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          area: projectForm.area.trim(),
          priority: projectForm.priority,
          due_date: projectForm.due_date || null,
          description: projectForm.description.trim(),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const payload = await res.json() as { project: WorkProject };
      setProjects((prev) => [payload.project, ...prev]);
      setProjectForm({ name: '', area: '', priority: 'medium', due_date: '', description: '' });
      setCreateOpen(false);
      setSelectedProjectId(payload.project.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreatingProject(false);
    }
  }

  if (selectedId !== null) {
    return (
      <JobDetailPanel jobId={selectedId} onClose={() => setSelectedId(null)} />
    );
  }

  if (selectedProjectId !== null) {
    return (
      <div className="cvt-jobs-tab">
        <header className="cvt-jobs-header">
          <button type="button" className="work-back-button" onClick={() => setSelectedProjectId(null)}>
            Voltar
          </button>
          <div>
            <h1>{projectDetail?.project.name || 'Projeto'}</h1>
            <p>{projectDetail?.project.area || 'Trabalho'} · {projectDetail?.project.status || 'carregando'}</p>
          </div>
        </header>
        {!projectDetail && <p className="cvt-empty">Carregando projeto…</p>}
        {projectDetail && (
          <>
            <div className="work-summary-grid">
              <div className="work-summary-card">
                <span>Prioridade</span>
                <strong>{projectDetail.project.priority}</strong>
                <small>{projectDetail.project.due_date ? `prazo ${projectDetail.project.due_date}` : 'sem prazo'}</small>
              </div>
              <div className="work-summary-card">
                <span>Vinculos</span>
                <strong>{projectDetail.links.length}</strong>
                <small>{projectDetail.summary.linked_tasks} tarefas · {projectDetail.summary.linked_triages} triagens</small>
              </div>
              <div className="work-summary-card">
                <span>Atencao</span>
                <strong>{projectDetail.summary.overdue ? 'atrasado' : projectDetail.summary.attention ? 'sim' : 'ok'}</strong>
                <small>{projectDetail.project.updated_at ? `atualizado ${new Date(projectDetail.project.updated_at).toLocaleDateString()}` : ''}</small>
              </div>
            </div>
            {projectDetail.project.description && (
              <section className="work-section">
                <h3>Briefing</h3>
                <p className="work-detail-text">{projectDetail.project.description}</p>
              </section>
            )}
            <section className="work-section">
              <div className="work-section__header">
                <h3>Itens vinculados</h3>
                <span>{projectDetail.links.length}</span>
              </div>
              {(projectDetail.items || projectDetail.links).length === 0 && (
                <p className="cvt-empty">Nenhum item vinculado ainda. Use o chat para ligar tarefas, notas ou triagens a este projeto.</p>
              )}
              {(projectDetail.items || projectDetail.links.map((link) => ({
                target_type: link.target_type,
                target_id: link.target_id,
                title: link.title,
                data: null,
              }))).map((item) => (
                <div key={`${item.target_type}-${item.target_id}`} className="work-task-row">
                  <span className="work-task-row__main">
                    <strong>{projectItemTitle(item)}</strong>
                    <small>{projectItemDetail(item)}</small>
                  </span>
                </div>
              ))}
            </section>
          </>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="cvt-jobs-tab">
        <header className="cvt-jobs-header">
          <h1>Trabalhos</h1>
        </header>
        <p className="cvt-empty">Carregando…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="cvt-jobs-tab">
        <header className="cvt-jobs-header">
          <h1>Trabalhos</h1>
        </header>
        <p className="cvt-detail-error">⚠ {error}</p>
      </div>
    );
  }

  // Triage-run view-models, derived from real cv_triage runs (see vagaFromJob).
  const vagas = jobs.map((job, i) => vagaFromJob(job, i));
  const activeCount = jobs.filter(
    (j) => !['done', 'failed', 'cancelled'].includes(j.status),
  ).length;
  const doneCount = jobs.filter((j) => j.status === 'done').length;
  const totalCvs = jobs.reduce((sum, j) => sum + (j.total_cvs || 0), 0);
  // Tip driven off a real top match when a finished run has one, else a
  // neutral nudge. No fabricated "vaga" name — uses real triage data.
  const topVaga = vagas.find((v) => v.match != null) || vagas[0] || null;
  const tip = topVaga && topVaga.match != null
    ? `Melhor candidato de "${topVaga.role}" com ${topVaga.match}% de match — quer revisar a triagem?`
    : 'Inicie uma triagem de CV no chat e a Seraphine ranqueia os candidatos pra você.';

  return (
    <div className="cvt-jobs-tab">
      <header className="cvt-jobs-header">
        <div>
          <h1>Trabalhos</h1>
          <p>
            {vagas.length} triage{vagas.length === 1 ? 'm' : 'ns'} · {activeCount} em andamento
            {doneCount > 0 ? ` · ${doneCount} concluída${doneCount === 1 ? '' : 's'}` : ''}
            {totalCvs > 0 ? ` · ${totalCvs} CV${totalCvs === 1 ? '' : 's'}` : ''}
          </p>
        </div>
        <button type="button" className="work-primary-button" onClick={() => setCreateOpen((v) => !v)}>
          + Novo projeto
        </button>
      </header>

      {createOpen && (
        <form className="work-create-form" onSubmit={(e) => { e.preventDefault(); void createProject(); }}>
          <input
            value={projectForm.name}
            onChange={(e) => setProjectForm((prev) => ({ ...prev, name: e.target.value }))}
            placeholder="Nome do projeto"
          />
          <input
            value={projectForm.area}
            onChange={(e) => setProjectForm((prev) => ({ ...prev, area: e.target.value }))}
            placeholder="Area"
          />
          <select
            value={projectForm.priority}
            onChange={(e) => setProjectForm((prev) => ({ ...prev, priority: e.target.value }))}
          >
            <option value="low">Baixa</option>
            <option value="medium">Media</option>
            <option value="high">Alta</option>
          </select>
          <input
            type="date"
            value={projectForm.due_date}
            onChange={(e) => setProjectForm((prev) => ({ ...prev, due_date: e.target.value }))}
          />
          <textarea
            value={projectForm.description}
            onChange={(e) => setProjectForm((prev) => ({ ...prev, description: e.target.value }))}
            placeholder="Briefing curto"
          />
          <button type="submit" disabled={creatingProject || !projectForm.name.trim()}>
            {creatingProject ? 'Criando…' : 'Criar'}
          </button>
        </form>
      )}

      <div className="jobs-list">
        {vagas.length === 0 && (
          <div className="jobs-list-empty">
            <strong>Nenhuma triagem ainda</strong>
            <small>Inicie uma triagem de CV no chat e ela aparece aqui.</small>
          </div>
        )}
        {vagas.map((vaga) => (
          <button
            key={vaga.id}
            type="button"
            className={`job-card${
              vaga.statusKey === 'entrevista' && vaga.highlight
                ? ' is-highlight'
                : vaga.statusKey === 'candidatado'
                  ? ' is-candidatado'
                  : ''
            }`}
            onClick={() => setSelectedId(vaga.id)}
          >
            <span className="job-card__avatar" style={{ background: vaga.avatarGradient }}>
              {vaga.initial}
            </span>
            <span className="job-card__main">
              <span className="job-card__role">{vaga.role}</span>
              <span className="job-card__sub">{vaga.subline}</span>
            </span>
            <span className="job-card__match">
              {vaga.match != null ? (
                <>
                  <span style={{ color: matchColor(vaga.match) }}>{vaga.match}%</span>
                  <small>match</small>
                </>
              ) : (
                <>
                  <span style={{ color: 'var(--text-dim)' }}>—</span>
                  <small>sem ranking</small>
                </>
              )}
            </span>
            <span className={`job-status job-status--${vaga.statusKey}`}>
              {vaga.statusLabel}
            </span>
          </button>
        ))}
        <div className="jobs-tip">
          <SparkleIcon size={16} />
          <span>{tip}</span>
        </div>
      </div>
    </div>
  );
}

function projectItemTitle(item: { title: string; target_id: string; data?: Record<string, unknown> | null }): string {
  return String(item.data?.title || item.data?.target_label || item.title || item.target_id);
}

function projectItemDetail(item: { target_type: string; data?: Record<string, unknown> | null }): string {
  const data = item.data || {};
  if (item.target_type === 'task') {
    return `tarefa · ${String(data.status || 'sem status')}${data.due_date ? ` · ${String(data.due_date)}` : ''}`;
  }
  if (item.target_type === 'cv_triage') {
    return `triagem · ${String(data.status || 'sem status')}${data.total_cvs ? ` · ${String(data.total_cvs)} CVs` : ''}`;
  }
  if (item.target_type === 'note') {
    return 'nota';
  }
  return item.target_type;
}

/**
 * Status chip for a triage-run card. The cv_triage backend models triage
 * RUNS (not a job-application pipeline), so the chip reflects the real
 * `job.status` phase. The CSS keys are reused from the original reskin:
 *   entrevista -> done (green), candidatado -> in-progress (blue),
 *   nova -> queued (dim), falhou -> failed/cancelled (red).
 */
type VagaStatusKey = 'nova' | 'candidatado' | 'entrevista' | 'falhou';

interface Vaga {
  id: number;
  initial: string;
  avatarGradient: string;
  /** Recruiter chat label the triage was sent to (real backend field). */
  role: string;
  /** Real triage stats line (CV counts + rubric snippet + date). */
  subline: string;
  /** 0–100 best match score from the ranked top5; null until a run is done. */
  match: number | null;
  statusKey: VagaStatusKey;
  statusLabel: string;
  /** Top-match rows get a lilac left accent in the design. */
  highlight: boolean;
}

/** Map a match score (0–100) to a band color per the Obsidian spec. */
function matchColor(match: number): string {
  if (match >= 90) return '#4ade80'; // green
  if (match >= 83) return '#8bc34a'; // lime
  if (match >= 75) return '#ffa726'; // orange
  return 'var(--text-dim)';
}

/** Short rubric snippet for the card sub-line (the vaga description). */
function rubricSnippet(rubric: string | undefined): string {
  const r = (rubric || '').trim().replace(/\s+/g, ' ');
  if (!r) return '';
  return r.length > 60 ? `${r.slice(0, 57)}…` : r;
}

const AVATAR_GRADIENTS = [
  'linear-gradient(135deg,#5c6bc0,#3949ab)',
  'linear-gradient(135deg,#635bff,#4b3fd6)',
  'linear-gradient(135deg,#f6821f,#e8590c)',
  'linear-gradient(135deg,#9a93ff,#6c63d6)',
  'linear-gradient(135deg,#26a69a,#00897b)',
  'linear-gradient(135deg,#ab47bc,#8e24aa)',
];

/** Stable pick so the same job keeps the same avatar gradient. */
function avatarGradient(id: number): string {
  return AVATAR_GRADIENTS[Math.abs(id) % AVATAR_GRADIENTS.length]!;
}

/**
 * Build a triage-run card view-model from a real cv_triage JobSummary.
 * Every field is backed by real backend data:
 *   role      <- job.target_label (recruiter chat the triage was sent to)
 *   subline   <- real CV counts + rubric snippet + created_at
 *   match     <- best match_pct from the ranked top5 (parsed server-side),
 *                null when the run hasn't produced a ranking yet
 *   status    <- job.status phase mapped to an honest chip
 *
 * Company / location / salary were removed: cv_triage models a triage run
 * keyed off a recruiter chat label, not a job posting, so those fields had
 * no backend source (see followUps for the vagas-domain option).
 */
function vagaFromJob(job: JobSummary, index: number): Vaga {
  const label = job.target_label?.trim() || `Triagem #${job.id}`;
  const initial = label.charAt(0).toUpperCase() || '·';
  // Real ranked match: top5 is now parsed by the backend (_job_to_dict).
  const match = job.top5?.length
    ? Math.round(Math.max(...job.top5.map((t) => t.match_pct)))
    : null;

  // Real triage stats sub-line: CV throughput + rubric snippet + date.
  const parts: string[] = [];
  if (job.total_cvs) {
    parts.push(
      job.processed_cvs && job.processed_cvs < job.total_cvs
        ? `${job.processed_cvs}/${job.total_cvs} CVs`
        : `${job.total_cvs} CV${job.total_cvs === 1 ? '' : 's'}`,
    );
  }
  const snippet = rubricSnippet(job.rubric);
  if (snippet) parts.push(snippet);
  if (job.created_at) {
    parts.push(new Date(job.created_at).toLocaleDateString('pt-BR'));
  }
  const subline = parts.join(' · ') || 'Triagem de CV';

  // Honest triage-run status chip (not a job-application pipeline).
  let statusKey: VagaStatusKey = 'nova';
  let statusLabel = 'Em fila';
  if (job.status === 'done') {
    statusKey = 'entrevista';
    statusLabel = 'Concluída';
  } else if (job.status === 'failed') {
    statusKey = 'falhou';
    statusLabel = 'Falhou';
  } else if (job.status === 'cancelled') {
    statusKey = 'falhou';
    statusLabel = 'Cancelada';
  } else if (['extracting', 'ranking', 'sending'].includes(job.status)) {
    statusKey = 'candidatado';
    statusLabel = 'Processando';
  }

  return {
    id: job.id,
    initial,
    avatarGradient: avatarGradient(job.id),
    role: label,
    subline,
    match,
    statusKey,
    statusLabel,
    highlight: index === 0 || statusKey === 'entrevista' || statusKey === 'candidatado',
  };
}

