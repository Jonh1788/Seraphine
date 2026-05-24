import { useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { listJobs } from './api';
import type { JobSummary } from './types';
import { JobDetailPanel } from './JobDetailPanel';

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

type WorkTab = 'overview' | 'projects' | 'triage';

interface WorkTask {
  id: number;
  title: string;
  status: string;
  type: string;
  source: string;
  due_date?: string | null;
  due_time?: string | null;
  priority?: string | null;
  tags?: string[];
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
  summary: {
    linked_tasks: number;
    linked_triages: number;
    linked_notes: number;
    overdue: boolean;
    attention: boolean;
  };
}

interface WorkBriefing {
  projects: WorkProject[];
  open_tasks: WorkTask[];
  active_triages: JobSummary[];
  due_projects: WorkProject[];
}

interface ProjectGroup {
  key: string;
  label: string;
  tasks: WorkTask[];
  overdue: number;
  high: number;
}

export function JobsTab({
  initialJobId,
  onInitialJobConsumed,
}: Props): JSX.Element {
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [tasks, setTasks] = useState<WorkTask[]>([]);
  const [projects, setProjects] = useState<WorkProject[]>([]);
  const [briefing, setBriefing] = useState<WorkBriefing | null>(null);
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
  const [activeTab, setActiveTab] = useState<WorkTab>(
    initialJobId != null ? 'triage' : 'overview',
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Consume the deep-link target exactly once.
  useEffect(() => {
    if (initialJobId != null) {
      setActiveTab('triage');
      setSelectedId(initialJobId);
      onInitialJobConsumed?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialJobId]);

  useEffect(() => {
    let cancelled = false;
    Promise.allSettled([
      listJobs(),
      fetch(`${API_BASE}/tasks?limit=120`).then((r) =>
        r.ok ? r.json() as Promise<{ tasks: WorkTask[] }> : { tasks: [] },
      ),
      fetch(`${API_BASE}/work/projects`).then((r) =>
        r.ok ? r.json() as Promise<{ projects: WorkProject[] }> : { projects: [] },
      ),
      fetch(`${API_BASE}/work/briefing`).then((r) =>
        r.ok ? r.json() as Promise<WorkBriefing> : null,
      ),
    ])
      .then(([jobsResult, tasksResult, projectsResult, briefingResult]) => {
        if (cancelled) return;
        if (jobsResult.status === 'fulfilled') {
          setJobs(jobsResult.value);
        } else {
          setError(jobsResult.reason instanceof Error ? jobsResult.reason.message : String(jobsResult.reason));
        }
        if (tasksResult.status === 'fulfilled') {
          setTasks(tasksResult.value.tasks || []);
        }
        if (projectsResult.status === 'fulfilled') {
          setProjects(projectsResult.value.projects || []);
        }
        if (briefingResult.status === 'fulfilled') {
          setBriefing(briefingResult.value);
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
              {projectDetail.links.length === 0 && (
                <p className="cvt-empty">Nenhum item vinculado ainda. Use o chat para ligar tarefas, notas ou triagens a este projeto.</p>
              )}
              {projectDetail.links.map((link) => (
                <div key={link.id} className="work-task-row">
                  <span className="work-task-row__main">
                    <strong>{link.title || link.target_id}</strong>
                    <small>{link.target_type} · {new Date(link.created_at).toLocaleString()}</small>
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

  const grouped = groupByDay(jobs);
  const openTasks = tasks.filter(isOpenTask);
  const overdueTasks = openTasks.filter(isOverdue);
  const suggestedProjects = groupProjects(openTasks);
  const activeTriages = jobs.filter((j) => !['done', 'failed', 'cancelled'].includes(j.status));
  const lastTriage = jobs[0] || null;
  const briefingProjects = briefing?.projects || projects.filter((p) => p.status === 'active');
  const briefingTasks = briefing?.open_tasks || openTasks;
  const dueProjects = briefing?.due_projects || projects.filter((p) => p.due_date && p.due_date <= new Date().toISOString().slice(0, 10));

  return (
    <div className="cvt-jobs-tab">
      <header className="cvt-jobs-header">
        <div>
          <h1>Trabalhos</h1>
          <p>Projetos, pendencias e operacoes de triagem em um so lugar.</p>
        </div>
        <button type="button" className="work-primary-button" onClick={() => setCreateOpen((v) => !v)}>
          Novo projeto
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

      <div className="work-tabs">
        <button
          type="button"
          className={activeTab === 'overview' ? 'is-active' : ''}
          onClick={() => setActiveTab('overview')}
        >
          Visao geral
        </button>
        <button
          type="button"
          className={activeTab === 'projects' ? 'is-active' : ''}
          onClick={() => setActiveTab('projects')}
        >
          Projetos
        </button>
        <button
          type="button"
          className={activeTab === 'triage' ? 'is-active' : ''}
          onClick={() => setActiveTab('triage')}
        >
          Triagens
        </button>
      </div>

      {activeTab === 'overview' && (
        <>
          <div className="work-summary-grid">
            <div className="work-summary-card">
              <span>Trabalho aberto</span>
              <strong>{openTasks.length}</strong>
              <small>{overdueTasks.length} atrasado{overdueTasks.length === 1 ? '' : 's'}</small>
            </div>
            <div className="work-summary-card">
              <span>Projetos ativos</span>
              <strong>{briefingProjects.length}</strong>
              <small>{dueProjects.length} pedindo atencao</small>
            </div>
            <div className="work-summary-card">
              <span>Triagens em andamento</span>
              <strong>{activeTriages.length}</strong>
              <small>{jobs.length} no historico</small>
            </div>
          </div>

          <section className="work-section">
            <div className="work-section__header">
              <h3>Fila de trabalho</h3>
              <button type="button" onClick={() => setActiveTab('projects')}>
                Ver projetos
              </button>
            </div>
            {openTasks.length === 0 && (
              <p className="cvt-empty">Nenhuma tarefa de trabalho aberta.</p>
            )}
            {briefingTasks.slice(0, 6).map((task) => (
              <div key={task.id} className="work-task-row">
                <span className="work-task-row__main">
                  <strong>{task.title}</strong>
                  <small>
                    {task.tags?.[0] || task.type || task.source}
                    {task.due_date ? ` · ${task.due_date}${task.due_time ? ` ${task.due_time}` : ''}` : ''}
                  </small>
                </span>
                {task.priority && <span className={`work-priority work-priority--${task.priority}`}>{task.priority}</span>}
              </div>
            ))}
          </section>

          <section className="work-section">
            <div className="work-section__header">
              <h3>Triagem de CV</h3>
              <button type="button" onClick={() => setActiveTab('triage')}>
                Ver triagens
              </button>
            </div>
            {!lastTriage && (
              <p className="cvt-empty">Nenhuma triagem ainda. Use a Triagem de CV no chat.</p>
            )}
            {lastTriage && (
              <div
                className="work-triage-card"
                role="button"
                tabIndex={0}
                onClick={() => {
                  setActiveTab('triage');
                  setSelectedId(lastTriage.id);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setActiveTab('triage');
                    setSelectedId(lastTriage.id);
                  }
                }}
              >
                <span>
                  <strong>Ultima triagem · {lastTriage.total_cvs} CV{lastTriage.total_cvs === 1 ? '' : 's'}</strong>
                  <small>{lastTriage.target_label} · {new Date(lastTriage.created_at).toLocaleString()}</small>
                </span>
                <span className={`cvt-badge cvt-badge-${lastTriage.status}`}>
                  {lastTriage.status}
                </span>
              </div>
            )}
          </section>
        </>
      )}

      {activeTab === 'projects' && (
        <>
          {projects.length === 0 && (
            <p className="cvt-empty">Nenhum projeto criado ainda. Crie um projeto ou use as sugestoes abaixo.</p>
          )}
          <div className="work-project-grid">
            {projects.map((project) => (
              <section
                key={project.id}
                className="work-project-card"
                role="button"
                tabIndex={0}
                onClick={() => setSelectedProjectId(project.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedProjectId(project.id);
                  }
                }}
              >
                <div className="work-project-card__header">
                  <h3>{project.name}</h3>
                  <span>{project.priority}</span>
                </div>
                <p>
                  {project.area || 'sem area'} · {project.due_date ? `prazo ${project.due_date}` : 'sem prazo'}
                </p>
                <div className="work-project-card__tasks">
                  {project.description && <div className="work-project-task"><strong>{project.description}</strong></div>}
                  {project.tags.slice(0, 3).map((tag) => <small key={tag}>#{tag}</small>)}
                </div>
              </section>
            ))}
          </div>
          {suggestedProjects.length > 0 && (
            <section className="work-section">
              <div className="work-section__header">
                <h3>Sugestoes por tarefas</h3>
                <span>{suggestedProjects.length}</span>
              </div>
              {suggestedProjects.slice(0, 6).map((project) => (
                <div key={project.key} className="work-task-row">
                  <span className="work-task-row__main">
                    <strong>{project.label}</strong>
                    <small>{project.tasks.length} tarefas · {project.overdue} atrasadas · {project.high} alta prioridade</small>
                  </span>
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {activeTab === 'triage' && (
        <>
          {grouped.length === 0 && (
            <p className="cvt-empty">Nenhum job ainda. Use a Triagem de CV no chat.</p>
          )}
          {grouped.map(({ label, items }) => (
            <section key={label} className="cvt-jobs-group">
              <h3>{label}</h3>
              <ul className="cvt-jobs-list">
                {items.map((j) => (
                  <li
                    key={j.id}
                    className="cvt-jobs-row"
                    onClick={() => setSelectedId(j.id)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelectedId(j.id);
                      }
                    }}
                  >
                    <span className="cvt-jobs-meta">
                      <strong>
                        Triagem · {j.total_cvs} CV{j.total_cvs === 1 ? '' : 's'}
                      </strong>
                      <small>
                        {j.target_label} · {new Date(j.created_at).toLocaleString()}
                      </small>
                    </span>
                    <span className={`cvt-badge cvt-badge-${j.status}`}>
                      {j.status}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}

function groupByDay(
  jobs: JobSummary[],
): { label: string; items: JobSummary[] }[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today.getTime() - 86_400_000);
  const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
  const buckets: Record<string, JobSummary[]> = {};
  for (const j of jobs) {
    const d = new Date(j.created_at);
    const label =
      d >= today
        ? 'Hoje'
        : d >= yesterday
          ? 'Ontem'
          : d >= weekAgo
            ? 'Esta semana'
            : 'Mais antigo';
    (buckets[label] ??= []).push(j);
  }
  return ['Hoje', 'Ontem', 'Esta semana', 'Mais antigo']
    .filter((l) => buckets[l]?.length)
    .map((label) => ({ label, items: buckets[label]! }));
}

function isOpenTask(task: WorkTask): boolean {
  return !['completed', 'rejected', 'failed'].includes(task.status);
}

function isOverdue(task: WorkTask): boolean {
  if (!task.due_date) return false;
  return task.due_date < new Date().toISOString().slice(0, 10);
}

function projectKey(task: WorkTask): string {
  return task.tags?.[0] || task.source || task.type || 'geral';
}

function labelProject(key: string): string {
  return key
    .replace(/[_-]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function groupProjects(tasks: WorkTask[]): ProjectGroup[] {
  const map = new Map<string, WorkTask[]>();
  for (const task of tasks) {
    const key = projectKey(task);
    map.set(key, [...(map.get(key) || []), task]);
  }
  return Array.from(map.entries())
    .map(([key, items]) => ({
      key,
      label: labelProject(key),
      tasks: items,
      overdue: items.filter(isOverdue).length,
      high: items.filter((task) => task.priority === 'high').length,
    }))
    .sort((a, b) => b.tasks.length - a.tasks.length);
}
