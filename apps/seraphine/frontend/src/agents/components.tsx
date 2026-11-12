/** Small building blocks shared by the agents screens. */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useAgentsStore } from './store';
import {
  RISK_LABELS,
  RUN_LIMIT_COPY,
  decidedLine,
  expiryLine,
  inboxCountLabel,
  riskOf,
  targetLine,
  initialOf,
  isActiveRun,
  isWaitingForAnswer,
  parkingCopy,
  readableOn,
  runLimitOf,
  runStatusView,
  safeColor,
} from './lib';
import {
  CloudOffIcon,
  HourglassIcon,
  InboxIcon,
  KeyIcon,
  LimitIcon,
  LoopIcon,
  PauseIcon,
  QuestionIcon,
  SilenceIcon,
  StopIcon,
  TickIcon,
  TimerIcon,
  WifiOffIcon,
} from './icons';
import { RoutineBadge } from './routineBits';
import type { Approval, Run, RunLimit, RunQuestion } from './types';

export const SERAPHINE_COLOR = '#9a93ff';

export interface Author {
  id: string;
  name: string;
  role: string;
  color: string;
}

/** Resolve a message/run author id to a name, role and tile color. */
export function useAuthor(): (id: string) => Author {
  const agents = useAgentsStore((s) => s.agents);
  const archived = useAgentsStore((s) => s.archivedAgents);
  return useCallback(
    (id: string): Author => {
      if (id === 'user') return { id, name: 'Você', role: '', color: '#23232e' };
      if (id === 'seraphine') return { id, name: 'Seraphine', role: 'orquestradora', color: SERAPHINE_COLOR };
      // An archived agent keeps its name on the messages it already wrote.
      const agent = agents.find((a) => a.id === id) ?? archived.find((a) => a.id === id);
      if (agent) return { id, name: agent.name, role: agent.role, color: safeColor(agent.color) };
      return { id, name: 'Agente', role: '', color: '#3a3a47' };
    },
    [agents, archived],
  );
}

export function AgentTile({
  name,
  color,
  size = 'md',
}: {
  name: string;
  color: string;
  size?: 'sm' | 'md' | 'lg';
}): JSX.Element {
  return (
    <span
      className={`a-tile a-tile--${size}`}
      aria-hidden="true"
      style={{ background: color, color: readableOn(color) }}
    >
      {initialOf(name)}
    </span>
  );
}

export function Notice({ children, tone = 'error' }: { children: React.ReactNode; tone?: 'error' | 'info' }): JSX.Element {
  return (
    <p className={`a-notice a-notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}

export function SectionTitle({ children, id }: { children: React.ReactNode; id?: string }): JSX.Element {
  return (
    <h2 className="a-eyebrow" id={id}>
      {children}
    </h2>
  );
}

export function EmptyNote({ children }: { children: React.ReactNode }): JSX.Element {
  return <p className="a-empty">{children}</p>;
}

// ---------- approvals ----------

const NOTE_MAX = 500;
/** Answers after which the request can no longer be decided: the card keeps the sentence and stops offering buttons. */
const FINAL_CODES = new Set(['already_decided', 'approval_expired', 'run_not_waiting']);

type CardMode = 'review' | 'confirm' | 'deny';
type Pressed = 'approve' | 'confirm' | 'deny' | 'note';

export function ApprovalCard({
  approval,
  variant = 'thread',
}: {
  approval: Approval;
  variant?: 'home' | 'thread';
}): JSX.Element {
  const decide = useAgentsStore((s) => s.decideApproval);
  const agents = useAgentsStore((s) => s.agents);
  const projects = useAgentsStore((s) => s.projects);
  const agent = agents.find((a) => a.id === approval.agent_id);
  const project = projects.find((p) => p.id === approval.project_id);
  const agentName = agent?.name ?? 'O agente';
  const [mode, setMode] = useState<CardMode>('review');
  const [note, setNote] = useState('');
  const [pressed, setPressed] = useState<Pressed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [final, setFinal] = useState(false);
  // A ref closes the gap before React re-renders the disabled buttons: a double click sends once.
  const inFlight = useRef(false);
  const titleId = useId();
  const noteId = useId();
  // Requests from events recorded before approvals v2 count as medium risk.
  const risk = riskOf(approval.risk_level);
  const reasons = approval.risk_reasons ?? [];
  const expiry = expiryLine(approval.expires_at);
  // Only a card that was pending when it mounted settles into its strip with a short fade;
  // decided requests loaded from history appear as they are.
  const startedPending = useRef(approval.status === 'pending');
  const settled = startedPending.current ? ' is-settled' : '';

  // The command changed under the owner (reloaded after a mismatch): start the review again.
  const digest = approval.command_digest;
  useEffect(() => {
    setMode('review');
    setNote('');
  }, [digest]);

  if (approval.status !== 'pending') {
    const tone = approval.status === 'approved' ? 'ok' : approval.status === 'expired' ? 'expired' : 'denied';
    return (
      <div className={`a-approval a-approval--${tone} a-approval--${variant}${settled}`} role="status">
        <span>{decidedLine(approval, agentName)}</span>
      </div>
    );
  }

  const act = async (
    which: Pressed,
    decision: 'approve' | 'deny',
    extras: { confirmHighRisk?: boolean; note?: string } = {},
  ): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPressed(which);
    setError(null);
    const res = await decide(approval.id, decision, extras);
    inFlight.current = false;
    setPressed(null);
    if (res.ok) return;
    setError(res.error ?? 'Não consegui registrar sua resposta.');
    if (res.code && FINAL_CODES.has(res.code)) setFinal(true);
    if (res.code === 'high_risk_unconfirmed') setMode('confirm');
  };

  const busy = pressed !== null;
  const progress = (which: Pressed, idle: string, doing: string): string => (pressed === which ? doing : idle);
  const onApprove = (): void => {
    if (risk === 'high') {
      setError(null);
      setMode('confirm');
    } else void act('approve', 'approve');
  };

  return (
    <section
      className={`a-approval a-approval--pending a-approval--${variant}`}
      aria-labelledby={titleId}
      aria-busy={busy}
    >
      <div className="a-approval__head">
        <span className="a-approval__who">{agentName} pede sua aprovação</span>
        {project && variant === 'home' && <span className="a-approval__project">#{project.name}</span>}
        <span className="a-approval__state">esperando você</span>
      </div>
      <div className="a-approval__titlebar">
        <strong className="a-approval__title" id={titleId}>
          {approval.title}
        </strong>
        <span className={`a-risk a-risk--${risk}`}>{RISK_LABELS[risk]}</span>
      </div>
      <div className="a-approval__detail">
        <span className="a-approval__label">Comando que vai rodar no seu computador</span>
        <pre className="a-approval__command">{approval.command || 'Sem comando informado.'}</pre>
        {reasons.length > 0 && (
          <ul className="a-approval__risks" aria-label="Por que este comando é arriscado">
            {reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        )}
        {approval.reason && (
          <p className="a-approval__reason">
            <span className="a-approval__label">Por que pede</span> {approval.reason}
          </p>
        )}
        {expiry && <p className="a-approval__expiry">{expiry}</p>}
      </div>
      {error && <Notice>{error}</Notice>}
      {final ? null : mode === 'confirm' ? (
        <div className="a-approval__confirm">
          <p className="a-approval__warn" role="alert">
            Este comando tem risco alto. Ele será executado no seu computador.
          </p>
          <div className="a-actions">
            <button
              type="button"
              className={`a-btn a-btn--caution${pressed === 'confirm' ? ' is-busy' : ''}`}
              disabled={busy}
              onClick={() => void act('confirm', 'approve', { confirmHighRisk: true })}
            >
              {progress('confirm', 'Aprovar mesmo assim', 'Aprovando…')}
            </button>
            <button type="button" className="a-btn a-btn--ghost" disabled={busy} onClick={() => setMode('review')}>
              Voltar
            </button>
          </div>
        </div>
      ) : mode === 'deny' ? (
        <div className="a-approval__confirm">
          <label className="a-approval__label" htmlFor={noteId}>
            Motivo para negar (o agente lê este texto)
          </label>
          <textarea
            id={noteId}
            className="a-input a-approval__note"
            maxLength={NOTE_MAX}
            rows={3}
            value={note}
            disabled={busy}
            onChange={(e) => setNote(e.target.value)}
          />
          <span className="a-approval__count" aria-hidden="true">
            {note.length}/{NOTE_MAX}
          </span>
          <div className="a-actions">
            <button
              type="button"
              className={`a-btn a-btn--primary${pressed === 'note' ? ' is-busy' : ''}`}
              disabled={busy || !note.trim()}
              onClick={() => void act('note', 'deny', { note })}
            >
              {progress('note', 'Enviar', 'Enviando…')}
            </button>
            <button type="button" className="a-btn a-btn--ghost" disabled={busy} onClick={() => setMode('review')}>
              Voltar
            </button>
          </div>
        </div>
      ) : (
        <div className="a-actions">
          <button
            type="button"
            className={`a-btn a-btn--primary${pressed === 'approve' ? ' is-busy' : ''}`}
            disabled={busy}
            onClick={onApprove}
          >
            {progress('approve', 'Aprovar', 'Aprovando…')}
          </button>
          <button
            type="button"
            className={`a-btn a-btn--ghost${pressed === 'deny' ? ' is-busy' : ''}`}
            disabled={busy}
            onClick={() => void act('deny', 'deny')}
          >
            {progress('deny', 'Negar', 'Negando…')}
          </button>
          <button type="button" className="a-btn a-btn--link" disabled={busy} onClick={() => setMode('deny')}>
            Negar com motivo
          </button>
        </div>
      )}
    </section>
  );
}

// ---------- active runs ----------

function LimitStatusIcon({ limit }: { limit: RunLimit }): JSX.Element {
  const props = { className: 'a-status__icon', size: 12 };
  if (limit === 'stuck_loop') return <LoopIcon {...props} />;
  if (limit === 'engine_silent') return <SilenceIcon {...props} />;
  if (limit === 'turn_timeout') return <TimerIcon {...props} />;
  return <LimitIcon {...props} />;
}

/**
 * Status chip. An interrupted or parked run says what happened in words and carries an icon:
 * never colour alone, never "falhou". A parked run adds when it comes back (or what the owner must do).
 */
export function RunStatusText({ run }: { run: Parameters<typeof runStatusView>[0] }): JSX.Element {
  const { label, tone, detail } = runStatusView(run);
  let icon: JSX.Element | null = null;
  const limit = tone === 'limit' ? runLimitOf(run) : null;
  if (tone === 'interrupted') icon = <PauseIcon className="a-status__icon" size={12} />;
  else if (limit) icon = <LimitStatusIcon limit={limit} />;
  else if (run.wait_kind === 'outage') icon = <CloudOffIcon className="a-status__icon" size={12} />;
  else if (run.wait_kind === 'plan_limit') icon = <HourglassIcon className="a-status__icon" size={12} />;
  else if (run.wait_kind === 'auth') icon = <KeyIcon className="a-status__icon" size={12} />;
  else if (run.wait_kind === 'owner_input') icon = <QuestionIcon className="a-status__icon" size={12} />;
  else if (tone === 'parked') icon = <PauseIcon className="a-status__icon" size={12} />;
  else if (tone === 'cancelled') icon = <StopIcon className="a-status__icon" size={10} />;
  return (
    <span className={`a-status a-status--${tone}`}>
      {icon}
      {label}
      {detail && <span className="a-status__detail">{detail}</span>}
    </span>
  );
}

/**
 * Calm card for a parked run: one sentence on what happened, one on when the work comes back or what the owner
 * has to do, and a button to try now. Outage and plan limit offer a secondary "Tentar agora"; a lapsed login
 * offers the primary "Tentar de novo", because only the owner can fix it. The card goes away when the run leaves `parked`.
 */
export function ParkingCard({ run }: { run: Run }): JSX.Element | null {
  const wake = useAgentsStore((s) => s.wakeRun);
  const agentName = useAuthor()(run.agent_id).name;
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref closes the gap before React re-renders the disabled button: a double click sends once.
  const inFlight = useRef(false);

  if (run.status !== 'parked') return null;
  const copy = parkingCopy(run, agentName);
  if (!copy) return null;

  const onWake = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const res = await wake(run.id);
    inFlight.current = false;
    setPending(false);
    if (!res.ok) setError(res.error ?? 'Não consegui tentar de novo agora. Tente mais uma vez em instantes.');
  };

  return (
    <section className={`a-park${copy.primary ? ' a-park--owner' : ''}`} aria-label="Trabalho em espera" aria-busy={pending}>
      <div className="a-park__head">
        <RunStatusText run={run} />
      </div>
      <p className="a-park__text">{copy.first}</p>
      <p className="a-park__text">{copy.second}</p>
      {copy.extra && <p className="a-park__extra">{copy.extra}</p>}
      {error && (
        <p className="a-park__error" role="alert">
          {error}
        </p>
      )}
      <div className="a-actions">
        <button
          type="button"
          className={`a-btn ${copy.primary ? 'a-btn--primary' : 'a-btn--ghost'}${pending ? ' is-busy' : ''}`}
          disabled={pending}
          onClick={() => void onWake()}
        >
          {pending ? 'Tentando…' : copy.button}
        </button>
      </div>
    </section>
  );
}

/**
 * The agent's question to the owner (`ask_owner`, step 3c). Same amber family as an approval, but its own shape: the agent's
 * name, the question and one button per suggested answer. An option is sent as the owner's message to that agent in that
 * project (the normal send path; the backend wakes the run). Without options, or to say something else, the composer
 * takes the answer. When the run leaves the parked state the card settles into one quiet line with the question.
 */
export function QuestionCard({ run }: { run: Run }): JSX.Element | null {
  const send = useAgentsStore((s) => s.sendMessage);
  const agentName = useAuthor()(run.agent_id).name;
  // The run's own `question` goes away when it resumes: the quiet line keeps what was asked while this card is on screen.
  const remembered = useRef<RunQuestion | null>(null);
  if (run.question) remembered.current = run.question;
  const question = run.question ?? remembered.current;
  const [pressed, setPressed] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref closes the gap before React re-renders the disabled buttons: a double click sends once.
  const inFlight = useRef(false);
  const titleId = useId();

  if (!question) return null;
  if (!isWaitingForAnswer(run) || !run.question) {
    return (
      <p className="a-ask a-ask--quiet" role="status">
        {agentName} perguntou: “{question.text}”
      </p>
    );
  }

  const options = run.question.options;
  const busy = pressed !== null || sent;
  const answer = async (option: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPressed(option);
    setError(null);
    const res = await send(run.project_id, option, run.agent_id, run.task_id ?? undefined);
    inFlight.current = false;
    setPressed(null);
    if (res.ok) setSent(true);
    else setError(res.error ?? 'Não consegui enviar sua resposta. Tente de novo.');
  };

  return (
    <section className="a-ask" aria-labelledby={titleId} aria-busy={pressed !== null}>
      <div className="a-ask__head">
        <QuestionIcon className="a-ask__icon" size={16} />
        <strong id={titleId}>{agentName} fez uma pergunta</strong>
        <span className="a-ask__state">esperando você</span>
      </div>
      <p className="a-ask__text">{run.question.text}</p>
      {options.length > 0 && (
        <div className="a-actions" role="group" aria-label="Respostas sugeridas">
          {options.map((option) => (
            <button
              key={option}
              type="button"
              className={`a-btn a-btn--ghost${pressed === option ? ' is-busy' : ''}`}
              disabled={busy}
              onClick={() => void answer(option)}
            >
              {pressed === option ? 'Enviando…' : option}
            </button>
          ))}
        </div>
      )}
      {error && <Notice>{error}</Notice>}
      <p className="a-ask__hint">
        {sent
          ? `Resposta enviada. ${agentName} retoma o trabalho em instantes.`
          : options.length > 0
            ? 'Quer responder de outro jeito? Escreva na caixa de mensagem abaixo.'
            : `Escreva a sua resposta na caixa de mensagem abaixo: a próxima mensagem para ${agentName} responde a esta pergunta.`}
      </p>
    </section>
  );
}

/** The "Continuar" action shared by the cards of an interrupted and of a stopped run: in-flight state and a double-click guard. */
function useContinueAction(run: Run): { pending: boolean; error: string | null; onContinue: () => Promise<void> } {
  const continueRun = useAgentsStore((s) => s.continueRun);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref closes the gap before React re-renders the disabled button: a double click sends once.
  const inFlight = useRef(false);

  const onContinue = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    const res = await continueRun(run.id);
    inFlight.current = false;
    setPending(false);
    if (!res.ok) setError(res.error ?? 'Não consegui continuar o trabalho agora. Tente de novo em instantes.');
  };
  return { pending, error, onContinue };
}

/**
 * Calm card for a run that the backend's restart cut short. `interrupted` offers one
 * button ("Continuar") when the backend says it is allowed; `interrupted_mid_action` only
 * explains, because an action may have stopped halfway. A run already continued shows one quiet line.
 */
export function InterruptionCard({ run }: { run: Run }): JSX.Element {
  const agentName = useAuthor()(run.agent_id).name;
  const { pending, error, onContinue } = useContinueAction(run);

  if (run.continued_by) {
    return <p className="a-interrupt a-interrupt--quiet" role="status">O trabalho continuou em uma nova execução.</p>;
  }

  const midAction = run.error === 'interrupted_mid_action';
  const offer = !midAction && run.can_continue;

  return (
    <section className="a-interrupt" aria-label="Trabalho interrompido" aria-busy={pending}>
      <div className="a-interrupt__head">
        <RunStatusText run={run} />
      </div>
      <p className="a-interrupt__text">
        {midAction
          ? 'Não era seguro continuar sozinho: uma ação do agente pode ter parado no meio. Confira o resultado e peça de novo.'
          : `A Seraphine reiniciou enquanto ${agentName} trabalhava e não conseguiu retomar o trabalho sozinha.`}
      </p>
      {error && (
        <p className="a-interrupt__error" role="alert">
          {error}
        </p>
      )}
      {offer && (
        <div className="a-actions">
          <button
            type="button"
            className={`a-btn a-btn--primary${pending ? ' is-busy' : ''}`}
            disabled={pending}
            onClick={() => void onContinue()}
          >
            {pending ? 'Continuando…' : 'Continuar'}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Calm card for a run the owner stopped. It says so in words and, when the backend allows it, offers "Continuar" as the
 * one primary action (the continue flow of step 1a). How far the agent got arrives as an ordinary channel message,
 * so it is not repeated here. A run already continued shows one quiet line.
 */
export function StoppedCard({ run }: { run: Run }): JSX.Element {
  const agentName = useAuthor()(run.agent_id).name;
  const { pending, error, onContinue } = useContinueAction(run);

  if (run.continued_by) {
    return <p className="a-interrupt a-interrupt--quiet" role="status">O trabalho continuou em uma nova execução.</p>;
  }

  return (
    <section className="a-interrupt a-interrupt--stopped" aria-label="Trabalho parado" aria-busy={pending}>
      <div className="a-interrupt__head">
        <RunStatusText run={run} />
      </div>
      <p className="a-interrupt__text">
        {run.can_continue
          ? `Você parou o trabalho de ${agentName}. O que ele já fez ficou guardado e ele pode seguir de onde parou.`
          : `Você parou o trabalho de ${agentName}. Esta execução não pode ser continuada: se quiser, peça de novo na conversa.`}
      </p>
      {error && (
        <p className="a-interrupt__error" role="alert">
          {error}
        </p>
      )}
      {run.can_continue && (
        <div className="a-actions">
          <button
            type="button"
            className={`a-btn a-btn--primary${pending ? ' is-busy' : ''}`}
            disabled={pending}
            onClick={() => void onContinue()}
          >
            {pending ? 'Continuando…' : 'Continuar'}
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Calm card for a run the harness stopped at a limit (step 1d): one sentence on what happened and one on what the owner can
 * do. One component for the four codes; "Continuar" is the primary action when the backend allows it. How far the agent got
 * arrives as an ordinary channel message, so it is not repeated here. A run already continued shows one quiet line.
 */
export function LimitCard({ run }: { run: Run }): JSX.Element | null {
  const { pending, error, onContinue } = useContinueAction(run);
  const limit = runLimitOf(run);
  if (!limit) return null;

  if (run.continued_by) {
    return <p className="a-interrupt a-interrupt--quiet" role="status">O trabalho continuou em uma nova execução.</p>;
  }

  const copy = RUN_LIMIT_COPY[limit];
  return (
    <section className="a-interrupt a-interrupt--limit" aria-label="Trabalho parado por um limite" aria-busy={pending}>
      <div className="a-interrupt__head">
        <RunStatusText run={run} />
      </div>
      <p className="a-interrupt__text">{copy.what}</p>
      <p className="a-interrupt__text">
        {run.can_continue ? copy.canContinue : 'Esta execução não pode ser continuada: se quiser, peça de novo na conversa.'}
      </p>
      {error && (
        <p className="a-interrupt__error" role="alert">
          {error}
        </p>
      )}
      {run.can_continue && (
        <div className="a-actions">
          <button
            type="button"
            className={`a-btn a-btn--primary${pending ? ' is-busy' : ''}`}
            disabled={pending}
            onClick={() => void onContinue()}
          >
            {pending ? 'Continuando…' : 'Continuar'}
          </button>
        </div>
      )}
    </section>
  );
}

/** The band appears only after the channel has been down this long: a fast reconnection says nothing. */
export const CONNECTION_BAND_DELAY_MS = 1200;
/** How long the "back" confirmation stays. */
export const CONNECTION_BAND_DONE_MS = 1600;

/**
 * Calm band for the live channel. It says nothing for the first 1,2 s of a drop; after that it says the live updates are
 * paused (amber, icon and words); when the channel is back and the resync has finished it confirms for a moment and goes away.
 * A polite live region that floats over the top edge: it takes no space, never covers the composer and never touches a draft.
 */
export function ConnectionBand(): JSX.Element {
  const connected = useAgentsStore((s) => s.streamConnected);
  const resyncing = useAgentsStore((s) => s.resyncing);
  const down = !connected;
  const [shown, setShown] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!down) return;
    setDone(false);
    const t = setTimeout(() => setShown(true), CONNECTION_BAND_DELAY_MS);
    return () => clearTimeout(t);
  }, [down]);

  const recovered = shown && !down && !resyncing;
  useEffect(() => {
    if (!recovered) return;
    setShown(false);
    setDone(true);
  }, [recovered]);

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), CONNECTION_BAND_DONE_MS);
    return () => clearTimeout(t);
  }, [done]);

  let band: JSX.Element | null = null;
  if (shown && down) {
    band = (
      <div className="a-conn__band a-conn__band--down">
        <WifiOffIcon size={16} />
        <span>Sem conexão ao vivo. As conversas podem estar desatualizadas. Estou tentando reconectar.</span>
      </div>
    );
  } else if (shown) {
    band = (
      <div className="a-conn__band a-conn__band--down">
        <WifiOffIcon size={16} />
        <span>Conexão de volta. Atualizando as conversas…</span>
      </div>
    );
  } else if (done) {
    band = (
      <div className="a-conn__band a-conn__band--ok">
        <TickIcon size={16} />
        <span>Conexão restabelecida. Tudo atualizado.</span>
      </div>
    );
  }
  return (
    <div className="a-conn" role="status" aria-live="polite">
      {band}
    </div>
  );
}

export function ActiveRunRow({ run, showProject = true }: { run: Run; showProject?: boolean }): JSX.Element {
  const author = useAuthor()(run.agent_id);
  const project = useAgentsStore((s) => s.projects.find((p) => p.id === run.project_id));
  const cancel = useAgentsStore((s) => s.cancelRun);
  const [error, setError] = useState<string | null>(null);
  const providers = useAgentsStore((s) => s.providers);
  const inboxLabel = isActiveRun(run) ? inboxCountLabel(run.inbox_count) : '';
  const meta = [showProject && project ? `#${project.name}` : null, targetLine(run, providers)]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="a-run">
      <div className="a-run__top">
        <AgentTile name={author.name} color={author.color} size="sm" />
        <strong className="a-run__name">{author.name}</strong>
        {run.routine_id && <RoutineBadge />}
        <RunStatusText run={run} />
      </div>
      <span className="a-run__goal">{run.goal}</span>
      {inboxLabel && (
        <span className="a-run__inbox">
          <InboxIcon size={12} className="a-run__inbox-icon" />
          {inboxLabel}
        </span>
      )}
      <div className="a-run__meta">
        <span>{meta}</span>
        {isActiveRun(run) && (
          <button
            type="button"
            className="a-btn a-btn--small a-btn--ghost"
            aria-label={`Parar ${author.name}`}
            onClick={async () => {
              setError(null);
              const res = await cancel(run.id);
              if (!res.ok) setError(res.error ?? 'Não consegui parar agora.');
            }}
          >
            <StopIcon /> Parar
          </button>
        )}
      </div>
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
