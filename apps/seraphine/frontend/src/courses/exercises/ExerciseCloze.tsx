import { useState } from 'react';
import type { Exercise } from '../api';
import { checkCloze } from './grading';

export function ExerciseCloze({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [value, setValue] = useState('');        // conteúdo da lacuna
  const [answered, setAnswered] = useState(false);
  const text = exercise.payload.text ?? '';
  const options = exercise.payload.options;
  const [before, after] = text.split('___');

  const verify = () => {
    if (answered || !value) return;
    setAnswered(true);
    onResult(checkCloze(exercise.payload.answers, value));
  };

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      <div className="tr-cloze__sentence">
        {before}
        {value
          ? <button type="button" className="tr-cloze__chip tr-cloze__chip--placed" disabled={answered}
              onClick={() => { if (!answered) setValue(''); }}>{value}</button>
          : <span className="tr-cloze__blank" />}
        {after}
      </div>
      {options && options.length ? (
        <div className="tr-cloze__bank">
          {options.map((opt, i) => (
            <button key={i} type="button" disabled={answered || value === opt}
              className={`tr-cloze__chip${value === opt ? ' tr-cloze__chip--used' : ''}`}
              onClick={() => { if (!answered) setValue(opt); }}>{opt}</button>
          ))}
        </div>
      ) : (
        <input className="tr-type__input" value={value} disabled={answered}
          onChange={(e) => setValue(e.target.value)} placeholder="Digite…"
          onKeyDown={(e) => { if (e.key === 'Enter') verify(); }} />
      )}
      {!answered && (
        <button type="button" className="tr-btn tr-btn--full" disabled={!value} onClick={verify}>Verificar</button>
      )}
    </div>
  );
}
