/** Phase 6b: occurrences of a schedule, the human date helper, words of states, the form model and its validation. */
import { describe, expect, it } from 'vitest';
import {
  ROUTINE_RUN_WORDS,
  activeRoutineCount,
  emptyRoutineForm,
  formToSchedule,
  humanWhen,
  lastRunLine,
  nextOccurrences,
  parseScheduleAt,
  routineErrorMessage,
  routineRunWord,
  routineStateView,
  routineStepLine,
  routineToForm,
  scheduleEquals,
  scheduleText,
  triggerOfRun,
  upcomingRoutines,
  validateRoutineForm,
  weekLine,
} from '../routines';
import type { RoutineFormValues } from '../routines';
import type { Schedule } from '../types';
import { makeRoutine, makeRoutineRun } from './routines-fixtures';

/** Local-time dates, so the tests do not depend on the machine's zone. Thursday 12/11/2026, 10:00. */
const NOW = new Date(2026, 10, 12, 10, 0, 0);
const at = (y: number, m: number, d: number, h = 0, min = 0): Date => new Date(y, m - 1, d, h, min, 0);
const fmt = (list: Date[]): string[] =>
  list.map((d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`);

describe('nextOccurrences', () => {
  it('daily: today if the time is still ahead, else tomorrow', () => {
    expect(fmt(nextOccurrences({ kind: 'daily', time: '19:30' }, NOW))).toEqual(['2026-11-12 19:30', '2026-11-13 19:30', '2026-11-14 19:30']);
    expect(fmt(nextOccurrences({ kind: 'daily', time: '08:00' }, NOW))).toEqual(['2026-11-13 08:00', '2026-11-14 08:00', '2026-11-15 08:00']);
  });

  it('never returns the very instant of now', () => {
    expect(fmt(nextOccurrences({ kind: 'daily', time: '10:00' }, NOW, 1))).toEqual(['2026-11-13 10:00']);
    expect(fmt(nextOccurrences({ kind: 'daily', time: '10:00' }, at(2026, 11, 12, 9, 59), 1))).toEqual(['2026-11-12 10:00']);
  });

  it('weekdays: skips the weekend', () => {
    expect(fmt(nextOccurrences({ kind: 'weekdays', time: '08:00' }, at(2026, 11, 13, 9, 0)))).toEqual(['2026-11-16 08:00', '2026-11-17 08:00', '2026-11-18 08:00']);
    expect(fmt(nextOccurrences({ kind: 'weekdays', time: '08:00' }, at(2026, 11, 14, 7, 0)))).toEqual(['2026-11-16 08:00', '2026-11-17 08:00', '2026-11-18 08:00']);
  });

  it('weekly: 0 is Monday and 6 is Sunday, and a day later today still counts', () => {
    const monThu: Schedule = { kind: 'weekly', time: '19:30', days: [0, 3] };
    expect(fmt(nextOccurrences(monThu, NOW))).toEqual(['2026-11-12 19:30', '2026-11-16 19:30', '2026-11-19 19:30']);
    expect(fmt(nextOccurrences({ kind: 'weekly', time: '08:00', days: [0, 3] }, NOW))).toEqual(['2026-11-16 08:00', '2026-11-19 08:00', '2026-11-23 08:00']);
    expect(fmt(nextOccurrences({ kind: 'weekly', time: '09:00', days: [6] }, NOW))).toEqual(['2026-11-15 09:00', '2026-11-22 09:00', '2026-11-29 09:00']);
  });

  it('weekly: every day of the week behaves like daily', () => {
    expect(fmt(nextOccurrences({ kind: 'weekly', time: '19:30', days: [0, 1, 2, 3, 4, 5, 6] }, NOW))).toEqual(
      fmt(nextOccurrences({ kind: 'daily', time: '19:30' }, NOW)),
    );
  });

  it('monthly: crosses the month and the year boundary', () => {
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 5 }, NOW))).toEqual(['2026-12-05 09:00', '2027-01-05 09:00', '2027-02-05 09:00']);
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 28 }, at(2026, 11, 28, 9, 0)))).toEqual(['2026-12-28 09:00', '2027-01-28 09:00', '2027-02-28 09:00']);
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 1 }, at(2026, 11, 30, 23, 0)))).toEqual(['2026-12-01 09:00', '2027-01-01 09:00', '2027-02-01 09:00']);
  });

  it('monthly "last": the real last day of each month, including February (leap and not)', () => {
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 'last' }, NOW))).toEqual(['2026-11-30 09:00', '2026-12-31 09:00', '2027-01-31 09:00']);
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 'last' }, at(2027, 1, 31, 10, 0)))).toEqual(['2027-02-28 09:00', '2027-03-31 09:00', '2027-04-30 09:00']);
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 'last' }, at(2028, 1, 31, 10, 0), 1))).toEqual(['2028-02-29 09:00']);
    // The last day itself, before the time: still today.
    expect(fmt(nextOccurrences({ kind: 'monthly', time: '09:00', day: 'last' }, at(2026, 11, 30, 8, 0), 1))).toEqual(['2026-11-30 09:00']);
  });

  it('interval: counts from now, every N minutes', () => {
    expect(nextOccurrences({ kind: 'interval', every_minutes: 30 }, NOW).map((d) => d.getTime() - NOW.getTime())).toEqual([30 * 60_000, 60 * 60_000, 90 * 60_000]);
  });

  it('once: its own time while ahead, nothing once it passed', () => {
    const future = at(2026, 11, 14, 10, 0);
    expect(nextOccurrences({ kind: 'once', at: future.toISOString() }, NOW)).toEqual([future]);
    expect(nextOccurrences({ kind: 'once', at: at(2026, 11, 12, 9, 0).toISOString() }, NOW)).toEqual([]);
  });

  it('gives nothing for a broken time', () => {
    expect(nextOccurrences({ kind: 'daily', time: '25:00' }, NOW)).toEqual([]);
  });
});

describe('parseScheduleAt', () => {
  it('reads a value with a zone as an instant and one without as local time', () => {
    expect(parseScheduleAt('2026-11-14T10:00:00Z')?.toISOString()).toBe('2026-11-14T10:00:00.000Z');
    expect(parseScheduleAt('2026-11-14T10:00:00')?.getTime()).toBe(at(2026, 11, 14, 10, 0).getTime());
    expect(parseScheduleAt('2026-11-14T10:00')?.getTime()).toBe(at(2026, 11, 14, 10, 0).getTime());
    expect(parseScheduleAt('lixo')).toBeNull();
    expect(parseScheduleAt(null)).toBeNull();
  });
});

describe('humanWhen', () => {
  const iso = (d: Date): string => d.toISOString();
  it('says today, tomorrow, yesterday and otherwise the weekday and date, in 24 h', () => {
    expect(humanWhen(iso(at(2026, 11, 12, 19, 30)), NOW)).toBe('hoje às 19:30');
    expect(humanWhen(iso(at(2026, 11, 13, 8, 0)), NOW)).toBe('amanhã às 08:00');
    expect(humanWhen(iso(at(2026, 11, 11, 19, 30)), NOW)).toBe('ontem às 19:30');
    expect(humanWhen(iso(at(2026, 11, 16, 8, 0)), NOW)).toBe('seg., 16/11 às 08:00');
    expect(humanWhen(iso(at(2026, 11, 14, 22, 5)), NOW)).toBe('sáb., 14/11 às 22:05');
    expect(humanWhen(iso(at(2026, 11, 15, 0, 0)), NOW)).toBe('dom., 15/11 às 00:00');
  });
  it('adds the year when it is not this year', () => {
    expect(humanWhen(iso(at(2027, 1, 15, 9, 0)), NOW)).toBe('sex., 15/01/2027 às 09:00');
  });
  it('treats the day boundary by the calendar day, not by 24 hours', () => {
    const lateNow = at(2026, 11, 12, 23, 59);
    expect(humanWhen(iso(at(2026, 11, 13, 0, 1)), lateNow)).toBe('amanhã às 00:01');
    expect(humanWhen(iso(at(2026, 11, 12, 0, 1)), lateNow)).toBe('hoje às 00:01');
  });
  it('accepts a Date, a zone-less backend time as UTC, and gives "" for nothing', () => {
    expect(humanWhen(at(2026, 11, 12, 19, 30), NOW)).toBe('hoje às 19:30');
    expect(humanWhen(null, NOW)).toBe('');
    expect(humanWhen('lixo', NOW)).toBe('');
    expect(humanWhen(new Date('x'), NOW)).toBe('');
  });
});

describe('words', () => {
  it('words every schedule', () => {
    expect(scheduleText({ kind: 'daily', time: '08:00' })).toBe('Todo dia às 08:00');
    expect(scheduleText({ kind: 'weekdays', time: '08:00' })).toBe('Todo dia útil às 08:00');
    expect(scheduleText({ kind: 'weekly', time: '19:30', days: [3, 0] })).toBe('Toda segunda e quinta às 19:30');
    expect(scheduleText({ kind: 'weekly', time: '09:00', days: [0, 2, 4] })).toBe('Toda segunda, quarta e sexta às 09:00');
    expect(scheduleText({ kind: 'weekly', time: '09:00', days: [6, 5] })).toBe('Todo sábado e domingo às 09:00');
    expect(scheduleText({ kind: 'monthly', time: '09:00', day: 5 })).toBe('Todo dia 5 às 09:00');
    expect(scheduleText({ kind: 'monthly', time: '09:00', day: 'last' })).toBe('Todo último dia do mês às 09:00');
    expect(scheduleText({ kind: 'interval', every_minutes: 30 })).toBe('A cada 30 minutos');
    expect(scheduleText({ kind: 'interval', every_minutes: 120 })).toBe('A cada 2 horas');
    expect(scheduleText({ kind: 'once', at: at(2026, 11, 14, 10, 0).toISOString() })).toBe('Uma vez, em 14/11 às 10:00');
  });

  it('words every ledger state', () => {
    expect(ROUTINE_RUN_WORDS).toEqual({
      running: 'rodando',
      reported: 'relatou',
      quiet: 'sem novidade',
      failed: 'falhou',
      cancelled: 'cancelada',
      skipped: 'pulada',
      missed: 'perdida (o PC estava desligado)',
    });
    expect(routineRunWord('quiet')).toBe('sem novidade');
    expect(routineRunWord('algo novo')).toBe('');
    expect(routineRunWord(null)).toBe('');
  });

  it('words the step-list line by how the run began', () => {
    expect(routineStepLine('Pendências', 'schedule')).toBe('Rotina «Pendências», no horário.');
    expect(routineStepLine('Pendências', 'manual')).toBe('Rotina «Pendências», a pedido.');
    expect(routineStepLine('Pendências', 'catchup')).toBe('Rotina «Pendências», ao voltar.');
    expect(routineStepLine('Pendências', null)).toBe('Rotina «Pendências», no horário.');
  });

  it('finds the trigger of a run in a loaded ledger, "no horário" otherwise', () => {
    const ledger = [makeRoutineRun({ run_id: 'run-9', trigger: 'manual' }), makeRoutineRun({ id: 'rr2', run_id: 'run-8', trigger: 'catchup' })];
    expect(triggerOfRun(ledger, 'run-9')).toBe('manual');
    expect(triggerOfRun(ledger, 'run-8')).toBe('catchup');
    expect(triggerOfRun(ledger, 'run-1')).toBe('schedule');
    expect(triggerOfRun(undefined, 'run-1')).toBe('schedule');
  });

  it('builds the state chip of a routine', () => {
    expect(routineStateView(makeRoutine()).word).toBe('Ativa');
    expect(routineStateView(makeRoutine({ enabled: false, next_run_at: null })).word).toBe('Pausada');
    expect(routineStateView(makeRoutine({ enabled: false, paused_reason: 'failures' })).word).toBe('Pausada por falhas');
    expect(routineStateView(makeRoutine({ running: true })).word).toBe('Rodando agora');
    expect(routineStateView(makeRoutine({ enabled: false, schedule: { kind: 'once', at: '2026-11-01T10:00:00Z' }, last_run_at: '2026-11-01T10:00:00Z' })).word).toBe('Concluída');
  });

  it('writes the week and last-run lines', () => {
    expect(weekLine({ ok: 0, total: 0 })).toBe('');
    expect(weekLine({ ok: 4, total: 5 })).toBe('4 de 5 bem esta semana');
    expect(lastRunLine(makeRoutine(), NOW)).toBe('');
    expect(lastRunLine({ last_run_at: at(2026, 11, 12, 8, 0).toISOString(), last_status: 'quiet' }, NOW)).toBe('Última: sem novidade, hoje às 08:00');
  });

  it('counts the routines that are on and picks the next three', () => {
    const list = [
      makeRoutine({ id: 'a', next_run_at: '2026-11-15T10:00:00Z' }),
      makeRoutine({ id: 'b', next_run_at: '2026-11-13T10:00:00Z' }),
      makeRoutine({ id: 'c', enabled: false, next_run_at: null }),
      makeRoutine({ id: 'd', next_run_at: '2026-11-14T10:00:00Z' }),
      makeRoutine({ id: 'e', next_run_at: '2026-11-16T10:00:00Z' }),
    ];
    expect(activeRoutineCount(list)).toBe(4);
    expect(upcomingRoutines(list, 3).map((r) => r.routine.id)).toEqual(['b', 'd', 'a']);
  });

  it('turns refusal codes into sentences', () => {
    expect(routineErrorMessage(409, 'routine_limit', '', 'Lia')).toMatch(/Lia já tem 20 rotinas ligadas/);
    expect(routineErrorMessage(409, 'routine_running', '')).toMatch(/já está rodando/);
    expect(routineErrorMessage(422, '', 'O horário é inválido.')).toBe('O horário é inválido.');
    expect(routineErrorMessage(404, '', '')).toBe('Essa rotina não existe mais.');
  });
});

describe('form model', () => {
  const form = (over: Partial<RoutineFormValues> = {}): RoutineFormValues => ({ ...emptyRoutineForm(), title: 'Pendências', prompt: 'Liste as pendências.', ...over });

  it('builds the payload of every schedule kind', () => {
    expect(formToSchedule(form({ kind: 'daily', time: '07:15' }))).toEqual({ kind: 'daily', time: '07:15' });
    expect(formToSchedule(form({ kind: 'weekdays', time: '08:00' }))).toEqual({ kind: 'weekdays', time: '08:00' });
    expect(formToSchedule(form({ kind: 'weekly', time: '19:30', days: [3, 0, 3] }))).toEqual({ kind: 'weekly', time: '19:30', days: [0, 3] });
    expect(formToSchedule(form({ kind: 'monthly', time: '09:00', monthDay: '5' }))).toEqual({ kind: 'monthly', time: '09:00', day: 5 });
    expect(formToSchedule(form({ kind: 'monthly', time: '09:00', monthDay: 'last' }))).toEqual({ kind: 'monthly', time: '09:00', day: 'last' });
    expect(formToSchedule(form({ kind: 'interval', every: '45' }))).toEqual({ kind: 'interval', every_minutes: 45 });
    expect(formToSchedule(form({ kind: 'once', onceDate: '2026-11-14', onceTime: '10:00' }))).toEqual({ kind: 'once', at: at(2026, 11, 14, 10, 0).toISOString() });
  });

  it('builds nothing while a field is missing or out of range', () => {
    expect(formToSchedule(form({ kind: 'weekly', days: [] }))).toBeNull();
    expect(formToSchedule(form({ kind: 'daily', time: '' }))).toBeNull();
    expect(formToSchedule(form({ kind: 'interval', every: '14' }))).toBeNull();
    expect(formToSchedule(form({ kind: 'interval', every: '1441' }))).toBeNull();
    expect(formToSchedule(form({ kind: 'interval', every: '' }))).toBeNull();
    expect(formToSchedule(form({ kind: 'monthly', monthDay: '29' }))).toBeNull();
    expect(formToSchedule(form({ kind: 'once', onceDate: '', onceTime: '10:00' }))).toBeNull();
    expect(formToSchedule(form({ kind: 'once', onceDate: '2026-02-31', onceTime: '10:00' }))).toBeNull();
  });

  it('round-trips a routine into the form and back', () => {
    const schedules: Schedule[] = [
      { kind: 'daily', time: '07:15' },
      { kind: 'weekdays', time: '08:00' },
      { kind: 'weekly', time: '19:30', days: [0, 3] },
      { kind: 'monthly', time: '09:00', day: 'last' },
      { kind: 'monthly', time: '09:00', day: 12 },
      { kind: 'interval', every_minutes: 90 },
      { kind: 'once', at: at(2026, 11, 20, 18, 45).toISOString() },
    ];
    for (const schedule of schedules) {
      const back = formToSchedule(routineToForm(makeRoutine({ schedule })));
      expect(back && scheduleEquals(back, schedule)).toBe(true);
    }
    expect(routineToForm(makeRoutine({ report: 'always' })).report).toBe('always');
  });

  it('compares schedules without caring about the order of the days', () => {
    expect(scheduleEquals({ kind: 'weekly', time: '08:00', days: [3, 0] }, { kind: 'weekly', time: '08:00', days: [0, 3] })).toBe(true);
    expect(scheduleEquals({ kind: 'weekly', time: '08:00', days: [0] }, { kind: 'weekly', time: '08:00', days: [0, 3] })).toBe(false);
    expect(scheduleEquals({ kind: 'daily', time: '08:00' }, { kind: 'weekdays', time: '08:00' })).toBe(false);
    expect(scheduleEquals({ kind: 'interval', every_minutes: 30 }, { kind: 'interval', every_minutes: 30 })).toBe(true);
  });

  it('validates the limits of the contract', () => {
    const ok = form();
    expect(validateRoutineForm(ok, 'Lia', NOW)).toEqual({});
    expect(validateRoutineForm(form({ title: '   ' }), 'Lia', NOW).title).toMatch(/nome/);
    expect(validateRoutineForm(form({ title: 'x'.repeat(120) }), 'Lia', NOW).title).toBeUndefined();
    expect(validateRoutineForm(form({ title: 'x'.repeat(121) }), 'Lia', NOW).title).toMatch(/120/);
    expect(validateRoutineForm(form({ prompt: '' }), 'Lia', NOW).prompt).toMatch(/Lia/);
    expect(validateRoutineForm(form({ prompt: 'x'.repeat(2000) }), 'Lia', NOW).prompt).toBeUndefined();
    expect(validateRoutineForm(form({ prompt: 'x'.repeat(2001) }), 'Lia', NOW).prompt).toMatch(/2\.000/);
    expect(validateRoutineForm(form({ kind: 'interval', every: '15' }), 'Lia', NOW).every).toBeUndefined();
    expect(validateRoutineForm(form({ kind: 'interval', every: '14' }), 'Lia', NOW).every).toMatch(/15 minutos/);
    expect(validateRoutineForm(form({ kind: 'interval', every: '1440' }), 'Lia', NOW).every).toBeUndefined();
    expect(validateRoutineForm(form({ kind: 'interval', every: '1441' }), 'Lia', NOW).every).toMatch(/1\.440/);
    expect(validateRoutineForm(form({ kind: 'interval', every: '2,5' }), 'Lia', NOW).every).toMatch(/números/);
    expect(validateRoutineForm(form({ kind: 'weekly', days: [] }), 'Lia', NOW).days).toMatch(/pelo menos um dia/);
    expect(validateRoutineForm(form({ time: '' }), 'Lia', NOW).time).toMatch(/hora/);
  });

  it('wants "uma vez" in the future', () => {
    expect(validateRoutineForm(form({ kind: 'once', onceDate: '2026-11-12', onceTime: '09:00' }), 'Lia', NOW).once).toMatch(/futuro/);
    expect(validateRoutineForm(form({ kind: 'once', onceDate: '2026-11-12', onceTime: '10:00' }), 'Lia', NOW).once).toMatch(/futuro/);
    expect(validateRoutineForm(form({ kind: 'once', onceDate: '2026-11-12', onceTime: '10:01' }), 'Lia', NOW).once).toBeUndefined();
    expect(validateRoutineForm(form({ kind: 'once', onceDate: '', onceTime: '10:00' }), 'Lia', NOW).once).toMatch(/dia e a hora/);
  });
});
