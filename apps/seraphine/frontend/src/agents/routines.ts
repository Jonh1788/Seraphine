/**
 * Pure helpers of phase 6b (routines): next occurrences of a schedule (mirrors contract section 1, in local time),
 * the one human date helper, the words of states, the form model and its validation. No React, no network.
 */
import { parseIsoUtc } from './lib';
import type { Routine, RoutineReport, RoutineRun, RoutineRunStatus, RoutineTrigger, Schedule, ScheduleKind } from './types';
import { ROUTINE_LIMITS } from './types';

const pad2 = (n: number): string => String(n).padStart(2, '0');

// ---------- dates ----------

const ZONE = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;
const DATE_ONLY_OR_NAIVE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?$/;

/**
 * Reads the `at` of a `once` schedule. A value with a zone is an instant; one without is the owner's local time
 * (schedule times are local, unlike the UTC timestamps of the rest of the API).
 */
export function parseScheduleAt(at: string | null | undefined): Date | null {
  if (!at || typeof at !== 'string') return null;
  const text = at.trim();
  if (DATE_ONLY_OR_NAIVE.test(text) && !ZONE.test(text)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(text);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0), 0, 0);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const WEEKDAY_SHORT = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'];

const startOfDay = (d: Date): number => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * The one way a routine time is shown, in the viewer's local time, 24 h: "hoje às 19:30", "amanhã às 08:00", "ontem às 19:30",
 * "seg., 16/11 às 08:00" (with the year when it is not this year). '' for a missing or invalid time.
 */
export function humanWhen(value: string | Date | null | undefined, now: Date = new Date()): string {
  const d = value instanceof Date ? (Number.isNaN(value.getTime()) ? null : value) : parseIsoUtc(value);
  if (!d) return '';
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  if (diff === 0) return `hoje às ${hm}`;
  if (diff === 1) return `amanhã às ${hm}`;
  if (diff === -1) return `ontem às ${hm}`;
  const date = `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}${d.getFullYear() === now.getFullYear() ? '' : `/${d.getFullYear()}`}`;
  return `${WEEKDAY_SHORT[d.getDay()]}, ${date} às ${hm}`;
}

// ---------- occurrences (contract section 1) ----------

/** 0 = Monday ... 6 = Sunday, as the contract numbers the days (`Date#getDay` has Sunday as 0). */
export function contractWeekday(d: Date): number {
  return (d.getDay() + 6) % 7;
}

function daysInMonth(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function splitTime(time: string): [number, number] | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h > 23 || min > 59 ? null : [h, min];
}

/**
 * The next `count` times of a schedule after `now`, local time (this is what the form previews; the backend computes the
 * real ones). `interval` counts from `now`, as the backend counts it from the creation or last change; `once` is its
 * own time while it is in the future.
 */
export function nextOccurrences(schedule: Schedule, now: Date = new Date(), count = 3): Date[] {
  if (schedule.kind === 'interval') {
    const every = schedule.every_minutes;
    if (!Number.isInteger(every) || every < 1) return [];
    return Array.from({ length: count }, (_, i) => new Date(now.getTime() + every * 60_000 * (i + 1)));
  }
  if (schedule.kind === 'once') {
    const at = parseScheduleAt(schedule.at);
    return at && at.getTime() > now.getTime() ? [at] : [];
  }
  const hm = splitTime(schedule.time);
  if (!hm) return [];
  const out: Date[] = [];
  // Monthly day 28 is at most 31 days apart; weekly one day at most 7: 400 days is far more than enough for 3 results.
  for (let i = 0; i < 400 && out.length < count; i += 1) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i, hm[0], hm[1], 0, 0);
    if (at.getTime() <= now.getTime()) continue;
    const dow = contractWeekday(at);
    let ok = false;
    if (schedule.kind === 'daily') ok = true;
    else if (schedule.kind === 'weekdays') ok = dow <= 4;
    else if (schedule.kind === 'weekly') ok = schedule.days.includes(dow);
    else ok = schedule.day === 'last' ? at.getDate() === daysInMonth(at) : at.getDate() === schedule.day;
    if (ok) out.push(at);
  }
  return out;
}

// ---------- words ----------

const DAY_NAMES = ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'];
export const DAY_CHIPS: { value: number; short: string; full: string }[] = [
  { value: 0, short: 'Seg', full: 'Segunda' },
  { value: 1, short: 'Ter', full: 'Terça' },
  { value: 2, short: 'Qua', full: 'Quarta' },
  { value: 3, short: 'Qui', full: 'Quinta' },
  { value: 4, short: 'Sex', full: 'Sexta' },
  { value: 5, short: 'Sáb', full: 'Sábado' },
  { value: 6, short: 'Dom', full: 'Domingo' },
];

function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
}

/** The pt-BR phrase of a schedule, worded like the backend's `schedule_text` (used when a draft arrives without one). */
export function scheduleText(schedule: Schedule): string {
  switch (schedule.kind) {
    case 'daily':
      return `Todo dia às ${schedule.time}`;
    case 'weekdays':
      return `Todo dia útil às ${schedule.time}`;
    case 'weekly': {
      const days = [...new Set(schedule.days)].sort((a, b) => a - b);
      if (days.length === 7) return `Todo dia às ${schedule.time}`;
      const weekendOnly = days.every((d) => d >= 5);
      return `${weekendOnly ? 'Todo' : 'Toda'} ${listWords(days.map((d) => DAY_NAMES[d]))} às ${schedule.time}`;
    }
    case 'monthly':
      return schedule.day === 'last' ? `Todo último dia do mês às ${schedule.time}` : `Todo dia ${schedule.day} às ${schedule.time}`;
    case 'interval': {
      const n = schedule.every_minutes;
      if (n >= 60 && n % 60 === 0) {
        const h = n / 60;
        return `A cada ${h} ${h === 1 ? 'hora' : 'horas'}`;
      }
      return `A cada ${n} minutos`;
    }
    default: {
      const at = parseScheduleAt(schedule.at);
      return at ? `Uma vez, em ${pad2(at.getDate())}/${pad2(at.getMonth() + 1)} às ${pad2(at.getHours())}:${pad2(at.getMinutes())}` : 'Uma vez';
    }
  }
}

/** The state of one time in the ledger (and the last state of a routine), in words. */
export const ROUTINE_RUN_WORDS: Record<RoutineRunStatus, string> = {
  running: 'rodando',
  reported: 'relatou',
  quiet: 'sem novidade',
  failed: 'falhou',
  cancelled: 'cancelada',
  skipped: 'pulada',
  missed: 'perdida (o PC estava desligado)',
};

export function routineRunWord(status: string | null | undefined): string {
  return status && status in ROUTINE_RUN_WORDS ? ROUTINE_RUN_WORDS[status as RoutineRunStatus] : '';
}

/** How a ledger line began. */
export const TRIGGER_WORDS: Record<RoutineTrigger, string> = {
  schedule: 'no horário',
  manual: 'a pedido',
  catchup: 'ao voltar',
};

/** The first line of the step list of a routine's run: "Rotina «Título», no horário." */
export function routineStepLine(title: string, trigger: RoutineTrigger | null | undefined): string {
  return `Rotina «${title}», ${TRIGGER_WORDS[trigger ?? 'schedule']}.`;
}

/** How the run began, from the routine's ledger when it is already loaded; `schedule` ("no horário") when it is not there. */
export function triggerOfRun(ledger: RoutineRun[] | undefined, runId: string): RoutineTrigger {
  return ledger?.find((l) => l.run_id === runId)?.trigger ?? 'schedule';
}

export const REPORT_LABELS: Record<RoutineReport, string> = {
  news: 'Só quando houver novidade',
  always: 'Sempre',
};

export const SCHEDULE_KIND_LABELS: Record<ScheduleKind, string> = {
  daily: 'Todo dia',
  weekdays: 'Dias úteis (segunda a sexta)',
  weekly: 'Dias da semana que eu escolher',
  monthly: 'Uma vez por mês',
  interval: 'De tanto em tanto tempo',
  once: 'Uma vez só',
};

export type RoutineTone = 'ok' | 'warn' | 'dim' | 'busy';
export interface RoutineStateView {
  word: string;
  tone: RoutineTone;
  icon: 'tick' | 'pause' | 'warning' | 'timer';
}

/** The chip of a routine: icon plus word, never colour alone. */
export function routineStateView(r: Routine): RoutineStateView {
  if (r.running) return { word: 'Rodando agora', tone: 'busy', icon: 'timer' };
  if (r.enabled) return { word: 'Ativa', tone: 'ok', icon: 'tick' };
  if (r.paused_reason === 'failures') return { word: 'Pausada por falhas', tone: 'warn', icon: 'warning' };
  if (isFinishedOnce(r)) return { word: 'Concluída', tone: 'dim', icon: 'tick' };
  return { word: 'Pausada', tone: 'dim', icon: 'pause' };
}

/** A `once` routine that ran: it turned itself off and has nothing left to resume. */
export function isFinishedOnce(r: Pick<Routine, 'schedule' | 'enabled' | 'last_run_at'>): boolean {
  return r.schedule.kind === 'once' && !r.enabled && !!r.last_run_at;
}

export function weekLine(week: { ok: number; total: number }): string {
  return week.total > 0 ? `${week.ok} de ${week.total} bem esta semana` : '';
}

/** "Última: relatou, hoje às 08:00" ('' when it never ran). */
export function lastRunLine(r: Pick<Routine, 'last_run_at' | 'last_status'>, now: Date = new Date()): string {
  if (!r.last_run_at) return '';
  const word = routineRunWord(r.last_status);
  return `Última: ${[word, humanWhen(r.last_run_at, now)].filter(Boolean).join(', ')}`;
}

export function activeRoutineCount(routines: Iterable<Routine>): number {
  let n = 0;
  for (const r of routines) if (r.enabled) n += 1;
  return n;
}

/** The next `limit` times across routines that are turned on, soonest first. */
export function upcomingRoutines(routines: Iterable<Routine>, limit = 3): { routine: Routine; at: string }[] {
  const rows: { routine: Routine; at: string; t: number }[] = [];
  for (const routine of routines) {
    if (!routine.enabled || !routine.next_run_at) continue;
    const t = parseIsoUtc(routine.next_run_at)?.getTime();
    if (t === undefined) continue;
    rows.push({ routine, at: routine.next_run_at, t });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.slice(0, limit).map(({ routine, at }) => ({ routine, at }));
}

export function pluralRoutines(n: number): string {
  return `${n} ${n === 1 ? 'rotina' : 'rotinas'}`;
}

// ---------- errors ----------

/** Sentences for the refusals of the routine routes; `detail` is the backend's own pt-BR text. */
export function routineErrorMessage(status: number | null, code: string | null | undefined, detail: string, agentName = 'O agente'): string {
  if (status === 409 && code === 'routine_limit') {
    return `${agentName} já tem ${ROUTINE_LIMITS.maxActive} rotinas ligadas. Pause ou apague uma para ligar outra.`;
  }
  if (status === 409 && code === 'routine_running') return 'Esta rotina já está rodando agora. Espere ela terminar.';
  if (status === 409 && code === 'agent_archived') return `${agentName} está arquivado. Restaure para rodar a rotina.`;
  if (status === 409 && code === 'agent_disabled') return `${agentName} está pausado. Retome para rodar a rotina.`;
  if (status === 404) return 'Essa rotina não existe mais.';
  return detail || 'Não consegui fazer isso agora. Tente de novo em instantes.';
}

// ---------- the form ----------

export interface RoutineFormValues {
  title: string;
  prompt: string;
  kind: ScheduleKind;
  time: string;
  days: number[];
  /** `1` to `28` or `last`. */
  monthDay: string;
  every: string;
  /** `YYYY-MM-DD` and `HH:MM`, local. */
  onceDate: string;
  onceTime: string;
  report: RoutineReport;
}

export function emptyRoutineForm(): RoutineFormValues {
  return { title: '', prompt: '', kind: 'weekdays', time: '08:00', days: [0], monthDay: '1', every: '60', onceDate: '', onceTime: '08:00', report: 'news' };
}

/** Schedule -> the selector's fields (the fields of other kinds keep their defaults). */
export function scheduleToFields(schedule: Schedule): Pick<RoutineFormValues, 'kind' | 'time' | 'days' | 'monthDay' | 'every' | 'onceDate' | 'onceTime'> {
  const base = emptyRoutineForm();
  const fields = { kind: base.kind, time: base.time, days: base.days, monthDay: base.monthDay, every: base.every, onceDate: base.onceDate, onceTime: base.onceTime };
  fields.kind = schedule.kind;
  if (schedule.kind === 'interval') fields.every = String(schedule.every_minutes);
  else if (schedule.kind === 'once') {
    const at = parseScheduleAt(schedule.at);
    if (at) {
      fields.onceDate = `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())}`;
      fields.onceTime = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
    }
  } else {
    fields.time = schedule.time;
    if (schedule.kind === 'weekly') fields.days = [...schedule.days].sort((a, b) => a - b);
    if (schedule.kind === 'monthly') fields.monthDay = String(schedule.day);
  }
  return fields;
}

export function routineToForm(r: Pick<Routine, 'title' | 'prompt' | 'schedule' | 'report'>): RoutineFormValues {
  return { title: r.title, prompt: r.prompt, report: r.report, ...scheduleToFields(r.schedule) };
}

/** Local date and time fields -> a Date (null when either is missing or not a real moment). */
export function onceDateOf(date: string, time: string): Date | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = splitTime(time);
  if (!d || !t) return null;
  const at = new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3]), t[0], t[1], 0, 0);
  // Reject 31/02 and the like (the constructor rolls them over).
  if (at.getMonth() !== Number(d[2]) - 1 || at.getDate() !== Number(d[3])) return null;
  return at;
}

/** The selector -> the schedule object of the contract; null while the fields do not make a valid schedule. */
export function formToSchedule(f: RoutineFormValues): Schedule | null {
  switch (f.kind) {
    case 'daily':
    case 'weekdays':
      return splitTime(f.time) ? { kind: f.kind, time: f.time } : null;
    case 'weekly': {
      if (!splitTime(f.time) || f.days.length === 0) return null;
      return { kind: 'weekly', time: f.time, days: [...new Set(f.days)].sort((a, b) => a - b) };
    }
    case 'monthly': {
      if (!splitTime(f.time)) return null;
      if (f.monthDay === 'last') return { kind: 'monthly', time: f.time, day: 'last' };
      const day = Number(f.monthDay);
      return Number.isInteger(day) && day >= 1 && day <= 28 ? { kind: 'monthly', time: f.time, day } : null;
    }
    case 'interval': {
      const every = Number(f.every);
      return f.every.trim() !== '' && Number.isInteger(every) && every >= ROUTINE_LIMITS.intervalMin && every <= ROUTINE_LIMITS.intervalMax
        ? { kind: 'interval', every_minutes: every }
        : null;
    }
    default: {
      const at = onceDateOf(f.onceDate, f.onceTime);
      // Sent as an instant (`...Z`): the owner picked it in this PC's local time.
      return at ? { kind: 'once', at: at.toISOString() } : null;
    }
  }
}

export type RoutineFormField = 'title' | 'prompt' | 'time' | 'days' | 'every' | 'once';
export type RoutineFormErrors = Partial<Record<RoutineFormField, string>>;

/** Client-side checks of the contract's limits; the backend checks again. An empty object means valid. */
export function validateRoutineForm(f: RoutineFormValues, agentName: string, now: Date = new Date()): RoutineFormErrors {
  const errors: RoutineFormErrors = {};
  const title = f.title.trim();
  if (!title) errors.title = 'Dê um nome à rotina.';
  else if (title.length > ROUTINE_LIMITS.title) errors.title = `O nome pode ter no máximo ${ROUTINE_LIMITS.title} caracteres.`;
  const prompt = f.prompt.trim();
  if (!prompt) errors.prompt = `Escreva o que ${agentName} deve fazer.`;
  else if (prompt.length > ROUTINE_LIMITS.prompt) errors.prompt = 'O pedido pode ter no máximo 2.000 caracteres.';
  if (f.kind === 'interval') {
    const every = Number(f.every);
    if (f.every.trim() === '' || !Number.isInteger(every)) errors.every = 'Escreva o intervalo em minutos, só com números.';
    else if (every < ROUTINE_LIMITS.intervalMin) errors.every = `O intervalo mínimo é de ${ROUTINE_LIMITS.intervalMin} minutos.`;
    else if (every > ROUTINE_LIMITS.intervalMax) errors.every = 'O intervalo máximo é de 1.440 minutos (24 horas).';
  } else if (f.kind === 'once') {
    const at = onceDateOf(f.onceDate, f.onceTime);
    if (!at) errors.once = 'Escolha o dia e a hora.';
    else if (at.getTime() <= now.getTime()) errors.once = 'Escolha um horário no futuro.';
  } else {
    if (!splitTime(f.time)) errors.time = 'Escolha a hora.';
    if (f.kind === 'weekly' && f.days.length === 0) errors.days = 'Escolha pelo menos um dia da semana.';
  }
  return errors;
}

/** Same schedule? (`days` in any order, `once` by instant). Used so an edit sends the schedule only when it changed. */
export function scheduleEquals(a: Schedule, b: Schedule): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'daily':
    case 'weekdays':
      return a.time === (b as typeof a).time;
    case 'weekly': {
      const o = b as typeof a;
      const x = [...a.days].sort((p, q) => p - q).join(',');
      const y = [...o.days].sort((p, q) => p - q).join(',');
      return a.time === o.time && x === y;
    }
    case 'monthly':
      return a.time === (b as typeof a).time && a.day === (b as typeof a).day;
    case 'interval':
      return a.every_minutes === (b as typeof a).every_minutes;
    default:
      return parseScheduleAt(a.at)?.getTime() === parseScheduleAt((b as typeof a).at)?.getTime();
  }
}
