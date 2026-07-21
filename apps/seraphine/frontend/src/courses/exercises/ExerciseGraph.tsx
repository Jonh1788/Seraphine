import { useState } from 'react';
import type { Exercise } from '../api';
import { GraphBlock, type GraphSpec } from '../GraphBlock';
import { checkGraphTarget } from './grading';

export function ExerciseGraph({ exercise, onResult }:
  { exercise: Exercise; onResult: (c: boolean) => void }) {
  const p = exercise.payload;
  const spec: GraphSpec | null = p.expr && p.x
    ? { expr: p.expr, x: p.x, params: p.params } : null;
  const target = p.target;
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries((p.params ?? []).map((q) => [q.name, q.default])));
  const [touched, setTouched] = useState(false);
  const [answered, setAnswered] = useState(false);

  if (!spec || !target) return <div className="tr-ex">Exercício indisponível.</div>;

  const verify = () => {
    if (answered) return;
    setAnswered(true);
    onResult(checkGraphTarget(values[target.param], target.value, target.tol));
  };

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      {/* GraphBlock com sliders controlados aqui: passa spec com defaults = values */}
      <GraphBlock hideSliders spec={{ ...spec, params: (spec.params ?? []).map((q) => ({ ...q, default: values[q.name] })) }}
        key={JSON.stringify(values) /* re-render simples do plot com os valores atuais */} />
      {(spec.params ?? []).map((q) => (
        <label key={q.name} className="tr-graph__slider">
          <span>{q.name} = {values[q.name].toFixed(2)}</span>
          <input type="range" min={q.min} max={q.max} step={(q.max - q.min) / 100}
            disabled={answered} value={values[q.name]}
            onChange={(e) => { setTouched(true); setValues({ ...values, [q.name]: Number(e.target.value) }); }} />
        </label>
      ))}
      {!answered && (
        <button type="button" className="tr-btn tr-btn--full" disabled={!touched} onClick={verify}>
          Verificar
        </button>
      )}
    </div>
  );
}
