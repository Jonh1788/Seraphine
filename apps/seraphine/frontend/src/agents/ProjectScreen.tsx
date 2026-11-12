/** Project channel: conversation, tasks tab and the "agora neste projeto" panel. */
import { useEffect, useMemo, useState } from 'react';
import { useAgentsStore } from './store';
import { ActiveRunRow, AgentTile, EmptyNote, Notice, SectionTitle, useAuthor } from './components';
import { Composer, MessageThread } from './Thread';
import { RoutinesTab } from './RoutinesTab';
import { AboutTab } from './AboutTab';
import { AgentChecklist } from './AgentChecklist';
import { pausedSentence } from './agentPage';
import type { ComposerPrefill } from './Thread';
import { FolderIcon, PauseIcon } from './icons';
import { EngineChip } from './engineChip';
import { agentEngineState } from './setup';
import { aboutAgentPrefill } from './guide';
import type { Agent } from './types';
import { TASK_STATUS_LABELS, isActiveRun, safeColor, summarizeRules } from './lib';

type Tab = 'chat' | 'tasks' | 'routines' | 'about';

function TasksTab({ projectId }: { projectId: string }): JSX.Element {
  const tasks = useAgentsStore((s) => s.tasksByProject[projectId]);
  const agents = useAgentsStore((s) => s.agents);
  const navigate = useAgentsStore((s) => s.navigate);
  const createTask = useAgentsStore((s) => s.createTask);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    const res = await createTask(projectId, title.trim(), description.trim() || undefined);
    setBusy(false);
    if (!res.ok) {
      setError(res.error ?? 'Não consegui criar a tarefa.');
      return;
    }
    setTitle('');
    setDescription('');
    setAdding(false);
    if (res.task) navigate({ screen: 'task', projectId, taskId: res.task.id });
  };

  return (
    <div className="a-tasks">
      <div className="a-section__head">
        <SectionTitle>TAREFAS DESTE PROJETO</SectionTitle>
        {!adding && (
          <button type="button" className="a-btn a-btn--small a-btn--primary" onClick={() => setAdding(true)}>
            Nova tarefa
          </button>
        )}
      </div>

      {adding && (
        <form className="a-card a-form" onSubmit={(e) => void submit(e)}>
          <label className="a-field">
            <span>Título da tarefa</span>
            <input className="a-input" value={title} onChange={(e) => setTitle(e.target.value)} required />
          </label>
          <label className="a-field">
            <span>Descrição (opcional)</span>
            <textarea
              className="a-input"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          {error && <Notice>{error}</Notice>}
          <div className="a-actions">
            <button type="submit" className="a-btn a-btn--primary" disabled={busy || !title.trim()}>
              Criar tarefa
            </button>
            <button type="button" className="a-btn a-btn--ghost" onClick={() => setAdding(false)}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {tasks === undefined ? (
        <EmptyNote>Carregando tarefas…</EmptyNote>
      ) : tasks.length === 0 && !adding ? (
        <EmptyNote>Nenhuma tarefa neste projeto ainda. Crie uma para dar um objetivo claro a um agente.</EmptyNote>
      ) : (
        <ul className="a-list">
          {tasks.map((t) => {
            const assignee = agents.find((a) => a.id === t.assignee_agent_id);
            const done = t.acceptance.filter((c) => c.done).length;
            return (
              <li key={t.id}>
                <button
                  type="button"
                  className="a-card a-task-row"
                  onClick={() => navigate({ screen: 'task', projectId, taskId: t.id })}
                >
                  <span className="a-task-row__num">#{t.number}</span>
                  <span className="a-task-row__title">{t.title}</span>
                  {t.acceptance.length > 0 && (
                    <span className="a-task-row__meta">
                      {done} de {t.acceptance.length}
                    </span>
                  )}
                  {assignee && <AgentTile name={assignee.name} color={safeColor(assignee.color)} size="sm" />}
                  <span className={`a-chip a-chip--${t.status}`}>{TASK_STATUS_LABELS[t.status]}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** The head of an agent's own conversation: tile, name, role, engine state and "Ajustar". */
function AgentHeader({ agent }: { agent: Agent }): JSX.Element {
  const engines = useAgentsStore((s) => s.engines);
  const providers = useAgentsStore((s) => s.providers);
  const navigate = useAgentsStore((s) => s.navigate);
  const guideAvailable = useAgentsStore((s) => s.guideState !== 'unavailable');
  const state = agentEngineState(agent, engines, providers);
  return (
    <div className="a-agent-head">
      <AgentTile name={agent.name} color={safeColor(agent.color)} size="lg" />
      <div className="a-agent-head__text">
        <h1>{agent.name}</h1>
        <span className="a-agent-head__role">
          {agent.role}
          <EngineChip ready={state.ready} word={state.ready ? 'Motor pronto' : 'Sem motor'} how={state.how} />
          {!agent.enabled && (
            <span className="a-chip a-chip--engine a-chip--todo">
              <PauseIcon size={12} />
              Pausado
            </span>
          )}
        </span>
        {!state.ready && state.how && <span className="a-hint">{state.how}</span>}
      </div>
      <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'roster', agentId: agent.id })}>
        Ajustar
      </button>
      {guideAvailable && (
        <button
          type="button"
          className="a-btn a-btn--ghost"
          onClick={() => navigate({ screen: 'guide', about: { agent_id: agent.id }, prefill: aboutAgentPrefill(agent.name) })}
        >
          Pedir à Seraphine
        </button>
      )}
    </div>
  );
}

/** The empty conversation of an agent's home: a hello and its example requests, which fill the composer without sending. */
function HomeEmpty({ agent, onPick }: { agent: Agent; onPick: (text: string) => void }): JSX.Element {
  return (
    <div className="a-home-empty">
      <AgentTile name={agent.name} color={safeColor(agent.color)} size="lg" />
      <h2>Diga oi para {agent.name}</h2>
      {agent.description && <p className="a-hint">{agent.description}</p>}
      {agent.suggestions.length > 0 && (
        <div className="a-suggestions" role="group" aria-label="Pedidos para começar">
          {agent.suggestions.map((s) => (
            <button key={s} type="button" className="a-chip-btn" onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The composer of a paused agent: off, with the sentence and the button that brings it back. */
function PausedComposer({ agent }: { agent: Agent }): JSX.Element {
  const setAgentPaused = useAgentsStore((s) => s.setAgentPaused);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resume = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const res = await setAgentPaused(agent.id, false);
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'Não consegui retomar agora. Tente de novo.');
  };
  return (
    <div className="a-composer a-composer--paused">
      <p className="a-composer__live" role="status">
        {pausedSentence(agent.name)}
      </p>
      <label className="a-composer__field">
        <span className="sr-only">{`Mensagem para ${agent.name}`}</span>
        <textarea className="a-composer__input" rows={2} disabled placeholder={`${agent.name} está pausado`} />
      </label>
      {error && <Notice>{error}</Notice>}
      <div className="a-composer__bar">
        <span className="a-spacer" />
        <button type="button" className="a-btn a-btn--primary" disabled={busy} onClick={() => void resume()}>
          {busy ? 'Retomando…' : 'Retomar'}
        </button>
      </div>
    </div>
  );
}

export function ProjectScreen({ projectId }: { projectId: string }): JSX.Element {
  const project = useAgentsStore((s) => s.projects.find((p) => p.id === projectId));
  const agents = useAgentsStore((s) => s.agents);
  const runs = useAgentsStore((s) => s.runs);
  const loadProject = useAgentsStore((s) => s.loadProject);
  const sendMessage = useAgentsStore((s) => s.sendMessage);
  const navigate = useAgentsStore((s) => s.navigate);
  const routesTab = useAgentsStore((s) => s.route.tab);
  const routinesAvailable = useAgentsStore((s) => s.routinesState !== 'unavailable');
  const pagesAvailable = useAgentsStore((s) => !s.pagesUnavailable);
  const author = useAuthor();
  const [tab, setTab] = useState<Tab>(routesTab === 'routines' || routesTab === 'about' ? routesTab : 'chat');
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);
  const resend = (text: string): void => setPrefill((p) => ({ text, seq: (p?.seq ?? 0) + 1 }));

  useEffect(() => {
    void loadProject(projectId);
  }, [loadProject, projectId]);

  // A chip on a message (or a link on the all-routines screen) asks for this tab while the screen is already open.
  useEffect(() => {
    if (routesTab === 'routines' || routesTab === 'about') setTab(routesTab);
  }, [routesTab]);

  const projectAgents = useMemo(() => agents.filter((a) => a.enabled && a.project_ids.includes(projectId)), [agents, projectId]);
  const working = useMemo(
    () => Object.values(runs).filter((r) => r.project_id === projectId && isActiveRun(r)),
    [runs, projectId],
  );
  const rules = useMemo(() => summarizeRules(projectAgents), [projectAgents]);
  const isHome = project?.kind === 'home';
  const owner = isHome ? agents.find((a) => a.id === project?.agent_id) : undefined;
  const showRoutines = !!owner && routinesAvailable;
  const showAbout = !!owner && pagesAvailable;
  const visibleTab: Tab = (tab === 'routines' && !showRoutines) || (tab === 'about' && !showAbout) ? 'chat' : tab;
  const tabOrder: Tab[] = ['chat', 'tasks', ...(showRoutines ? (['routines'] as const) : []), ...(showAbout ? (['about'] as const) : [])];
  const onTabKey = (e: React.KeyboardEvent): void => {
    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (!step && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const at = tabOrder.indexOf(visibleTab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabOrder.length - 1 : (at + step + tabOrder.length) % tabOrder.length;
    setTab(tabOrder[next]);
    requestAnimationFrame(() => document.getElementById(`tab-${tabOrder[next]}`)?.focus());
  };

  if (!project) {
    return (
      <div className="a-page">
        <EmptyNote>Esse projeto não existe mais ou foi arquivado.</EmptyNote>
        <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'home' })}>
          Voltar ao início
        </button>
      </div>
    );
  }

  return (
    <div className="a-page a-page--fill">
      <header className="a-header">
        {owner ? (
          <AgentHeader agent={owner} />
        ) : (
          <div className="a-header__text">
            <h1>
              <span className="a-hash" aria-hidden="true">#</span> {project.name}
            </h1>
            <span className="a-path">
              <FolderIcon /> {project.path} · agentes só alteram arquivos dentro dela
            </span>
          </div>
        )}
        <div className="a-tabs" role="tablist" aria-label="Seções do projeto" onKeyDown={onTabKey}>
          <button
            type="button"
            role="tab"
            id="tab-chat"
            aria-selected={visibleTab === 'chat'}
            aria-controls="panel-chat"
            tabIndex={visibleTab === 'chat' ? 0 : -1}
            className={`a-tab${visibleTab === 'chat' ? ' is-active' : ''}`}
            onClick={() => setTab('chat')}
          >
            Conversa
          </button>
          <button
            type="button"
            role="tab"
            id="tab-tasks"
            aria-selected={visibleTab === 'tasks'}
            aria-controls="panel-tasks"
            tabIndex={visibleTab === 'tasks' ? 0 : -1}
            className={`a-tab${visibleTab === 'tasks' ? ' is-active' : ''}`}
            onClick={() => setTab('tasks')}
          >
            Tarefas
          </button>
          {showRoutines && (
            <button
              type="button"
              role="tab"
              id="tab-routines"
              aria-selected={visibleTab === 'routines'}
              aria-controls="panel-routines"
              tabIndex={visibleTab === 'routines' ? 0 : -1}
              className={`a-tab${visibleTab === 'routines' ? ' is-active' : ''}`}
              onClick={() => setTab('routines')}
            >
              Rotinas
            </button>
          )}
          {showAbout && (
            <button
              type="button"
              role="tab"
              id="tab-about"
              aria-selected={visibleTab === 'about'}
              aria-controls="panel-about"
              tabIndex={visibleTab === 'about' ? 0 : -1}
              className={`a-tab${visibleTab === 'about' ? ' is-active' : ''}`}
              onClick={() => setTab('about')}
            >
              Sobre
            </button>
          )}
        </div>
      </header>

      <div className="a-channel">
        <div className="a-channel__main">
          {visibleTab === 'chat' ? (
            <section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat" className="a-chat">
              {owner && <AgentChecklist agent={owner} onFillRequest={resend} onOpenRoutines={routinesAvailable ? () => setTab('routines') : undefined} />}
              <MessageThread projectId={projectId} onResend={resend} onOpenRoutines={owner && routinesAvailable ? () => setTab('routines') : undefined} empty={owner ? <HomeEmpty agent={owner} onPick={resend} /> : undefined} />
              {owner && !owner.enabled ? (
                <PausedComposer agent={owner} />
              ) : (
                <Composer
                  projectId={projectId}
                  prefill={prefill}
                  hidePicker={!!owner}
                  label={owner ? `Mensagem para ${owner.name}` : `Mensagem para o projeto ${project.name}`}
                  placeholder={owner ? `Escreva para ${owner.name}` : `Mensagem para #${project.name} · use @ para chamar um agente`}
                  agents={owner ? [owner] : projectAgents.length ? projectAgents : agents.filter((a) => a.enabled)}
                  onSend={(body, agentId, mode, fresh) => sendMessage(projectId, body, agentId, undefined, mode, fresh)}
                />
              )}
            </section>
          ) : visibleTab === 'about' && owner ? (
            <section id="panel-about" role="tabpanel" aria-labelledby="tab-about" className="a-chat a-chat--scroll">
              <AboutTab agent={owner} onOpenRoutines={routinesAvailable ? () => setTab('routines') : undefined} />
            </section>
          ) : visibleTab === 'routines' && owner ? (
            <section id="panel-routines" role="tabpanel" aria-labelledby="tab-routines" className="a-chat">
              <RoutinesTab agent={owner} />
            </section>
          ) : (
            <section id="panel-tasks" role="tabpanel" aria-labelledby="tab-tasks" className="a-chat">
              <TasksTab projectId={projectId} />
            </section>
          )}
        </div>

        <aside className="a-channel__side" aria-label="Agora neste projeto">
          <section className="a-section">
            <SectionTitle>TRABALHANDO AGORA</SectionTitle>
            {working.length === 0 ? (
              <EmptyNote>Nenhum agente está trabalhando aqui agora.</EmptyNote>
            ) : (
              <div className="a-stack">
                {working.map((r) => (
                  <ActiveRunRow key={r.id} run={r} showProject={false} />
                ))}
              </div>
            )}
          </section>

          <section className="a-section">
            <SectionTitle>REGRAS DESTE PROJETO</SectionTitle>
            <ul className="a-rules">
              {rules.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <button type="button" className="a-link" onClick={() => navigate({ screen: 'roster', agentId: owner?.id })}>
              Mudar regras
            </button>
          </section>

          {!isHome && projectAgents.length > 0 && (
            <section className="a-section">
              <SectionTitle>AGENTES COM ACESSO</SectionTitle>
              <ul className="a-people">
                {projectAgents.map((a) => {
                  const au = author(a.id);
                  return (
                    <li key={a.id}>
                      <AgentTile name={au.name} color={au.color} size="sm" />
                      <span>{a.name}</span>
                      <small>{a.role}</small>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
