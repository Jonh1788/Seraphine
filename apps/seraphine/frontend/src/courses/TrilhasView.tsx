import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftIcon, ZapIcon, FlameIcon, SparkleIcon, TrilhasIcon, CheckIcon } from '../icons/Icons';
import {
  listCourses, createCourse, getCourse, getStats,
  type CourseSummary, type Course, type Stats,
} from './api';
import { CourseMap } from './CourseMap';
import { LessonPlayer } from './LessonPlayer';
import './obsidian.css';

type Mode = { kind: 'list' } | { kind: 'map'; courseId: string } | { kind: 'lesson'; courseId: string; lessonId: string };

export function TrilhasView({ onBack }: { onBack: () => void }) {
  const [courses, setCourses] = useState<CourseSummary[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [topic, setTopic] = useState('');
  const [creating, setCreating] = useState(false);
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  const [course, setCourse] = useState<Course | null>(null);

  const refreshList = useCallback(async () => {
    const [cs, st] = await Promise.all([listCourses(), getStats()]);
    setCourses(cs); setStats(st);
  }, []);

  useEffect(() => { refreshList().catch(() => {}); }, [refreshList]);

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
    if (!topic.trim() || creating) return;
    setCreating(true);
    try { await createCourse(topic.trim()); setTopic(''); await refreshList(); }
    finally { setCreating(false); }
  };

  if (mode.kind === 'lesson') {
    return (
      <div className="trilha-view">
        <LessonPlayer lessonId={mode.lessonId}
          onDone={() => loadCourse(mode.courseId)} />
      </div>
    );
  }

  if (mode.kind === 'map' && course) {
    return (
      <div className="trilha-view">
        <header className="trilha-view__header">
          <button type="button" className="trilha-back" onClick={() => { setMode({ kind: 'list' }); refreshList(); }}>
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

      <div className="tr-create">
        <span className="tr-create__icon"><SparkleIcon size={20} /></span>
        <input className="tr-create__input" value={topic} onChange={(e) => setTopic(e.target.value)}
          placeholder="Aprender sobre… (ex: Redes neurais)"
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button type="button" className="tr-btn" disabled={creating || !topic.trim()} onClick={create}>
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
