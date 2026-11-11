import './obsidian.css';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import rehypeRaw from 'rehype-raw';
import remarkGfm from 'remark-gfm';
import { ArrowLeftIcon, SearchIcon } from '../icons/Icons';
import { ModelPicker } from '../ui';
import type { ModelPickerGroup } from '../ui';
import {
  cancelRun,
  getConfig,
  getRun,
  listModels,
  listRuns,
  putConfig,
  startRun,
  streamRun,
} from './api';
import type {
  DeepsearchConfig,
  ModelOption,
  ResearchEvent,
  ResearchMode,
  ResearchRun,
  Source,
} from './types';

interface ResearchViewProps {
  onBack: () => void;
}

/** Host portion of a URL, for the compact source-card label. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function formatDate(iso: string | null): string {
  if (!iso || iso.length < 10) return '';
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const today = new Date();
    if (
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    ) {
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  } catch {
    return '';
  }
}

/**
 * Turn `[n]` citation markers into in-page anchor links pointing at the matching
 * source in the Sources list (id `src-n`). Only markers with a known source `n`
 * are linkified; the rest are left verbatim. The result is HTML embedded in the
 * markdown, rendered via `rehype-raw` (same approach as NoteEditor).
 */
function linkifyCitations(markdown: string, sources: Source[]): string {
  const known = new Set(sources.map((s) => s.n).filter((n): n is number => typeof n === 'number'));
  return markdown.replace(/\[(\d+)\]/g, (match, digits: string) => {
    const n = Number(digits);
    if (!known.has(n)) return match;
    return `<a href="#src-${n}" class="research-cite">[${n}]</a>`;
  });
}

const STATUS_LABEL: Record<ResearchRun['status'], string> = {
  running: 'Em andamento',
  done: 'Concluido',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

interface LiveSource {
  url: string;
  title: string;
  read?: boolean;
  ok?: boolean;
}

export function ResearchView({ onBack }: ResearchViewProps): JSX.Element {
  // Composer
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<ResearchMode>('quick');

  // Run lifecycle
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Aborts the in-flight NDJSON stream on unmount or when a new run starts, so
  // navigating away from the Pesquisa tab doesn't leak a reader / setState on an
  // unmounted component.
  const streamAbortRef = useRef<AbortController | null>(null);

  // Live progress
  const [subQuestions, setSubQuestions] = useState<string[]>([]);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [round, setRound] = useState<{ n: number; total: number } | null>(null);
  const [queries, setQueries] = useState<string[]>([]);
  const [liveSources, setLiveSources] = useState<LiveSource[]>([]);

  // Report
  const [report, setReport] = useState('');
  const [reportSources, setReportSources] = useState<Source[]>([]);
  const [finished, setFinished] = useState(false);
  const [readOnly, setReadOnly] = useState(false);

  // History
  const [history, setHistory] = useState<ResearchRun[]>([]);

  // Model config panel
  const [configOpen, setConfigOpen] = useState(false);
  const [config, setConfig] = useState<DeepsearchConfig | null>(null);
  const [models, setModels] = useState<{ cliproxy: ModelOption[]; openrouter: ModelOption[] }>({
    cliproxy: [],
    openrouter: [],
  });
  const [fanoutModel, setFanoutModel] = useState('');
  const [synthModel, setSynthModel] = useState('');
  const [orKey, setOrKey] = useState('');
  const [savingConfig, setSavingConfig] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);

  /** Os dois pickers (fan-out e síntese) leem o mesmo catálogo. */
  const modelGroups = useMemo<ModelPickerGroup[]>(
    () => [
      { label: 'cliproxy / Claude', options: models.cliproxy },
      { label: 'OpenRouter', options: models.openrouter },
    ],
    [models],
  );

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setHistory(await listRuns());
    } catch {
      // History is non-critical; ignore.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Abort any in-flight stream when the view unmounts.
  useEffect(() => () => streamAbortRef.current?.abort(), []);

  // Reset all live + report state for a fresh run.
  const resetLive = useCallback(() => {
    setSubQuestions([]);
    setCriteria([]);
    setRound(null);
    setQueries([]);
    setLiveSources([]);
    setReport('');
    setReportSources([]);
    setFinished(false);
    setReadOnly(false);
    setError(null);
  }, []);

  const onEvent = useCallback(
    (e: ResearchEvent): void => {
      switch (e.type) {
        case 'snapshot':
          // Resume: hydrate report/sources/status, then replay nested progress.
          if (e.report) setReport(e.report);
          if (e.sources?.length) setReportSources(e.sources);
          if (e.status === 'done' || e.status === 'failed' || e.status === 'cancelled') {
            setFinished(true);
          }
          for (const inner of e.progress ?? []) onEvent(inner);
          break;
        case 'plan':
          setSubQuestions(e.sub_questions ?? []);
          setCriteria(e.criteria ?? []);
          break;
        case 'round':
          setRound({ n: e.n, total: e.total });
          break;
        case 'query':
          setQueries((prev) => (prev.includes(e.q) ? prev : [...prev, e.q]));
          break;
        case 'source_found':
          setLiveSources((prev) =>
            prev.some((s) => s.url === e.url) ? prev : [...prev, { url: e.url, title: e.title }],
          );
          break;
        case 'source_read':
          setLiveSources((prev) =>
            prev.map((s) => (s.url === e.url ? { ...s, read: true, ok: e.ok } : s)),
          );
          break;
        case 'synthesis':
          setReport((prev) => prev + e.text);
          break;
        case 'report':
          setReport(e.markdown);
          setReportSources(e.sources ?? []);
          break;
        case 'error':
          setError(e.message);
          setRunning(false);
          setCancelling(false);
          break;
        case 'done':
          setFinished(true);
          setRunning(false);
          setCancelling(false);
          void refresh();
          break;
        default:
          break;
      }
    },
    [refresh],
  );

  const handleSubmit = useCallback(async (): Promise<void> => {
    const q = query.trim();
    if (!q || running) return;
    resetLive();
    setRunning(true);
    setCancelling(false);
    // Tear down any prior stream before starting a fresh one.
    streamAbortRef.current?.abort();
    const ctrl = new AbortController();
    streamAbortRef.current = ctrl;
    try {
      const { id } = await startRun(q, mode);
      setActiveId(id);
      await streamRun(
        id,
        onEvent,
        () => {
          setRunning(false);
        },
        ctrl.signal,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }, [query, mode, running, resetLive, onEvent]);

  const handleCancel = useCallback(async (): Promise<void> => {
    if (!activeId) return;
    // Keep `running` true until the terminal `done` (status `cancelled`) arrives,
    // so the Pesquisar button stays disabled and a second run can't start mid-drain.
    setCancelling(true);
    try {
      await cancelRun(activeId);
    } catch {
      // ignore
    }
  }, [activeId]);

  // Load a past run read-only (no live stream).
  const handleOpenHistory = useCallback(
    async (id: string): Promise<void> => {
      resetLive();
      setReadOnly(true);
      setActiveId(id);
      try {
        const run = await getRun(id);
        setReport(run.report ?? '');
        setReportSources(run.sources ?? []);
        setQuery(run.query);
        setMode(run.mode);
        setFinished(true);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [resetLive],
  );

  // Lazy-load models + config when the config panel first opens.
  const toggleConfig = useCallback(async (): Promise<void> => {
    const next = !configOpen;
    setConfigOpen(next);
    if (next && !configLoaded) {
      setConfigLoaded(true);
      try {
        const [cfg, mdl] = await Promise.all([getConfig(), listModels()]);
        setConfig(cfg);
        setModels(mdl);
        setFanoutModel(cfg.fanout_model);
        setSynthModel(cfg.synth_model);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [configOpen, configLoaded]);

  const handleSaveConfig = useCallback(async (): Promise<void> => {
    setSavingConfig(true);
    try {
      const saved = await putConfig({
        fanout_model: fanoutModel,
        synth_model: synthModel,
        ...(orKey.trim() ? { openrouter_key: orKey.trim() } : {}),
      });
      setConfig(saved);
      setOrKey('');
      // Re-fetch models: with an OpenRouter key now saved, /models returns the
      // OpenRouter catalogue (it was empty before the key existed).
      try { setModels(await listModels()); } catch { /* keep the current list */ }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingConfig(false);
    }
  }, [fanoutModel, synthModel, orKey]);

  const renderedReport = useMemo(
    () => linkifyCitations(report, reportSources),
    [report, reportSources],
  );

  const hasProgress =
    subQuestions.length > 0 ||
    criteria.length > 0 ||
    round !== null ||
    queries.length > 0 ||
    liveSources.length > 0;

  return (
    <div className="tasks-view research-view">
      <div className="memory-view__header research-view__header">
        <div className="memory-view__header-left">
          <button
            className="memory-view__back"
            onClick={onBack}
            type="button"
            aria-label="Voltar"
          >
            <ArrowLeftIcon size={18} />
            <span>Voltar</span>
          </button>
          <div className="memory-view__header-icon">
            <SearchIcon size={22} />
          </div>
          <div className="memory-view__header-text">
            <h2 className="memory-view__title">Pesquisa</h2>
            <p className="memory-view__subtitle">
              Pesquisa profunda na web com fontes citadas
            </p>
          </div>
        </div>
        <button
          type="button"
          className="research-view__config-toggle"
          onClick={() => void toggleConfig()}
          aria-expanded={configOpen}
        >
          Configurar modelos
        </button>
      </div>

      {error && <div className="tasks-view__error research-view__error">{error}</div>}

      {/* Model config panel */}
      {configOpen && (
        <div className="research-config">
          <div className="research-config__row">
            {/* Busca em vez de `<select>`: o catálogo do OpenRouter vem inteiro
                (~400 modelos) desde que o teto de 80 saiu do backend. O id vai e
                volta VERBATIM — nada de reprefixar. */}
            <div className="research-config__field">
              <span className="research-config__label">Modelo de fan-out</span>
              <ModelPicker
                label="Modelo de fan-out"
                value={fanoutModel}
                groups={modelGroups}
                onChange={setFanoutModel}
              />
            </div>

            <div className="research-config__field">
              <span className="research-config__label">Modelo de sintese</span>
              <ModelPicker
                label="Modelo de sintese"
                value={synthModel}
                groups={modelGroups}
                onChange={setSynthModel}
              />
            </div>
          </div>

          <label className="research-config__field">
            <span className="research-config__label">Chave OpenRouter</span>
            <input
              type="password"
              className="research-config__input"
              value={orKey}
              onChange={(e) => setOrKey(e.target.value)}
              placeholder={config?.openrouter_key_set ? 'definida' : 'sk-or-...'}
              autoComplete="off"
            />
          </label>

          <div className="research-config__foot">
            <button
              type="button"
              className="research-view__primary"
              onClick={() => void handleSaveConfig()}
              disabled={savingConfig}
            >
              {savingConfig ? 'Salvando...' : 'Salvar'}
            </button>
          </div>
        </div>
      )}

      {/* Query bar */}
      <div className="research-composer">
        <textarea
          className="research-composer__field"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="O que voce quer pesquisar? Faca uma pergunta..."
          rows={3}
          disabled={running}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <div className="research-composer__foot">
          <div className="research-mode" role="group" aria-label="Modo de pesquisa">
            <button
              type="button"
              className={`research-mode__btn${mode === 'quick' ? ' is-active' : ''}`}
              onClick={() => setMode('quick')}
              aria-pressed={mode === 'quick'}
              disabled={running}
            >
              Quick
            </button>
            <button
              type="button"
              className={`research-mode__btn${mode === 'deep' ? ' is-active' : ''}`}
              onClick={() => setMode('deep')}
              aria-pressed={mode === 'deep'}
              disabled={running}
            >
              Deep
            </button>
          </div>
          {running ? (
            <button
              type="button"
              className="research-view__secondary"
              onClick={() => void handleCancel()}
              disabled={cancelling}
            >
              {cancelling ? 'Cancelando...' : 'Cancelar'}
            </button>
          ) : null}
          <button
            type="button"
            className="research-view__primary research-composer__submit"
            onClick={() => void handleSubmit()}
            disabled={running || !query.trim()}
          >
            <SearchIcon size={16} />
            <span>{running ? 'Pesquisando...' : 'Pesquisar'}</span>
          </button>
        </div>
      </div>

      <div className="research-view__body">
        {/* Live progress panel */}
        {(hasProgress || running) && !readOnly && (
          <div className="research-progress">
            {round && (
              <div className="research-progress__round">
                Round {round.n}/{round.total}
              </div>
            )}

            {subQuestions.length > 0 && (
              <div className="research-progress__block">
                <div className="research-progress__heading">Plano</div>
                <ul className="research-progress__plan">
                  {subQuestions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
                {criteria.length > 0 && (
                  <div className="research-progress__criteria">
                    {criteria.map((c, i) => (
                      <span key={i} className="research-progress__criterion">
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}

            {queries.length > 0 && (
              <div className="research-progress__block">
                <div className="research-progress__heading">Buscas</div>
                <div className="research-progress__queries">
                  {queries.map((q, i) => (
                    <span key={i} className="research-query-chip">
                      <SearchIcon size={12} />
                      {q}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {liveSources.length > 0 && (
              <div className="research-progress__block">
                <div className="research-progress__heading">
                  Fontes ({liveSources.length})
                </div>
                <div className="research-source-cards">
                  {liveSources.map((s) => (
                    <a
                      key={s.url}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className={`research-source-card${
                        s.read ? (s.ok === false ? ' is-failed' : ' is-read') : ''
                      }`}
                    >
                      <span className="research-source-card__title">{s.title || hostOf(s.url)}</span>
                      <span className="research-source-card__host">{hostOf(s.url)}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Report */}
        {report && (
          <div className="research-report">
            {finished && <div className="research-report__badge">Relatorio</div>}
            <div className="research-report__body">
              <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>{renderedReport}</Markdown>
            </div>

            {reportSources.length > 0 && (
              <div className="research-sources">
                <div className="research-sources__heading">Fontes</div>
                <ol className="research-sources__list">
                  {reportSources.map((s) => (
                    <li key={s.n ?? s.url} id={typeof s.n === 'number' ? `src-${s.n}` : undefined}>
                      <a href={s.url} target="_blank" rel="noreferrer noopener">
                        {s.title || s.url}
                      </a>
                      <span className="research-sources__host">{hostOf(s.url)}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}

        {/* History */}
        {history.length > 0 && (
          <div className="research-history">
            <div className="research-history__heading">Historico</div>
            <div className="research-history__list">
              {history.map((run) => (
                <button
                  key={run.id}
                  type="button"
                  className={`research-history__item${run.id === activeId ? ' is-active' : ''}`}
                  onClick={() => void handleOpenHistory(run.id)}
                >
                  <span className="research-history__query">{run.query}</span>
                  <span className="research-history__meta">
                    <span className={`research-badge research-badge--${run.mode}`}>
                      {run.mode === 'deep' ? 'Deep' : 'Quick'}
                    </span>
                    <span className={`research-status research-status--${run.status}`}>
                      {STATUS_LABEL[run.status]}
                    </span>
                    <span className="research-history__date">
                      {formatDate(run.created_at)}
                    </span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {!report && !hasProgress && !running && history.length === 0 && (
          <div className="research-view__empty">
            <div className="research-view__empty-icon">
              <SearchIcon size={30} />
            </div>
            <p className="research-view__empty-title">Faca sua primeira pesquisa</p>
            <p className="research-view__empty-hint">
              Escreva uma pergunta acima e escolha Quick (rapido) ou Deep (varias
              rodadas). A Seraphine busca na web, le as fontes e escreve um
              relatorio com citacoes.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
