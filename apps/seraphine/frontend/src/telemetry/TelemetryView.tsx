/**
 * 096 — Telemetry "Custos & Energia" dashboard (Obsidian reskin).
 *
 * Cost (tokens + $) is the cross-platform value. cliproxy / claude_max /
 * ollama calls run on a flat subscription or locally → $0 marginal; we frame
 * them as "local/flat" vs metered cloud (anthropic / openrouter). The power
 * widget is Mac-only (Tauri `read_power`) and degrades to "indisponível".
 */

import './obsidian.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, RefreshIcon, GaugeIcon } from '../icons/Icons';
import {
  fetchTelemetrySummary,
  readPower,
  type TelemetrySummary,
  type PowerSample,
} from './api';

interface TelemetryViewProps {
  onBack: () => void;
}

type Period = 7 | 30;

/** Backends with $0 marginal cost: flat subscription (cliproxy / Claude Max)
 *  or fully local inference (ollama). Everything else is metered cloud. */
const FLAT_BACKENDS = new Set(['cliproxy', 'claude_max', 'ollama', 'local']);

function isFlatBackend(backend: string): boolean {
  return FLAT_BACKENDS.has(backend.toLowerCase());
}

/* ------------------------------------------------------------------ */
/*  Formatting helpers                                                 */
/* ------------------------------------------------------------------ */

/** Cost in USD. Sub-cent values keep more precision so they don't read $0.00. */
function fmtUsd(v: number): string {
  if (v <= 0) return '0,00';
  if (v < 0.01) return v.toFixed(4).replace('.', ',');
  return v.toFixed(2).replace('.', ',');
}

/** Compact token/integer count: 1234 -> "1,2k", 1_200_000 -> "1,2M". */
function fmtCount(v: number): string {
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1).replace('.', ',')}k`;
  return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
}

/** mW -> W with one decimal (pt-BR). */
function fmtWatts(mw: number): string {
  return (mw / 1000).toFixed(1).replace('.', ',');
}

function pct(v: number, max: number): number {
  return max > 0 ? (v / max) * 100 : 0;
}

/* ------------------------------------------------------------------ */
/*  Power widget (Mac-only, Tauri `read_power`)                        */
/* ------------------------------------------------------------------ */

function PowerWidget(): JSX.Element {
  const [sample, setSample] = useState<PowerSample | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      const s = await readPower();
      if (alive) setSample(s);
    };
    void tick();
    // Poll while the view is mounted. readPower() never throws → safe to loop.
    const id = window.setInterval(() => { void tick(); }, 3000);
    return () => { alive = false; window.clearInterval(id); };
  }, []);

  const supported = sample?.supported === true;

  return (
    <section className="focus-analytics__chart-card tel-power">
      <div className="tel-power__head">
        <h3 className="focus-analytics__chart-title">Energia (Mac local)</h3>
        {supported && (
          <span className="tel-power__live">
            <span className="tel-power__dot" aria-hidden="true" />
            ao vivo
          </span>
        )}
      </div>

      {supported ? (
        <div className="tel-power__grid">
          <Gauge label="CPU" mw={sample?.cpu_mw} />
          <Gauge label="GPU" mw={sample?.gpu_mw} />
          <Gauge label="Pacote" mw={sample?.package_mw} />
        </div>
      ) : (
        <p className="tel-power__off">
          Energia indisponível — disponível apenas no backend local em Mac.
        </p>
      )}
    </section>
  );
}

function Gauge({ label, mw }: { label: string; mw?: number }): JSX.Element {
  const has = typeof mw === 'number' && Number.isFinite(mw);
  return (
    <div className="tel-gauge">
      <span className="tel-gauge__label">{label}</span>
      <span className="tel-gauge__value">
        {has ? fmtWatts(mw!) : '--'}
        <small>W</small>
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main view                                                          */
/* ------------------------------------------------------------------ */

export function TelemetryView({ onBack }: TelemetryViewProps): JSX.Element {
  const [period, setPeriod] = useState<Period>(7);
  const [summary, setSummary] = useState<TelemetrySummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reqId = useRef(0);

  const load = useCallback(async (p: Period): Promise<void> => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const data = await fetchTelemetrySummary(p);
      if (id === reqId.current) setSummary(data);
    } catch (e) {
      if (id === reqId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(period); }, [period, load]);
  const handleRefresh = useCallback(() => { void load(period); }, [period, load]);

  /* Split backends into flat ($0 marginal) vs metered cloud. */
  const split = useMemo(() => {
    const rows = summary?.by_backend ?? [];
    let flatCalls = 0;
    let meteredCalls = 0;
    let meteredCost = 0;
    const flatNames: string[] = [];
    for (const r of rows) {
      if (isFlatBackend(r.backend)) {
        flatCalls += r.calls;
        if (r.calls > 0) flatNames.push(r.backend);
      } else {
        meteredCalls += r.calls;
        meteredCost += r.cost_usd;
      }
    }
    return { flatCalls, meteredCalls, meteredCost, flatNames };
  }, [summary]);

  const total = summary?.total;
  const hasData = !!total && total.calls > 0;
  const modelMax = useMemo(
    () => Math.max(1, ...(summary?.by_model ?? []).map((m) => m.cost_usd)),
    [summary],
  );
  // When every call is flat ($0), bars by cost are all empty — fall back to
  // ranking models by call volume so the list still communicates usage.
  const modelByCost = (summary?.by_model ?? []).some((m) => m.cost_usd > 0);
  const callMax = useMemo(
    () => Math.max(1, ...(summary?.by_model ?? []).map((m) => m.calls)),
    [summary],
  );

  return (
    <div className="tasks-view focus-analytics">
      <div className="memory-view__header">
        <div className="memory-view__header-left">
          <button className="memory-view__back" onClick={onBack} type="button" aria-label="Voltar">
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <GaugeIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Custos & Energia</h2>
            <p className="memory-view__subtitle">Gasto de tokens, custo da nuvem e energia local</p>
          </div>
        </div>
        <div className="tasks-view__header-actions">
          <button type="button" className="tasks-view__new-btn" onClick={handleRefresh} disabled={loading}>
            <RefreshIcon size={16} />
            <span>{loading ? 'Carregando...' : 'Atualizar'}</span>
          </button>
        </div>
      </div>

      <div className="insights-view__filters" role="group" aria-label="Período do relatório">
        {([7, 30] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`insights-view__chip${period === p ? ' insights-view__chip--active' : ''}`}
            aria-pressed={period === p}
            onClick={() => setPeriod(p)}
          >
            {p} dias
          </button>
        ))}
        {loading && <span className="calendar-view__loading">carregando...</span>}
      </div>

      {error && <div className="tasks-view__error">{error}</div>}

      <div className="focus-analytics__body" aria-busy={loading}>
        {/* Hero + token cluster */}
        <section className="tel-hero-row">
          <div className="focus-analytics__chart-card tel-hero">
            <div className="tel-hero-eyebrow">
              <GaugeIcon size={14} />
              Nuvem (medido) · {period} dias
            </div>
            <div className="tel-hero-value">
              $<span>{fmtUsd(split.meteredCost)}</span>
            </div>
            <div className="tel-hero-meta">
              <b>{split.meteredCalls}</b> chamadas medidas
              {total && <> · <b>{total.calls}</b> chamadas no total</>}
            </div>
            <div className="tel-flat">
              <span className="tel-flat__badge">FLAT / LOCAL</span>
              <span className="tel-flat__text">
                <b>{split.flatCalls}</b> chamadas em{' '}
                {split.flatNames.length > 0 ? split.flatNames.join(', ') : 'cliproxy / local'} —{' '}
                <b>$0 marginal</b> nessas chamadas (assinatura flat ou inferência local).
              </span>
            </div>
          </div>

          <div className="tel-mini-grid">
            <div className="tel-mini">
              <div className="tel-mini-label">Tokens enviados</div>
              <div className="tel-mini-value">{total ? fmtCount(total.input_tokens) : '--'}</div>
              <div className="tel-mini-sub">entrada (prompt)</div>
            </div>
            <div className="tel-mini">
              <div className="tel-mini-label">Tokens gerados</div>
              <div className="tel-mini-value">{total ? fmtCount(total.output_tokens) : '--'}</div>
              <div className="tel-mini-sub">saída (resposta)</div>
            </div>
            <div className="tel-mini">
              <div className="tel-mini-label">Chamadas</div>
              <div className="tel-mini-value">{total ? fmtCount(total.calls) : '--'}</div>
              <div className="tel-mini-sub">total no período</div>
            </div>
            <div className="tel-mini">
              <div className="tel-mini-label">Custo total</div>
              <div className="tel-mini-value">
                <small>$</small>{total ? fmtUsd(total.cost_usd) : '--'}
              </div>
              <div className="tel-mini-sub">apenas nuvem medida</div>
            </div>
          </div>
        </section>

        {hasData ? (
          <section className="tel-two-col">
            {/* By model — horizontal bars */}
            <div className="focus-analytics__chart-card">
              <h3 className="focus-analytics__chart-title">Por modelo</h3>
              {(summary?.by_model ?? []).length === 0 ? (
                <div className="tel-empty-hint">Nenhuma chamada registrada.</div>
              ) : (
                <div className="tel-rows">
                  {(summary?.by_model ?? []).map((m) => {
                    const zero = m.cost_usd <= 0;
                    const width = modelByCost
                      ? pct(m.cost_usd, modelMax)
                      : pct(m.calls, callMax);
                    return (
                      <div key={m.model} className="tel-row">
                        <div className="tel-row__head">
                          <span className="tel-row__name" title={m.model}>{m.model}</span>
                        </div>
                        <div className="tel-row__meta">
                          <span className={`tel-row__cost${zero ? ' tel-row__cost--zero' : ''}`}>
                            {zero ? '$0' : `$${fmtUsd(m.cost_usd)}`}
                          </span>
                          <span className="tel-row__calls">{m.calls}×</span>
                        </div>
                        <div className="tel-row__track">
                          <div
                            className={`tel-row__fill${zero ? ' tel-row__fill--flat' : ''}`}
                            style={{ width: `${width}%` }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* By feature — compact list */}
            <div className="focus-analytics__chart-card">
              <h3 className="focus-analytics__chart-title">Por funcionalidade</h3>
              {(summary?.by_feature ?? []).length === 0 ? (
                <div className="tel-empty-hint">Nenhuma chamada registrada.</div>
              ) : (
                <div className="tel-flist">
                  {(summary?.by_feature ?? []).map((f) => (
                    <div key={f.feature} className="tel-fitem">
                      <span className="tel-fitem__name" title={f.feature}>{f.feature}</span>
                      <span className="tel-fitem__meta">
                        <span className="tel-fitem__cost">
                          {f.cost_usd <= 0 ? '$0' : `$${fmtUsd(f.cost_usd)}`}
                        </span>
                        <span className="tel-fitem__calls">{f.calls}×</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        ) : (
          !loading && !error && (
            <div className="habits-view__empty">
              <div className="habits-view__empty-icon">
                <GaugeIcon size={32} />
              </div>
              <p className="habits-view__empty-title">Nenhuma chamada registrada</p>
              <p className="habits-view__empty-hint">
                Conforme você conversa com a Seraphine, o consumo de tokens e o custo
                aparecem aqui. Chamadas via cliproxy / Claude Max ou modelos locais não
                têm custo marginal.
              </p>
            </div>
          )
        )}

        {/* Power widget — Mac-only, polls every ~3s, degrades gracefully */}
        <PowerWidget />
      </div>
    </div>
  );
}
