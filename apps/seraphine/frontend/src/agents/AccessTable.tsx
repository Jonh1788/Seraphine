/**
 * "Ferramentas e acesso" (phase 6c part 2, contract 5.4): the agents in the rows, the tool groups in the columns, and one button per
 * cell that cycles through the levels that group accepts. Each change is saved at once through the grants route and announced with
 * an "Desfazer" that puts the previous level back. Raising the personal memory asks first; an engine that only chats is locked.
 */
import { useEffect, useRef, useState } from 'react';
import { Notice } from './components';
import { LockIcon } from '../icons/Icons';
import { ToolGroupIcon, TickIcon } from './icons';
import {
  LOCKED_ROW_NOTE,
  cellAriaLabel,
  grantChangedLine,
  grantRestoredLine,
  levelCell,
  lockedCellAriaLabel,
  memoryConfirmMessage,
  needsMemoryConfirm,
  nextLevel,
} from './agentPage';
import { TOOLS_FIXED_NOTE, engineUsesTools, grantLevel } from './lib';
import { useAgentsStore } from './store';
import type { GrantLevel, ToolGroup } from './types';
import { useConfirm } from '../ui';

interface LastChange {
  agentId: string;
  agentName: string;
  group: ToolGroup;
  previous: GrantLevel;
  line: string;
}

export function AccessTable({ highlightAgentId }: { highlightAgentId?: string }): JSX.Element {
  const agents = useAgentsStore((s) => s.agents);
  const tools = useAgentsStore((s) => s.tools);
  const toolsState = useAgentsStore((s) => s.toolsState);
  const engines = useAgentsStore((s) => s.engines);
  const loadTools = useAgentsStore((s) => s.loadTools);
  const saveGrants = useAgentsStore((s) => s.saveGrants);
  const confirm = useConfirm();
  const [busyCell, setBusyCell] = useState<string | null>(null);
  const [last, setLast] = useState<LastChange | null>(null);
  const [announce, setAnnounce] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const rowRef = useRef<HTMLTableRowElement>(null);

  // Coming from an agent's "Mudar o acesso": the row is in view and its first cell has the keyboard.
  useEffect(() => {
    if (!highlightAgentId) return;
    rowRef.current?.scrollIntoView?.({ block: 'center' });
    rowRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')?.focus();
  }, [highlightAgentId, tools.length, agents.length]);

  const change = async (agentId: string, agentName: string, group: ToolGroup, to: GrantLevel, from: GrantLevel, isUndo = false): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusyCell(`${agentId}:${group.id}`);
    setError(null);
    const res = await saveGrants(agentId, { [group.id]: to });
    inFlight.current = false;
    setBusyCell(null);
    if (!res.ok) {
      setError(res.error ?? 'Não consegui salvar o acesso agora. Tente de novo.');
      return;
    }
    if (isUndo) {
      setLast(null);
      setAnnounce(grantRestoredLine(group.label, agentName, to));
    } else {
      const line = grantChangedLine(group.label, agentName, to);
      setLast({ agentId, agentName, group, previous: from, line });
      setAnnounce(line);
    }
  };

  const onCell = async (agentId: string, agentName: string, group: ToolGroup): Promise<void> => {
    const agent = useAgentsStore.getState().agents.find((a) => a.id === agentId);
    if (!agent) return;
    const from = grantLevel(agent.grants, group);
    const to = nextLevel(from, group.levels);
    if (to === from) return;
    if (needsMemoryConfirm(group, from, to)) {
      const ok = await confirm({
        title: `Dar acesso a ${group.label}`,
        message: memoryConfirmMessage(agentName),
        confirmLabel: 'Dar acesso',
        variant: 'danger',
      });
      if (!ok) return;
    }
    await change(agentId, agentName, group, to, from);
  };

  let body: JSX.Element;
  if (agents.length === 0) {
    body = <p className="a-empty">Nenhum agente ainda. Quando você criar agentes, o acesso de cada um aparece aqui.</p>;
  } else if (tools.length === 0) {
    body = (
      <p className="a-hint">
        {toolsState === 'loading' ? 'Carregando as ferramentas…' : 'Não consegui carregar as ferramentas agora.'}{' '}
        {toolsState === 'error' && (
          <button type="button" className="a-link" onClick={() => void loadTools()}>
            Tentar de novo
          </button>
        )}
      </p>
    );
  } else {
    body = (
      <div className="a-tablewrap" role="region" aria-label="Acesso de cada agente às ferramentas" tabIndex={0}>
        <table className="a-table a-access">
          <caption className="a-label-text">Acesso de cada agente às ferramentas da Seraphine</caption>
          <thead>
            <tr>
              <th scope="col">Agente</th>
              {tools.map((g) => (
                <th scope="col" key={g.id}>
                  <span className="a-access__group">
                    <ToolGroupIcon group={g.id} size={14} />
                    {g.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const locked = !engineUsesTools(a.engine, engines);
              const highlighted = a.id === highlightAgentId;
              return (
                <tr key={a.id} ref={highlighted ? rowRef : undefined} className={highlighted ? 'is-highlight' : undefined} aria-current={highlighted ? 'true' : undefined}>
                  <th scope="row">
                    <span className="a-access__who">
                      {a.name}
                      {highlighted && (
                        <span className="a-chip a-chip--engine a-chip--todo">
                          <TickIcon size={12} />
                          Em destaque
                        </span>
                      )}
                    </span>
                    {locked && <small className="a-access__locked">{LOCKED_ROW_NOTE}</small>}
                  </th>
                  {tools.map((g) => {
                    if (locked) {
                      return (
                        <td key={g.id}>
                          <button type="button" className="a-cell is-locked" disabled aria-label={lockedCellAriaLabel(g.label, a.name)}>
                            <LockIcon size={14} />
                            Travado
                          </button>
                        </td>
                      );
                    }
                    const level = grantLevel(a.grants, g);
                    const next = nextLevel(level, g.levels);
                    return (
                      <td key={g.id}>
                        <button
                          type="button"
                          className={`a-cell is-${level}`}
                          disabled={busyCell === `${a.id}:${g.id}`}
                          aria-label={cellAriaLabel(g.label, a.name, level, next)}
                          onClick={() => void onCell(a.id, a.name, g)}
                        >
                          {levelCell(level)}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="a-access-panel">
      <p className="a-hint">Clique em uma célula para mudar o acesso do agente àquele grupo. A mudança vale na hora.</p>
      {error && <Notice>{error}</Notice>}
      <div className="a-access__live" role="status" aria-live="polite">
        {announce && (
          <span>
            {announce}
            {last && (
              <>
                {' '}
                <button type="button" className="a-link a-link--inline" onClick={() => void change(last.agentId, last.agentName, last.group, last.previous, grantLevel(agents.find((x) => x.id === last.agentId)?.grants, last.group), true)}>
                  Desfazer
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {body}
      {tools.length > 0 && (
        <section className="a-card a-legend" aria-label="O que é cada grupo">
          <p className="a-label-text">O que é cada grupo</p>
          <dl className="a-legend__list">
            {tools.map((g) => (
              <div key={g.id} className="a-legend__item">
                <dt>
                  <ToolGroupIcon group={g.id} size={14} /> {g.label}
                </dt>
                <dd>
                  {g.description}
                  {g.tools.length > 0 && <small>{` Inclui: ${g.tools.map((t) => t.label).join(' · ')}.`}</small>}
                  {g.sensitive && <small>{' O que o agente ler aqui é enviado ao provedor de IA que ele usa.'}</small>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      <p className="a-hint a-tools__fixed">
        <LockIcon size={14} /> {TOOLS_FIXED_NOTE}
      </p>
    </div>
  );
}
