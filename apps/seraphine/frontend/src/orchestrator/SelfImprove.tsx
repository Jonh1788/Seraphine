import { useEffect, useMemo, useState } from 'react';
import { useAgentStream } from './useAgentStream';
import { Timeline } from './Timeline';
import { useSelfImproveStore, GATE_LABELS, type Phase } from './selfImproveStore';

// ---- diff-stat parsing (graceful degradation) -----------------------------
// The backend returns DiffFile.changes as the right side of `git diff --stat`
// (e.g. "+64 −12", "+32", "12 +++++-----"). Best-effort: pull the first two
// integers as added/removed; if we can only find one, treat it per the badge.
// Never throws — returns { added, removed, ok }.
function parseChanges(changes: string): { added: number; removed: number; ok: boolean } {
  const s = changes ?? '';
  // Form A: explicit signed counts "+64 −12" / "+32 -0" (− or - both accepted).
  const plus = s.match(/\+\s*(\d+)/);
  const minus = s.match(/[−-]\s*(\d+)/);
  if (plus || minus) {
    return { added: plus ? Number(plus[1]) : 0, removed: minus ? Number(minus[1]) : 0, ok: true };
  }
  // Form B: numstat-ish "12 +++++-----" — count +/- glyphs proportionally to N.
  const total = s.match(/(\d+)/);
  const pluses = (s.match(/\+/g) || []).length;
  const minuses = (s.match(/-/g) || []).length;
  if (total && (pluses || minuses)) {
    const n = Number(total[1]);
    const denom = pluses + minuses || 1;
    return { added: Math.round((n * pluses) / denom), removed: Math.round((n * minuses) / denom), ok: true };
  }
  return { added: 0, removed: 0, ok: false };
}

// Proportional mini-bar segments (green = added, red = removed), max 5 total.
function miniBars(added: number, removed: number): Array<'add' | 'del'> {
  const total = added + removed;
  if (total <= 0) return [];
  const MAX = 5;
  let g = Math.round((added / total) * MAX);
  let r = MAX - g;
  if (added > 0 && g === 0) g = 1;
  if (removed > 0 && r === 0 && g > 1) r = 1;
  if (removed === 0) r = 0;
  if (added === 0) g = 0;
  return [...Array(g).fill('add'), ...Array(r).fill('del')] as Array<'add' | 'del'>;
}

// M (modified) vs A (added): additions-only -> A/green; anything with removals
// (or unparseable) -> M/amber. We can't see git's true M/A/D from a diff --stat
// numbers-only line, so additions-only is the strongest "added" signal.
function diffBadge(parsed: { added: number; removed: number; ok: boolean }): 'A' | 'M' {
  if (parsed.ok && parsed.removed === 0 && parsed.added > 0) return 'A';
  return 'M';
}

// ---- inline SVG icons (Lucide-style, no emojis — design spec exact paths) --
const sk = { fill: 'none', stroke: 'currentColor', strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const IconFolder = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M3 7.5A2 2 0 0 1 5 5.5h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
const IconLink = (): JSX.Element => <svg width="13" height="13" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" /><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" /></svg>;
const IconX = (): JSX.Element => <svg width="13" height="13" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconPlus = (): JSX.Element => <svg width="13" height="13" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M12 5v14M5 12h14" /></svg>;
const IconShieldCheck = (p: { size?: number; stroke?: string; sw?: number }): JSX.Element => (
  <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" fill="none" stroke={p.stroke ?? 'currentColor'} strokeWidth={p.sw ?? 1.8} strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><path d="M9 12l2 2 4-4" />
  </svg>
);
const IconShield = (p: { size?: number; stroke?: string }): JSX.Element => <svg width={p.size ?? 16} height={p.size ?? 16} viewBox="0 0 24 24" fill="none" stroke={p.stroke ?? 'currentColor'} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>;
const IconBranch = (p: { size?: number }): JSX.Element => <svg width={p.size ?? 14} height={p.size ?? 14} viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M6 3v15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></svg>;
const IconClock = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>;
const IconCheck = (p: { size?: number; stroke?: string; sw?: number }): JSX.Element => <svg width={p.size ?? 15} height={p.size ?? 15} viewBox="0 0 24 24" fill="none" stroke={p.stroke ?? '#4ade80'} strokeWidth={p.sw ?? 2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M20 6 9 17l-5-5" /></svg>;
const IconCross = (): JSX.Element => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef6b6b" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>;
const IconMerge = (): JSX.Element => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 3v12" /><circle cx="18" cy="12" r="3" /><circle cx="6" cy="18" r="3" /><path d="M15 6a9 9 0 0 1-9 9" /></svg>;
const IconTrash = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" /></svg>;
const IconChat = (): JSX.Element => <svg width="16" height="16" viewBox="0 0 24 24" {...sk} strokeWidth={1.8}><path d="M3 11.5a8.38 8.38 0 0 0 .9 3.8 8.5 8.5 0 0 0 7.6 4.7 8.38 8.38 0 0 0 3.8-.9L21 21l-1.9-5.7a8.38 8.38 0 0 0 .9-3.8 8.5 8.5 0 0 0-4.7-7.6 8.38 8.38 0 0 0-3.8-.9h-.5a8.48 8.48 0 0 0-8 8v.5z" /></svg>;
const IconSparkle = (): JSX.Element => <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.8" strokeLinejoin="round"><path d="M12 3l1.7 4.6L18 9l-4.3 1.4L12 15l-1.7-4.6L6 9l4.3-1.4z" /></svg>;

// ---- pipeline stepper -----------------------------------------------------
type StepState = 'completed' | 'active' | 'pending' | 'fail';
const STEP_LABELS = ['Objetivo', 'Worktree', 'Agente', 'Gate', 'Revisão'];

/** Map phase → per-step state. Steps: 0 Objetivo,1 Worktree,2 Agente,3 Gate,4 Revisão. */
function stepStates(phase: Phase): StepState[] {
  switch (phase) {
    case 'idle':
      return ['active', 'pending', 'pending', 'pending', 'pending'];
    case 'working':
      return ['completed', 'completed', 'active', 'pending', 'pending'];
    case 'gating':
      return ['completed', 'completed', 'completed', 'active', 'pending'];
    case 'ready':
      return ['completed', 'completed', 'completed', 'completed', 'active'];
    case 'failed':
      return ['completed', 'completed', 'completed', 'fail', 'pending'];
  }
}

function Stepper({ phase }: { phase: Phase }): JSX.Element {
  const states = stepStates(phase);
  return (
    <div className="si-stepper">
      {STEP_LABELS.map((label, i) => {
        const st = states[i];
        const next = states[i + 1];
        let connector = '';
        if (i < STEP_LABELS.length - 1) {
          if (st === 'completed' && next === 'completed') connector = 'si-step-conn--done';
          else if (st === 'completed' && (next === 'active' || next === 'fail')) connector = 'si-step-conn--grad';
          else connector = 'si-step-conn--pending';
        }
        return (
          <div className="si-stepper__seg" key={label}>
            <div className="si-step">
              <span className={`si-step__circle si-step__circle--${st}`}>
                {st === 'completed' && <IconCheck size={14} stroke="#0d0d11" sw={2.4} />}
                {st === 'fail' && <IconCross />}
                {st === 'active' && (
                  i === 4
                    ? <span className="si-step__num si-step__num--active">5</span>
                    : <><span className="si-step__ring" aria-hidden /><span className="si-step__dot" /></>
                )}
                {st === 'pending' && <span className="si-step__num">{i + 1}</span>}
              </span>
              <span className={`si-step__label si-step__label--${st}`}>{label}</span>
            </div>
            {i < STEP_LABELS.length - 1 && <span className={`si-step-conn ${connector}`} />}
          </div>
        );
      })}
    </div>
  );
}

export function SelfImprove(): JSX.Element {
  // Run state + actions live in the store so an in-flight run survives leaving
  // and re-entering the Maestro tab/view. The gate-iterate loop is driven by the
  // global event stream inside the store (selfImproveStore.ts), not here.
  const repoRoot = useSelfImproveStore((s) => s.repoRoot);
  const goal = useSelfImproveStore((s) => s.goal);
  const refs = useSelfImproveStore((s) => s.refs);
  const newRef = useSelfImproveStore((s) => s.newRef);
  const session = useSelfImproveStore((s) => s.session);
  const agentId = useSelfImproveStore((s) => s.agentId);
  const phase = useSelfImproveStore((s) => s.phase);
  const gate = useSelfImproveStore((s) => s.gate);
  const diff = useSelfImproveStore((s) => s.diff);
  const attempts = useSelfImproveStore((s) => s.attempts);
  const iterFeedback = useSelfImproveStore((s) => s.iterFeedback);
  const error = useSelfImproveStore((s) => s.error);
  const runStart = useSelfImproveStore((s) => s.runStart);
  const setRepoRoot = useSelfImproveStore((s) => s.setRepoRoot);
  const setGoal = useSelfImproveStore((s) => s.setGoal);
  const setNewRef = useSelfImproveStore((s) => s.setNewRef);
  const setIterFeedback = useSelfImproveStore((s) => s.setIterFeedback);
  const addRef = useSelfImproveStore((s) => s.addRef);
  const removeRef = useSelfImproveStore((s) => s.removeRef);
  const startSI = useSelfImproveStore((s) => s.startSI);
  const approve = useSelfImproveStore((s) => s.approve);
  const reject = useSelfImproveStore((s) => s.reject);
  const iterate = useSelfImproveStore((s) => s.iterate);
  const review = useSelfImproveStore((s) => s.review);
  const reviewing = useSelfImproveStore((s) => s.reviewing);
  const runReview = useSelfImproveStore((s) => s.runReview);

  const events = useAgentStream();
  const [, setTick] = useState(0); // drives the elapsed-minutes re-render

  const agentEvents = useMemo(() => events.filter((e) => e.agent_id === agentId), [events, agentId]);

  // Tick every 30s while a run is in flight so the elapsed-minutes clock line
  // re-renders. Cleared when the run ends or runStart resets.
  useEffect(() => {
    if (runStart === null) return;
    if (phase !== 'working' && phase !== 'gating' && phase !== 'ready' && phase !== 'failed') return;
    const t = setInterval(() => setTick((n) => n + 1), 30000);
    return () => clearInterval(t);
  }, [runStart, phase]);

  const canStart = !!repoRoot && !!goal.trim() && (phase === 'idle' || phase === 'failed');
  const editable = phase === 'idle' || phase === 'failed';
  const showActions = phase === 'ready' || phase === 'failed';
  const showSummary = phase === 'working' || phase === 'gating' || phase === 'ready';
  const live = phase === 'working' || phase === 'gating';

  // Diff totals (sum of parsed adds/removes across files).
  const diffTotals = useMemo(() => {
    let added = 0; let removed = 0;
    for (const d of diff) { const p = parseChanges(d.changes); added += p.added; removed += p.removed; }
    return { added, removed };
  }, [diff]);

  const branch = session?.branch ?? '';
  const mins = runStart ? Math.floor((Date.now() - runStart) / 60000) : 0;

  return (
    <div className="si-root">
      <Stepper phase={phase} />

      <div className="si-content">
        {/* ---- Left column ---- */}
        <aside className="si-aside">
          {showSummary ? (
            <>
              <div className="si-card si-summary">
                <span className="si-fieldlabel">OBJETIVO</span>
                <div className="si-summary__goal">{goal || '—'}</div>
                <div className="si-summary__meta">
                  <span className="si-meta-row"><IconBranch />{<code className="si-mono">{branch || 'si/…'}</code>}</span>
                  <span className="si-meta-row"><span className="si-meta-icon si-meta-icon--amber"><IconShield size={14} stroke="#ffa726" /></span>worktree sandbox · isolado do main</span>
                  <span className="si-meta-row"><IconClock />{mins} min · {attempts} {attempts === 1 ? 'tentativa' : 'tentativas'}</span>
                </div>
              </div>

              {gate && (
                <div className={`si-card si-gate ${gate.ok ? 'si-gate--pass' : 'si-gate--fail'}`}>
                  <div className="si-gate__head">
                    <span className="si-gate__tile"><IconShieldCheck size={15} stroke={gate.ok ? '#4ade80' : '#ef6b6b'} sw={2} /></span>
                    <span className="si-gate__title">{gate.ok ? 'Gate passou' : 'Gate falhou'}</span>
                    <span className="si-gate__count">{gate.steps.filter((s) => s.ok).length}/{gate.steps.length}</span>
                  </div>
                  <div className="si-gate__steps">
                    {gate.steps.map((st, i) => (
                      <div className="si-gate__step" key={i}>
                        <div className="si-gate__row">
                          {st.ok ? <IconCheck size={15} /> : <IconCross />}
                          <code className={`si-gate__cmd${st.ok ? '' : ' si-gate__cmd--fail'}`}>{GATE_LABELS[i] ?? st.cmd}</code>
                        </div>
                        {!st.ok && st.tail && <pre className="si-gate__tail">{st.tail}</pre>}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {gate?.ok ? (
                <div className="si-seal">
                  <IconShieldCheck size={16} stroke="#4ade80" sw={1.8} />
                  <span className="si-seal__text">Compila e passa em todos os testes. <strong>Seguro pra mesclar.</strong></span>
                </div>
              ) : (
                error && <div className="si-error">{error}</div>
              )}
            </>
          ) : (
            <>
              <div className="si-card si-config">
                <div className="si-field">
                  <span className="si-fieldlabel">RAIZ DO REPOSITÓRIO</span>
                  <div className="si-inset si-inset--row">
                    <span className="si-inset__icon"><IconFolder /></span>
                    <input
                      className="si-inset__input si-mono"
                      placeholder="/caminho/do/repo"
                      value={repoRoot}
                      onChange={(e) => setRepoRoot(e.target.value)}
                      disabled={!editable}
                    />
                  </div>
                </div>

                <div className="si-field">
                  <span className="si-fieldlabel">OBJETIVO</span>
                  <textarea
                    className="si-inset si-inset__textarea"
                    placeholder="O que a Seraphine deve melhorar em si mesma?"
                    value={goal}
                    onChange={(e) => setGoal(e.target.value)}
                    disabled={!editable}
                  />
                </div>

                <div className="si-field">
                  <span className="si-fieldlabel">REFERÊNCIAS</span>
                  <div className="si-refs">
                    {refs.map((r) => (
                      <div key={r.id} className="si-inset si-ref">
                        <span className="si-ref__icon"><IconLink /></span>
                        <span className="si-ref__url si-mono">{r.url}</span>
                        <button
                          type="button"
                          className="si-ref__rm"
                          aria-label="Remover referência"
                          disabled={!editable}
                          onClick={() => removeRef(r.id)}
                        ><IconX /></button>
                      </div>
                    ))}
                    <div className="si-ref si-ref--add">
                      <span className="si-ref__icon"><IconPlus /></span>
                      <input
                        className="si-ref__input si-mono"
                        placeholder="Adicionar URL…"
                        value={newRef}
                        onChange={(e) => setNewRef(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRef(); } }}
                        disabled={!editable}
                      />
                      <button
                        type="button"
                        className="si-ref__addbtn"
                        aria-label="Adicionar referência"
                        disabled={!newRef.trim() || !editable}
                        onClick={addRef}
                      ><IconPlus /></button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="si-card si-quality">
                <div className="si-quality__head">
                  <IconShieldCheck size={14} stroke="var(--dim)" />
                  <span className="si-quality__title">Gate de qualidade</span>
                  <span className="si-quality__note">roda ao terminar</span>
                </div>
                <div className="si-quality__list">
                  {GATE_LABELS.map((cmd) => (
                    <div className="si-quality__item" key={cmd}>
                      <span className="si-quality__dot" />
                      <code className="si-mono">{cmd}</code>
                    </div>
                  ))}
                </div>
              </div>

              {phase !== 'failed' && error && <div className="si-error">{error}</div>}

              <button type="button" className="si-start" disabled={!canStart} onClick={startSI}>
                Iniciar
              </button>

              <div className="si-footnote">
                <IconShield size={16} stroke="var(--accent)" />
                <span className="si-footnote__text">Roda num <strong>worktree isolado</strong>. Nada toca o <code className="si-mono">main</code> até você aprovar.</span>
              </div>
            </>
          )}
        </aside>

        {/* ---- Main area ---- */}
        <section className="si-main">
          {showActions ? (
            <>
              <div className="si-diffhead">
                <span className="si-diffhead__title">Mudanças</span>
                <span className="si-diffhead__count">{diff.length} {diff.length === 1 ? 'arquivo' : 'arquivos'}</span>
                <span className="si-diffhead__totals">
                  <span className="si-add">+{diffTotals.added}</span> <span className="si-del">−{diffTotals.removed}</span>
                </span>
              </div>
              <div className="si-diffbody">
                {phase === 'failed' && gate && !gate.ok && (
                  <div className="si-gate si-gate--fail si-gate--inline">
                    <div className="si-gate__head">
                      <span className="si-gate__tile"><IconShieldCheck size={15} stroke="#ef6b6b" sw={2} /></span>
                      <span className="si-gate__title">Gate falhou</span>
                      <span className="si-gate__count">{gate.steps.filter((s) => s.ok).length}/{gate.steps.length}</span>
                    </div>
                    <div className="si-gate__steps">
                      {gate.steps.map((st, i) => (
                        <div className="si-gate__step" key={i}>
                          <div className="si-gate__row">
                            {st.ok ? <IconCheck size={15} /> : <IconCross />}
                            <code className={`si-gate__cmd${st.ok ? '' : ' si-gate__cmd--fail'}`}>{GATE_LABELS[i] ?? st.cmd}</code>
                          </div>
                          {!st.ok && st.tail && <pre className="si-gate__tail">{st.tail}</pre>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {phase === 'failed' && error && <div className="si-error">{error}</div>}
                {diff.map((d, i) => {
                  const p = parseChanges(d.changes);
                  const badge = diffBadge(p);
                  const bars = miniBars(p.added, p.removed);
                  return (
                    <div key={i} className="si-difffile">
                      <span className={`si-difffile__badge si-difffile__badge--${badge}`}>{badge}</span>
                      <span className="si-difffile__path si-mono">{d.path}</span>
                      {p.ok ? (
                        <span className="si-difffile__counts">
                          <span className="si-add">+{p.added}</span>
                          {p.removed > 0 && <span className="si-del">−{p.removed}</span>}
                          {bars.length > 0 && (
                            <span className="si-difffile__bars">
                              {bars.map((b, bi) => <span key={bi} className={`si-bar si-bar--${b}`} />)}
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="si-difffile__counts si-mono si-dim">{d.changes}</span>
                      )}
                    </div>
                  );
                })}
                {diff.length === 0 && <div className="si-diffempty">Sem mudanças para mostrar.</div>}
              </div>

              <div className="si-review">
                <div className="si-review__head">
                  <span className="si-review__title"><IconSparkle /> Revisão da IA</span>
                  <button type="button" className="si-review__refresh" disabled={reviewing} onClick={runReview}>
                    {reviewing ? 'Revisando…' : review ? 'Revisar de novo' : 'Revisar'}
                  </button>
                </div>
                {reviewing && !review ? (
                  <div className="si-review__loading"><span className="si-spinner" aria-hidden /> Analisando as mudanças…</div>
                ) : review ? (
                  <div className="si-review__body">{review}</div>
                ) : (
                  <div className="si-review__empty">Um agente de IA revisa o que foi implementado — clique em Revisar.</div>
                )}
              </div>

              <div className="si-actionbar">
                <div className="si-actionbar__row">
                  {phase === 'ready' && (
                    <button type="button" className="si-btn si-btn--merge" onClick={approve}><IconMerge />Aprovar &amp; mesclar</button>
                  )}
                  <button type="button" className="si-btn si-btn--reject" onClick={reject}><IconTrash />Rejeitar</button>
                  {phase === 'ready' && branch && (
                    <span className="si-actionbar__legend">aprovar funde <code className="si-mono">{branch}</code> → <code className="si-mono">main</code></span>
                  )}
                </div>
                {agentId && (
                  <div className="si-iterate">
                    <span className="si-iterate__icon"><IconChat /></span>
                    <input
                      className="si-iterate__input"
                      placeholder="Pedir um ajuste antes de mesclar… (Iterar)"
                      value={iterFeedback}
                      onChange={(e) => setIterFeedback(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && iterFeedback.trim()) { e.preventDefault(); iterate(); } }}
                    />
                    <button type="button" className="si-iterate__btn" disabled={!iterFeedback.trim()} onClick={iterate}>Iterar</button>
                  </div>
                )}
              </div>
            </>
          ) : agentId ? (
            <>
              <div className="si-livehead">
                <span className="si-livehead__status">
                  <span className="si-spinner" aria-hidden />
                  {phase === 'gating' ? 'Rodando o gate (build + testes)…' : 'Agente trabalhando…'}
                  {phase === 'working' && attempts > 0 && <span className="si-livehead__try"> (tentativa {attempts + 1})</span>}
                </span>
                {branch && <span className="si-livehead__branch"><IconBranch size={11} /><code className="si-mono">{branch}</code></span>}
                <span className="si-livehead__seal"><IconShield size={11} stroke="currentColor" />sandbox</span>
              </div>
              <div className="si-livebody">
                <Timeline events={agentEvents} sepLabel="WORKTREE CRIADO" />
              </div>
              {live && <div className="si-progress"><span className="si-progress__bar" /></div>}
            </>
          ) : (
            <div className="si-mainempty">
              <span className="si-mainempty__icon"><IconSparkle /></span>
              <div className="si-mainempty__title">Pronto para melhorar a Seraphine</div>
              <div className="si-mainempty__body">Defina a raiz do repositório e um objetivo, depois clique em Iniciar. O agente trabalha num worktree isolado e o gate roda build + testes antes de você revisar.</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
