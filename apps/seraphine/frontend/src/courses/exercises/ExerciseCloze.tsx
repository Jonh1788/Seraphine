import { useState } from 'react';
import type { Exercise } from '../api';
import { checkCloze } from './grading';

export function ExerciseCloze({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [value, setValue] = useState('');
  const [answered, setAnswered] = useState(false);
  const text = exercise.payload.text ?? '';
  const options = exercise.payload.options;
  const [before, after] = text.split('___');
  const submit = (v: string) => { setValue(v); setAnswered(true); onResult(checkCloze(exercise.payload.answers, v)); };
  return (
    <div className="trilha-ex">
      <p className="trilha-ex__prompt">{exercise.prompt}</p>
      <p className="trilha-cloze">{before}<strong>{answered ? value || '—' : '____'}</strong>{after}</p>
      {options && options.length ? (
        <div className="trilha-ex__options">
          {options.map((opt, i) => (
            <button key={i} type="button" disabled={answered}
              className="trilha-opt" onClick={() => submit(opt)}>{opt}</button>
          ))}
        </div>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); if (!answered) submit(value); }}>
          <input className="trilha-input" value={value} disabled={answered}
            onChange={(e) => setValue(e.target.value)} placeholder="Digite…" />
        </form>
      )}
    </div>
  );
}
