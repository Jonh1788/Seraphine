import { API_BASE } from '../api';

export interface CourseSummary {
  id: string;
  topic: string;
  title: string | null;
  status: 'generating' | 'ready' | 'failed';
  total: number;
  done: number;
  source_ref?: string | null;
}

export interface TutorModel { id: string; name: string }

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

export type ExerciseType = 'mcq' | 'cloze' | 'type' | 'match' | 'graph';

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
    expr?: string;
    x?: { var: string; min: number; max: number };
    params?: { name: string; min: number; max: number; default: number }[];
    target?: { param: string; value: number; tol: number };
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

export interface CreateCourseInput {
  topic?: string;
  code?: string;
  focus?: 'math' | 'code';
  tutorModel?: string;
}

export async function createCourse(input: CreateCourseInput): Promise<{ course_id: string; status: string }> {
  const body: Record<string, unknown> = {};
  if (input.topic) body.topic = input.topic;
  if (input.code) { body.code = input.code; body.focus = input.focus ?? 'math'; }
  if (input.tutorModel) body.tutor_model = input.tutorModel;
  return j(await fetch(`${API_BASE}/courses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

export async function listModels(): Promise<TutorModel[]> {
  const data = await j<{ models: TutorModel[] }>(await fetch(`${API_BASE}/courses/models`));
  return data.models;
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
