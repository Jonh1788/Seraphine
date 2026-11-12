/**
 * The usage block of "IA e uso" (phase 6c part 2, contract 3 and 5.4): period selector, totals, a plain bar chart of runs per day
 * (every bar has a text alternative and a table sits beside it for screen readers) and the table by agent. Only what was measured.
 */
import { useEffect } from 'react';
import { Notice, SectionTitle } from './components';
import {
  USAGE_NOTE,
  barText,
  chartSummary,
  costText,
  formatCount,
  lastRunText,
  periodLabel,
  shortDay,
  usageCostKnown,
} from './agentPage';
import { useAgentsStore } from './store';
import { USAGE_PERIODS } from './types';
import type { Usage } from './types';

function Totals({ usage }: { usage: Usage }): JSX.Element {
  const known = usageCostKnown(usage);
  const t = usage.totals;
  return (
    <dl className="a-totals">
      <div className="a-card a-total">
        <dt>Execuções</dt>
        <dd>{formatCount(t.runs)}</dd>
        <small>{`${formatCount(t.routine_runs)} de rotinas`}</small>
      </div>
      <div className="a-card a-total">
        <dt>Tokens de entrada</dt>
        <dd>{formatCount(t.tokens_in)}</dd>
      </div>
      <div className="a-card a-total">
        <dt>Tokens de saída</dt>
        <dd>{formatCount(t.tokens_out)}</dd>
      </div>
      <div className="a-card a-total">
        <dt>Custo</dt>
        <dd className={known ? '' : 'a-total__unknown'}>{costText(t.cost_usd, known)}</dd>
      </div>
    </dl>
  );
}

function RunsChart({ usage }: { usage: Usage }): JSX.Element {
  const days = usage.by_day;
  const max = days.reduce((m, d) => Math.max(m, d.runs), 0);
  const first = days[0];
  const last = days[days.length - 1];
  return (
    <figure className="a-chart">
      <figcaption className="a-label-text">{`Execuções por dia, nos últimos ${usage.days} dias`}</figcaption>
      <p className="a-hint">{chartSummary(days)}</p>
      {/* The bars are decoration for the eyes: each one carries its text (`title`), and the table below says the same to a screen reader. */}
      <div className="a-chart__bars" aria-hidden="true">
        {days.map((d) => (
          <span key={d.date} className="a-chart__col" title={barText(d.date, d.runs)}>
            <span className="a-chart__bar" style={{ height: max > 0 ? `${Math.max(d.runs > 0 ? 4 : 0, Math.round((d.runs / max) * 100))}%` : '0%' }} />
          </span>
        ))}
      </div>
      {first && last && (
        <div className="a-chart__axis" aria-hidden="true">
          <span>{shortDay(first.date)}</span>
          <span>{shortDay(last.date)}</span>
        </div>
      )}
      <table className="sr-only">
        <caption>{`Execuções por dia, nos últimos ${usage.days} dias`}</caption>
        <thead>
          <tr>
            <th scope="col">Dia</th>
            <th scope="col">Execuções</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{shortDay(d.date)}</th>
              <td>{d.runs}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function AgentsTable({ usage }: { usage: Usage }): JSX.Element {
  return (
    <div className="a-tablewrap" role="region" aria-label="Uso por agente" tabIndex={0}>
      <table className="a-table">
        <caption className="a-label-text">{`Uso por agente, nos últimos ${usage.days} dias`}</caption>
        <thead>
          <tr>
            <th scope="col">Agente</th>
            <th scope="col">Execuções</th>
            <th scope="col">Das quais rotinas</th>
            <th scope="col">Tokens de entrada</th>
            <th scope="col">Tokens de saída</th>
            <th scope="col">Custo</th>
            <th scope="col">Última vez</th>
          </tr>
        </thead>
        <tbody>
          {usage.agents.map((a) => (
            <tr key={a.agent_id}>
              <th scope="row">
                {a.name}
                {a.archived && <span className="a-chip a-chip--engine a-chip--todo">Arquivado</span>}
              </th>
              <td>{formatCount(a.runs)}</td>
              <td>{formatCount(a.routine_runs)}</td>
              <td>{formatCount(a.tokens_in)}</td>
              <td>{formatCount(a.tokens_out)}</td>
              <td className={a.cost_known ? '' : 'a-total__unknown'}>{costText(a.cost_usd, a.cost_known)}</td>
              <td>{lastRunText(a.last_run_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders nothing on a backend without the usage route. */
export function UsagePanel(): JSX.Element | null {
  const usage = useAgentsStore((s) => s.usage);
  const state = useAgentsStore((s) => s.usageState);
  const days = useAgentsStore((s) => s.usageDays);
  const loadUsage = useAgentsStore((s) => s.loadUsage);

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  if (state === 'unavailable') return null;
  const empty = !!usage && usage.totals.runs === 0;

  return (
    <section className="a-section" aria-labelledby="usage-title">
      <div className="a-section__head">
        <SectionTitle id="usage-title">USO</SectionTitle>
        <div className="a-seg" role="radiogroup" aria-label="Período do uso">
          {USAGE_PERIODS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={days === p}
              className={`a-seg__btn${days === p ? ' is-on' : ''}`}
              onClick={() => void loadUsage(p)}
            >
              {periodLabel(p)}
            </button>
          ))}
        </div>
      </div>

      {state === 'error' && (
        <>
          <Notice>Não consegui carregar o uso agora.</Notice>
          <div className="a-actions">
            <button type="button" className="a-btn a-btn--ghost a-btn--small" onClick={() => void loadUsage()}>
              Tentar de novo
            </button>
          </div>
        </>
      )}
      {!usage && state !== 'error' && (
        <p className="a-empty" role="status">
          Carregando o uso…
        </p>
      )}
      {usage && (
        <div className="a-usage" aria-busy={state === 'loading'}>
          {state === 'loading' && (
            <p className="a-hint" role="status">
              Atualizando…
            </p>
          )}
          {empty && <p className="a-empty">{`Ainda não há execuções nos últimos ${usage.days} dias. Quando um agente trabalhar, o uso aparece aqui.`}</p>}
          <Totals usage={usage} />
          <RunsChart usage={usage} />
          {usage.agents.length > 0 && <AgentsTable usage={usage} />}
          <p className="a-hint">{USAGE_NOTE}</p>
        </div>
      )}
    </section>
  );
}
