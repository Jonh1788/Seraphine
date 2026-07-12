import { useEffect, useState } from 'react';
import type { Exercise } from '../api';
import { checkMCQ } from './grading';

export function ExerciseMCQ({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const options = exercise.payload.options ?? [];
  const answered = chosen !== null;

  const pick = (i: number) => {
    if (answered || i < 0 || i >= options.length) return;
    setChosen(i);
    onResult(checkMCQ(exercise.payload.answer_idx, i));
  };

  useEffect(() => {
    if (answered) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) pick(n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, options.length]);

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      <div className="tr-opts">
        {options.map((opt, i) => {
          const state = !answered ? '' :
            i === exercise.payload.answer_idx ? 'correct' :
            i === chosen ? 'wrong' : '';
          return (
            <button key={i} type="button" disabled={answered}
              className={`tr-opt${state ? ` tr-opt--${state}` : ''}${chosen === i ? ' tr-opt--chosen' : ''}`}
              onClick={() => pick(i)}>
              <span className="tr-opt__num">{i + 1}</span>
              <span>{opt}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
