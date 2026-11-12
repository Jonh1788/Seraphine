/**
 * The four ways to connect an engine ("Plano do Claude", "Plano do ChatGPT", "Modelos locais", "Chaves de API"), shared by the
 * first-steps screen and the settings screen ("IA e uso"): state chip, what is missing, "Testar" and the default-engine choice.
 */
import { EngineChip } from './engineChip';
import type { EngineRow } from './setup';
import { useAgentsStore } from './store';

export function EngineRowView({
  row,
  checked,
  onPick,
}: {
  row: EngineRow;
  checked: boolean;
  /** Without it the row has no default-engine choice. */
  onPick?: () => void;
}): JSX.Element {
  const running = useAgentsStore((s) => s.bridgeRunning);
  const result = useAgentsStore((s) => (row.testEngine ? s.bridgeResults[row.testEngine] : undefined));
  const test = useAgentsStore((s) => s.testBridge);
  const mine = !!row.testEngine && running === row.testEngine;
  return (
    <li className="a-card a-engine-row">
      <div className="a-engine-row__main">
        <div className="a-engine-row__head">
          <strong>{row.name}</strong>
          <EngineChip ready={row.ready} word={row.chip} how={row.how} />
        </div>
        <span className="a-hint">{row.hint}</span>
        {!row.ready && row.how && <span className="a-engine-row__how">{row.how}</span>}
        {mine && (
          <span className="a-engine-row__result" role="status">
            Testando… pode levar até um minuto.
          </span>
        )}
        {!mine && result && (
          <span className={`a-engine-row__result a-engine-row__result--${result.ok ? 'ok' : 'fail'}`} role="status">
            {result.text}
          </span>
        )}
      </div>
      <div className="a-engine-row__side">
        {row.testEngine && (
          <button
            type="button"
            className={`a-btn a-btn--ghost a-btn--small${mine ? ' is-busy' : ''}`}
            aria-label={`Testar ${row.name}`}
            disabled={running !== null}
            onClick={() => void test(row.testEngine as string)}
          >
            {mine ? 'Testando…' : 'Testar'}
          </button>
        )}
        {row.ready && onPick && (
          <label className="a-engine-row__radio">
            <input type="radio" name="default-engine" checked={checked} onChange={onPick} aria-label={`Usar ${row.name} como motor padrão`} />
            <span>Motor padrão</span>
          </label>
        )}
      </div>
    </li>
  );
}

/** The list of rows; `chosen` is the row marked as default. */
export function EngineList({ rows, chosen, onPick }: { rows: EngineRow[]; chosen: EngineRow['id'] | null; onPick?: (id: EngineRow['id']) => void }): JSX.Element {
  return (
    <ul className="a-stack" aria-label="Motores">
      {rows.map((r) => (
        <EngineRowView key={r.id} row={r} checked={chosen === r.id} onPick={onPick ? () => onPick(r.id) : undefined} />
      ))}
    </ul>
  );
}
