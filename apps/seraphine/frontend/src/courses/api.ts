import { API_BASE } from '../api';

export interface CourseSummary {
  id: string;
  topic: string;
  title: string | null;
  status: 'generating' | 'ready' | 'failed';
  total: number;
  done: number;
}

export interface LessonNode {
  id: string;
  order_idx: number;
  title: string;
  status: 'ok' | 'incomplete';
  lock: 'locked' | 'unlocked' | 'done';
}

export interface Course {
  id: string;
  topic: string;
  title: string | null;
  description: string | null;
  status: string;
  lessons: LessonNode[];
}

export type ExerciseType = 'mcq' | 'cloze' | 'type' | 'match';

export interface Exercise {
  id: string;
  order_idx: number;
  type: ExerciseType;
  prompt: string;
  // payload varia por tipo; para 'type' vem vazio (gabarito fica no servidor)
  payload: {
    options?: string[];
    answer_idx?: number;
    text?: string;
    answers?: string[];
    pairs?: [string, string][];
    steps?: string[];
  };
  explanation: string | null;
}

export interface Lesson {
  id: string;
  course_id: string;
  title: string;
  concept_md: string;
  exercises: Exercise[];
}

export interface Stats {
  xp_total: number;
  streak_count: number;
  streak_last_day: string | null;
}

export interface GradeResult {
  correct: boolean;
  feedback: string;
}

export interface CompleteResult {
  xp_gained: number;
  xp_total: number;
  streak_count: number;
  seeded_cards: number;
  already_done: boolean;
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export async function createCourse(topic: string): Promise<{ course_id: string; status: string }> {
  return j(await fetch(`${API_BASE}/courses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic }),
  }));
}

export async function listCourses(): Promise<CourseSummary[]> {
  const data = await j<{ courses: CourseSummary[] }>(await fetch(`${API_BASE}/courses`));
  return data.courses;
}

export async function getCourse(id: string): Promise<Course> {
  return j(await fetch(`${API_BASE}/courses/${id}`));
}

export async function getLesson(id: string): Promise<Lesson> {
  return j(await fetch(`${API_BASE}/courses/lessons/${id}`));
}

export async function gradeType(exerciseId: string, answer: string): Promise<GradeResult> {
  return j(await fetch(`${API_BASE}/courses/answer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ exercise_id: exerciseId, answer }),
  }));
}

export async function completeLesson(lessonId: string, correct: number): Promise<CompleteResult> {
  return j(await fetch(`${API_BASE}/courses/lessons/${lessonId}/complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ correct }),
  }));
}

export async function getStats(): Promise<Stats> {
  return j(await fetch(`${API_BASE}/courses/stats`));
}
