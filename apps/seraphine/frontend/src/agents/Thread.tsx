/** Conversation pieces: the "O que ele fez" step list, the message thread and the composer. */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAgentsStore } from './store';
import { ApprovalCard, AgentTile, InterruptionCard, LimitCard, Notice, ParkingCard, QuestionCard, StoppedCard, useAuthor } from './components';
import { ReceiptAction, ReceiptStrip } from './receipts';
import { RoutineBadge } from './routineBits';
import { routineStepLine, triggerOfRun } from './routines';
import { ChatContinueIcon, ChatNewIcon, StopIcon, TickIcon, ChevronDownIcon, ClockIcon, InboxIcon, InfoIcon, PauseIcon, QuestionIcon, RestartIcon, ToolGroupIcon } from './icons';
import { SendIcon } from '../icons/Icons';
import {
  actionsLabel,
  buildSteps,
  canInterrupt,
  composerLiveLine,
  composerTarget,
  deliveryLine,
  FRESH_HELP,
  FRESH_LABEL,
  formatDuration,
  freshArmedLine,
  freshAvailability,
  formatTime,
  isActiveRun,
  isInterrupted,
  parseMessageText,
  runErrorMessage,
  runLimitOf,
  TOOL_FAILED_FALLBACK,
} from './lib';
import type { Step } from './lib';
import type { ActionResult } from './store';
import type { Agent, Approval, Message, Run, SendMode } from './types';

// ---------- step list ----------

function StepIcon({ step }: { step: Step }): JSX.Element {
  if (step.kind === 'system') {
    if (step.reason === 'parked') return <PauseIcon className="a-step__icon" size={14} />;
    if (step.reason === 'inbox') return <InboxIcon className="a-step__icon" size={14} />;
    if (step.reason === 'limit_warning') return <InfoIcon className="a-step__icon" size={14} />;
    if (step.reason === 'tool_denied' || step.reason === 'bridge_unavailable') return <InfoIcon className="a-step__icon" size={14} />;
    if (step.reason === 'asked_owner') return <QuestionIcon className="a-step__icon" size={14} />;
    if (step.reason === 'session') {
      return step.sessionMode === 'continued' ? (
        <ChatContinueIcon className="a-step__icon" size={14} />
      ) : (
        <ChatNewIcon className="a-step__icon" size={14} />
      );
    }
    if (step.reason === 'limit_stop') return <StopIcon className="a-step__icon" size={10} />;
    if (step.reason === 'interrupted_by_owner') return <StopIcon className="a-step__icon" size={10} />;
    return <RestartIcon className="a-step__icon" size={14} />;
  }
  if (step.state === 'running') return <span className="a-step__icon a-step__spin" aria-hidden="true" />;
  if (step.state === 'unfinished') return <PauseIcon className="a-step__icon" size={14} />;
  if (step.group) return <ToolGroupIcon group={step.group} className="a-step__icon" size={14} />;
  return <TickIcon className="a-step__icon" />;
}

export function RunSteps({ run }: { run: Run }): JSX.Element {
  const events = useAgentsStore((s) => s.eventsByRun[run.id]);
  const loadRunEvents = useAgentsStore((s) => s.loadRunEvents);
  const cancel = useAgentsStore((s) => s.cancelRun);
  const navigate = useAgentsStore((s) => s.navigate);
  // Phase 6b: a routine's run starts its list with how it began. The ledger is read only when it is already loaded.
  const routineTitle = useAgentsStore((s) => (run.routine_id ? (run.routine_title ?? s.routines[run.routine_id]?.title ?? null) : null));
  const routineLedger = useAgentsStore((s) => (run.routine_id ? s.routineRuns[run.routine_id] : undefined));
  const live = isActiveRun(run);
  const parked = run.status === 'parked';
  const [open, setOpen] = useState(live);
  const [error, setError] = useState<string | null>(null);
  const listId = useId();
  const loaded = events !== undefined;

  useEffect(() => {
    if (!loaded) void loadRunEvents(run.id);
  }, [loaded, loadRunEvents, run.id]);

  // A run that starts live stays open; one that finishes folds away on its own.
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) setOpen(false);
    if (!wasLive.current && live) setOpen(true);
    wasLive.current = live;
  }, [live]);

  const steps = useMemo(() => buildSteps(events ?? [], { runEnded: !live }), [events, live]);
  // Only the count: where the cap is belongs to the backend, so the page never guesses "near the limit".
  const duration = [formatDuration(run), actionsLabel(run.actions_count)].filter(Boolean).join(' · ');

  // Steps already there when the events first load are history; only later arrivals animate in.
  const baseline = useRef<Set<string> | null>(null);
  if (loaded && baseline.current === null) baseline.current = new Set(steps.map((s) => s.id));

  return (
    <div className="a-steps">
      <div className="a-steps__head">
        <button
          type="button"
          className="a-steps__toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((v) => !v)}
        >
          <ChevronDownIcon className={`a-steps__chev${open ? ' is-open' : ''}`} />
          <span>O que ele fez{duration ? ` · ${duration}` : ''}</span>
        </button>
        {live && (
          <>
            <span className={`a-steps__live${parked ? ' a-steps__live--parked' : ''}`}>{parked ? 'em espera' : 'trabalhando…'}</span>
            <button
              type="button"
              className="a-btn a-btn--small a-btn--ghost"
              onClick={async () => {
                setError(null);
                const res = await cancel(run.id);
                if (!res.ok) setError(res.error ?? 'Não consegui parar agora.');
              }}
            >
              <StopIcon /> Parar
            </button>
          </>
        )}
      </div>
      <ol className="a-steps__list" id={listId} aria-live="polite" hidden={!open}>
        {run.routine_id && (
          <li className="a-step a-step--system a-step--done a-step--routine">
            <ClockIcon className="a-step__icon" size={14} />
            <span className="a-step__body">
              <span>{routineStepLine(routineTitle ?? 'sem nome', triggerOfRun(routineLedger, run.id))}</span>
            </span>
          </li>
        )}
        {steps.map((step) => (
          <li
            key={step.id}
            className={`a-step a-step--${step.kind} a-step--${step.state}${step.reason === 'limit_warning' ? ' a-step--info' : ''}${step.failed ? ' a-step--failed' : ''}${step.receipt ? ' a-step--receipt' : ''}${baseline.current && !baseline.current.has(step.id) ? ' is-new' : ''}`}
          >
            <StepIcon step={step} />
            <span className="a-step__body">
              {step.kind === 'command' ? <code>{step.text}</code> : <span>{step.text}</span>}
              {step.state === 'running' && <span className="a-step__note">em andamento</span>}
              {step.state === 'unfinished' && <span className="a-step__note">não terminou</span>}
              {step.failed && (
                <span className="a-step__note a-step__note--fail">
                  {TOOL_FAILED_FALLBACK}
                  {step.error ? `: ${step.error}` : ''}
                </span>
              )}
              {!step.failed && step.summary && <span className="a-step__note a-step__summary">{step.summary}</span>}
              {step.receipt && <ReceiptAction actionId={step.actionId} undoUntil={step.undoUntil} undone={step.undone} />}
              {step.reason === 'tool_denied' && (
                <button
                  type="button"
                  className="a-step__action"
                  onClick={() => navigate({ screen: 'roster', agentId: run.agent_id, section: 'tools' })}
                >
                  Dar acesso
                </button>
              )}
            </span>
          </li>
        ))}
        {steps.length === 0 && (
          <li className="a-step a-step--empty">{live ? (parked ? 'em espera…' : 'trabalhando…') : 'Sem passos registrados.'}</li>
        )}
      </ol>
      {isInterrupted(run) && <InterruptionCard run={run} />}
      <QuestionCard run={run} />
      {parked && <ParkingCard run={run} />}
      {run.status === 'cancelled' && <StoppedCard run={run} />}
      {runLimitOf(run) && <LimitCard run={run} />}
      {run.status === 'failed' && run.error && !isInterrupted(run) && !runLimitOf(run) && (
        <Notice>
          {runErrorMessage(run.error).text}
          {runErrorMessage(run.error).code && (
            <>
              {' '}
              <code className="a-mono" style={{ fontSize: '0.75em' }}>{runErrorMessage(run.error).code}</code>
            </>
          )}
        </Notice>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}

// ---------- thread ----------

type Entry =
  | { type: 'message'; key: string; at: string; message: Message; ownsRun: Run | null }
  | { type: 'orphan'; key: string; at: string; run: Run }
  | { type: 'approval'; key: string; at: string; approval: Approval };

/** Message text: backtick spans as <code>, fenced blocks as <pre>, the rest plain text (React nodes, never HTML). */
function Paragraphs({ text }: { text: string }): JSX.Element {
  const blocks = parseMessageText(text);
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'fence' ? (
          <pre className="a-code-block" key={i}>
            <code>{b.code}</code>
          </pre>
        ) : (
          <p className="a-msg__text" key={i}>
            {b.parts.map((p, j) =>
              p.kind === 'code' ? (
                <code className="a-code" key={j}>
                  {p.value}
                </code>
              ) : (
                p.value
              ),
            )}
          </p>
        ),
      )}
    </>
  );
}

/**
 * Quiet receipt under an owner message sent while an agent was working: icon plus words, never colour alone.
 * A message that was never read offers "Enviar de novo", which only puts the text back in the composer.
 */
function DeliveryReceipt({
  message,
  agentName,
  onResend,
}: {
  message: Message;
  agentName: string;
  onResend?: (body: string) => void;
}): JSX.Element | null {
  const line = deliveryLine(message.delivery, agentName);
  if (!line) return null;
  const icon =
    line.tone === 'pending' ? <ClockIcon size={12} /> : line.tone === 'delivered' ? <TickIcon size={12} /> : <InfoIcon size={12} />;
  return (
    <div className={`a-receipt a-receipt--${line.tone}`}>
      <span className="a-receipt__text">
        {icon}
        {line.text}
      </span>
      {line.tone === 'undelivered' && onResend && (
        <button type="button" className="a-receipt__retry" onClick={() => onResend(message.body)}>
          Enviar de novo
        </button>
      )}
    </div>
  );
}

export function MessageThread({
  projectId,
  taskId,
  onResend,
  empty,
  onOpenRoutines,
}: {
  projectId: string;
  taskId?: string;
  /** Put the text of an unread message back in the composer. */
  onResend?: (body: string) => void;
  /** Replaces the empty-conversation text (the home of an agent says hi). Shown only once the messages have loaded. */
  empty?: React.ReactNode;
  /** Makes the "Rotina · título" chip of a routine's message a button that opens the "Rotinas" tab. */
  onOpenRoutines?: () => void;
}): JSX.Element {
  const rawMessages = useAgentsStore((s) => (taskId ? s.messagesByTask[taskId] : s.messagesByProject[projectId]));
  const runs = useAgentsStore((s) => s.runs);
  const approvals = useAgentsStore((s) => s.approvals);
  const routines = useAgentsStore((s) => s.routines);
  const author = useAuthor();
  const listRef = useRef<HTMLDivElement>(null);
  /** The routine that made a message or a run: its title from the run (frozen at the time) or the routine itself. */
  const routineTitleOf = (routineId: string | null, run: Run | undefined): string | null => (routineId ? (run?.routine_title ?? routines[routineId]?.title ?? null) : null);

  const entries = useMemo<Entry[]>(() => {
    const messages = (rawMessages ?? []).filter((m) => taskId || !m.task_id);
    const scoped = Object.values(runs).filter(
      (r) => r.project_id === projectId && (taskId ? r.task_id === taskId : !r.task_id),
    );
    const runById = new Map(scoped.map((r) => [r.id, r]));
    const owner = new Map<string, string>();
    for (const m of messages) {
      if (m.run_id && m.author !== 'user' && !owner.has(m.run_id)) owner.set(m.run_id, m.id);
    }
    const referenced = new Set(messages.map((m) => m.run_id).filter((r): r is string => !!r));
    const out: Entry[] = [];
    const runApprovals = (runId: string): Entry[] =>
      Object.values(approvals)
        .filter((a) => a.run_id === runId)
        .map((a) => ({ type: 'approval' as const, key: `ap-${a.id}`, at: a.created_at, approval: a }));

    for (const m of messages) {
      const ownsRun = m.run_id && owner.get(m.run_id) === m.id ? (runById.get(m.run_id) ?? null) : null;
      out.push({ type: 'message', key: `m-${m.id}`, at: m.created_at, message: m, ownsRun });
      if (ownsRun) out.push(...runApprovals(ownsRun.id));
    }
    const orphans = scoped
      .filter((r) => !owner.has(r.id))
      .sort((x, y) => (x.created_at < y.created_at ? -1 : x.created_at > y.created_at ? 1 : 0));
    for (const r of orphans) {
      if (!isActiveRun(r) && !referenced.has(r.id)) continue;
      out.push({ type: 'orphan', key: `r-${r.id}`, at: r.created_at, run: r });
      out.push(...runApprovals(r.id));
    }
    // Pending requests whose run we cannot place still have to be answered.
    const placed = new Set(out.filter((e) => e.type === 'approval').map((e) => e.key));
    if (!taskId) {
      for (const a of Object.values(approvals)) {
        if (a.project_id === projectId && a.status === 'pending' && !placed.has(`ap-${a.id}`)) {
          out.push({ type: 'approval', key: `ap-${a.id}`, at: a.created_at, approval: a });
        }
      }
    }
    return out;
  }, [rawMessages, runs, approvals, projectId, taskId]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);

  if (entries.length === 0 && empty !== undefined) {
    return (
      <div className="a-thread a-thread--empty" ref={listRef}>
        {rawMessages !== undefined && empty}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div className="a-thread a-thread--empty" ref={listRef}>
        <p className="a-empty">
          {taskId
            ? 'Ninguém comentou nesta tarefa ainda. Escreva abaixo para começar a conversa.'
            : 'Esta conversa ainda está vazia. Escreva abaixo e a Seraphine escolhe quem responde.'}
        </p>
      </div>
    );
  }

  return (
    <div className="a-thread" ref={listRef} role="log" aria-label="Conversa">
      {entries.map((entry) => {
        if (entry.type === 'approval') {
          return (
            <div className="a-thread__approval" key={entry.key}>
              <ApprovalCard approval={entry.approval} variant="thread" />
            </div>
          );
        }
        if (entry.type === 'orphan') {
          const a = author(entry.run.agent_id);
          return (
            <article className="a-msg" key={entry.key}>
              <AgentTile name={a.name} color={a.color} />
              <div className="a-msg__main">
                <div className="a-msg__meta">
                  <strong>{a.name}</strong>
                  <span>{[a.role, formatTime(entry.run.created_at)].filter(Boolean).join(' · ')}</span>
                  {entry.run.routine_id && <RoutineBadge title={routineTitleOf(entry.run.routine_id, entry.run)} onClick={onOpenRoutines} />}
                </div>
                <RunSteps run={entry.run} />
                {entry.run.result_summary && <Paragraphs text={entry.run.result_summary} />}
                <ReceiptStrip runId={entry.run.id} />
              </div>
            </article>
          );
        }
        const m = entry.message;
        if (m.author === 'user') {
          return (
            <div className="a-msg a-msg--user" key={entry.key}>
              <div className="a-msg__user">
                <div className="a-bubble">{m.body}</div>
                {m.delivery && (
                  <DeliveryReceipt
                    message={m}
                    agentName={(m.run_id && runs[m.run_id] ? author(runs[m.run_id].agent_id).name : '') || 'o agente'}
                    onResend={onResend}
                  />
                )}
              </div>
            </div>
          );
        }
        const a = author(m.author);
        return (
          <article className="a-msg" key={entry.key}>
            <AgentTile name={a.name} color={a.color} />
            <div className="a-msg__main">
              <div className="a-msg__meta">
                <strong>{a.name}</strong>
                <span>{[a.role, formatTime(m.created_at)].filter(Boolean).join(' · ')}</span>
                {m.routine_id && <RoutineBadge title={routineTitleOf(m.routine_id, m.run_id ? runs[m.run_id] : undefined)} onClick={onOpenRoutines} />}
              </div>
              {entry.ownsRun && <RunSteps run={entry.ownsRun} />}
              <Paragraphs text={m.body} />
              {entry.ownsRun && <ReceiptStrip runId={entry.ownsRun.id} />}
            </div>
          </article>
        );
      })}
    </div>
  );
}

// ---------- composer ----------

/** Text to put back in the composer ("Enviar de novo"); `seq` changes on every request so the same text can be asked twice. */
export interface ComposerPrefill {
  text: string;
  seq: number;
}

export function Composer({
  label,
  placeholder,
  agents,
  projectId,
  prefill,
  hidePicker = false,
  onSend,
}: {
  label: string;
  placeholder: string;
  agents: Agent[];
  /** Project whose runs decide what a new message meets (a message always joins a run of the same project). */
  projectId: string;
  prefill?: ComposerPrefill | null;
  /** The conversation of one agent's home: the answer always comes from that agent, so there is nothing to pick. */
  hidePicker?: boolean;
  onSend: (body: string, agentId: string, mode: SendMode, fresh: boolean) => Promise<ActionResult>;
}): JSX.Element {
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState('auto');
  // "Começar do zero": applies to the next message only.
  const [freshArmed, setFreshArmed] = useState(false);
  const freshHelpId = useId();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref closes the gap before React re-renders the disabled buttons: a double activation sends once.
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const runs = useAgentsStore((s) => s.runs);
  const author = useAuthor();

  // The chosen agent can disappear (turned off, access removed): fall back to auto.
  const effectiveAgent = agentId === 'auto' || agents.some((a) => a.id === agentId) ? agentId : 'auto';

  const target = useMemo(() => composerTarget(Object.values(runs), projectId, effectiveAgent), [runs, projectId, effectiveAgent]);
  const workingName = target.kind === 'none' ? '' : author(target.run.agent_id).name;
  const interruptAllowed = canInterrupt(target);
  const fresh = freshAvailability(target, workingName);
  // Armed only counts while the message would start a conversation (not join work in progress).
  const freshOn = freshArmed && fresh.allowed;
  const chosenName = effectiveAgent === 'auto' ? '' : (agents.find((a) => a.id === effectiveAgent)?.name ?? '');
  const liveLine = composerLiveLine(target, workingName) || (freshOn ? freshArmedLine(chosenName) : '');

  // The work the message would join appeared after arming: the choice no longer applies, so it turns itself off.
  useEffect(() => {
    if (freshArmed && !fresh.allowed) setFreshArmed(false);
  }, [freshArmed, fresh.allowed]);

  // Only a request made after this composer mounted refills it (a remount must not bring an old one back).
  const seenSeq = useRef(prefill?.seq ?? 0);
  useEffect(() => {
    if (!prefill || prefill.seq === seenSeq.current) return;
    seenSeq.current = prefill.seq;
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${prefill.text}` : prefill.text));
    inputRef.current?.focus();
  }, [prefill]);

  const submit = async (mode: SendMode = 'join'): Promise<void> => {
    const body = text.trim();
    if (!body || inFlight.current) return;
    inFlight.current = true;
    setSending(true);
    setError(null);
    // Only this message carries "fresh": it turns off at once, so nothing typed while it is being sent can repeat it.
    const sendFresh = freshOn;
    if (sendFresh) setFreshArmed(false);
    const res = await onSend(body, effectiveAgent, mode === 'interrupt' && interruptAllowed ? 'interrupt' : 'join', sendFresh);
    inFlight.current = false;
    setSending(false);
    if (res.ok) setText('');
    else {
      // Not sent: the text stays, and so does the choice to start from scratch.
      if (sendFresh) setFreshArmed(true);
      setError(res.error ?? 'Não consegui enviar. Tente de novo.');
    }
  };

  return (
    <div className="a-composer">
      {liveLine && (
        <p className="a-composer__live" role="status">
          {liveLine}
        </p>
      )}
      <label className="a-composer__field">
        <span className="sr-only">{label}</span>
        <textarea
          ref={inputRef}
          className="a-composer__input"
          rows={2}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(e.ctrlKey || e.metaKey ? 'interrupt' : 'join');
            }
          }}
        />
      </label>
      {error && <Notice>{error}</Notice>}
      <div className="a-composer__bar">
        {!hidePicker && (
          <label className="a-picker">
            <span className="sr-only">Quem responde</span>
            <select value={effectiveAgent} onChange={(e) => setAgentId(e.target.value)}>
              <option value="auto">Seraphine escolhe quem responde</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <button
          type="button"
          className={`a-btn a-btn--small a-btn--ghost a-fresh${freshOn ? ' is-on' : ''}`}
          aria-pressed={freshOn}
          aria-describedby={freshHelpId}
          title={fresh.allowed ? FRESH_HELP : fresh.reason}
          disabled={!fresh.allowed}
          onClick={() => setFreshArmed((v) => !v)}
        >
          <ChatNewIcon size={14} /> {FRESH_LABEL}
        </button>
        <span className="sr-only" id={freshHelpId}>
          {fresh.allowed ? FRESH_HELP : fresh.reason}
        </span>
        <span className="a-spacer" />
        {interruptAllowed && (
          <button
            type="button"
            className="a-btn a-btn--small a-btn--ghost a-stopsend"
            aria-label={`Parar e mandar: interrompe o que ${workingName} está fazendo agora e faz ele ler esta mensagem já`}
            aria-keyshortcuts="Control+Enter"
            title="Ctrl+Enter"
            disabled={sending || !text.trim()}
            onClick={() => void submit('interrupt')}
          >
            <StopIcon /> Parar e mandar
          </button>
        )}
        <button
          type="button"
          className="a-send"
          aria-label="Enviar"
          disabled={sending || !text.trim()}
          onClick={() => void submit('join')}
        >
          <SendIcon size={18} />
        </button>
      </div>
    </div>
  );
}
