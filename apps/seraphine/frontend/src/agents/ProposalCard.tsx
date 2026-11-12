/**
 * A proposal of the Seraphine (phase 6c part 1, contract 4.1): what it does in words, exactly what changes (before and after, or the
 * same agent cards and routine lines of the first steps, read-only), the deadline, "Aplicar" and "Descartar", and after applying the
 * links to what changed. Nothing here changes anything until the owner clicks.
 */
import { useId, useRef, useState } from 'react';
import { Notice } from './components';
import { DraftCard, DraftRoutines } from './TeamBuilder';
import { TeamUndo } from './TeamUndo';
import { FieldDiff, LongText, ProposalChip } from './guideBits';
import { agentChangeRows, deadlineLine, effectiveStatus, proposalSummary, routineChangeRows } from './guide';
import { REPORT_LABELS } from './routines';
import { useAgentsStore } from './store';
import type { GuideProposal } from './types';

export function ProposalCard({ proposal }: { proposal: GuideProposal }): JSX.Element {
  const agents = useAgentsStore((s) => s.agents);
  const routines = useAgentsStore((s) => s.routines);
  const versionsUnavailable = useAgentsStore((s) => s.versionsUnavailable);
  const apply = useAgentsStore((s) => s.applyProposal);
  const dismiss = useAgentsStore((s) => s.dismissProposal);
  const navigate = useAgentsStore((s) => s.navigate);
  const openConversation = useAgentsStore((s) => s.openAgentConversation);
  const [busy, setBusy] = useState<'apply' | 'dismiss' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  // A ref closes the gap before React re-renders the disabled buttons: a double click sends once.
  const inFlight = useRef(false);
  const titleId = useId();

  const now = new Date();
  const status = effectiveStatus(proposal, now);
  const payload = proposal.payload;
  const deadline = deadlineLine(proposal, now);

  const decide = async (which: 'apply' | 'dismiss'): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(which);
    setError(null);
    setAnnounce('');
    const res = await (which === 'apply' ? apply(proposal.id) : dismiss(proposal.id));
    inFlight.current = false;
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? 'Não consegui fazer isso agora. Tente de novo.');
      return;
    }
    const after = useAgentsStore.getState().guideProposals[proposal.id];
    if (which === 'dismiss') setAnnounce('Proposta descartada. Nada foi mudado.');
    else if (after?.status === 'applied') setAnnounce(`Proposta aplicada: ${proposal.title}.`);
    else setAnnounce(after?.detail || 'A proposta não pôde ser aplicada.');
  };

  const open = async (agentId: string, tab?: 'routines'): Promise<void> => {
    setError(null);
    const res = await openConversation(agentId, tab);
    if (!res.ok) setError(res.error ?? 'Não consegui abrir a conversa agora. Tente de novo.');
  };

  // ---- what changes ----
  let body: JSX.Element;
  if (payload.kind === 'create_agents') {
    body = (
      <ul className="a-stack a-drafts" aria-label="Agentes que seriam criados">
        {payload.agents.map((d, i) => (
          <DraftCard key={i} draft={d} index={i} readOnly />
        ))}
      </ul>
    );
  } else if (payload.kind === 'update_agent') {
    body = (
      <div className="a-diffs">
        {agentChangeRows(payload.changes, proposal.before).map((row) => (
          <FieldDiff key={row.key} row={row} />
        ))}
      </div>
    );
  } else if (payload.kind === 'create_routine') {
    body = (
      <div className="a-prop__routine">
        <DraftRoutines routines={[payload.routine]} readOnly />
        <div className="a-prop__ask">
          <p className="a-label-text">Pedido</p>
          <LongText text={payload.routine.prompt} />
        </div>
        <p className="a-hint">{REPORT_LABELS[payload.routine.report ?? 'news']}</p>
      </div>
    );
  } else {
    body = (
      <div className="a-diffs">
        {routineChangeRows(payload.changes, proposal.before).map((row) => (
          <FieldDiff key={row.key} row={row} />
        ))}
      </div>
    );
  }

  // ---- after applying ----
  const result = proposal.result;
  const links: { key: string; label: string; onClick: () => void }[] = [];
  if (status === 'applied') {
    if (payload.kind === 'create_agents' || payload.kind === 'update_agent') {
      const ids = payload.kind === 'update_agent' ? [payload.agent_id] : (result?.agent_ids ?? []);
      for (const id of ids) {
        const agent = agents.find((a) => a.id === id);
        if (agent) links.push({ key: `open-${id}`, label: `Abrir a conversa de ${agent.name}`, onClick: () => void open(id) });
      }
      if (payload.kind === 'update_agent' && !versionsUnavailable && agents.some((a) => a.id === payload.agent_id)) {
        links.push({ key: 'history', label: 'Ver o histórico', onClick: () => navigate({ screen: 'roster', agentId: payload.agent_id, section: 'history' }) });
      }
    } else {
      const routineId = payload.kind === 'update_routine' ? payload.routine_id : result?.routine_ids?.[0];
      const agentId = payload.kind === 'create_routine' ? payload.agent_id : routines[payload.routine_id]?.agent_id;
      const agentKnown = !!agentId && agents.some((a) => a.id === agentId);
      if (routineId || agentId) {
        links.push({
          key: 'routine',
          label: 'Ver a rotina',
          onClick: () => (agentKnown && agentId ? void open(agentId, 'routines') : navigate({ screen: 'routines' })),
        });
      }
    }
  }

  const failed = result?.failed ?? [];

  return (
    <article className="a-card a-prop" aria-labelledby={titleId} aria-busy={busy !== null}>
      <header className="a-prop__head">
        <h3 className="a-prop__title" id={titleId}>
          {proposal.title}
        </h3>
        <ProposalChip status={status} />
      </header>
      <p className="a-prop__summary">{proposalSummary(proposal, agents, routines)}</p>
      {body}
      {proposal.detail && <p className="a-prop__detail">{proposal.detail}</p>}
      {failed.length > 0 && (
        <section className="a-prop__failed" aria-label="O que não deu certo">
          <p className="a-label-text">{status === 'applied' ? 'Não foi possível criar' : 'O que não deu certo'}</p>
          <ul className="a-bullets">
            {failed.map((f, i) => (
              <li key={i}>
                <strong>{f.name}</strong>: {f.detail}
              </li>
            ))}
          </ul>
        </section>
      )}
      {status === 'applied' && payload.kind === 'create_agents' && <TeamUndo batch={result?.batch} askServer />}
      {deadline && <p className="a-hint a-prop__deadline">{deadline}</p>}
      {error && error !== proposal.detail && <Notice>{error}</Notice>}
      {status === 'pending' && (
        <div className="a-actions">
          <button type="button" className={`a-btn a-btn--primary${busy === 'apply' ? ' is-busy' : ''}`} disabled={busy !== null} onClick={() => void decide('apply')}>
            {busy === 'apply' ? 'Aplicando…' : 'Aplicar'}
          </button>
          <button type="button" className={`a-btn a-btn--ghost${busy === 'dismiss' ? ' is-busy' : ''}`} disabled={busy !== null} onClick={() => void decide('dismiss')}>
            {busy === 'dismiss' ? 'Descartando…' : 'Descartar'}
          </button>
        </div>
      )}
      {links.length > 0 && (
        <div className="a-actions a-prop__links">
          {links.map((l) => (
            <button key={l.key} type="button" className="a-link" onClick={l.onClick}>
              {l.label}
            </button>
          ))}
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </article>
  );
}
