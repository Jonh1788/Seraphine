import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getLesson, completeLesson, type Lesson, type CompleteResult } from './api';
import { ExerciseMCQ } from './exercises/ExerciseMCQ';
import { ExerciseCloze } from './exercises/ExerciseCloze';
import { ExerciseType } from './exercises/ExerciseType';
import { ExerciseMatch } from './exercises/ExerciseMatch';
import { XIcon, BookmarkIcon, SparkleIcon, TrophyIcon, ZapIcon, FlameIcon, FlashcardIcon, CheckIcon } from '../icons/Icons';

type Screen = 'loading' | 'error' | 'teach' | 'exercise' | 'result';

const EYEBROW: Record<string, string> = {
  mcq: 'Múltipla escolha', cloze: 'Complete a frase', type: 'Digite a resposta', match: 'Relacionar',
};

export function LessonPlayer({ lessonId, onDone, onNext }:
  { lessonId: string; onDone: () => void; onNext?: () => void }) {
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

  if (screen === 'loading') return <div className="tr-player">Carregando…</div>;
  if (screen === 'error' || !lesson) return (
    <div className="tr-player">
      <p>Não deu pra abrir a lição.</p>
      <button type="button" className="tr-btn" onClick={onDone}>Voltar</button>
    </div>
  );

  const total = lesson.exercises.length;
  const frameProgress = screen === 'teach' ? 0 : screen === 'result' ? 100 : (idx / Math.max(total, 1)) * 100;

  const frame = (
    <div className="tr-player__top">
      <button type="button" className="tr-player__x" onClick={onDone} aria-label="Sair"><XIcon size={18} /></button>
      <div className="tr-progress tr-player__progress">
        <span className="tr-progress__bar" style={{ width: `${frameProgress}%` }} />
      </div>
      {screen === 'teach' && (
        <span className="tr-pill tr-pill--accent"><BookmarkIcon size={13} />Teoria</span>
      )}
      {screen === 'exercise' && <span className="tr-player__count">{idx + 1}/{total}</span>}
    </div>
  );

  if (screen === 'teach') {
    const hasEx = total > 0;
    return (
      <div className="tr-player">
        {frame}
        <p className="tr-eyebrow">Teoria da lição</p>
        <h2 className="tr-player__title">{lesson.title}</h2>
        <div className="tr-concept">
          <Markdown remarkPlugins={[remarkGfm]}>{lesson.concept_md}</Markdown>
        </div>
        <div className="tr-tip">
          <span className="tr-tip__icon"><SparkleIcon size={16} /></span>
          <p>Dica da Seraphine: leia o exemplo com calma — os exercícios usam exatamente esses conceitos.</p>
        </div>
        <button type="button" className="tr-btn tr-btn--full" onClick={() => setScreen(hasEx ? 'exercise' : 'result')}>
          {hasEx ? 'Começar exercícios' : 'Concluir'}
        </button>
      </div>
    );
  }

  if (screen === 'result') {
    return <ResultScreen lessonId={lessonId} lessonTitle={lesson.title} correct={correct} total={total}
      result={result} setResult={setResult} onDone={onDone} onNext={onNext} />;
  }

  const ex = lesson.exercises[idx];
  const onResult = (c: boolean) => { setAnswered(true); setLastCorrect(c); if (c) setCorrect((n) => n + 1); };
  const next = () => {
    setAnswered(false);
    if (idx + 1 < total) setIdx(idx + 1);
    else setScreen('result');
  };
  return (
    <div className="tr-player">
      {frame}
      <div key={ex.id} className="tr-ex-slot">
        <p className="tr-eyebrow">{EYEBROW[ex.type] ?? 'Exercício'}</p>
        {ex.type === 'mcq' && <ExerciseMCQ exercise={ex} onResult={onResult} />}
        {ex.type === 'cloze' && <ExerciseCloze exercise={ex} onResult={onResult} />}
        {ex.type === 'type' && <ExerciseType exercise={ex} onResult={onResult} />}
        {ex.type === 'match' && <ExerciseMatch exercise={ex} onResult={onResult} />}
      </div>
      {answered && (
        <div className={`tr-feedback tr-feedback--${lastCorrect ? 'ok' : 'no'}`}>
          <span className="tr-feedback__dot"><CheckIcon size={16} /></span>
          <div>
            <p className="tr-feedback__title">{lastCorrect ? 'Certo!' : 'Quase…'}</p>
            {ex.explanation && <p className="tr-feedback__expl">{ex.explanation}</p>}
          </div>
          <div className="tr-feedback__actions">
            <button type="button" className={`tr-btn${lastCorrect ? ' tr-btn--green' : ''}`} onClick={next}>Continuar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultScreen({ lessonId, lessonTitle, correct, total, result, setResult, onDone, onNext }: {
  lessonId: string; lessonTitle: string; correct: number; total: number;
  result: CompleteResult | null; setResult: (r: CompleteResult) => void;
  onDone: () => void; onNext?: () => void;
}) {
  const [saving, setSaving] = useState(true);
  useEffect(() => {
    let ok = true;
    completeLesson(lessonId, correct)
      .then((r) => { if (ok) { setResult(r); setSaving(false); } })
      .catch(() => { if (ok) setSaving(false); });
  }, [lessonId, correct, setResult]);
  return (
    <div className="tr-player tr-result">
      <span className="tr-result__trophy"><TrophyIcon size={48} /></span>
      <h2 className="tr-player__title">Lição concluída!</h2>
      <p className="tr-result__sub">{lessonTitle} · {correct}/{total} certos</p>
      {saving ? <p className="tr-result__saving">Salvando…</p> : result && (
        <div className="tr-result__stats">
          <div className="tr-stat tr-stat--xp"><ZapIcon size={18} /><strong>+{result.xp_gained}</strong><span>XP</span></div>
          <div className="tr-stat tr-stat--streak"><FlameIcon size={18} /><strong>{result.streak_count}</strong><span>dias</span></div>
          {result.seeded_cards > 0 && (
            <div className="tr-stat tr-stat--cards"><FlashcardIcon size={18} /><strong>{result.seeded_cards}</strong><span>p/ revisão</span></div>
          )}
        </div>
      )}
      <div className="tr-result__actions">
        <button type="button" className="tr-btn tr-btn--ghost" onClick={onDone}>Voltar à trilha</button>
        {onNext && <button type="button" className="tr-btn" onClick={onNext}>Próxima lição</button>}
      </div>
    </div>
  );
}
