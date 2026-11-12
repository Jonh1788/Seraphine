/** "Rotinas" (phase 6b, contract 8.2): every routine of every agent, grouped by agent, with the "Só ativas" filter. */
import { useMemo, useState } from 'react';
import { AgentTile, EmptyNote, Notice, SectionTitle } from './components';
import { RoutineList, RoutineNotes } from './RoutinesTab';
import type { RoutineNote } from './RoutinesTab';
import { activeRoutineCount, pluralRoutines } from './routines';
import { safeColor } from './lib';
import { useAgentsStore } from './store';
import type { Agent, Routine } from './types';

export function RoutinesScreen(): JSX.Element {
  const routines = useAgentsStore((s) => s.routines);
  const state = useAgentsStore((s) => s.routinesState);
  const agents = useAgentsStore((s) => s.agents);
  const loadRoutines = useAgentsStore((s) => s.loadRoutines);
  const navigate = useAgentsStore((s) => s.navigate);
  const [onlyActive, setOnlyActive] = useState(false);
  const [note, setNote] = useState<RoutineNote | null>(null);

  const all = useMemo(() => Object.values(routines), [routines]);
  const active = activeRoutineCount(all);
  const groups = useMemo(() => {
    const visible = onlyActive ? all.filter((r) => r.enabled) : all;
    const byAgent = new Map<string, Routine[]>();
    for (const r of visible) byAgent.set(r.agent_id, [...(byAgent.get(r.agent_id) ?? []), r]);
    const out: { agent: Agent; routines: Routine[] }[] = [];
    for (const agent of agents) {
      const list = byAgent.get(agent.id);
      if (list?.length) out.push({ agent, routines: list.sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)) });
    }
    return out;
  }, [all, agents, onlyActive]);

  const subtitle = all.length === 0 ? 'Nenhuma rotina ainda.' : `${active} ${active === 1 ? 'ativa' : 'ativas'} de ${pluralRoutines(all.length)}.`;

  let body: JSX.Element;
  if (state === 'unavailable') {
    body = <EmptyNote>Esta versão da Seraphine ainda não tem rotinas.</EmptyNote>;
  } else if (state === 'idle' || (state === 'loading' && all.length === 0)) {
    body = <EmptyNote>Carregando as rotinas…</EmptyNote>;
  } else if (state === 'error' && all.length === 0) {
    body = (
      <Notice>
        Não consegui carregar as rotinas.{' '}
        <button type="button" className="a-link" onClick={() => void loadRoutines()}>
          Tentar de novo
        </button>
      </Notice>
    );
  } else if (all.length === 0) {
    body = (
      <div className="a-routines__empty">
        <p className="a-empty">Nenhuma rotina ainda. Escolha um agente e combine com ele o que fazer em cada horário.</p>
        <div className="a-actions">
          <button type="button" className="a-btn a-btn--small a-btn--primary" onClick={() => navigate({ screen: 'roster' })}>
            Escolher um agente
          </button>
        </div>
      </div>
    );
  } else if (groups.length === 0) {
    body = <EmptyNote>Nenhuma rotina ativa. Desligue o filtro para ver as pausadas.</EmptyNote>;
  } else {
    body = (
      <div className="a-stack a-routine-groups">
        {groups.map(({ agent, routines: list }) => (
          <section className="a-section" key={agent.id} aria-labelledby={`routines-group-${agent.id}`}>
            <div className="a-section__head">
              <h2 className="a-routine-group__title" id={`routines-group-${agent.id}`}>
                <AgentTile name={agent.name} color={safeColor(agent.color)} size="sm" />
                <span>{agent.name}</span>
                <small>{agent.role}</small>
              </h2>
              <button
                type="button"
                className="a-link"
                onClick={() => navigate({ screen: 'project', projectId: list[0].project_id, tab: 'routines' })}
              >
                Abrir a conversa de {agent.name}
              </button>
            </div>
            <RoutineList agent={agent} routines={list} onNote={setNote} />
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="a-page">
      <header className="a-header">
        <div className="a-header__text">
          <h1>Rotinas</h1>
          <span>{subtitle}</span>
        </div>
        {state !== 'unavailable' && all.length > 0 && (
          <label className="a-check">
            <input type="checkbox" checked={onlyActive} onChange={(e) => setOnlyActive(e.target.checked)} />
            <span>Só ativas</span>
          </label>
        )}
      </header>
      <section className="a-section" aria-label="Rotinas de todos os agentes">
        <SectionTitle>TODAS AS ROTINAS</SectionTitle>
        <p className="a-hint">Uma rotina age com as permissões do agente dela. Comandos continuam esperando a sua aprovação.</p>
        <RoutineNotes note={note} />
        {body}
      </section>
    </div>
  );
}
