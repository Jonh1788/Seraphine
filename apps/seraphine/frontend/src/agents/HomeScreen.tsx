/** "Início": what waits for the owner, what is running, today's spend, projects. */
import { useMemo, useState } from 'react';
import { useAgentsStore, pendingApprovalsOf } from './store';
import { ActiveRunRow, AgentTile, ApprovalCard, EmptyNote, Notice, SectionTitle, useAuthor } from './components';
import { ChevronRightSmallIcon, ClockIcon, FolderIcon, KeyIcon, QuestionIcon, TickIcon } from './icons';
import { CHECKLIST_LABELS, plainProjects } from './setup';
import { humanWhen, upcomingRoutines } from './routines';
import { effectiveStatus, pendingProposalCount, pendingProposalsLine, pendingProposalsSubtitle } from './guide';
import { SparkIcon } from './setupIcons';
import { SETUP_STEP_IDS } from './types';
import { engineName, formatUsd, greeting, isActiveRun, isWaitingForAnswer, isWaitingForLogin, safeColor } from './lib';
import type { Run } from './types';
import { useConfirm } from '../ui';

/** A run parked because the engine's login expired: one compact row that opens the project conversation (where the card is). */
function LoginWaitRow({ run }: { run: Run }): JSX.Element {
  const author = useAuthor()(run.agent_id);
  const project = useAgentsStore((s) => s.projects.find((p) => p.id === run.project_id));
  const navigate = useAgentsStore((s) => s.navigate);
  const engine = engineName(run.engine);
  return (
    <button
      type="button"
      className="a-card a-wait-row"
      onClick={() => navigate({ screen: 'project', projectId: run.project_id })}
    >
      <KeyIcon className="a-wait-row__icon" size={16} />
      <span className="a-wait-row__text">
        <strong>{author.name} espera você</strong>
        <span>
          {run.wait_detail?.trim() || `Entre de novo no ${engine} para o trabalho continuar`}
          {project ? ` · #${project.name}` : ''}
        </span>
      </span>
      <span className="a-wait-row__go">
        Abrir conversa <ChevronRightSmallIcon />
      </span>
    </button>
  );
}

/** A run parked because its agent asked the owner something: one compact row that opens the project conversation (where the question is). */
function QuestionWaitRow({ run }: { run: Run }): JSX.Element {
  const author = useAuthor()(run.agent_id);
  const project = useAgentsStore((s) => s.projects.find((p) => p.id === run.project_id));
  const navigate = useAgentsStore((s) => s.navigate);
  return (
    <button
      type="button"
      className="a-card a-wait-row"
      onClick={() => navigate({ screen: 'project', projectId: run.project_id })}
    >
      <QuestionIcon className="a-wait-row__icon" size={16} />
      <span className="a-wait-row__text">
        <strong>{author.name} fez uma pergunta</strong>
        <span>
          {run.question?.text.trim() || 'Abra a conversa para responder'}
          {project ? ` · #${project.name}` : ''}
        </span>
      </span>
      <span className="a-wait-row__go">
        Abrir conversa <ChevronRightSmallIcon />
      </span>
    </button>
  );
}

/** Proposals of the Seraphine waiting for a decision: one compact row that opens the conversation (where the cards are). */
function GuideWaitRow({ count }: { count: number }): JSX.Element {
  const navigate = useAgentsStore((s) => s.navigate);
  const proposals = useAgentsStore((s) => s.guideProposals);
  const first = useMemo(() => Object.values(proposals).find((p) => effectiveStatus(p) === 'pending'), [proposals]);
  return (
    <button type="button" className="a-card a-wait-row" onClick={() => navigate({ screen: 'guide' })}>
      <SparkIcon className="a-wait-row__icon" size={16} />
      <span className="a-wait-row__text">
        <strong>{pendingProposalsLine(count)}</strong>
        <span>{count === 1 && first?.title ? first.title : 'Abra a conversa para ver o que muda e decidir'}</span>
      </span>
      <span className="a-wait-row__go">
        Abrir conversa <ChevronRightSmallIcon />
      </span>
    </button>
  );
}

function ProjectsSection(): JSX.Element {
  const allProjects = useAgentsStore((s) => s.projects);
  const projects = useMemo(() => plainProjects(allProjects), [allProjects]);
  const createProject = useAgentsStore((s) => s.createProject);
  const archiveProject = useAgentsStore((s) => s.archiveProject);
  const navigate = useAgentsStore((s) => s.navigate);
  const confirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = (): void => {
    setAdding(false);
    setName('');
    setPath('');
    setDescription('');
    setError(null);
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await createProject({
      name: name.trim(),
      path: path.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
    });
    setBusy(false);
    if (res.ok) reset();
    else setError(res.error ?? 'Não consegui adicionar o projeto.');
  };

  return (
    <section className="a-section" aria-labelledby="agents-projects-title">
      <div className="a-section__head">
        <SectionTitle id="agents-projects-title">PROJETOS</SectionTitle>
        {!adding && (
          <button type="button" className="a-btn a-btn--small a-btn--ghost" onClick={() => setAdding(true)}>
            Adicionar projeto
          </button>
        )}
      </div>

      {adding && (
        <form className="a-card a-form" onSubmit={(e) => void submit(e)}>
          <label className="a-field">
            <span>Nome do projeto</span>
            <input className="a-input" value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label className="a-field">
            <span>Pasta no seu PC (caminho completo)</span>
            <input
              className="a-input a-input--mono"
              value={path}
              placeholder="C:\Projetos\minha-loja"
              onChange={(e) => setPath(e.target.value)}
              required
            />
            <small>Os agentes só leem e escrevem dentro desta pasta.</small>
          </label>
          <label className="a-field">
            <span>Descrição (opcional)</span>
            <input className="a-input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {error && <Notice>{error}</Notice>}
          <div className="a-actions">
            <button type="submit" className="a-btn a-btn--primary" disabled={busy || !name.trim() || !path.trim()}>
              Adicionar
            </button>
            <button type="button" className="a-btn a-btn--ghost" onClick={reset}>
              Cancelar
            </button>
          </div>
        </form>
      )}

      {projects.length === 0 && !adding && (
        <EmptyNote>Nenhum projeto ainda. Adicione a pasta de um projeto para os agentes poderem trabalhar nela.</EmptyNote>
      )}

      <ul className="a-list">
        {projects.map((p) => (
          <li className="a-card a-project" key={p.id}>
            <button
              type="button"
              className="a-project__open"
              onClick={() => navigate({ screen: 'project', projectId: p.id })}
            >
              <span className="a-project__name">
                <span className="a-hash" aria-hidden="true">#</span>
                {p.name}
              </span>
              <span className="a-project__path">
                <FolderIcon /> {p.path}
              </span>
            </button>
            <button
              type="button"
              className="a-btn a-btn--small a-btn--ghost"
              aria-label={`Arquivar ${p.name}`}
              onClick={async () => {
                const ok = await confirm({
                  title: 'Arquivar projeto',
                  message: `Arquivar #${p.name}? Os agentes deixam de agir nessa pasta. Nada é apagado do seu PC.`,
                  confirmLabel: 'Arquivar',
                  variant: 'danger',
                });
                if (!ok) return;
                const res = await archiveProject(p.id);
                if (!res.ok) setError(res.error ?? 'Não consegui arquivar.');
              }}
            >
              Arquivar
            </button>
          </li>
        ))}
      </ul>
      {!adding && error && <Notice>{error}</Notice>}
    </section>
  );
}

/** "PRÓXIMAS ROTINAS": the next 3 times across agents; nothing at all (no empty note) while no routine is on. */
function UpcomingRoutines(): JSX.Element | null {
  const routines = useAgentsStore((s) => s.routines);
  const agents = useAgentsStore((s) => s.agents);
  const state = useAgentsStore((s) => s.routinesState);
  const navigate = useAgentsStore((s) => s.navigate);
  const rows = useMemo(() => upcomingRoutines(Object.values(routines), 3), [routines]);
  if (state === 'unavailable' || rows.length === 0) return null;
  const now = new Date();
  return (
    <section className="a-section" aria-labelledby="agents-routines-title">
      <div className="a-section__head">
        <SectionTitle id="agents-routines-title">PRÓXIMAS ROTINAS</SectionTitle>
        <button type="button" className="a-link" onClick={() => navigate({ screen: 'routines' })}>
          Ver todas
        </button>
      </div>
      <ul className="a-list">
        {rows.map(({ routine, at }) => {
          const agent = agents.find((a) => a.id === routine.agent_id);
          return (
            <li className="a-card a-next-routine" key={routine.id}>
              {agent && <AgentTile name={agent.name} color={safeColor(agent.color)} size="sm" />}
              <span className="a-next-routine__text">
                <strong>{agent?.name ?? 'Agente'}</strong>
                <span>{routine.title}</span>
              </span>
              <span className="a-next-routine__when">{humanWhen(at, now)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** "Continue de onde parou": shown while the first steps are not all done and the owner did not say "agora não". */
export function ResumeBlock(): JSX.Element | null {
  const setup = useAgentsStore((s) => s.setup);
  const saveSetup = useAgentsStore((s) => s.saveSetup);
  const navigate = useAgentsStore((s) => s.navigate);
  const [error, setError] = useState<string | null>(null);
  if (!setup || setup.dismissed || setup.done >= setup.total) return null;
  return (
    <section className="a-card a-resume" aria-labelledby="agents-resume-title">
      <h2 className="a-resume__title" id="agents-resume-title">
        <button type="button" className="a-resume__open" onClick={() => navigate({ screen: 'setup' })}>
          Continue de onde parou · {setup.done} de {setup.total}
          <ChevronRightSmallIcon />
        </button>
      </h2>
      <ul className="a-resume__list">
        {SETUP_STEP_IDS.map((id) => {
          const done = setup.steps.some((s) => s.id === id && s.done);
          return (
            <li key={id} className="a-resume__item">
              <span>{CHECKLIST_LABELS[id]}</span>
              <span className={`a-chip a-chip--engine ${done ? 'a-chip--ok' : 'a-chip--todo'}`}>
                {done ? <TickIcon size={12} /> : <ClockIcon size={12} />}
                {done ? 'Feito' : 'Falta'}
              </span>
            </li>
          );
        })}
      </ul>
      {error && <Notice>{error}</Notice>}
      <div className="a-actions">
        <button
          type="button"
          className="a-btn a-btn--ghost a-btn--small"
          onClick={async () => {
            setError(null);
            const res = await saveSetup({ dismissed: true });
            if (!res.ok) setError(res.error ?? 'Não consegui guardar. Tente de novo.');
          }}
        >
          Agora não
        </button>
      </div>
    </section>
  );
}

export function HomeScreen(): JSX.Element {
  const approvals = useAgentsStore((s) => s.approvals);
  const runs = useAgentsStore((s) => s.runs);
  const agents = useAgentsStore((s) => s.agents);
  const spend = useAgentsStore((s) => s.spendToday);
  const guideProposals = useAgentsStore((s) => s.guideProposals);
  const guideWaiting = useMemo(() => pendingProposalCount(guideProposals), [guideProposals]);
  const pending = useMemo(() => pendingApprovalsOf(approvals), [approvals]);
  const active = useMemo(
    () =>
      Object.values(runs)
        .filter(isActiveRun)
        .sort((a, b) => (a.created_at < b.created_at ? -1 : 1)),
    [runs],
  );

  // A run waiting for the engine's login waits on the owner too: a compact row, not an approval card.
  const loginWaits = useMemo(() => active.filter(isWaitingForLogin), [active]);
  // So does a run whose agent asked a question and waits for the answer.
  const questionWaits = useMemo(() => active.filter(isWaitingForAnswer), [active]);

  const spendRows = useMemo(() => {
    const byAgent = new Map(spend.map((r) => [r.agent_id, r]));
    return agents
      .filter((a) => a.enabled || byAgent.has(a.id))
      .map((a) => {
        const row = byAgent.get(a.id);
        return {
          agent: a,
          cost: row?.spent_usd ?? 0,
          budget: row?.daily_budget_usd ?? a.daily_budget_usd ?? null,
        };
      });
  }, [agents, spend]);

  const waitingParts: string[] = [];
  if (pending.length === 1) waitingParts.push('um pedido espera sua decisão');
  else if (pending.length > 1) waitingParts.push(`${pending.length} pedidos esperam sua decisão`);
  if (loginWaits.length === 1) waitingParts.push('um agente espera uma ação sua');
  else if (loginWaits.length > 1) waitingParts.push(`${loginWaits.length} agentes esperam uma ação sua`);
  if (questionWaits.length === 1) waitingParts.push('um agente fez uma pergunta');
  else if (questionWaits.length > 1) waitingParts.push(`${questionWaits.length} agentes fizeram perguntas`);
  if (guideWaiting > 0) waitingParts.push(pendingProposalsSubtitle(guideWaiting));
  const subtitle =
    waitingParts.length === 0
      ? 'Nada espera sua decisão agora.'
      : `${waitingParts.join(' e ').replace(/^./, (c) => c.toUpperCase())}.`;

  return (
    <div className="a-page">
      <header className="a-header">
        <div className="a-header__text">
          <h1>{greeting()}</h1>
          <span>{subtitle}</span>
        </div>
      </header>

      <div className="a-home">
        <ResumeBlock />

        <section className="a-section" id="agents-waiting" aria-labelledby="agents-waiting-title">
          <SectionTitle id="agents-waiting-title">ESPERANDO VOCÊ</SectionTitle>
          {pending.length === 0 && loginWaits.length === 0 && questionWaits.length === 0 && guideWaiting === 0 ? (
            <EmptyNote>Quando um agente precisar da sua aprovação, o pedido aparece aqui.</EmptyNote>
          ) : (
            <div className="a-stack">
              {pending.map((a) => (
                <ApprovalCard key={a.id} approval={a} variant="home" />
              ))}
              {loginWaits.map((r) => (
                <LoginWaitRow key={r.id} run={r} />
              ))}
              {questionWaits.map((r) => (
                <QuestionWaitRow key={r.id} run={r} />
              ))}
              {guideWaiting > 0 && <GuideWaitRow count={guideWaiting} />}
            </div>
          )}
        </section>

        <section className="a-section" aria-labelledby="agents-working-title">
          <SectionTitle id="agents-working-title">TRABALHANDO AGORA</SectionTitle>
          {active.length === 0 ? (
            <EmptyNote>Nenhum agente está trabalhando neste momento.</EmptyNote>
          ) : (
            <div className="a-stack">
              {active.map((r) => (
                <ActiveRunRow key={r.id} run={r} />
              ))}
            </div>
          )}
        </section>

        <UpcomingRoutines />

        <section className="a-section" aria-labelledby="agents-spend-title">
          <SectionTitle id="agents-spend-title">GASTO DE HOJE</SectionTitle>
          {spendRows.length === 0 ? (
            <EmptyNote>Quando você criar agentes, o gasto de cada um aparece aqui.</EmptyNote>
          ) : (
            <ul className="a-spend">
              {spendRows.map(({ agent, cost, budget }) => {
                const pct = budget && budget > 0 ? Math.min(100, Math.round((cost / budget) * 100)) : null;
                return (
                  <li className="a-spend__row" key={agent.id}>
                    <AgentTile name={agent.name} color={safeColor(agent.color)} size="sm" />
                    <span className="a-spend__name">{agent.name}</span>
                    <span className="a-spend__amount">
                      {formatUsd(cost)}
                      {budget ? ` de ${formatUsd(budget)}` : ''}
                    </span>
                    {pct !== null && (
                      <span
                        className="a-bar"
                        role="progressbar"
                        aria-label={`Gasto de ${agent.name} hoje`}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={pct}
                      >
                        <span className="a-bar__fill" style={{ width: `${pct}%` }} />
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="a-hint">Cada agente pode ter um limite por dia. Ao atingir, ele para e avisa.</p>
        </section>

        <ProjectsSection />
      </div>
    </div>
  );
}
