/**
 * "Desfazer a criação" of a freshly created team (phase 6c part 2, contract 5.5), shared by the result panel of the "Seus agentes"
 * dialog and by an applied `create_agents` proposal card. The button shows while `undo_until` has not passed; it asks first (inline,
 * so it also works inside the dialog) and then says what was deleted, what was archived and what stayed.
 */
import { useEffect, useId, useRef, useState } from 'react';
import * as api from './api';
import { ApiError } from './api';
import { Notice } from './components';
import { UNDO_CONFIRM_TITLE, UNDO_LABEL, undoConfirmMessage, undoOutcomeHeading, undoOutcomeLines } from './agentPage';
import { parseIsoUtc } from './lib';
import { useAgentsStore } from './store';
import type { TeamBatchRef } from './types';

/** Re-renders when `until` passes, so the button goes away by itself. */
function useExpired(until: string): boolean {
  const [, tick] = useState(0);
  const at = parseIsoUtc(until)?.getTime() ?? 0;
  const expired = at <= Date.now();
  useEffect(() => {
    if (expired) return;
    // setTimeout caps at about 24.8 days: a longer wait re-checks then.
    const timer = setTimeout(() => tick((n) => n + 1), Math.min(at - Date.now() + 50, 2_147_000_000));
    return () => clearTimeout(timer);
  }, [at, expired]);
  return expired;
}

export function TeamUndo({
  batch,
  askServer = false,
}: {
  batch: TeamBatchRef | null | undefined;
  /** An applied proposal read from the history: ask the batch route whether it can still be undone (the panel of a creation that just happened knows). */
  askServer?: boolean;
}): JSX.Element | null {
  const entry = useAgentsStore((s) => (batch ? s.teamUndo[batch.id] : undefined));
  const undoTeam = useAgentsStore((s) => s.undoTeam);
  const expired = useExpired(batch?.undo_until ?? '');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [server, setServer] = useState<'unknown' | 'ok' | 'undone' | 'hidden'>('unknown');
  const inFlight = useRef(false);
  const titleId = useId();
  const batchId = batch?.id;

  useEffect(() => {
    if (!askServer || !batchId) return;
    let alive = true;
    api.getTeamBatch(batchId).then(
      (b) => {
        if (!alive) return;
        setServer(b.undone_at ? 'undone' : b.can_undo ? 'ok' : 'hidden');
      },
      (e: unknown) => {
        // A 404 means a backend without batches: the feature hides. Any other failure leaves the button to the deadline.
        if (alive && e instanceof ApiError && e.status === 404) setServer('hidden');
      },
    );
    return () => {
      alive = false;
    };
  }, [askServer, batchId]);

  if (!batch) return null;

  if (entry?.phase === 'done') {
    const lines = undoOutcomeLines(entry);
    return (
      <section className="a-undo a-undo--done" role="status" aria-label="O que foi desfeito">
        <h4 className="a-label-text">{undoOutcomeHeading(entry)}</h4>
        {lines.map((l) => (
          <div key={l.key}>
            <p className="a-label-text">{l.heading}</p>
            <ul className="a-bullets">
              {l.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    );
  }
  if (entry?.phase === 'closed') {
    return (
      <p className="a-hint a-undo a-undo--closed" role="status">
        {entry.text}
      </p>
    );
  }
  if (server === 'undone') {
    return (
      <p className="a-hint a-undo a-undo--closed" role="status">
        Esta criação já foi desfeita.
      </p>
    );
  }
  if (server === 'hidden' || expired) return null;

  const run = async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const res = await undoTeam(batch.id);
    inFlight.current = false;
    setBusy(false);
    if (!res.ok) {
      setConfirming(false);
      // A final refusal (`undo_expired`, `already_undone`) is shown by the stored entry; the others are plain errors.
      if (res.code !== 'undo_expired' && res.code !== 'already_undone') setError(res.error ?? 'Não consegui desfazer agora. Tente de novo em instantes.');
    }
  };

  return (
    <div className="a-undo">
      {!confirming ? (
        <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => setConfirming(true)}>
          {UNDO_LABEL}
        </button>
      ) : (
        <div className="a-undo__confirm" role="group" aria-labelledby={titleId}>
          <p className="a-label-text" id={titleId}>
            {UNDO_CONFIRM_TITLE}
          </p>
          <p className="a-hint">{undoConfirmMessage()}</p>
          <div className="a-actions">
            <button type="button" className="a-btn a-btn--danger a-btn--small" disabled={busy} onClick={() => void run()}>
              {busy ? 'Desfazendo…' : 'Sim, desfazer'}
            </button>
            <button type="button" className="a-btn a-btn--ghost a-btn--small" disabled={busy} onClick={() => setConfirming(false)}>
              Voltar
            </button>
          </div>
        </div>
      )}
      {error && <Notice>{error}</Notice>}
    </div>
  );
}
