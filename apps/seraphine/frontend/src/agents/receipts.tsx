/**
 * Receipts of what an agent wrote (step 3c): the "Desfazer" action with the time left, and the compact strip under the
 * agent's message. Every receipt keeps its own clock, so a tick re-renders that one action and nothing around it.
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { useAgentsStore } from './store';
import { UNDO_FINAL_CODES, buildSteps, parseIsoUtc, receiptView, undoButtonLabel, undoNextChangeIn } from './lib';
import type { Step } from './lib';
import { ToolGroupIcon } from './icons';

/**
 * The current time, refreshed only at the instants the words of the countdown change ("4 min" -> "3 min" ->
 * "menos de 1 min") and when the window ends. With no deadline it never ticks.
 */
function useCountdownNow(deadline: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = (): void => {
      const t = Date.now();
      setNow(t);
      const next = undoNextChangeIn(deadline - t);
      if (next !== null) timer = setTimeout(tick, next + 20);
    };
    tick();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [deadline]);
  return now;
}

interface ReceiptActionProps {
  actionId: string | undefined;
  undoUntil: string | undefined;
  /** The run's own events already say the action was undone. */
  undone: boolean | undefined;
  /** Id of the element that says what would be undone (read out with the button). */
  describedBy?: string;
}

/**
 * What stands at the end of a receipt line: "Desfazer · 4 min" while the window is open (the button shows progress while
 * the request runs), a quiet "Desfeito" afterwards, the sentence of a refusal, or nothing once the window has closed.
 */
export function ReceiptAction({ actionId, undoUntil, undone, describedBy }: ReceiptActionProps): JSX.Element | null {
  const action = useAgentsStore((s) => (actionId ? s.actionsById[actionId] : undefined));
  const pending = useAgentsStore((s) => !!actionId && !!s.undoingIds[actionId]);
  const error = useAgentsStore((s) => (actionId ? s.undoErrors[actionId] : undefined));
  const undo = useAgentsStore((s) => s.undoAction);

  const isUndone = !!undone || !!action?.undone_at;
  const deadline = parseIsoUtc(action?.undo_until ?? undoUntil)?.getTime() ?? null;
  const now = useCountdownNow(isUndone ? null : deadline);
  const view = receiptView({ actionId, undoUntil, undone }, action, now);

  if (view.state === 'undone') return <span className="a-rcpt__done">Desfeito</span>;
  // A refusal that settles the matter (window over, already undone, changed afterwards) takes the button away.
  const settled = !!error && UNDO_FINAL_CODES.includes(error.code);
  const open = view.state === 'open' && !settled;
  if (!open && !error) return null;
  return (
    <span className="a-rcpt__act">
      {open && actionId && (
        <button
          type="button"
          className={`a-rcpt__btn${pending ? ' is-busy' : ''}`}
          disabled={pending}
          aria-describedby={describedBy}
          onClick={() => void undo(actionId)}
        >
          {pending ? 'Desfazendo…' : undoButtonLabel(view.remainingMs)}
        </button>
      )}
      {error && (
        <span className="a-rcpt__err" role="alert">
          {error.text}
        </span>
      )}
    </span>
  );
}

/** The writes of a run, from its events: finished calls that changed something. Asks for their state once. */
export function useRunReceipts(runId: string): Step[] {
  const events = useAgentsStore((s) => s.eventsByRun[runId]);
  const loadRunActions = useAgentsStore((s) => s.loadRunActions);
  const receipts = useMemo(() => buildSteps(events ?? []).filter((s) => s.receipt), [events]);
  const any = receipts.some((s) => s.actionId);
  useEffect(() => {
    if (any) void loadRunActions(runId);
  }, [any, loadRunActions, runId]);
  return receipts;
}

function ReceiptLine({ step }: { step: Step }): JSX.Element {
  const labelId = useId();
  const undone = useAgentsStore((s) => !!step.undone || !!(step.actionId && s.actionsById[step.actionId]?.undone_at));
  return (
    <li className={`a-rcpt${undone ? ' is-undone' : ''}`}>
      <ToolGroupIcon group={step.group} className="a-rcpt__icon" size={14} />
      <span className="a-rcpt__label" id={labelId}>
        {step.text}
      </span>
      <ReceiptAction actionId={step.actionId} undoUntil={step.undoUntil} undone={step.undone} describedBy={labelId} />
    </li>
  );
}

/**
 * One line per write the run made, under the agent's message: the same wording and the same "Desfazer" as the
 * activity list, so a change to the owner's own notes does not hide inside a collapsed list.
 */
export function ReceiptStrip({ runId }: { runId: string }): JSX.Element | null {
  const receipts = useRunReceipts(runId);
  if (receipts.length === 0) return null;
  return (
    <ul className="a-rcpts" aria-label="O que o agente escreveu">
      {receipts.map((step) => (
        <ReceiptLine key={step.id} step={step} />
      ))}
    </ul>
  );
}
