/** One task: description, acceptance criteria, controls, run request and its own conversation. */
import { useEffect, useId, useMemo, useState } from 'react';
import { useAgentsStore } from './store';
import { EmptyNote, Notice, SectionTitle } from './components';
import { Composer, MessageThread } from './Thread';
import type { ComposerPrefill } from './Thread';
import { PRIORITY_LABELS, PRIORITY_ORDER, TASK_STATUS_LABELS, TASK_STATUS_ORDER } from './lib';
import type { TaskPatch, TaskPriority, TaskStatus } from './types';

export function TaskScreen({ taskId }: { taskId: string }): JSX.Element {
  const task = useAgentsStore((s) => s.tasksById[taskId]);
  const project = useAgentsStore((s) => (task ? s.projects.find((p) => p.id === task.project_id) : undefined));
  const agents = useAgentsStore((s) => s.agents);
  const loadTask = useAgentsStore((s) => s.loadTask);
  const patchTask = useAgentsStore((s) => s.patchTask);
  const runTask = useAgentsStore((s) => s.runTask);
  const sendMessage = useAgentsStore((s) => s.sendMessage);
  const navigate = useAgentsStore((s) => s.navigate);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newCriterion, setNewCriterion] = useState('');
  const [runAgent, setRunAgent] = useState('');
  const [running, setRunning] = useState(false);
  const [prefill, setPrefill] = useState<ComposerPrefill | null>(null);
  const resend = (text: string): void => setPrefill((p) => ({ text, seq: (p?.seq ?? 0) + 1 }));
  const ids = { status: useId(), assignee: useId(), priority: useId(), due: useId(), agent: useId() };

  useEffect(() => {
    void loadTask(taskId);
  }, [loadTask, taskId]);

  const candidates = useMemo(() => {
    if (!task) return [];
    const withAccess = agents.filter((a) => a.enabled && a.project_ids.includes(task.project_id));
    return withAccess.length ? withAccess : agents.filter((a) => a.enabled);
  }, [agents, task]);

  const chosenAgent = runAgent && candidates.some((a) => a.id === runAgent)
    ? runAgent
    : (candidates.find((a) => a.id === task?.assignee_agent_id)?.id ?? candidates[0]?.id ?? '');

  if (!task) {
    return (
      <div className="a-page">
        <EmptyNote>Carregando a tarefa…</EmptyNote>
        <button type="button" className="a-btn a-btn--ghost" onClick={() => navigate({ screen: 'home' })}>
          Voltar ao início
        </button>
      </div>
    );
  }

  const patch = async (p: TaskPatch): Promise<void> => {
    setError(null);
    const res = await patchTask(task.id, p);
    if (!res.ok) setError(res.error ?? 'Não consegui salvar a alteração.');
  };

  const done = task.acceptance.filter((c) => c.done).length;

  const ask = async (): Promise<void> => {
    if (!chosenAgent) return;
    setRunning(true);
    setError(null);
    setNotice(null);
    const res = await runTask(task.id, chosenAgent);
    setRunning(false);
    if (res.ok) setNotice('Pedido enviado. O agente comenta o plano aqui e começa.');
    else setError(res.error ?? 'Não consegui pedir ao agente.');
  };

  return (
    <div className="a-page a-page--channel">
      <header className="a-header">
        <div className="a-header__text">
          <button
            type="button"
            className="a-link a-crumb"
            onClick={() => navigate({ screen: 'project', projectId: task.project_id })}
          >
            <span aria-hidden="true">#</span>
            {project?.name ?? 'projeto'} · Tarefas
          </button>
          <h1>
            <span className="a-task-num">#{task.number}</span> {task.title}
          </h1>
          <span>
            {task.created_by === 'user' ? 'Criada por você' : `Criada por ${task.created_by === 'seraphine' ? 'Seraphine' : 'um agente'}`}
          </span>
        </div>
      </header>

      <div className="a-channel">
        <div className="a-channel__main a-task-main">
          <section className="a-card a-run-request" aria-label="Pedir a um agente para fazer">
            <div>
              <strong>Pedir a um agente para fazer</strong>
              <p className="a-hint">
                Ele lê o que precisa, comenta o plano aqui e faz. O que for sensível, como publicar, pede sua aprovação.
              </p>
            </div>
            {candidates.length === 0 ? (
              <p className="a-hint">Crie um agente ligado a este projeto para poder pedir.</p>
            ) : (
              <div className="a-run-request__row">
                <label className="a-field a-field--inline" htmlFor={ids.agent}>
                  <span className="sr-only">Agente</span>
                  <select id={ids.agent} className="a-input" value={chosenAgent} onChange={(e) => setRunAgent(e.target.value)}>
                    {candidates.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <button type="button" className="a-btn a-btn--primary" disabled={running || !chosenAgent} onClick={() => void ask()}>
                  Pedir a um agente para fazer
                </button>
              </div>
            )}
          </section>

          {error && <Notice>{error}</Notice>}
          {notice && <Notice tone="info">{notice}</Notice>}

          <section className="a-section">
            <SectionTitle>DESCRIÇÃO</SectionTitle>
            <p className="a-body">{task.description || 'Sem descrição.'}</p>
          </section>

          <section className="a-section" aria-labelledby="criteria-title">
            <div className="a-section__head">
              <SectionTitle id="criteria-title">CRITÉRIOS DE ACEITE</SectionTitle>
              {task.acceptance.length > 0 && (
                <span className="a-hint">
                  {done} de {task.acceptance.length}
                </span>
              )}
            </div>
            {task.acceptance.length === 0 && <EmptyNote>Nenhum critério ainda. Eles dizem quando a tarefa está pronta.</EmptyNote>}
            <ul className="a-criteria">
              {task.acceptance.map((c, i) => (
                <li key={`${i}-${c.text}`}>
                  <label className="a-check">
                    <input
                      type="checkbox"
                      checked={c.done}
                      onChange={() =>
                        void patch({ acceptance: task.acceptance.map((x, j) => (j === i ? { ...x, done: !x.done } : x)) })
                      }
                    />
                    <span>{c.text}</span>
                  </label>
                </li>
              ))}
            </ul>
            <form
              className="a-inline-form"
              onSubmit={(e) => {
                e.preventDefault();
                const text = newCriterion.trim();
                if (!text) return;
                setNewCriterion('');
                void patch({ acceptance: [...task.acceptance, { text, done: false }] });
              }}
            >
              <label className="a-field a-field--inline">
                <span className="sr-only">Novo critério</span>
                <input
                  className="a-input"
                  placeholder="Adicionar critério"
                  value={newCriterion}
                  onChange={(e) => setNewCriterion(e.target.value)}
                />
              </label>
              <button type="submit" className="a-btn a-btn--ghost" disabled={!newCriterion.trim()}>
                Adicionar
              </button>
            </form>
          </section>

          <section className="a-section" aria-label="Conversa da tarefa">
            <SectionTitle>CONVERSA DA TAREFA</SectionTitle>
            <div className="a-chat a-chat--task">
              <MessageThread projectId={task.project_id} taskId={task.id} onResend={resend} />
              <Composer
                projectId={task.project_id}
                prefill={prefill}
                label={`Comentar na tarefa ${task.number}`}
                placeholder={`Comentar na tarefa ${task.number}`}
                agents={candidates}
                onSend={(body, agentId, mode, fresh) => sendMessage(task.project_id, body, agentId, task.id, mode, fresh)}
              />
            </div>
          </section>
        </div>

        <aside className="a-channel__side" aria-label="Detalhes da tarefa">
          <div className="a-field">
            <label htmlFor={ids.status}>Coluna</label>
            <select
              id={ids.status}
              className="a-input"
              value={task.status}
              onChange={(e) => void patch({ status: e.target.value as TaskStatus })}
            >
              {TASK_STATUS_ORDER.map((s) => (
                <option key={s} value={s}>
                  {TASK_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </div>
          <div className="a-field">
            <label htmlFor={ids.assignee}>Responsável</label>
            <select
              id={ids.assignee}
              className="a-input"
              value={task.assignee_agent_id ?? ''}
              onChange={(e) => void patch({ assignee_agent_id: e.target.value || null })}
            >
              <option value="">Ninguém</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="a-field">
            <label htmlFor={ids.priority}>Prioridade</label>
            <select
              id={ids.priority}
              className="a-input"
              value={task.priority}
              onChange={(e) => void patch({ priority: e.target.value as TaskPriority })}
            >
              {PRIORITY_ORDER.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </option>
              ))}
            </select>
          </div>
          <div className="a-field">
            <label htmlFor={ids.due}>Prazo</label>
            <input
              id={ids.due}
              className="a-input"
              type="date"
              value={task.due_at ? task.due_at.slice(0, 10) : ''}
              onChange={(e) =>
                void patch({ due_at: e.target.value ? new Date(`${e.target.value}T12:00:00`).toISOString() : null })
              }
            />
          </div>
          <p className="a-hint">
            A tarefa anda sozinha: vai para Em andamento quando um agente começa e para Em revisão quando fica pronta
            para você conferir.
          </p>
        </aside>
      </div>
    </div>
  );
}
