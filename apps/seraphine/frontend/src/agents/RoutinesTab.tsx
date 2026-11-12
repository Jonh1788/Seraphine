/**
 * Routines (phase 6b, contract 8.1 and 8.2): the lines with their actions, the ledger ("Ver execuções"), the create/edit form
 * and the "Rotinas" tab of an agent's conversation. `RoutineList` is shared with the all-routines screen.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as api from './api';
import { ApiError } from './api';
import { Notice, SectionTitle } from './components';
import { SeraphineSays } from './TeamBuilder';
import { aboutRoutinePrefill } from './guide';
import { RoutineRunChip, RoutineStateChip } from './routineBits';
import { WarningIcon } from './setupIcons';
import { ChevronDownIcon } from './icons';
import {
  DAY_CHIPS,
  REPORT_LABELS,
  SCHEDULE_KIND_LABELS,
  TRIGGER_WORDS,
  emptyRoutineForm,
  formToSchedule,
  humanWhen,
  lastRunLine,
  nextOccurrences,
  routineToForm,
  scheduleEquals,
  scheduleToFields,
  validateRoutineForm,
  weekLine,
  isFinishedOnce,
} from './routines';
import type { RoutineFormErrors, RoutineFormField, RoutineFormValues } from './routines';
import { errorText, useAgentsStore } from './store';
import type { Agent, Routine, RoutinePatch, RoutineReport, ScheduleKind } from './types';
import { ROUTINE_LIMITS, SCHEDULE_KINDS } from './types';
import { useConfirm } from '../ui';

/** One sentence shown above the list after an action (a quiet confirmation or a refusal). */
export interface RoutineNote {
  tone: 'info' | 'error';
  text: string;
}

export const ROUTINE_HELP = (name: string): string => `Uma rotina age com as permissões de ${name}. Comandos continuam esperando a sua aprovação.`;

// ---------- ledger ----------

function RoutineLedger({ routine, ledgerId }: { routine: Routine; ledgerId: string }): JSX.Element {
  const ledger = useAgentsStore((s) => s.routineRuns[routine.id]);
  const loadRuns = useAgentsStore((s) => s.loadRoutineRuns);
  const navigate = useAgentsStore((s) => s.navigate);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(ledger === undefined);

  const load = (): void => {
    setError(null);
    setLoading(true);
    void loadRuns(routine.id).then((res) => {
      setLoading(false);
      if (!res.ok) setError(res.error ?? 'Não consegui carregar as execuções agora.');
    });
  };
  useEffect(() => {
    if (ledger === undefined) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routine.id]);

  const now = new Date();
  return (
    <section className="a-routine__runs" id={ledgerId} aria-label={`Execuções de ${routine.title}`}>
      {error && (
        <Notice>
          {error}{' '}
          <button type="button" className="a-link" onClick={load}>
            Tentar de novo
          </button>
        </Notice>
      )}
      {ledger === undefined && loading && !error && <p className="a-hint">Carregando as execuções…</p>}
      {ledger !== undefined && ledger.length === 0 && <p className="a-hint">Ainda não rodou. Quando rodar, cada horário aparece aqui.</p>}
      {ledger !== undefined && ledger.length > 0 && (
        <ul className="a-routine__runlist">
          {ledger.map((line) => (
            <li key={line.id} className="a-routine__runline">
              <span className="a-routine__when">{humanWhen(line.scheduled_for, now)}</span>
              <span className="a-hint">{TRIGGER_WORDS[line.trigger]}</span>
              <RoutineRunChip status={line.status} />
              {line.detail && <span className="a-hint a-routine__detail">{line.detail}</span>}
              {line.run_id && (
                <button type="button" className="a-link" onClick={() => navigate({ screen: 'project', projectId: routine.project_id })}>
                  Ver na conversa
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---------- one line ----------

function RoutineRow({
  routine,
  agentName,
  onEdit,
  onNote,
}: {
  routine: Routine;
  agentName: string;
  onEdit: () => void;
  onNote: (note: RoutineNote) => void;
}): JSX.Element {
  const updateRoutine = useAgentsStore((s) => s.updateRoutine);
  const removeRoutine = useAgentsStore((s) => s.removeRoutine);
  const runRoutine = useAgentsStore((s) => s.runRoutine);
  const copyRoutine = useAgentsStore((s) => s.copyRoutine);
  const loadRuns = useAgentsStore((s) => s.loadRoutineRuns);
  const ledger = useAgentsStore((s) => s.routineRuns[routine.id]);
  const navigate = useAgentsStore((s) => s.navigate);
  const guideAvailable = useAgentsStore((s) => s.guideState !== 'unavailable');
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);
  const [showRuns, setShowRuns] = useState(false);
  // A ref closes the gap before React re-renders the disabled buttons: a double click sends once.
  const inFlight = useRef(false);
  const titleId = useId();
  const ledgerId = useId();

  const pausedByFailures = !routine.enabled && routine.paused_reason === 'failures';
  // The last reason comes from the ledger; it is only asked for when the routine was paused by failures.
  useEffect(() => {
    if (pausedByFailures && ledger === undefined) void loadRuns(routine.id);
  }, [pausedByFailures, ledger, loadRuns, routine.id]);
  const lastReason = ledger?.find((l) => l.status === 'failed' && l.detail)?.detail ?? '';

  const act = async (key: string, fn: () => Promise<{ ok: boolean; error?: string }>, okText: string): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    const res = await fn();
    inFlight.current = false;
    setBusy(null);
    onNote(res.ok ? { tone: 'info', text: okText } : { tone: 'error', text: res.error ?? 'Não consegui fazer isso agora. Tente de novo.' });
  };

  const now = new Date();
  const next = routine.enabled && routine.next_run_at ? humanWhen(routine.next_run_at, now) : '';
  const week = weekLine(routine.week);
  const last = lastRunLine(routine, now);
  const finishedOnce = isFinishedOnce(routine);
  const disabledAll = busy !== null;

  return (
    <article className="a-card a-routine" aria-labelledby={titleId} aria-busy={busy !== null}>
      <header className="a-routine__head">
        <h3 className="a-routine__title" id={titleId}>
          {routine.title}
        </h3>
        <RoutineStateChip routine={routine} />
      </header>
      <p className="a-routine__schedule">{routine.schedule_text}</p>
      {(next || week || last) && (
        <ul className="a-routine__facts">
          {next && <li>Próxima: {next}</li>}
          {week && <li>{week}</li>}
          {last && <li>{last}</li>}
        </ul>
      )}
      {pausedByFailures && (
        <p className="a-routine__alert">
          <WarningIcon size={14} />
          <span>
            Pausada depois de {routine.consecutive_failures > 0 ? `${routine.consecutive_failures} falhas seguidas` : 'falhas seguidas'}.
            {lastReason ? ` ${lastReason}` : ''} Quando o motivo estiver resolvido, toque em Retomar.
          </span>
        </p>
      )}
      <div className="a-actions a-routine__actions">
        <button
          type="button"
          className="a-btn a-btn--small a-btn--primary"
          disabled={disabledAll || routine.running}
          onClick={() =>
            void act('run', () => runRoutine(routine.id), `Pedi para ${agentName} rodar «${routine.title}» agora. O relato aparece na conversa dele.`)
          }
        >
          {busy === 'run' ? 'Pedindo…' : 'Rodar agora'}
        </button>
        {!finishedOnce &&
          (routine.enabled ? (
            <button
              type="button"
              className="a-btn a-btn--small a-btn--ghost"
              disabled={disabledAll}
              onClick={() => void act('toggle', () => updateRoutine(routine.id, { enabled: false }), `Pausei «${routine.title}». Ela não roda até você retomar.`)}
            >
              Pausar
            </button>
          ) : (
            <button
              type="button"
              className="a-btn a-btn--small a-btn--ghost"
              disabled={disabledAll}
              onClick={() => void act('toggle', () => updateRoutine(routine.id, { enabled: true }), `Retomei «${routine.title}».`)}
            >
              Retomar
            </button>
          ))}
        <button type="button" className="a-btn a-btn--small a-btn--ghost" data-routine-edit={routine.id} disabled={disabledAll} onClick={onEdit}>
          Editar
        </button>
        <button
          type="button"
          className="a-btn a-btn--small a-btn--ghost"
          disabled={disabledAll}
          onClick={() =>
            void act(
              'copy',
              async () => {
                const res = await copyRoutine(routine.id);
                return res;
              },
              `Criei a cópia «${routine.title} (cópia)». Ela nasce pausada: ligue quando quiser.`,
            )
          }
        >
          Duplicar
        </button>
        {guideAvailable && (
          <button
            type="button"
            className="a-btn a-btn--small a-btn--ghost"
            disabled={disabledAll}
            onClick={() => navigate({ screen: 'guide', about: { routine_id: routine.id }, prefill: aboutRoutinePrefill(routine.title) })}
          >
            Pedir à Seraphine
          </button>
        )}
        <button
          type="button"
          className="a-btn a-btn--small a-btn--ghost"
          disabled={disabledAll}
          onClick={async () => {
            const ok = await confirm({
              title: 'Apagar rotina',
              message: `Apagar a rotina «${routine.title}»? O histórico de execuções dela também é apagado. Uma execução que já está em andamento continua até o fim.`,
              confirmLabel: 'Apagar',
              variant: 'danger',
            });
            if (ok) await act('delete', () => removeRoutine(routine.id), `Apaguei a rotina «${routine.title}».`);
          }}
        >
          Apagar
        </button>
        <span className="a-spacer" />
        <button
          type="button"
          className="a-link a-routine__toggle"
          aria-expanded={showRuns}
          aria-controls={showRuns ? ledgerId : undefined}
          onClick={() => setShowRuns((v) => !v)}
        >
          <ChevronDownIcon className={`a-steps__chev${showRuns ? ' is-open' : ''}`} /> Ver execuções
        </button>
      </div>
      {showRuns && <RoutineLedger routine={routine} ledgerId={ledgerId} />}
    </article>
  );
}

// ---------- form ----------

function fieldIds(base: string): Record<RoutineFormField, string> {
  return { title: `${base}-title`, prompt: `${base}-prompt`, time: `${base}-time`, days: `${base}-days`, every: `${base}-every`, once: `${base}-once` };
}

export function RoutineForm({
  agent,
  routine,
  onDone,
  onCancel,
}: {
  agent: Agent;
  /** Editing this routine; a new one when absent. */
  routine?: Routine;
  onDone: (note: RoutineNote) => void;
  onCancel: () => void;
}): JSX.Element {
  const createRoutine = useAgentsStore((s) => s.createRoutine);
  const updateRoutine = useAgentsStore((s) => s.updateRoutine);
  const [values, setValues] = useState<RoutineFormValues>(() => (routine ? routineToForm(routine) : emptyRoutineForm()));
  const [submitted, setSubmitted] = useState(false);
  const [touched, setTouched] = useState<Partial<Record<RoutineFormField, true>>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sentence, setSentence] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [say, setSay] = useState<string | null>(null);
  const draftBusy = useRef(false);
  const saveBusy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const firstRef = useRef<HTMLTextAreaElement>(null);
  const base = useId();
  const ids = fieldIds(base);
  const sentenceId = useId();
  const sentenceHintId = useId();
  const reportName = useId();

  useEffect(() => {
    firstRef.current?.focus();
  }, []);

  const errors: RoutineFormErrors = validateRoutineForm(values, agent.name);
  const show = (field: RoutineFormField): string => (submitted || touched[field] ? (errors[field] ?? '') : '');
  const touch = (field: RoutineFormField): void => setTouched((t) => (t[field] ? t : { ...t, [field]: true }));
  const set = (patch: Partial<RoutineFormValues>): void => setValues((v) => ({ ...v, ...patch }));
  const errAttrs = (field: RoutineFormField, extra?: string): { 'aria-invalid': boolean; 'aria-describedby': string | undefined } => ({
    'aria-invalid': !!show(field),
    'aria-describedby': [show(field) ? `${ids[field]}-err` : '', extra ?? ''].filter(Boolean).join(' ') || undefined,
  });
  const err = (field: RoutineFormField): JSX.Element | null =>
    show(field) ? (
      <p className="a-field-error" id={`${ids[field]}-err`}>
        {show(field)}
      </p>
    ) : null;

  const schedule = formToSchedule(values);
  const upcoming = schedule ? nextOccurrences(schedule, new Date(), 3) : [];
  const nowForPreview = new Date();

  const readSentence = async (): Promise<void> => {
    const text = sentence.trim();
    if (!text || draftBusy.current) return;
    draftBusy.current = true;
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await api.draftRoutine({ text, agent_id: agent.id });
      setValues((v) => ({ ...v, title: res.draft.title, prompt: res.draft.prompt, report: res.draft.report, ...scheduleToFields(res.draft.schedule) }));
      setSay(res.say);
    } catch (e) {
      // The typed sentence stays where it is: only the reason is shown.
      if (e instanceof ApiError && e.status === 409) {
        setDraftError('A Seraphine já está ocupada com outro pedido. Espere um instante e tente de novo.');
      } else if (e instanceof ApiError && e.status === 503) {
        setDraftError(e.detail || 'Não consegui entender a frase agora. Você pode preencher o formulário à mão.');
      } else {
        setDraftError(errorText(e));
      }
    } finally {
      draftBusy.current = false;
      setDrafting(false);
    }
  };

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saveBusy.current) return;
    if (Object.keys(errors).length > 0 || !schedule) {
      setSubmitted(true);
      setTimeout(() => formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(), 0);
      return;
    }
    saveBusy.current = true;
    setSaving(true);
    setSaveError(null);
    const title = values.title.trim();
    const prompt = values.prompt.trim();
    let res: { ok: boolean; error?: string };
    if (routine) {
      // Only what changed goes on the wire: sending an unchanged schedule would restart an interval.
      const patch: RoutinePatch = {};
      if (title !== routine.title) patch.title = title;
      if (prompt !== routine.prompt) patch.prompt = prompt;
      if (!scheduleEquals(schedule, routine.schedule)) patch.schedule = schedule;
      if (values.report !== routine.report) patch.report = values.report;
      if (Object.keys(patch).length === 0) {
        saveBusy.current = false;
        setSaving(false);
        onDone({ tone: 'info', text: 'Nada mudou em «' + routine.title + '».' });
        return;
      }
      res = await updateRoutine(routine.id, patch);
    } else {
      res = await createRoutine({ agent_id: agent.id, title, prompt, schedule, report: values.report });
    }
    saveBusy.current = false;
    setSaving(false);
    if (!res.ok) {
      setSaveError(res.error ?? 'Não consegui guardar a rotina agora. Tente de novo.');
      return;
    }
    onDone({ tone: 'info', text: routine ? `Guardei as mudanças em «${title}».` : `Criei a rotina «${title}». Ela já está ligada.` });
  };

  return (
    <form className="a-card a-routine-form" ref={formRef} onSubmit={(e) => void submit(e)} noValidate aria-label={routine ? `Editar a rotina ${routine.title}` : 'Nova rotina'}>
      <h3 className="a-build__title">{routine ? 'Editar rotina' : 'Nova rotina'}</h3>

      <div className="a-field">
        <label htmlFor={sentenceId}>Descreva em uma frase</label>
        <textarea
          id={sentenceId}
          ref={firstRef}
          className="a-input"
          rows={2}
          maxLength={ROUTINE_LIMITS.text}
          aria-describedby={sentenceHintId}
          placeholder="Ex.: todo dia útil às 8 me mande as pendências"
          value={sentence}
          onChange={(e) => setSentence(e.target.value)}
        />
        <small id={sentenceHintId}>A Seraphine preenche o formulário abaixo. Você confere e salva.</small>
        <div className="a-actions">
          <button type="button" className="a-btn a-btn--small a-btn--ghost" disabled={drafting || !sentence.trim()} onClick={() => void readSentence()}>
            {drafting ? 'Lendo…' : 'Preencher o formulário'}
          </button>
        </div>
        <div role="status" aria-live="polite" className="a-build__live">
          {drafting ? 'A Seraphine está lendo a sua frase…' : ''}
        </div>
        {draftError && <Notice>{draftError}</Notice>}
        {say && !drafting && <SeraphineSays>{say}</SeraphineSays>}
      </div>

      <div className="a-field">
        <label htmlFor={ids.title}>Nome da rotina</label>
        <input
          id={ids.title}
          className="a-input"
          value={values.title}
          {...errAttrs('title')}
          onChange={(e) => set({ title: e.target.value })}
          onBlur={() => touch('title')}
        />
        {err('title')}
      </div>

      <div className="a-field">
        <label htmlFor={ids.prompt}>O que {agent.name} deve fazer</label>
        <textarea
          id={ids.prompt}
          className="a-input"
          rows={4}
          value={values.prompt}
          {...errAttrs('prompt', `${ids.prompt}-count`)}
          onChange={(e) => set({ prompt: e.target.value })}
          onBlur={() => touch('prompt')}
        />
        <small id={`${ids.prompt}-count`}>
          {values.prompt.length} de {ROUTINE_LIMITS.prompt.toLocaleString('pt-BR')} caracteres
        </small>
        {err('prompt')}
      </div>

      <fieldset className="a-fieldset">
        <legend>Quando</legend>
        <div className="a-field">
          <label htmlFor={`${base}-kind`}>Repetir</label>
          <select
            id={`${base}-kind`}
            className="a-input"
            value={values.kind}
            onChange={(e) => set({ kind: e.target.value as ScheduleKind })}
          >
            {SCHEDULE_KINDS.map((k) => (
              <option key={k} value={k}>
                {SCHEDULE_KIND_LABELS[k]}
              </option>
            ))}
          </select>
        </div>

        {values.kind === 'weekly' && (
          <div className="a-field">
            <span id={`${ids.days}-label`}>Dias da semana</span>
            <div className="a-chips" role="group" aria-labelledby={`${ids.days}-label`} id={ids.days}>
              {DAY_CHIPS.map((d) => {
                const on = values.days.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    className={`a-chip-btn${on ? ' is-on' : ''}`}
                    aria-pressed={on}
                    aria-label={d.full}
                    aria-invalid={!!show('days')}
                    aria-describedby={show('days') ? `${ids.days}-err` : undefined}
                    onClick={() => {
                      touch('days');
                      set({ days: on ? values.days.filter((x) => x !== d.value) : [...values.days, d.value].sort((a, b) => a - b) });
                    }}
                  >
                    {d.short}
                  </button>
                );
              })}
            </div>
            {err('days')}
          </div>
        )}

        {values.kind === 'monthly' && (
          <div className="a-field">
            <label htmlFor={`${base}-monthday`}>Dia do mês</label>
            <select id={`${base}-monthday`} className="a-input" value={values.monthDay} onChange={(e) => set({ monthDay: e.target.value })}>
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i + 1} value={String(i + 1)}>
                  {i + 1}
                </option>
              ))}
              <option value="last">Último dia do mês</option>
            </select>
          </div>
        )}

        {values.kind === 'interval' && (
          <div className="a-field">
            <label htmlFor={ids.every}>A cada quantos minutos</label>
            <input
              id={ids.every}
              className="a-input"
              type="number"
              inputMode="numeric"
              value={values.every}
              {...errAttrs('every', `${ids.every}-hint`)}
              onChange={(e) => set({ every: e.target.value })}
              onBlur={() => touch('every')}
            />
            <small id={`${ids.every}-hint`}>De 15 a 1.440 minutos (24 horas). Conta a partir de agora.</small>
            {err('every')}
          </div>
        )}

        {values.kind === 'once' && (
          <div className="a-field">
            <span id={`${ids.once}-label`}>Dia e hora</span>
            <div className="a-form-grid" role="group" aria-labelledby={`${ids.once}-label`}>
              <input
                className="a-input"
                type="date"
                aria-label="Dia"
                value={values.onceDate}
                aria-invalid={!!show('once')}
                aria-describedby={show('once') ? `${ids.once}-err` : undefined}
                onChange={(e) => set({ onceDate: e.target.value })}
                onBlur={() => touch('once')}
              />
              <input
                className="a-input"
                type="time"
                aria-label="Hora"
                value={values.onceTime}
                aria-invalid={!!show('once')}
                aria-describedby={show('once') ? `${ids.once}-err` : undefined}
                onChange={(e) => set({ onceTime: e.target.value })}
                onBlur={() => touch('once')}
              />
            </div>
            {err('once')}
          </div>
        )}

        {values.kind !== 'interval' && values.kind !== 'once' && (
          <div className="a-field">
            <label htmlFor={ids.time}>Hora</label>
            <input
              id={ids.time}
              className="a-input"
              type="time"
              value={values.time}
              {...errAttrs('time')}
              onChange={(e) => set({ time: e.target.value })}
              onBlur={() => touch('time')}
            />
            {err('time')}
          </div>
        )}

        <div className="a-field" role="group" aria-labelledby={`${base}-next`}>
          <span id={`${base}-next`}>Próximas</span>
          {upcoming.length > 0 ? (
            <ul className="a-bullets">
              {upcoming.map((d) => (
                <li key={d.getTime()}>{humanWhen(d, nowForPreview)}</li>
              ))}
            </ul>
          ) : (
            <p className="a-hint">Preencha o horário para ver as próximas vezes.</p>
          )}
        </div>
      </fieldset>

      <fieldset className="a-fieldset">
        <legend>O que fazer com o resultado</legend>
        {(['news', 'always'] as RoutineReport[]).map((r) => (
          <label key={r} className="a-radio">
            <input type="radio" name={reportName} value={r} checked={values.report === r} onChange={() => set({ report: r })} />
            <span>{REPORT_LABELS[r]}</span>
          </label>
        ))}
        <p className="a-hint">
          {values.report === 'news'
            ? `${agent.name} só escreve na conversa quando houver algo novo.`
            : `${agent.name} escreve na conversa toda vez que a rotina rodar.`}
        </p>
      </fieldset>

      {saveError && <Notice>{saveError}</Notice>}
      <div className="a-actions">
        <button type="submit" className="a-btn a-btn--primary" disabled={saving}>
          {saving ? 'Guardando…' : routine ? 'Salvar' : 'Criar rotina'}
        </button>
        <button type="button" className="a-btn a-btn--ghost" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    </form>
  );
}

// ---------- list (shared) ----------

/**
 * The lines of a set of routines of ONE agent, with the editing form in place of the line being edited.
 * `creating` shows the form for a new routine above the lines.
 */
export function RoutineList({
  agent,
  routines,
  creating,
  onCloseCreate,
  onNote,
}: {
  agent: Agent;
  routines: Routine[];
  creating?: boolean;
  onCloseCreate?: () => void;
  onNote: (note: RoutineNote) => void;
}): JSX.Element {
  const [editingId, setEditingId] = useState<string | null>(null);
  const restore = (id: string): void => {
    setTimeout(() => document.querySelector<HTMLElement>(`[data-routine-edit="${id}"]`)?.focus(), 0);
  };
  return (
    <>
      {creating && (
        <RoutineForm
          agent={agent}
          onCancel={() => onCloseCreate?.()}
          onDone={(note) => {
            onCloseCreate?.();
            onNote(note);
          }}
        />
      )}
      <ul className="a-list a-routine-list">
        {routines.map((r) => (
          <li key={r.id}>
            {editingId === r.id ? (
              <RoutineForm
                agent={agent}
                routine={r}
                onCancel={() => {
                  setEditingId(null);
                  restore(r.id);
                }}
                onDone={(note) => {
                  setEditingId(null);
                  onNote(note);
                  restore(r.id);
                }}
              />
            ) : (
              <RoutineRow routine={r} agentName={agent.name} onEdit={() => setEditingId(r.id)} onNote={onNote} />
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** Live regions that say what an action did (and persist while it changes). */
export function RoutineNotes({ note }: { note: RoutineNote | null }): JSX.Element {
  return (
    <>
      <div role="status" aria-live="polite" className="a-routines__live">
        {note?.tone === 'info' && <p className="a-notice a-notice--info">{note.text}</p>}
      </div>
      {note?.tone === 'error' && <Notice>{note.text}</Notice>}
    </>
  );
}

// ---------- the tab ----------

/** The "Rotinas" tab of an agent's own conversation. */
export function RoutinesTab({ agent }: { agent: Agent }): JSX.Element {
  const routines = useAgentsStore((s) => s.routines);
  const state = useAgentsStore((s) => s.routinesState);
  const loadRoutines = useAgentsStore((s) => s.loadRoutines);
  const [creating, setCreating] = useState(false);
  const [note, setNote] = useState<RoutineNote | null>(null);
  const newRef = useRef<HTMLButtonElement>(null);

  const mine = useMemo(
    () => Object.values(routines).filter((r) => r.agent_id === agent.id).sort((a, b) => (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0)),
    [routines, agent.id],
  );
  const closeCreate = (): void => {
    setCreating(false);
    setTimeout(() => newRef.current?.focus(), 0);
  };
  const newButton = (
    <button type="button" className="a-btn a-btn--small a-btn--primary" ref={newRef} onClick={() => { setNote(null); setCreating(true); }}>
      Nova rotina
    </button>
  );

  let body: JSX.Element;
  if (state === 'idle' || (state === 'loading' && mine.length === 0)) {
    body = <p className="a-empty">Carregando as rotinas…</p>;
  } else if (state === 'error' && mine.length === 0) {
    body = (
      <Notice>
        Não consegui carregar as rotinas.{' '}
        <button type="button" className="a-link" onClick={() => void loadRoutines()}>
          Tentar de novo
        </button>
      </Notice>
    );
  } else {
    body = (
      <>
        {mine.length === 0 && !creating && (
          <div className="a-routines__empty">
            <p className="a-empty">Nenhuma rotina ainda. Combine uma vez e {agent.name} faz no horário.</p>
            {newButton}
          </div>
        )}
        <RoutineList agent={agent} routines={mine} creating={creating} onCloseCreate={closeCreate} onNote={setNote} />
      </>
    );
  }

  return (
    <div className="a-routines">
      <div className="a-section__head">
        <SectionTitle>{`ROTINAS DE ${agent.name.toUpperCase()}`}</SectionTitle>
        {mine.length > 0 && !creating && newButton}
      </div>
      <p className="a-hint">{ROUTINE_HELP(agent.name)}</p>
      {!agent.enabled && (
        <Notice tone="info">{agent.name} está pausado: os horários das rotinas dele são pulados, sem contar como falha, até você retomar.</Notice>
      )}
      <RoutineNotes note={note} />
      {body}
    </div>
  );
}
