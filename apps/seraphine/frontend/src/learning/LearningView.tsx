/**
 * Learning loop — "Aprendizado" review panel (Obsidian reskin).
 *
 * The backend self-improvement loop proposes candidate policies (a behavior
 * addendum, tool guidance, and knob overrides) scored against a baseline.
 * Promotion to production is HUMAN-GATED here: the user reviews the proposed
 * change + score delta + rationale and explicitly promotes or rejects.
 */

import './obsidian.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeftIcon,
  RefreshIcon,
  PlayIcon,
  CheckIcon,
  XIcon,
  ChevronRightIcon,
  LearningIcon,
} from '../icons/Icons';
import {
  fetchActivePolicy,
  fetchCandidates,
  fetchLearningTraces,
  promoteCandidate,
  rejectCandidate,
  runLearningCycle,
  type ActivePolicy,
  type Candidate,
  type LearningTrace,
  type CycleSummary,
} from './api';

interface LearningViewProps {
  onBack: () => void;
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

/** Score → 2-3 decimal string (pt-BR comma). Non-numbers degrade to "--". */
function fmtScore(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '--';
  // 3 decimals, trim a trailing zero so 0.900 reads "0,90" but 0.915 stays.
  const s = v.toFixed(3);
  const trimmed = s.endsWith('0') ? s.slice(0, -1) : s;
  return trimmed.replace('.', ',');
}

/** Stringify a knob value for the diff list (numbers, bools, strings, json). */
function fmtKnob(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(v).replace('.', ',');
  }
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Truthy/structural equality for knob comparison (handles json values). */
function knobEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

/** baseline_score → candidate_score with a colored arrow (green if ≥). */
function ScoreDelta({ base, cand }: { base: number; cand: number }): JSX.Element {
  const up = Number.isFinite(cand) && Number.isFinite(base) && cand >= base;
  return (
    <span className={`lrn-delta${up ? ' lrn-delta--up' : ''}`} title="baseline → candidato">
      <span className="lrn-delta__base">{fmtScore(base)}</span>
      <span className="lrn-delta__arrow" aria-hidden="true">
        <ChevronRightIcon size={16} />
      </span>
      <span className="lrn-delta__cand">{fmtScore(cand)}</span>
    </span>
  );
}

/** A label + readable text block; renders "(sem alteração)" when empty. */
function ChangeBlock({ label, text }: { label: string; text: string }): JSX.Element {
  const empty = !text || !text.trim();
  return (
    <div className="lrn-block">
      <span className="lrn-block__label">{label}</span>
      <div className={`lrn-block__text lrn-block__text--mono${empty ? ' lrn-block__text--empty' : ''}`}>
        {empty ? '(sem alteração)' : text}
      </div>
    </div>
  );
}

/** Knob diff: compares the candidate's knobs to the active policy's. */
function KnobDiff({
  knobs,
  active,
}: {
  knobs: Record<string, unknown>;
  active: Record<string, unknown> | undefined;
}): JSX.Element | null {
  const names = Object.keys(knobs ?? {});
  if (names.length === 0) return null;
  return (
    <div className="lrn-block">
      <span className="lrn-block__label">Knobs propostos</span>
      <div className="lrn-knobs">
        {names.map((name) => {
          const next = knobs[name];
          const hasOld = active != null && Object.prototype.hasOwnProperty.call(active, name);
          const old = hasOld ? active[name] : undefined;
          const changed = !hasOld || !knobEqual(old, next);
          return (
            <div key={name} className={`lrn-knob${changed ? ' lrn-knob--changed' : ''}`}>
              <span className="lrn-knob__name">{name}:</span>
              {changed && hasOld && (
                <>
                  <span className="lrn-knob__old">{fmtKnob(old)}</span>
                  <span className="lrn-knob__arrow" aria-hidden="true">→</span>
                </>
              )}
              <span className="lrn-knob__new">{fmtKnob(next)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Signal dot: +1 → green, -1 → red, null → neutral. */
function SignalDot({ signal }: { signal: number | null }): JSX.Element {
  const cls =
    signal == null ? '' : signal > 0 ? ' lrn-trace__dot--good' : signal < 0 ? ' lrn-trace__dot--bad' : '';
  const label = signal == null ? 'neutro' : signal > 0 ? 'bom' : signal < 0 ? 'ruim' : 'neutro';
  return (
    <span className="lrn-trace__sig" title={label} aria-label={label}>
      <span className={`lrn-trace__dot${cls}`} />
    </span>
  );
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function LearningView({ onBack }: LearningViewProps): JSX.Element {
  const [active, setActive] = useState<ActivePolicy | null>(null);
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [traces, setTraces] = useState<LearningTrace[] | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [cycle, setCycle] = useState<CycleSummary | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [note, setNote] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [tracesOpen, setTracesOpen] = useState(false);

  const reqId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const [a, c, t] = await Promise.all([
        fetchActivePolicy(),
        fetchCandidates('pending'),
        fetchLearningTraces(15),
      ]);
      if (id === reqId.current) {
        setActive(a);
        setCandidates(c);
        setTraces(t);
      }
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Refetch just the active policy + pending candidates after an action.
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [a, c] = await Promise.all([fetchActivePolicy(), fetchCandidates('pending')]);
      setActive(a);
      setCandidates(c);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const handleRun = useCallback(async () => {
    setRunning(true);
    setNote(null);
    try {
      const summary = await runLearningCycle();
      setCycle(summary);
      await refresh();
    } catch (e) {
      setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setRunning(false);
    }
  }, [refresh]);

  const handlePromote = useCallback(
    async (c: Candidate) => {
      if (!window.confirm('Promover esta política para produção?')) return;
      setActingId(c.id);
      setNote(null);
      try {
        const { version } = await promoteCandidate(c.id);
        setNote({ kind: 'ok', text: `Política promovida — agora ativa na versão ${version}.` });
        await refresh();
      } catch (e) {
        setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setActingId(null);
      }
    },
    [refresh],
  );

  const handleReject = useCallback(
    async (c: Candidate) => {
      setActingId(c.id);
      setNote(null);
      try {
        await rejectCandidate(c.id);
        setNote({ kind: 'ok', text: 'Candidato rejeitado.' });
        await refresh();
      } catch (e) {
        setNote({ kind: 'err', text: e instanceof Error ? e.message : String(e) });
      } finally {
        setActingId(null);
      }
    },
    [refresh],
  );

  const activeKnobs = active?.knobs;
  const pending = candidates ?? [];

  return (
    <div className="tasks-view focus-analytics">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button className="memory-view__back" onClick={onBack} type="button" aria-label="Voltar">
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <LearningIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Aprendizado</h2>
            <p className="memory-view__subtitle">
              Revise e aprove melhorias propostas pela Seraphine
            </p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          {cycle && (() => {
            const skipped = cycle.status.startsWith('skipped');
            const tag = skipped ? 'skip' : cycle.passed ? 'pass' : 'fail';
            return (
              <span className="lrn-runnote">
                <span className={`lrn-runnote__tag lrn-runnote__tag--${tag}`}>
                  {cycle.status}
                </span>
                {!skipped && (
                  <>{fmtScore(cycle.baseline_score)} → {fmtScore(cycle.candidate_score)}</>
                )}
              </span>
            );
          })()}
          <button type="button" className="tasks-view__new-btn" onClick={handleRun} disabled={running}>
            {running ? <RefreshIcon size={16} /> : <PlayIcon size={16} />}
            <span>{running ? 'Rodando...' : 'Rodar ciclo agora'}</span>
          </button>
        </div>
      </div>

      {loading && <div className="insights-view__filters"><span className="calendar-view__loading">carregando...</span></div>}
      {error && <div className="tasks-view__error">{error}</div>}
      {note && <div className={`lrn-note lrn-note--${note.kind}`}>{note.text}</div>}

      <div className="focus-analytics__body" aria-busy={loading}>
        {/* ── Candidatos pendentes ──────────────────────────────────── */}
        <section className="focus-analytics__chart-card lrn-section">
          <div className="lrn-section__head">
            <h3 className="focus-analytics__chart-title">Candidatos pendentes</h3>
            {candidates != null && (
              <span className="lrn-section__count">{pending.length}</span>
            )}
          </div>

          {candidates != null && pending.length === 0 ? (
            <div className="lrn-empty-hint">
              Nenhum candidato pendente. Rode um ciclo ou aguarde o ciclo noturno (03:30).
            </div>
          ) : (
            <div className="lrn-cands">
              {pending.map((c) => {
                const acting = actingId === c.id;
                return (
                  <div key={c.id} className="lrn-card">
                    <div className="lrn-card__top">
                      <ScoreDelta base={c.baseline_score} cand={c.candidate_score} />
                      <span className="lrn-card__id" title={`base v${c.base_version}`}>
                        #{c.id.slice(0, 8)} · base v{c.base_version}
                      </span>
                    </div>

                    <ChangeBlock label="Adendo de comportamento" text={c.behavior_addendum} />
                    <ChangeBlock label="Orientação de ferramentas" text={c.tool_guidance} />
                    <KnobDiff knobs={c.knobs ?? {}} active={activeKnobs} />

                    {c.rationale && c.rationale.trim() && (
                      <div className="lrn-block">
                        <span className="lrn-block__label">Justificativa</span>
                        <div className="lrn-rationale">{c.rationale}</div>
                      </div>
                    )}

                    <div className="lrn-actions">
                      <button
                        type="button"
                        className="lrn-btn lrn-btn--promote"
                        onClick={() => void handlePromote(c)}
                        disabled={acting}
                      >
                        <CheckIcon size={15} />
                        <span>{acting ? '...' : 'Promover'}</span>
                      </button>
                      <button
                        type="button"
                        className="lrn-btn lrn-btn--reject"
                        onClick={() => void handleReject(c)}
                        disabled={acting}
                      >
                        <XIcon size={15} />
                        <span>Rejeitar</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* ── Política ativa ────────────────────────────────────────── */}
        <section className="focus-analytics__chart-card lrn-section">
          <h3 className="focus-analytics__chart-title">Política ativa</h3>
          {active == null ? (
            <div className="lrn-empty-hint">{loading ? 'carregando...' : '—'}</div>
          ) : active.version === 0 ? (
            <div className="lrn-active__empty">
              Nenhuma política ativa (v0 — comportamento padrão).
            </div>
          ) : (
            <div className="lrn-active">
              <div className="lrn-active__ver">
                <span className="lrn-active__ver-num">v{active.version}</span>
                <span className="lrn-active__ver-label">versão em produção</span>
              </div>
              <ChangeBlock label="Adendo de comportamento" text={active.behavior_addendum} />
              <ChangeBlock label="Orientação de ferramentas" text={active.tool_guidance} />
              {Object.keys(active.knobs ?? {}).length > 0 && (
                <div className="lrn-block">
                  <span className="lrn-block__label">Knobs ativos</span>
                  <div className="lrn-knobs">
                    {Object.entries(active.knobs).map(([name, val]) => (
                      <div key={name} className="lrn-knob">
                        <span className="lrn-knob__name">{name}:</span>
                        <span className="lrn-knob__new">{fmtKnob(val)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* ── Traces recentes (collapsible) ─────────────────────────── */}
        <section className="focus-analytics__chart-card lrn-section">
          <button
            type="button"
            className="lrn-collapse"
            onClick={() => setTracesOpen((v) => !v)}
            aria-expanded={tracesOpen}
          >
            <span className={`lrn-collapse__chevron${tracesOpen ? ' lrn-collapse__chevron--open' : ''}`}>
              <ChevronRightIcon size={14} />
            </span>
            Traces recentes{traces != null ? ` (${traces.length})` : ''}
          </button>

          {tracesOpen &&
            (traces == null ? (
              <div className="lrn-empty-hint">{loading ? 'carregando...' : '—'}</div>
            ) : traces.length === 0 ? (
              <div className="lrn-empty-hint">Nenhuma interação registrada ainda.</div>
            ) : (
              <div className="lrn-traces">
                {traces.map((t) => (
                  <div key={t.id} className="lrn-trace">
                    <SignalDot signal={t.signal} />
                    <div className="lrn-trace__body">
                      <span className="lrn-trace__user" title={t.user_msg}>
                        {t.user_msg || '(sem mensagem)'}
                      </span>
                      <span className="lrn-trace__asst" title={t.assistant_msg}>
                        {t.assistant_msg || '(sem resposta)'}
                      </span>
                      {t.feature && <span className="lrn-trace__feature">{t.feature}</span>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
        </section>
      </div>
    </div>
  );
}
