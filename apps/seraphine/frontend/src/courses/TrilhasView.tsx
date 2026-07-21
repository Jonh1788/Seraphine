import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftIcon, ZapIcon, FlameIcon, SparkleIcon, TrilhasIcon, CheckIcon, LinkIcon, CommandIcon } from '../icons/Icons';
import {
  listCourses, createCourse, getCourse, getStats, listModels,
  type CourseSummary, type Course, type Stats, type TutorModel,
} from './api';
import { CourseMap } from './CourseMap';
import { LessonPlayer } from './LessonPlayer';
import './obsidian.css';

type Mode = { kind: 'list' } | { kind: 'map'; courseId: string } | { kind: 'lesson'; courseId: string; lessonId: string };

export function TrilhasView({ onBack }: { onBack: () => void }) {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [topic, setTopic] = useState('');
  const [codeMode, setCodeMode] = useState(false);
  const [code, setCode] = useState('');
  const [focus, setFocus] = useState<'math' | 'code'>('math');
  const [tutorModel, setTutorModel] = useState('');
  const [models, setModels] = useState<TutorModel[]>([]);
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [course, setCourse] = useState<Course | null>(null);

  const refreshList = useCallback(async () => {
    const [cs, st] = await Promise.all([listCourses(), getStats()]);
    setCourses(cs); setStats(st);
  }, []);

  useEffect(() => { refreshList().catch(() => {}); }, [refreshList]);

  useEffect(() => { listModels().then(setModels).catch(() => {}); }, []);

  // poll enquanto algum curso está 'generating'
  useEffect(() => {
    if (!courses.some((c) => c.status === 'generating')) return;
    const t = setInterval(() => { refreshList().catch(() => {}); }, 4000);
    return () => clearInterval(t);
  }, [courses, refreshList]);

  const loadCourse = useCallback(async (courseId: string) => {
    setCourse(await getCourse(courseId));
    setMode({ kind: 'map', courseId });
  }, []);

  const create = async () => {
    if ((codeMode ? !code.trim() : !topic.trim()) || creating) return;
    setCreating(true);
    try {
      await createCourse({
        topic: topic.trim() || undefined,
        code: codeMode ? code : undefined,
        focus,
        tutorModel: tutorModel || undefined,
      });
      setTopic(''); setCode('');
      await refreshList();
    }
    finally { setCreating(false); }
  };

  if (mode.kind === 'lesson') {
    return (
      <div className="tr-view">
        <LessonPlayer lessonId={mode.lessonId}
          onDone={() => loadCourse(mode.courseId)}
          onNext={async () => {
            const c = await getCourse(mode.courseId);
            setCourse(c);
            const nxt = c.lessons.find((l) => l.lock === 'unlocked');
            if (nxt) setMode({ kind: 'lesson', courseId: mode.courseId, lessonId: nxt.id });
            else setMode({ kind: 'map', courseId: mode.courseId });
          }} />
      </div>
    );
  }

  if (mode.kind === 'map' && course) {
    return (
      <div className="tr-view">
        <header className="tr-head">
          <button type="button" className="tr-back" onClick={() => { setMode({ kind: 'list' }); refreshList(); }}>
            <ArrowLeftIcon size={18} /><span>Trilhas</span>
          </button>
        </header>
        <CourseMap course={course}
          onOpenLesson={(lessonId) => setMode({ kind: 'lesson', courseId: mode.courseId, lessonId })} />
      </div>
    );
  }

  // list
  return (
    <div className="tr-view">
      <header className="tr-head">
        <button type="button" className="tr-back" onClick={onBack}>
          <ArrowLeftIcon size={18} /><span>Voltar</span>
        </button>
        <div className="tr-head__text">
          <h2 className="tr-head__title">Trilhas</h2>
          <p className="tr-head__sub">Aprenda qualquer coisa, uma lição por vez</p>
        </div>
        {stats && (
          <div className="tr-head__stats">
            <span className="tr-pill tr-pill--xp"><ZapIcon size={14} />{stats.xp_total.toLocaleString('pt-BR')} XP</span>
            <span className="tr-pill tr-pill--streak"><FlameIcon size={14} />{stats.streak_count} dias</span>
          </div>
        )}
      </header>

      <div className={`tr-create${codeMode ? ' tr-create--code' : ''}`}>
        <span className="tr-create__icon"><SparkleIcon size={20} /></span>
        <input className="tr-create__input" value={topic} onChange={(e) => setTopic(e.target.value)}
          placeholder={codeMode ? 'Título (opcional)' : 'Aprender sobre… (tópico ou link)'}
          onKeyDown={(e) => { if (e.key === 'Enter' && !codeMode) create(); }} />
        {codeMode && (
          <>
            <textarea className="tr-create__code" value={code} onChange={(e) => setCode(e.target.value)}
              rows={10} placeholder="Cole o código aqui…" />
            <div className="tr-create__focus">
              <label>
                <input type="radio" name="tr-focus" checked={focus === 'math'} onChange={() => setFocus('math')} />
                Matemática do código
              </label>
              <label>
                <input type="radio" name="tr-focus" checked={focus === 'code'} onChange={() => setFocus('code')} />
                Entender o código
              </label>
            </div>
          </>
        )}
        <button type="button" className={`tr-create__toggle${codeMode ? ' tr-create__toggle--on' : ''}`}
          onClick={() => setCodeMode((v) => !v)}>
          <CommandIcon size={13} /> colar código
        </button>
        <select className="tr-create__tutor" value={tutorModel} onChange={(e) => setTutorModel(e.target.value)}>
          <option value="">Tutor: Padrão</option>
          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <button type="button" className="tr-btn" disabled={creating || (codeMode ? !code.trim() : !topic.trim())} onClick={create}>
          {creating ? 'Criando…' : 'Criar trilha'}
        </button>
      </div>

      <ul className="tr-grid">
        {courses.map((c) => {
          const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
          const isDone = c.status === 'ready' && c.total > 0 && c.done === c.total;
          return (
            <li key={c.id}>
              <button type="button" className={`tr-card${isDone ? ' tr-card--done' : ''}`}
                disabled={c.status !== 'ready'} onClick={() => loadCourse(c.id)}>
                <span className="tr-card__icon"><TrilhasIcon size={20} /></span>
                <span className={`tr-card__status tr-card__status--${c.status === 'generating' ? 'gen' : isDone ? 'done' : 'active'}`}>
                  {c.status === 'generating' ? (<><span className="tr-card__blink" />gerando…</>)
                    : c.status === 'failed' ? 'falhou'
                    : isDone ? (<><CheckIcon size={12} />concluída</>) : 'em andamento'}
                </span>
                <span className="tr-card__title">{c.title || c.topic}</span>
                {c.source_ref && <span className="tr-card__link"><LinkIcon size={11} />link</span>}
                <span className="tr-card__meta">
                  {c.status === 'generating' ? 'A Seraphine está montando as lições' : `${c.done}/${c.total} lições`}
                </span>
                <span className="tr-progress">
                  {c.status === 'generating'
                    ? <span className="tr-progress__bar tr-progress__bar--shimmer" />
                    : <span className={`tr-progress__bar${pct === 100 ? ' tr-progress__bar--green' : ''}`} style={{ width: `${pct}%` }} />}
                </span>
              </button>
            </li>
          );
        })}
        {!courses.length && <li className="tr-empty">Crie sua primeira trilha.</li>}
      </ul>
    </div>
  );
}
