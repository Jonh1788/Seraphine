import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  getFocusStats,
  getTimeByCategory,
  getWeeklyReport,
  listInsights,
} from '../../insights/api';
import type {
  FocusStats,
  Insight,
  TimeByCategoryEntry,
  WeeklyReport,
} from '../../insights/types';
import {
  ActivityIcon,
  ArrowLeftIcon,
  BookIcon,
  BriefcaseIcon,
  CoffeeIcon,
  DumbbellIcon,
  HeartIcon,
  LeafIcon,
  SparkleIcon,
  TargetIcon,
} from '../../icons/Icons';
import type { ScreenProps } from './registry';
import './InsightsScreen.css';

/* Tela INSIGHTS (handoff linha 549) — empurrada: ‹ + título, três stat-cards,
 * gráfico de barras da semana com o pico em accent, bloco "SERAPHINE NOTOU" e
 * as barras de "onde foi seu tempo".
 *
 * A tela é uma VISUALIZAÇÃO DE DADO, então duas coisas são invioláveis aqui:
 *  1. o pico é `Math.max` dos minutos reais — no handoff ele cai na quinta, mas
 *     fixar a quinta pintaria de accent um dia qualquer e inventaria a
 *     descoberta que o gráfico deveria mostrar;
 *  2. as barras escalam pelo pico da semana, com base zero. Sete barras da
 *     mesma altura por escala errada são piores que gráfico nenhum, porque
 *     parecem um achado.
 *
 * `PushedScreen` não desenha mais chrome: o ‹ é desta tela e chama `onBack`.
 *
 * Regra da onda: nenhum bloco some por falta de dado. Cada um tem três saídas —
 * dado, vazio (com a frase do seu domínio) e erro — e uma semana sem nenhuma
 * sessão é um estado real, que se diz em vez de virar moldura de gráfico vazia.
 */

/** Colunas do gráfico, segunda-primeiro, como no handoff. */
const ROTULOS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];
const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** Paleta das fatias de "onde foi seu tempo", por posto (a mais gorda primeiro).
 *  As três primeiras são as do handoff. */
const CORES = ['#42a5f5', '#ab47bc', '#26a69a', '#ff8a4c', '#9a93ff', '#fbbf24'];

/** Estado de uma chamada: `dado` só existe quando `erro` é falso. */
interface Fonte<T> { dado: T | null; erro: boolean }
const VAZIA = { dado: null, erro: false };

/** "2026-06-20" → Date local. `new Date(iso)` leria como UTC e deslocaria o dia. */
function dataLocal(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
}

/** Coluna segunda-primeiro (0=seg … 6=dom) de um ISO local. */
function coluna(iso: string): number {
  const js = dataLocal(iso).getDay();
  return js === 0 ? 6 : js - 1;
}

/** "Semana de 16–22 jun" (ou "28 jun – 4 jul" quando vira o mês). */
function faixaSemana(inicio: string, fim: string): string {
  const a = dataLocal(inicio);
  const b = dataLocal(fim);
  if (a.getMonth() === b.getMonth()) {
    return `Semana de ${a.getDate()}–${b.getDate()} ${MESES[b.getMonth()]}`;
  }
  return `Semana de ${a.getDate()} ${MESES[a.getMonth()]} – ${b.getDate()} ${MESES[b.getMonth()]}`;
}

/** Minutos → "45min" / "2,1h" / "28h". Vírgula decimal, e o ",0" sai fora. */
function duracao(min: number): string {
  if (min < 60) return `${Math.round(min)}min`;
  const h = (min / 60).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  return `${h}h`;
}

/** Ícone da categoria. Inline SVG do Icons.tsx — o handoff usa emoji, que o
 *  design system não admite. Sem correspondência: glifo genérico. */
function IconeCategoria({ nome }: { nome: string }) {
  const n = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (n.includes('trabalho') || n.includes('work')) return <BriefcaseIcon size={13} />;
  if (n.includes('estud') || n.includes('leitura') || n.includes('curso')) return <BookIcon size={13} />;
  if (n.includes('saude') || n.includes('health')) return <HeartIcon size={13} />;
  if (n.includes('treino') || n.includes('exerc') || n.includes('academia')) return <DumbbellIcon size={13} />;
  if (n.includes('pessoal') || n.includes('descanso')) return <LeafIcon size={13} />;
  if (n.includes('pausa') || n.includes('break')) return <CoffeeIcon size={13} />;
  if (n.includes('foco')) return <TargetIcon size={13} />;
  return <ActivityIcon size={13} />;
}

/** Humor médio da semana em palavra. O handoff mostra um emoji aqui; a palavra
 *  ocupa o mesmo lugar, carrega mais informação e não é emoji. */
function humor(mood: WeeklyReport['mood'] | undefined): string | null {
  const avgs = mood?.daily_avgs ?? [];
  if (!mood || !mood.total_logs || avgs.length === 0) return null;
  const media = avgs.reduce((s, d) => s + d.avg_valence, 0) / avgs.length;
  if (media > 0.3) return 'Bem';
  if (media < -0.3) return 'Baixo';
  return 'Neutro';
}

interface Barra { rotulo: string; min: number; pct: number; pico: boolean; fds: boolean }

export function InsightsScreen({ onBack }: ScreenProps) {
  const [insights, setInsights] = useState<Fonte<Insight[]>>(VAZIA);
  const [relatorio, setRelatorio] = useState<Fonte<WeeklyReport | null>>(VAZIA);
  const [foco, setFoco] = useState<Fonte<FocusStats | null>>(VAZIA);
  const [tempo, setTempo] = useState<Fonte<TimeByCategoryEntry[]>>(VAZIA);
  const [carregando, setCarregando] = useState(true);

  // As quatro chamadas são independentes: `allSettled` para a queda de uma não
  // apagar as outras três (era o que fazia a tela inteira sumir por um 500).
  useEffect(() => {
    let vivo = true;
    Promise.allSettled([
      listInsights(),
      getWeeklyReport(),
      getFocusStats('week'),
      getTimeByCategory('week'),
    ]).then(([ins, rel, fs, tc]) => {
      if (!vivo) return;
      setInsights(ins.status === 'fulfilled' ? { dado: ins.value, erro: false } : { dado: null, erro: true });
      setRelatorio(rel.status === 'fulfilled' ? { dado: rel.value, erro: false } : { dado: null, erro: true });
      setFoco(fs.status === 'fulfilled' ? { dado: fs.value, erro: false } : { dado: null, erro: true });
      setTempo(
        tc.status === 'fulfilled'
          ? { dado: tc.value?.categories ?? [], erro: false }
          : { dado: null, erro: true },
      );
      setCarregando(false);
    });
    return () => { vivo = false; };
  }, []);

  // Barras reais: os 7 dias que /focus/stats devolve caem cada um na SUA coluna
  // da semana, a escala é 0→pico e o pico é o máximo do conjunto.
  const barras = useMemo<Barra[]>(() => {
    const dias = foco.dado?.by_day ?? [];
    if (dias.length === 0) return [];
    const mins = ROTULOS.map(() => 0);
    const temDia = ROTULOS.map(() => false);
    dias.forEach((d) => {
      const c = coluna(d.date);
      mins[c] += d.focus_min;
      temDia[c] = true;
    });
    const pico = Math.max(...mins);
    if (pico <= 0) return [];
    const idxPico = mins.indexOf(pico);
    return ROTULOS.map((rotulo, i) => ({
      rotulo,
      min: mins[i],
      pct: Math.round((mins[i] / pico) * 100),
      pico: i === idxPico,
      fds: i >= 5,
    })).filter((_, i) => temDia[i]);
  }, [foco]);

  // Sem barra nenhuma e sem falha: a semana foi parada. Não depende de `dado`
  // ser um objeto — `/focus/stats` pode responder sem corpo JSON e devolver
  // `null`, e aí a moldura do gráfico ficaria vazia em vez de dizer o que houve.
  const semSessao = !carregando && !foco.erro && barras.length === 0;

  // Cabeçalho: a faixa da semana sai do dado que chegou, nunca de um chute.
  const faixa = useMemo(() => {
    const dias = foco.dado?.by_day ?? [];
    if (dias.length > 0) return faixaSemana(dias[0].date, dias[dias.length - 1].date);
    const r = relatorio.dado;
    if (r) return faixaSemana(r.week_start, r.week_end);
    return null;
  }, [foco, relatorio]);

  const rel = relatorio.dado;
  const feitas = typeof rel?.tasks?.completed === 'number' ? String(rel.tasks.completed) : null;
  const dias = foco.dado?.by_day?.length ?? 0;
  const focoDia = dias > 0 && foco.dado ? duracao(foco.dado.total_focus_min / dias) : null;
  const media = humor(rel?.mood);
  const erroResumo = relatorio.erro || foco.erro;

  const notou = (insights.dado ?? []).filter((i) => !i.dismissed).slice(0, 3);
  const linhas = tempo.dado ?? [];

  return (
    <div className="ms-insights">
      <header className="ms-insights-head">
        <button type="button" className="ms-insights-voltar" aria-label="Voltar" onClick={onBack}>
          <ArrowLeftIcon size={18} />
        </button>
        <div className="ms-insights-head__texto">
          <h1 className="ms-insights-titulo">Insights</h1>
          {carregando ? <Skel linhas={1} />
            : faixa ? <p className="ms-insights-sub">{faixa}</p>
            : <p className="ms-insights-sub">Semana ainda sem dados</p>}
        </div>
      </header>

      <div className="ms-insights-corpo">
        {/* ── três stat-cards ── */}
        <section className="ms-insights-stats">
          <div className="ms-insights-linha">
            <Stat carregando={carregando} valor={feitas}
              rotulo="tarefas feitas" ausente="sem balanço da semana" />
            <Stat carregando={carregando} valor={focoDia}
              rotulo="foco / dia" ausente="sem foco registrado" />
            <Stat carregando={carregando} valor={media}
              rotulo="humor médio" ausente="sem humor registrado" />
          </div>
          {!carregando && erroResumo && <Erro>Não consegui carregar o resumo da semana.</Erro>}
        </section>

        {/* ── produtividade da semana ── */}
        <section className="ms-insights-card ms-insights-grafico">
          <h2 className="ms-insights-card__titulo">Produtividade da semana</h2>
          {carregando ? <SkelBarras />
            : foco.erro ? <Erro>Não consegui carregar as sessões de foco desta semana.</Erro>
            : semSessao ? (
              <Vazio>
                Nenhuma sessão de foco nesta semana — o gráfico aparece quando você
                registrar a primeira.
              </Vazio>
            )
            : (
              <div className="ms-insights-barras">
                {barras.map((b) => (
                  <div key={b.rotulo} className="ms-insights-col">
                    <div
                      className={[
                        'ms-insights-barra',
                        b.pico ? 'ms-insights-barra--pico' : '',
                        !b.pico && b.fds ? 'ms-insights-barra--fds' : '',
                      ].filter(Boolean).join(' ')}
                      style={{ height: `${b.pct}%` }}
                      data-dia={b.rotulo}
                      data-min={b.min}
                      data-pct={b.pct}
                      role="img"
                      aria-label={`${b.rotulo}: ${duracao(b.min)} de foco`}
                    />
                    <span className={`ms-insights-rotulo${b.pico ? ' ms-insights-rotulo--pico' : ''}`}>
                      {b.rotulo}
                    </span>
                  </div>
                ))}
              </div>
            )}
        </section>

        {/* ── SERAPHINE NOTOU ── */}
        <section className="ms-insights-notou">
          <div className="ms-insights-notou__head">
            <span className="ms-insights-notou__icone" aria-hidden="true"><SparkleIcon size={13} /></span>
            <span className="ms-insights-notou__eyebrow">SERAPHINE NOTOU</span>
          </div>
          {carregando ? <Skel linhas={2} />
            : insights.erro ? <Erro>Não consegui carregar o que eu notei nesta semana.</Erro>
            : notou.length === 0 ? (
              <Vazio>
                Ainda não encontrei padrões nesta semana — preciso de mais alguns
                dias de tarefas, foco e hábitos.
              </Vazio>
            )
            : notou.map((i) => (
              <p key={i.id} className="ms-insights-notou__texto">{i.description || i.title}</p>
            ))}
        </section>

        {/* ── onde foi seu tempo ── */}
        <section className="ms-insights-card ms-insights-tempo">
          <h2 className="ms-insights-card__titulo">Onde foi seu tempo</h2>
          {carregando ? <Skel linhas={3} />
            : tempo.erro ? <Erro>Não consegui somar onde seu tempo foi nesta semana.</Erro>
            : linhas.length === 0 ? (
              <Vazio>
                Nenhuma sessão de foco categorizada nesta semana — escolha a
                categoria ao iniciar o foco para ver a divisão aqui.
              </Vazio>
            )
            : (
              <div className="ms-insights-tempo__linhas">
                {linhas.map((c, i) => (
                  <div key={c.category}>
                    <div className="ms-insights-tempo__head">
                      <span className="ms-insights-tempo__nome">
                        <span className="ms-insights-tempo__icone" aria-hidden="true">
                          <IconeCategoria nome={c.category} />
                        </span>
                        {c.category}
                      </span>
                      <span className="ms-insights-tempo__valor">{duracao(c.focus_min)}</span>
                    </div>
                    <div className="ms-insights-trilho">
                      <span
                        className="ms-insights-fatia"
                        style={{ width: `${c.pct}%`, background: CORES[i % CORES.length] }}
                        data-cat={c.category}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
        </section>
      </div>
    </div>
  );
}

/** Stat-card: valor grande + rótulo. Sem dado, o valor vira "—" e o RÓTULO diz
 *  o que falta — assim a ausência é lida, não apenas notada. */
function Stat({ carregando, valor, rotulo, ausente }: {
  carregando: boolean; valor: string | null; rotulo: string; ausente: string;
}) {
  return (
    <div className="ms-insights-stat">
      {carregando
        ? <Skel linhas={1} />
        : <span className="ms-insights-stat__valor">{valor ?? '—'}</span>}
      <span className="ms-insights-stat__rotulo">{carregando ? '' : valor ? rotulo : ausente}</span>
    </div>
  );
}

/** Vazio: o bloco continua de pé e diz o que exatamente não há. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-insights-vazio">{children}</p>;
}

/** Erro: tinta de perigo, para nunca ser lido como "a semana foi parada". */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-insights-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nenhum bloco pode piscar "nada aqui" antes do dado. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-insights-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

/** Esqueleto do gráfico: colunas cinzentas, sem número e sem legenda. */
function SkelBarras() {
  return (
    <div className="ms-insights-skel ms-insights-skel--barras" aria-hidden="true">
      {ROTULOS.map((r) => <span key={r} />)}
    </div>
  );
}
