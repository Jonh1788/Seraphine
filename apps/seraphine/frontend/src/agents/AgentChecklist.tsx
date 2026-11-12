/**
 * The to-do list of an agent (phase 6c part 2, contract 5.2): a collapsible card at the top of the "Conversa" tab, "Para Bia
 * trabalhar bem · 2 de 4". It reads the page route, shows while something is missing and goes away when complete or dismissed.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Notice } from './components';
import { AGENT_CHECKLIST_LABELS, checklistTitle, checklistVisible, firstRequestText, knownChecklistItems } from './agentPage';
import { ChevronDownIcon, ChevronRightSmallIcon, ClockIcon, TickIcon } from './icons';
import { isActiveRun } from './lib';
import { useAgentsStore } from './store';
import type { Agent, ChecklistPatch } from './types';

export function AgentChecklist({
  agent,
  onFillRequest,
  onOpenRoutines,
}: {
  agent: Agent;
  /** "Fazer o primeiro pedido": puts the text in the composer without sending it. */
  onFillRequest: (text: string) => void;
  /** "Nova rotina": opens the routines tab. */
  onOpenRoutines?: () => void;
}): JSX.Element | null {
  const checklist = useAgentsStore((s) => s.agentPages[agent.id]?.checklist);
  const unavailable = useAgentsStore((s) => s.pagesUnavailable);
  const loadAgentPage = useAgentsStore((s) => s.loadAgentPage);
  const saveChecklist = useAgentsStore((s) => s.saveChecklist);
  const navigate = useAgentsStore((s) => s.navigate);
  const runs = useAgentsStore((s) => s.runs);
  const routines = useAgentsStore((s) => s.routines);
  const [open, setOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const bodyId = useId();

  // What the list depends on: the runs that finished, the access levels and the routines of this agent. Any change reads it again;
  // the first pass is the read of the moment the tab is shown.
  const finished = useMemo(() => Object.values(runs).filter((r) => r.agent_id === agent.id && !isActiveRun(r)).length, [runs, agent.id]);
  const routinesSig = useMemo(
    () =>
      Object.values(routines)
        .filter((r) => r.agent_id === agent.id)
        .map((r) => `${r.id}:${r.enabled ? 1 : 0}`)
        .sort()
        .join(','),
    [routines, agent.id],
  );
  const signature = `${finished}|${JSON.stringify(agent.grants)}|${routinesSig}|${agent.enabled ? 1 : 0}`;
  useEffect(() => {
    if (!unavailable) void loadAgentPage(agent.id);
  }, [agent.id, signature, unavailable, loadAgentPage]);

  if (unavailable || !checklistVisible(checklist)) return null;
  const items = knownChecklistItems(checklist);

  const save = async (patch: ChecklistPatch): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const res = await saveChecklist(agent.id, patch);
    inFlight.current = false;
    setBusy(false);
    if (!res.ok) setError(res.error ?? 'Não consegui guardar. Tente de novo.');
  };

  const actions = (id: string): JSX.Element | null => {
    switch (id) {
      case 'engine':
        return (
          <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => navigate({ screen: 'settings', settingsTab: 'ai' })}>
            Conectar um motor
          </button>
        );
      case 'first_talk':
        return (
          <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => onFillRequest(firstRequestText(agent.name, agent.suggestions))}>
            Fazer o primeiro pedido
          </button>
        );
      case 'access':
        return (
          <>
            <button
              type="button"
              className="a-btn a-btn--ghost a-btn--small"
              onClick={() => navigate({ screen: 'settings', settingsTab: 'access', agentId: agent.id })}
            >
              Ver o acesso
            </button>
            <button type="button" className="a-btn a-btn--ghost a-btn--small" disabled={busy} onClick={() => void save({ access_ok: true })}>
              Está bom assim
            </button>
          </>
        );
      case 'routine':
        return (
          <>
            {onOpenRoutines && (
              <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={onOpenRoutines}>
                Nova rotina
              </button>
            )}
            <button type="button" className="a-btn a-btn--ghost a-btn--small" disabled={busy} onClick={() => void save({ routine_skipped: true })}>
              Agora não
            </button>
          </>
        );
      default:
        return null;
    }
  };

  return (
    <section className="a-card a-todo" aria-label={`Lista de pendências de ${agent.name}`}>
      <div className="a-todo__head">
        <button type="button" className="a-todo__toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen((v) => !v)}>
          {open ? <ChevronDownIcon /> : <ChevronRightSmallIcon />}
          <span>{checklistTitle(agent.name, checklist.done, checklist.total)}</span>
        </button>
        <button type="button" className="a-btn a-btn--ghost a-btn--small" disabled={busy} onClick={() => void save({ dismissed: true })}>
          Dispensar
        </button>
      </div>
      <div id={bodyId} hidden={!open}>
        <ul className="a-todo__list">
          {items.map((item) => (
            <li key={item.id} className="a-todo__item">
              <span className="a-todo__label">
                {AGENT_CHECKLIST_LABELS[item.id]}
                {item.optional && <small> (opcional)</small>}
              </span>
              <span className={`a-chip a-chip--engine ${item.done ? 'a-chip--ok' : 'a-chip--todo'}`}>
                {item.done ? <TickIcon size={12} /> : <ClockIcon size={12} />}
                {item.done ? 'Feito' : 'Falta'}
              </span>
              {!item.done && <span className="a-todo__actions">{actions(item.id)}</span>}
            </li>
          ))}
        </ul>
        {error && <Notice>{error}</Notice>}
      </div>
    </section>
  );
}
