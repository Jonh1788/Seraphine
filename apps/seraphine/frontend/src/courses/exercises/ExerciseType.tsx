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
    <div className="trilha-ex">
      <p className="trilha-ex__prompt">{exercise.prompt}</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input className="trilha-input" value={value} disabled={state !== 'idle'}
          onChange={(e) => setValue(e.target.value)} placeholder="Sua resposta…" />
        {state === 'idle' && <button type="submit" className="trilha-check">Verificar</button>}
      </form>
      {state === 'checking' && <p className="trilha-ex__hint">Verificando…</p>}
      {state === 'done' && <p className="trilha-ex__hint">{feedback}</p>}
    </div>
  );
}
