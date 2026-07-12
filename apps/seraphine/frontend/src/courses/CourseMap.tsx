import type { Course, LessonNode } from './api';
import { PlayIcon, CheckIcon, LockIcon, TrophyIcon, TrilhasIcon } from '../icons/Icons';

const LANE_X = [0, 90, 0, -90]; // zigue-zague determinístico (px do centro)
const STEP_Y = 110;             // distância vertical entre nós
const TOP = 40;

function nodeX(i: number) { return 260 + LANE_X[i % 4]; } // coluna de 520px → centro 260
function nodeY(i: number) { return TOP + i * STEP_Y; }

function pathD(from: number, to: number) {
  // curva suave entre nós consecutivos [from..to]
  let d = `M ${nodeX(from)} ${nodeY(from)}`;
  for (let i = from + 1; i <= to; i++) {
    const x0 = nodeX(i - 1), y0 = nodeY(i - 1), x1 = nodeX(i), y1 = nodeY(i);
    const my = (y0 + y1) / 2;
    d += ` C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`;
  }
  return d;
}

export function CourseMap({ course, onOpenLesson }:
  { course: Course; onOpenLesson: (lessonId: string) => void }) {
  const lessons = course.lessons;
  const doneCount = lessons.filter((l) => l.lock === 'done').length;
  const next = lessons.find((l) => l.lock === 'unlocked');
  const total = lessons.length + 1; // +1 = nó-troféu final
  const height = TOP + total * STEP_Y;
  // trecho percorrido = até o último done contíguo (ou até o nó next)
  const solidUntil = Math.max(doneCount, 0);

  return (
    <div className="tr-map">
      <div className="tr-map__main">
        <header className="tr-map__head">
          <span className="tr-map__icon"><TrilhasIcon size={22} /></span>
          <div>
            <h2 className="tr-map__title">{course.title || course.topic}</h2>
            <p className="tr-map__sub">{doneCount} de {lessons.length} lições{next ? ' · continue de onde parou' : ''}</p>
          </div>
        </header>
        <div className="tr-progress tr-map__progress">
          <span className="tr-progress__bar" style={{ width: `${lessons.length ? (doneCount / lessons.length) * 100 : 0}%` }} />
        </div>

        <div className="tr-map__path" style={{ height }}>
          <svg className="tr-map__svg" width="520" height={height} aria-hidden="true">
            {solidUntil > 0 && (
              <path d={pathD(0, Math.min(solidUntil, total - 1))} fill="none"
                stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
            )}
            <path d={pathD(Math.min(solidUntil, total - 1), total - 1)} fill="none"
              stroke="rgba(154,147,255,.35)" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 9" />
          </svg>
          {lessons.map((l, i) => <MapNode key={l.id} lesson={l} i={i} onOpen={onOpenLesson} />)}
          {/* nó final: troféu */}
          <div className="tr-node tr-node--end" style={{ left: nodeX(lessons.length), top: nodeY(lessons.length) }}>
            <span className="tr-node__circle tr-node__circle--end"><TrophyIcon size={24} /></span>
            <span className="tr-node__label tr-node__label--faint">Fim da trilha</span>
          </div>
        </div>
      </div>

      <aside className="tr-map__side">
        {next && (
          <div className="tr-side-card">
            <span className="tr-eyebrow">Próxima lição</span>
            <p className="tr-side-card__title">{next.title}</p>
            <p className="tr-side-card__meta">Conceito + exercícios</p>
            <button type="button" className="tr-btn tr-btn--full" onClick={() => onOpenLesson(next.id)}>Continuar</button>
          </div>
        )}
        <div className="tr-side-card tr-side-card--muted">
          <p className="tr-side-card__meta">Ao concluir uma lição, os conceitos viram <strong>flashcards</strong> automaticamente pra revisão.</p>
        </div>
      </aside>
    </div>
  );
}

function MapNode({ lesson, i, onOpen }: { lesson: LessonNode; i: number; onOpen: (id: string) => void }) {
  const { lock } = lesson;
  return (
    <div className="tr-node" style={{ left: nodeX(i), top: nodeY(i) }}>
      {lock === 'unlocked' && <span className="tr-node__tooltip">COMEÇAR</span>}
      <button type="button" disabled={lock === 'locked'}
        className={`tr-node__circle tr-node__circle--${lock}`}
        onClick={() => onOpen(lesson.id)} aria-label={lesson.title}>
        {lock === 'done' ? <CheckIcon size={22} /> : lock === 'unlocked' ? <PlayIcon size={24} /> : <LockIcon size={20} />}
      </button>
      <span className={`tr-node__label${lock === 'locked' ? ' tr-node__label--faint' : ''}`}>{lesson.title}</span>
    </div>
  );
}
