import { useState } from 'react';
import type { Exercise } from '../api';
import { checkMatchPairs, checkSteps } from './grading';

export function ExerciseMatch({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const pairs = exercise.payload.pairs;
  const steps = exercise.payload.steps;
  if (pairs && pairs.length) return <MatchPairs pairs={pairs} prompt={exercise.prompt} onResult={onResult} />;
  if (steps && steps.length) return <OrderSteps steps={steps} prompt={exercise.prompt} onResult={onResult} />;
  return <div className="trilha-ex">Exercício indisponível.</div>;
}

function MatchPairs({ pairs, prompt, onResult }:
  { pairs: [string, string][]; prompt: string; onResult: (c: boolean) => void }) {
  const rights = pairs.map((p) => p[1]);
  const [mapping, setMapping] = useState<Record<number, number>>({});
  const [answered, setAnswered] = useState(false);
  const allSet = Object.keys(mapping).length === pairs.length;
  return (
    <div className="trilha-ex">
      <p className="trilha-ex__prompt">{prompt}</p>
      {pairs.map((p, i) => (
        <div key={i} className="trilha-match-row">
          <span className="trilha-match-left">{p[0]}</span>
          <select className="trilha-input" disabled={answered}
            value={mapping[i] ?? ''} onChange={(e) => setMapping({ ...mapping, [i]: Number(e.target.value) })}>
            <option value="" disabled>escolha…</option>
            {rights.map((r, ri) => <option key={ri} value={ri}>{r}</option>)}
          </select>
        </div>
      ))}
      {!answered && (
        <button type="button" className="trilha-check" disabled={!allSet}
          onClick={() => { setAnswered(true); onResult(checkMatchPairs(pairs, mapping)); }}>Verificar</button>
      )}
    </div>
  );
}

function OrderSteps({ steps, prompt, onResult }:
  { steps: string[]; prompt: string; onResult: (c: boolean) => void }) {
  // embaralha uma vez por render inicial (determinístico o suficiente pro v1)
  const [order, setOrder] = useState<string[]>(() => [...steps].reverse());
  const [answered, setAnswered] = useState(false);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  return (
    <div className="trilha-ex">
      <p className="trilha-ex__prompt">{prompt}</p>
      <ol className="trilha-steps">
        {order.map((s, i) => (
          <li key={s} className="trilha-step">
            <span>{s}</span>
            <span className="trilha-step__ctrl">
              <button type="button" disabled={answered} onClick={() => move(i, -1)}>↑</button>
              <button type="button" disabled={answered} onClick={() => move(i, 1)}>↓</button>
            </span>
          </li>
        ))}
      </ol>
      {!answered && (
        <button type="button" className="trilha-check"
          onClick={() => { setAnswered(true); onResult(checkSteps(steps, order)); }}>Verificar</button>
      )}
    </div>
  );
}
