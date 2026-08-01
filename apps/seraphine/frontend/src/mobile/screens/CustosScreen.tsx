import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, ChevronRightIcon, GaugeIcon, InsightsIcon, RefreshIcon } from '../../icons/Icons';
import {
  fetchEngineInfo,
  fetchTelemetrySummary,
  listFlatBackends,
  type EngineInfo,
  type TelemetrySummary,
} from '../../telemetry/api';
import type { ScreenProps } from './registry';
import './CustosScreen.css';

/* Tela CUSTOS & ENERGIA — visão geral (handoff v3, frame "Custos & Energia").
 * Adaptação do `telemetry/TelemetryView.tsx` (desktop) para o celular.
 *
 * Esta tela mostra DINHEIRO, e isso aperta a regra da onda: um custo exibido
 * errado é pior que um custo ausente — não quebra nada, não avisa ninguém e
 * corrói a confiança em todo o resto do app. Daí três decisões que valem para
 * o arquivo inteiro:
 *
 *  1. NENHUM valor default. Enquanto o dado não chegou é esqueleto; quando
 *     falha, é uma frase dizendo o que faltou. Nunca um zero de enfeite.
 *  2. NENHUMA estimativa no cliente. Percentual do teto, projeção e "estourou"
 *     vêm prontos do backend (Task 2). `spent / monthly` aqui daria `Infinity`
 *     no dia em que o teto for zero.
 *  3. NENHUMA cópia da lista de backends flat (Task 1) — ver o bloco abaixo.
 */

/* Quem custa $0 marginal é decidido por `pricing.FLAT_BACKENDS`, no backend,
 * que é quem PRECIFICA e GRAVA; esta tela só EXIBE. A lista chega por
 * `listFlatBackends()` e não existe cópia local aqui, em nenhuma forma —
 * constante, literal ou um `includes` com nome de backend escrito à mão. Nem
 * neste comentário, para que uma busca por nome de backend não encontre nada
 * neste arquivo e ninguém conclua que a lista mora aqui. A cópia do desktop
 * já divergiu do backend uma vez (latente: valeria $18 contra $0 em 1M/1M no
 * dia em que um sink fosse ligado), e recriá-la aqui refaria a classe do bug
 * que a Task 1 existe para matar.
 *
 * Enquanto a lista não chegou, a tela NÃO CLASSIFICA — esqueleto. Assumir
 * "flat" zera um custo real; assumir "medido" inventa um. Os dois chutes
 * mostram número errado numa tela de dinheiro, ainda que por um quadro só. */

type Periodo = 7 | 30;

/* ------------------------------------------------------------------ */
/*  Formatação (pt-BR)                                                 */
/* ------------------------------------------------------------------ */

/* Estes três são cópia deliberada dos helpers do `TelemetryView` — e a cópia
 * aqui é legítima, ao contrário da lista flat: formatar é apresentação pura,
 * sem política e sem dono no backend. Duas telas que formatam igual nunca
 * mostram números diferentes; duas telas que CLASSIFICAM igual, sim. Não os
 * importei porque não são exportados e `TelemetryView.tsx` não é meu arquivo. */

/** Custo em USD. Sub-centavo mantém 4 casas para não ser lido como "$0,00" —
 *  o backend devolve 6 casas desde 2026-07-31, então há precisão de sobra. */
function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v <= 0) return '0,00';
  if (v < 0.01) return v.toFixed(4).replace('.', ',');
  return v.toFixed(2).replace('.', ',');
}

/** Contagem compacta: 1234 → "1,2k", 1_200_000 → "1,2M". */
function fmtCount(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1).replace('.', ',')}k`;
  return `${(v / 1_000_000).toFixed(1).replace('.', ',')}M`;
}

/** Percentual sem clamp: 38,6667 → "39"; 5,25 → "5,3"; 162 → "162". */
function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)).replace('.', ',').replace(/,0$/, '');
}

/** "faltam 11 dias" / "falta 1 dia" / "último dia do mês". */
function fmtDiasRestantes(n: number): string {
  if (n <= 0) return 'último dia do mês';
  if (n === 1) return 'falta 1 dia';
  return `faltam ${n} dias`;
}

/* ------------------------------------------------------------------ */
/*  Teto do mês (bloco `budget` do summary — Task 2)                    */
/* ------------------------------------------------------------------ */

interface Teto {
  monthly: number;
  spent: number;
  daysLeft: number;
  projected: number;
  /** `null` com teto zero: não existe percentual de zero. Use `over`. */
  pctUsed: number | null;
  over: boolean;
}

type LeituraTeto =
  | { tipo: 'sem-teto' }   // `budget: null` — nunca configurado
  | { tipo: 'teto'; teto: Teto }
  | { tipo: 'ilegivel' };  // veio, mas fora do formato acordado

/** `TelemetrySummary` (em `telemetry/api.ts`, que não é meu arquivo) ainda não
 *  declara `budget`; o backend passou a mandá-lo na Task 2. Leio o campo com
 *  guarda de tipo em vez de confiar na forma: numa tela de dinheiro, um
 *  `spent_usd` que chega como string tem de virar aviso, não `NaN` na cara do
 *  usuário. `undefined` (backend anterior à Task 2) é tratado como "sem teto",
 *  o mesmo que `null` — é o que ele significava. */
function lerTeto(resumo: TelemetrySummary): LeituraTeto {
  const bruto = (resumo as unknown as { budget?: unknown }).budget;
  if (bruto === null || bruto === undefined) return { tipo: 'sem-teto' };
  if (typeof bruto !== 'object') return { tipo: 'ilegivel' };

  const b = bruto as Record<string, unknown>;
  const num = (x: unknown): number | null =>
    typeof x === 'number' && Number.isFinite(x) ? x : null;

  const monthly = num(b.monthly_usd);
  const spent = num(b.spent_usd);
  const daysLeft = num(b.days_left);
  const projected = num(b.projected_usd);
  const over = typeof b.over_budget === 'boolean' ? b.over_budget : null;
  // `pct_used` é `number | null` no contrato; qualquer outra coisa é ilegível.
  const pctUsed = b.pct_used === null ? null : num(b.pct_used);

  if (monthly === null || spent === null || daysLeft === null) return { tipo: 'ilegivel' };
  if (projected === null || over === null) return { tipo: 'ilegivel' };
  if (b.pct_used !== null && pctUsed === null) return { tipo: 'ilegivel' };

  return { tipo: 'teto', teto: { monthly, spent, daysLeft, projected, pctUsed, over } };
}

/* ------------------------------------------------------------------ */
/*  Tela                                                               */
/* ------------------------------------------------------------------ */

interface Divisao {
  chamadasFlat: number;
  chamadasMedidas: number;
  custoMedido: number;
  nomesFlat: string[];
  nomesMedidos: string[];
  pctFlat: number;
}

export function CustosScreen({ onBack, onOpen }: ScreenProps) {
  const [periodo, setPeriodo] = useState<Periodo>(7);
  const [resumo, setResumo] = useState<TelemetrySummary | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);

  // `null` = ainda não sabemos quem é flat → não classificar.
  const [flat, setFlat] = useState<Set<string> | null>(null);
  const [erroFlat, setErroFlat] = useState(false);

  const [motor, setMotor] = useState<EngineInfo | null>(null);
  const [erroMotor, setErroMotor] = useState(false);
  const [carregandoMotor, setCarregandoMotor] = useState(true);

  const req = useRef(0);

  // A lista de backends flat não depende do período: uma busca no mount.
  useEffect(() => {
    let vivo = true;
    listFlatBackends()
      .then((lista) => { if (vivo) { setFlat(new Set(lista)); setErroFlat(false); } })
      .catch(() => { if (vivo) { setFlat(null); setErroFlat(true); } });
    return () => { vivo = false; };
  }, []);

  // O motor ativo também não depende do período.
  useEffect(() => {
    let vivo = true;
    fetchEngineInfo()
      .then((m) => { if (vivo) { setMotor(m); setErroMotor(false); setCarregandoMotor(false); } })
      .catch(() => { if (vivo) { setMotor(null); setErroMotor(true); setCarregandoMotor(false); } });
    return () => { vivo = false; };
  }, []);

  const carregar = useCallback(async (p: Periodo): Promise<void> => {
    const id = ++req.current;
    setCarregando(true);
    setErro(false);
    try {
      const dado = await fetchTelemetrySummary(p);
      // Resposta de um período já abandonado não pode sobrescrever a atual.
      if (id === req.current) setResumo(dado);
    } catch {
      if (id === req.current) { setErro(true); setResumo(null); }
    } finally {
      if (id === req.current) setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(periodo); }, [periodo, carregar]);
  const atualizar = useCallback(() => { void carregar(periodo); }, [periodo, carregar]);

  /* A janela rotulada sai do `days` que o BACKEND ecoou, não do chip: enquanto
   * um período novo carrega, o herói continua mostrando o dado do anterior, e
   * rotulá-lo com o chip diria "30 dias" sobre números de 7. */
  const dias = typeof resumo?.days === 'number' && Number.isFinite(resumo.days) ? resumo.days : periodo;

  const divisao = useMemo<Divisao | null>(() => {
    if (!flat || !resumo) return null;
    let chamadasFlat = 0;
    let chamadasMedidas = 0;
    let custoMedido = 0;
    const nomesFlat: string[] = [];
    const nomesMedidos: string[] = [];
    for (const linha of resumo.by_backend ?? []) {
      if (flat.has(String(linha.backend).toLowerCase())) {
        chamadasFlat += linha.calls;
        if (linha.calls > 0) nomesFlat.push(linha.backend);
      } else {
        chamadasMedidas += linha.calls;
        custoMedido += linha.cost_usd;
        if (linha.calls > 0) nomesMedidos.push(linha.backend);
      }
    }
    const total = chamadasFlat + chamadasMedidas;
    return {
      chamadasFlat,
      chamadasMedidas,
      custoMedido,
      nomesFlat,
      nomesMedidos,
      pctFlat: total > 0 ? (chamadasFlat / total) * 100 : 0,
    };
  }, [flat, resumo]);

  const leitura = resumo ? lerTeto(resumo) : null;
  const semChamadas = !!resumo && (resumo.total?.calls ?? 0) === 0;
  const total = resumo?.total;

  return (
    <div className="ms-custos">
      <header className="ms-custos-head">
        <button type="button" className="ms-custos-voltar" aria-label="Voltar" onClick={onBack}>
          <ArrowLeftIcon size={18} />
        </button>
        <span className="ms-custos-head__icone" aria-hidden="true"><GaugeIcon size={17} /></span>
        <div className="ms-custos-head__texto">
          <h1 className="ms-custos-titulo">Custos &amp; Energia</h1>
          <p className="ms-custos-sub">Tokens, custo da nuvem e energia local</p>
        </div>
        <button
          type="button"
          className="ms-custos-atualizar"
          aria-label="Atualizar"
          onClick={atualizar}
          disabled={carregando}
        >
          <RefreshIcon size={15} />
        </button>
      </header>

      <div className="ms-custos-chips" role="group" aria-label="Período do relatório">
        {([7, 30] as const).map((p) => (
          <button
            key={p}
            type="button"
            className={`ms-custos-chip${periodo === p ? ' ms-custos-chip--ativo' : ''}`}
            aria-pressed={periodo === p}
            onClick={() => setPeriodo(p)}
          >
            {p} dias
          </button>
        ))}
      </div>

      <div className="ms-custos-corpo" aria-busy={carregando}>
        {/* Único `role="alert"` da tela: a falha do resumo, que é a que apaga
            os números. As demais são secundárias e usam `role="status"`. */}
        {erro && (
          <p className="ms-custos-erro" role="alert">
            Não consegui carregar os custos do período. Toque em atualizar para tentar de novo.
          </p>
        )}

        {/* ── herói: nuvem medida no período ── */}
        <section className="ms-custos-hero">
          <div className="ms-custos-hero__topo">
            <div className="ms-custos-hero__texto">
              <p className="ms-custos-hero__eyebrow">
                <GaugeIcon size={12} />
                Nuvem (medido) · últimos {dias} dias
              </p>
              {erro ? (
                <p className="ms-custos-indisp">Custo do período indisponível.</p>
              ) : divisao && resumo ? (
                semChamadas ? (
                  <p className="ms-custos-vazio">
                    Nenhuma chamada nos últimos {dias} dias — o custo aparece conforme
                    você conversa com a Seraphine.
                  </p>
                ) : (
                  <p className="ms-custos-hero__valor">${fmtUsd(divisao.custoMedido)}</p>
                )
              ) : erroFlat ? (
                <p className="ms-custos-status" role="status">
                  Não consegui separar nuvem medida de local: a lista de backends sem
                  custo marginal não carregou. Os totais abaixo seguem válidos.
                </p>
              ) : (
                <Esqueleto testId="custos-hero-esqueleto" linhas={3} />
              )}
            </div>
            <span className="ms-custos-hero__selo" aria-hidden="true"><GaugeIcon size={21} /></span>
          </div>

          {divisao && !semChamadas && !erro && (
            <>
              <div className="ms-custos-hero__contagem">
                <span>
                  <b>{fmtCount(divisao.chamadasMedidas)}</b> medidas · <b>{fmtCount(divisao.chamadasFlat)}</b> flat
                </span>
                <span className="ms-custos-hero__sem-custo">{fmtPct(divisao.pctFlat)}% sem custo</span>
              </div>
              <div
                className="ms-custos-hero__barra"
                data-flat={divisao.chamadasFlat}
                data-medidas={divisao.chamadasMedidas}
                role="img"
                aria-label={`${fmtPct(divisao.pctFlat)}% das chamadas sem custo marginal`}
              >
                <span className="ms-custos-hero__seg ms-custos-hero__seg--flat" style={{ width: `${divisao.pctFlat}%` }} />
                <span className="ms-custos-hero__seg ms-custos-hero__seg--medido" style={{ width: `${100 - divisao.pctFlat}%` }} />
              </div>
              <div className="ms-custos-hero__legenda">
                <span className="ms-custos-legenda__item">
                  <span className="ms-custos-legenda__ponto ms-custos-legenda__ponto--flat" aria-hidden="true" />
                  {divisao.nomesFlat.length > 0 ? divisao.nomesFlat.join(' · ') : 'nenhum backend flat'}
                </span>
                <span className="ms-custos-legenda__item">
                  <span className="ms-custos-legenda__ponto ms-custos-legenda__ponto--medido" aria-hidden="true" />
                  {divisao.nomesMedidos.length > 0 ? divisao.nomesMedidos.join(' · ') : 'nenhum backend medido'}
                </span>
              </div>
            </>
          )}
        </section>

        {/* ── onde foi o custo ──
            O frame do handoff desenha as duas telas de Custos e não desenha o
            controle entre elas; sem ele a tela B fica inalcançável. Esta linha
            é a mesma peça das Configurações (ícone 30 + nome + sub + chevron),
            e não um botão novo: é a forma que o app já usa para "esta linha
            leva a outra tela".

            Ela nasce logo ABAIXO do herói porque é o desdobramento DELE — o
            herói diz quanto custou, a tela B diz onde foi. E o sub diz "7
            dias" porque a tela B não tem seletor de período: com o chip em 30
            dias, entrar ali troca a janela, e uma tela de dinheiro não pode
            trocar a janela em silêncio.

            Botão que não navega é botão morto: só existe com `onOpen`. */}
        {onOpen && (
          <button
            type="button"
            className="ms-custos-detalhe"
            onClick={() => onOpen({ key: 'custos-detalhe', title: 'Onde foi o custo' })}
          >
            <span className="ms-custos-detalhe__icone" aria-hidden="true"><InsightsIcon size={16} /></span>
            <span className="ms-custos-detalhe__txt">
              <span className="ms-custos-detalhe__nome">Onde foi o custo</span>
              <span className="ms-custos-detalhe__sub">
                Por funcionalidade, por modelo e a energia do Mac · últimos 7 dias
              </span>
            </span>
            <ChevronRightIcon size={16} className="ms-custos-detalhe__chevron" />
          </button>
        )}

        {/* ── teto do mês ── */}
        <section className="ms-custos-teto">
          <div className="ms-custos-teto__head">
            <h2 className="ms-custos-teto__titulo">Teto do mês</h2>
            {/* O rótulo da janela não é decoração: `budget.spent_usd` é do mês
                corrente e IGNORA o `?days=` de propósito, então ele discorda
                por construção dos agregados de 7/30 dias exibidos acima. Sem
                dizer qual janela é qual, a tela mostra dois totais
                contraditórios e o usuário conclui que ela está quebrada.
                "este mês" sem o nome do mês porque o corte é feito em UTC: em
                UTC-3 a virada desloca 3h, e nomear o mês pelo relógio local
                afirmaria uma precisão que o dado não tem. */}
            <span className="ms-custos-teto__janela">este mês (fecha em UTC)</span>
          </div>

          {erro ? (
            <p className="ms-custos-indisp">Teto do mês indisponível.</p>
          ) : !leitura ? (
            <Esqueleto testId="custos-teto-esqueleto" linhas={3} />
          ) : leitura.tipo === 'ilegivel' ? (
            <p className="ms-custos-status" role="status">
              Não consegui ler o teto do mês: o backend respondeu num formato que eu não
              reconheço. Prefiro não mostrar número a mostrar o número errado.
            </p>
          ) : leitura.tipo === 'sem-teto' ? (
            <p className="ms-custos-teto__convite">
              Você ainda não definiu um teto mensal. Defina um em Configurações para
              acompanhar quanto do mês já foi gasto.
            </p>
          ) : (
            <BlocoTeto teto={leitura.teto} dias={dias} />
          )}
        </section>

        {/* ── tiles de tokens e chamadas ── */}
        <section className="ms-custos-tiles">
          <Tile rotulo="Tokens enviados" sub="entrada" carregando={carregando && !erro}
            valor={total && !erro ? fmtCount(total.input_tokens) : null} />
          <Tile rotulo="Tokens gerados" sub="saída" carregando={carregando && !erro}
            valor={total && !erro ? fmtCount(total.output_tokens) : null} />
          <Tile rotulo="Chamadas" sub={`nos últimos ${dias} dias`} carregando={carregando && !erro}
            valor={total && !erro ? fmtCount(total.calls) : null} />
        </section>

        {/* ── motor de inferência ── */}
        <section className="ms-custos-motor">
          <p className="ms-custos-motor__eyebrow">
            <GaugeIcon size={13} />
            MOTOR DE INFERÊNCIA
          </p>
          {carregandoMotor ? (
            <Esqueleto testId="custos-motor-esqueleto" linhas={2} />
          ) : erroMotor || !motor ? (
            <p className="ms-custos-status" role="status">
              Não consegui ler o motor de inferência ativo.
            </p>
          ) : (
            <>
              <div className="ms-custos-motor__linha">
                <span className="ms-custos-motor__nome">{motor.name}</span>
                <span className="ms-custos-motor__modelo">{motor.model}</span>
              </div>
              {/* Os chips vêm de `GET /llm/engine`, que descreve o motor ATIVO.
                  Não é a mesma coisa que a classificação do herói, que soma
                  chamadas já gravadas por vários backends do período. */}
              <div className="ms-custos-motor__chips">
                <span className="ms-custos-motor__chip">{motor.is_local ? 'local' : 'nuvem'}</span>
                <span className={`ms-custos-motor__chip ${motor.is_flat_cost ? 'ms-custos-motor__chip--verde' : 'ms-custos-motor__chip--ambar'}`}>
                  {motor.is_flat_cost ? 'flat $0' : 'medido'}
                </span>
                {motor.supports_tools && <span className="ms-custos-motor__chip">tools</span>}
                {motor.supports_vision && <span className="ms-custos-motor__chip">visão</span>}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Peças                                                              */
/* ------------------------------------------------------------------ */

/** Teto configurado. Todo número aqui veio pronto do backend: nenhuma divisão
 *  acontece nesta função. */
function BlocoTeto({ teto, dias }: { teto: Teto; dias: number }) {
  /* Largura da barra: `pct_used` existe → clamp em [0, 100] (162% é válido e
   * esperado, mas uma barra não passa da caixa). `pct_used` null é o teto zero,
   * onde não há percentual nenhum: aí a barra segue `over_budget` — cheia se
   * estourou, vazia se não houve gasto. */
  const largura = teto.pctUsed === null
    ? (teto.over ? 100 : 0)
    : Math.min(100, Math.max(0, teto.pctUsed));
  const estourou = teto.over || (teto.pctUsed !== null && teto.pctUsed > 100);
  // A projeção só é "risco" quando ultrapassa o teto — com teto zero, qualquer
  // projeção positiva já ultrapassa.
  const projecaoEmRisco = teto.projected > teto.monthly;

  return (
    <>
      <div className="ms-custos-teto__valores">
        <span className="ms-custos-teto__gasto">${fmtUsd(teto.spent)}</span>
        <span className="ms-custos-teto__limite">de ${fmtUsd(teto.monthly)}</span>
      </div>
      <div className="ms-custos-teto__trilho">
        <span
          className={`ms-custos-teto__fill${estourou ? ' ms-custos-teto__fill--estouro' : ''}`}
          style={{ width: `${largura}%` }}
        />
      </div>
      <div className="ms-custos-teto__rodape">
        <span className="ms-custos-teto__estado">
          {teto.pctUsed !== null
            ? `${fmtPct(teto.pctUsed)}% usado · ${fmtDiasRestantes(teto.daysLeft)}`
            : teto.over
              ? `teto estourado · ${fmtDiasRestantes(teto.daysLeft)}`
              : `nada gasto neste mês · ${fmtDiasRestantes(teto.daysLeft)}`}
        </span>
        <span className={`ms-custos-teto__projecao${projecaoEmRisco ? ' ms-custos-teto__projecao--risco' : ''}`}>
          projeção ${fmtUsd(teto.projected)}
        </span>
      </div>
      <p className="ms-custos-teto__nota">
        O teto é mensal e não acompanha o filtro de {dias} dias.
      </p>
    </>
  );
}

/** Tile de contagem, com os três estados separados: esperando é esqueleto,
 *  ausente é "—" com o rótulo dizendo o que faltou. Um zero aqui seria lido
 *  como fato — "não gastei nada" —, e é justamente o que não sabemos. */
function Tile({ rotulo, valor, sub, carregando }: {
  rotulo: string; valor: string | null; sub: string; carregando: boolean;
}) {
  return (
    <div className="ms-custos-tile">
      <span className="ms-custos-tile__rotulo">{rotulo}</span>
      {carregando
        ? <Esqueleto linhas={1} />
        : <span className="ms-custos-tile__valor">{valor ?? '—'}</span>}
      <span className="ms-custos-tile__sub">
        {carregando ? '' : valor === null ? 'indisponível' : sub}
      </span>
    </div>
  );
}

/** Espera sem texto: nenhum bloco pode piscar um número antes do dado. */
function Esqueleto({ linhas = 2, testId }: { linhas?: number; testId?: string }) {
  return (
    <span className="ms-custos-skel" aria-hidden="true" data-testid={testId}>
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </span>
  );
}
