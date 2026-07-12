import { useEffect, useState } from 'react';
import { getLesson, completeLesson, type Lesson, type CompleteResult } from './api';
import { ExerciseMCQ } from './exercises/ExerciseMCQ';
import { ExerciseCloze } from './exercises/ExerciseCloze';
import { ExerciseType } from './exercises/ExerciseType';
import { ExerciseMatch } from './exercises/ExerciseMatch';

type Screen = 'loading' | 'error' | 'teach' | 'exercise' | 'result';

export function LessonPlayer({ lessonId, onDone }: { lessonId: string; onDone: () => void }) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [screen, setScreen] = useState<Screen>('loading');
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [answered, setAnswered] = useState(false);
  const [lastCorrect, setLastCorrect] = useState(false);
  const [result, setResult] = useState<CompleteResult | null>(null);

  useEffect(() => {
    let ok = true;
    getLesson(lessonId)
      .then((l) => { if (ok) { setLesson(l); setScreen('teach'); } })
      .catch(() => { if (ok) setScreen('error'); });
    return () => { ok = false; };
  }, [lessonId]);

  if (screen === 'loading') return <div className="trilha-player">Carregando…</div>;
  if (screen === 'error' || !lesson) return (
    <div className="trilha-player">
      <p>Não deu pra abrir a lição.</p>
      <button type="button" className="trilha-check" onClick={onDone}>Voltar</button>
    </div>
  );

  if (screen === 'teach') {
    const hasEx = lesson.exercises.length > 0;
    return (
      <div className="trilha-player">
        <h2 className="trilha-player__title">{lesson.title}</h2>
        <div className="trilha-concept">{lesson.concept_md}</div>
        <button type="button" className="trilha-check"
          onClick={() => setScreen(hasEx ? 'exercise' : 'result')}>
          {hasEx ? 'Começar exercícios' : 'Concluir'}
        </button>
      </div>
    );
  }

  if (screen === 'result') {
    return <ResultScreen lessonId={lessonId} correct={correct} total={lesson.exercises.length}
      result={result} setResult={setResult} onDone={onDone} />;
  }

  // screen === 'exercise'
  const ex = lesson.exercises[idx];
  const onResult = (c: boolean) => { setAnswered(true); setLastCorrect(c); if (c) setCorrect((n) => n + 1); };
  const next = () => {
    setAnswered(false);
    if (idx + 1 < lesson.exercises.length) setIdx(idx + 1);
    else setScreen('result');
  };
  return (
    <div className="trilha-player">
      <div className="trilha-progress">
        <div className="trilha-progress__bar" style={{ width: `${(idx / lesson.exercises.length) * 100}%` }} />
      </div>
      <div key={ex.id} className="trilha-ex-slot">
        {ex.type === 'mcq' && <ExerciseMCQ exercise={ex} onResult={onResult} />}
        {ex.type === 'cloze' && <ExerciseCloze exercise={ex} onResult={onResult} />}
        {ex.type === 'type' && <ExerciseType exercise={ex} onResult={onResult} />}
        {ex.type === 'match' && <ExerciseMatch exercise={ex} onResult={onResult} />}
      </div>
      {answered && (
        <div className={`trilha-feedback trilha-feedback--${lastCorrect ? 'ok' : 'no'}`}>
          <span>{lastCorrect ? 'Certo!' : 'Quase…'}</span>
          {ex.explanation && <p>{ex.explanation}</p>}
          <button type="button" className="trilha-check" onClick={next}>Continuar</button>
        </div>
      )}
    </div>
  );
}

function ResultScreen({ lessonId, correct, total, result, setResult, onDone }: {
  lessonId: string; correct: number; total: number;
  result: CompleteResult | null; setResult: (r: CompleteResult) => void; onDone: () => void;
}) {
  const [saving, setSaving] = useState(true);
  useEffect(() => {
    let ok = true;
    completeLesson(lessonId, correct)
      .then((r) => { if (ok) { setResult(r); setSaving(false); } })
      .catch(() => { if (ok) setSaving(false); });
  }, [lessonId, correct, setResult]);
  return (
    <div className="trilha-player trilha-result">
      <h2 className="trilha-player__title">Lição concluída</h2>
      <p className="trilha-result__score">{correct}/{total} certos</p>
      {saving ? <p>Salvando…</p> : result && (
        <div className="trilha-result__stats">
          <span className="trilha-badge">+{result.xp_gained} XP</span>
          <span className="trilha-badge">Streak: {result.streak_count}</span>
          {result.seeded_cards > 0 && <span className="trilha-badge">{result.seeded_cards} p/ revisão</span>}
        </div>
      )}
      <button type="button" className="trilha-check" onClick={onDone}>Voltar à trilha</button>
    </div>
  );
}
