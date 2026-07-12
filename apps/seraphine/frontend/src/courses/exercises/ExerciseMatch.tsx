import { useState } from 'react';
import type { Exercise } from '../api';
import { checkSteps } from './grading';

export function ExerciseMatch({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const pairs = exercise.payload.pairs;
  const steps = exercise.payload.steps;
  if (pairs && pairs.length) return <MatchPairs pairs={pairs} prompt={exercise.prompt} onResult={onResult} />;
  if (steps && steps.length) return <OrderSteps steps={steps} prompt={exercise.prompt} onResult={onResult} />;
  return <div className="tr-ex">Exercício indisponível.</div>;
}

function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function MatchPairs({ pairs, prompt, onResult }:
  { pairs: [string, string][]; prompt: string; onResult: (c: boolean) => void }) {
  const [rightOrder] = useState(() => shuffled(pairs.length)); // exibição embaralhada da coluna B
  const [selLeft, setSelLeft] = useState<number | null>(null);
  const [selRight, setSelRight] = useState<number | null>(null);
  const [lockedLeft, setLockedLeft] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState(0);
  const [flash, setFlash] = useState<{ l: number; r: number } | null>(null);
  const done = lockedLeft.size === pairs.length;

  const tryPair = (l: number | null, r: number | null) => {
    if (l === null || r === null) return;
    if (l === r) { // índices originais iguais = par correto
      const next = new Set(lockedLeft); next.add(l);
      setLockedLeft(next); setSelLeft(null); setSelRight(null);
      if (next.size === pairs.length) onResult(errors === 0);
    } else {
      setErrors((n) => n + 1);
      setFlash({ l, r });
      setTimeout(() => { setFlash(null); setSelLeft(null); setSelRight(null); }, 300);
    }
  };

  const pickLeft = (i: number) => {
    if (done || lockedLeft.has(i) || flash) return;
    setSelLeft(i); tryPair(i, selRight);
  };
  const pickRight = (origIdx: number) => {
    if (done || lockedLeft.has(origIdx) || flash) return;
    setSelRight(origIdx); tryPair(selLeft, origIdx);
  };

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{prompt}</p>
      <div className="tr-match">
        <div className="tr-match__col">
          {pairs.map((p, i) => (
            <button key={i} type="button" disabled={lockedLeft.has(i) || done}
              className={`tr-match__item${lockedLeft.has(i) ? ' tr-match__item--ok' : ''}${selLeft === i ? ' tr-match__item--sel' : ''}${flash?.l === i ? ' tr-match__item--err' : ''}`}
              onClick={() => pickLeft(i)}>{p[0]}</button>
          ))}
        </div>
        <div className="tr-match__col">
          {rightOrder.map((orig) => (
            <button key={orig} type="button" disabled={lockedLeft.has(orig) || done}
              className={`tr-match__item${lockedLeft.has(orig) ? ' tr-match__item--ok' : ''}${selRight === orig ? ' tr-match__item--sel' : ''}${flash?.r === orig ? ' tr-match__item--err' : ''}`}
              onClick={() => pickRight(orig)}>{pairs[orig][1]}</button>
          ))}
        </div>
      </div>
      <p className="tr-ex__hint">Toque num item de cada coluna pra formar o par · {lockedLeft.size} de {pairs.length} pares</p>
    </div>
  );
}

function OrderSteps({ steps, prompt, onResult }:
  { steps: string[]; prompt: string; onResult: (c: boolean) => void }) {
  const [order, setOrder] = useState<string[]>(() => shuffled(steps.length).map((i) => steps[i]));
  const [answered, setAnswered] = useState(false);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (answered || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{prompt}</p>
      <ol className="tr-steps">
        {order.map((s, i) => (
          <li key={s} className="tr-steps__item">
            <span>{s}</span>
            <span className="tr-steps__ctrl">
              <button type="button" disabled={answered} onClick={() => move(i, -1)} aria-label="Subir">↑</button>
              <button type="button" disabled={answered} onClick={() => move(i, 1)} aria-label="Descer">↓</button>
            </span>
          </li>
        ))}
      </ol>
      {!answered && (
        <button type="button" className="tr-btn tr-btn--full"
          onClick={() => { setAnswered(true); onResult(checkSteps(steps, order)); }}>Verificar</button>
      )}
    </div>
  );
}
