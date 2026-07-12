import { useState } from 'react';
import type { Exercise } from '../api';
import { checkMCQ } from './grading';

export function ExerciseMCQ({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const options = exercise.payload.options ?? [];
  const answered = chosen !== null;
  return (
    <div className="trilha-ex">
      <p className="trilha-ex__prompt">{exercise.prompt}</p>
      <div className="trilha-ex__options">
        {options.map((opt, i) => {
          const state = !answered ? '' :
            i === exercise.payload.answer_idx ? 'correct' :
            i === chosen ? 'wrong' : '';
          return (
            <button key={i} type="button" disabled={answered}
              className={`trilha-opt trilha-opt--${state}`}
              onClick={() => { setChosen(i); onResult(checkMCQ(exercise.payload.answer_idx, i)); }}>
              {opt}
            </button>
          );
        })}
      </div>
    </div>
  );
}
