import { useEffect, useState, useCallback } from 'react';
import { ArrowLeftIcon } from '../icons/Icons';
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
    <div className="trilha-view">
      <header className="trilha-view__header">
        <button type="button" className="trilha-back" onClick={onBack}>
          <ArrowLeftIcon size={18} /><span>Voltar</span>
        </button>
        {stats && (
          <div className="trilha-stats">
            <span className="trilha-badge">{stats.xp_total} XP</span>
            <span className="trilha-badge">Streak: {stats.streak_count}</span>
          </div>
        )}
      </header>
      <div className="trilha-create">
        <input className="trilha-input" value={topic} onChange={(e) => setTopic(e.target.value)}
          placeholder="Aprender sobre… (ex: Redes neurais)"
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button type="button" className="trilha-check" disabled={creating || !topic.trim()} onClick={create}>
          {creating ? 'Criando…' : 'Criar trilha'}
        </button>
      </div>
      <ul className="trilha-list">
        {courses.map((c) => (
          <li key={c.id}>
            <button type="button" className="trilha-card"
              disabled={c.status !== 'ready'}
              onClick={() => loadCourse(c.id)}>
              <span className="trilha-card__title">{c.title || c.topic}</span>
              <span className="trilha-card__meta">
                {c.status === 'generating' ? 'Gerando…' :
                 c.status === 'failed' ? 'Falhou' :
                 `${c.done}/${c.total} lições`}
              </span>
            </button>
          </li>
        ))}
        {!courses.length && <li className="trilha-empty">Crie sua primeira trilha.</li>}
      </ul>
    </div>
  );
}
