import { useState } from 'react';
import type { Exercise } from '../api';
import { gradeType } from '../api';

export function ExerciseType({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<'idle' | 'checking' | 'done'>('idle');
  const [feedback, setFeedback] = useState('');
  const submit = async () => {
    if (state !== 'idle' || !value.trim()) return;
    setState('checking');
    try {
      const r = await gradeType(exercise.id, value);
      setFeedback(r.feedback);
      setState('done');
      onResult(r.correct);
    } catch {
      setFeedback('Não deu pra corrigir agora.');
      setState('done');
      onResult(false);
    }
  };
  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input className="tr-type__input" value={value} disabled={state !== 'idle'}
          onChange={(e) => setValue(e.target.value)} placeholder="Sua resposta…" autoFocus />
        {state === 'idle' && (
          <button type="submit" className="tr-btn tr-btn--full tr-type__submit" disabled={!value.trim()}>Verificar</button>
        )}
      </form>
      {state === 'checking' && <p className="tr-ex__hint">Verificando…</p>}
      {state === 'done' && <p className="tr-ex__hint">{feedback}</p>}
    </div>
  );
}
