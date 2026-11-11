import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeftIcon, SparkleIcon } from '../../icons/Icons';
import {
  cacheHitRate,
  fetchTelemetrySummary,
  listFlatBackends,
  readPower,
  type PowerSample,
  type TelemetrySummary,
} from '../../telemetry/api';
import type { ScreenProps } from './registry';
import './CustosDetalheScreen.css';

/* Tela CUSTOS & ENERGIA — DETALHE (handoff v3, frame "Custos & Energia ·
 * detalhe"). Irmã da `CustosScreen`: lá está o total do período e o teto do
 * mês; aqui está ONDE o dinheiro foi — por funcionalidade e por modelo — mais
 * a energia da máquina local.
 *
 * As três regras da tela irmã valem inteiras, porque a matéria é a mesma:
 *
 *  1. NENHUM valor default. Enquanto o dado não chegou é esqueleto; quando
 *     falha, é uma frase dizendo o que faltou. Nunca um zero de enfeite —
 *     zero é um VALOR, e afirma que não houve consumo.
 *  2. NENHUMA estimativa no cliente. O que se calcula aqui é aritmética sobre
 *     os números exibidos (proporção de barra, soma das colunas), nunca
 *     previsão nem conversão inventada.
 *  3. NENHUMA cópia da lista de backends flat (Task 1) — ver o bloco abaixo.
 */

/* Quem custa $0 marginal é decidido por `pricing.FLAT_BACKENDS`, no backend,
 * que é quem PRECIFICA e GRAVA; esta tela só EXIBE. A lista chega por
 * `listFlatBackends()` e não existe cópia local aqui em forma nenhuma —
 * constante, literal, `includes` com nome de backend escrito à mão, e nem em
 * comentário, para que uma busca por nome de backend não encontre nada neste
 * arquivo e ninguém conclua que a lista mora aqui. A cópia do desktop já
 * divergiu do backend uma vez, e recriá-la refaria a classe do bug que a
 * Task 1 existe para matar.
 *
 * O que a lista decide NESTA tela:
 *
 *   a) o `$0` em verde e a frase "sem custo marginal" — dizer que uma chamada
 *      é de graça POR DESENHO é uma afirmação, e ela é do backend, não minha.
 *      Um `$0` gravado só diz que o custo registrado foi zero;
 *   b) se TODO o período rodou flat, caso em que ordenar por custo devolve uma
 *      lista com tudo zerado, cuja ordem parece aleatória — aí a ordem é o
 *      volume de chamadas (o mesmo fallback do `TelemetryView` no desktop).
 *
 * Enquanto ela não chegou, a tela NÃO CLASSIFICA: os dois blocos de custo
 * ficam em esqueleto. Se ela FALHA, os números gravados aparecem (são fato)
 * mas sem a marcação de flat (é a afirmação que não pude confirmar). */

/** O frame de detalhe não tem seletor de período: ele é o recorte de 7 dias da
 *  visão geral. O rótulo, ainda assim, sai do `days` que o BACKEND ecoou. */
const PERIODO = 7;

/** Colunas que cabem lado a lado num telefone. O resto não some: vira uma
 *  linha somada abaixo, porque esconder gasto é a falha desta tela. */
const MAX_COLUNAS = 5;

/* ------------------------------------------------------------------ */
/*  Formatação (pt-BR)                                                 */
/* ------------------------------------------------------------------ */

/* Cópia deliberada dos helpers da `CustosScreen` — e legítima, ao contrário da
 * lista flat: formatar é apresentação pura, sem política e sem dono no
 * backend. Duas telas que formatam igual nunca mostram números diferentes. Não
 * os importei porque não são exportados e aquele arquivo não é meu. */

/** Custo em USD. Sub-centavo mantém 4 casas para não ser lido como "$0,00" —
 *  o backend arredonda em 6 casas, então há precisão de sobra. */
function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v <= 0) return '0,00';
  if (v < 0.01) return v.toFixed(4).replace('.', ',');
  return v.toFixed(2).replace('.', ',');
}

/** Custo de uma linha: zero é escrito `$0`, não `$0,00` — a casa decimal
 *  sugeriria um arredondamento que não houve. Mesma escolha do desktop. */
function fmtCusto(v: number): string {
  return v > 0 ? `$${fmtUsd(v)}` : '$0';
}

/** Contagem com separador de milhar pt-BR: 1402 → "1.402". Feito à mão em vez
 *  de `toLocaleString` para não depender do ICU do runtime. */
function fmtCount(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return String(Math.trunc(v)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Percentual inteiro acima de 10, uma casa abaixo: 64,78 → "65"; 5,25 → "5,3". */
function fmtPct(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)).replace('.', ',').replace(/,0$/, '');
}

/** mW → W com uma casa: 3200 → "3,2". */
function fmtWatts(mw: number): string {
  return (mw / 1000).toFixed(1).replace('.', ',');
}

/** Proporção de barra, arredondada em uma casa. É desenho, não número exibido. */
function proporcao(v: number, max: number): string {
  if (!(max > 0) || !Number.isFinite(v) || v <= 0) return '0%';
  return `${Math.round(Math.min(v / max, 1) * 1000) / 10}%`;
}

/* Paleta do ponto de provedor. Cores FIXAS, escolhidas para não colidir com o
 * significado que a tela já dá ao verde (sem custo marginal), ao âmbar (o
 * maior gasto) e ao vermelho (falha). O índice sai de um hash do provedor:
 * mesmo provedor, mesma cor, sempre — e nenhuma cor de marca é afirmada, o que
 * seria um mapa a manter e a errar. */
const CORES_PROVEDOR = ['#9a93ff', '#4fa3ff', '#c48bff', '#4fc3c9', '#e08bd0', '#7f8cff'];

/** O provedor é o prefixo antes da `/` no id do modelo (`anthropic/…`), que é
 *  dado literal do backend. Sem `/`, o id inteiro identifica a origem. */
function provedorDe(modelo: string): string {
  const corte = modelo.indexOf('/');
  return corte > 0 ? modelo.slice(0, corte) : modelo;
}

function corDoProvedor(provedor: string): string {
  let h = 0;
  for (let i = 0; i < provedor.length; i++) h = (h * 31 + provedor.charCodeAt(i)) >>> 0;
  return CORES_PROVEDOR[h % CORES_PROVEDOR.length];
}

/* ------------------------------------------------------------------ */
/*  Leitura defensiva do payload                                       */
/* ------------------------------------------------------------------ */

interface Linha {
  nome: string;
  custo: number;
  chamadas: number;
  /** Fração da entrada lida do cache de prompt. `null` = não dá para dizer:
   *  backend que não reporta (cliproxy) ou período sem entrada. Distinto de 0,
   *  que é "o cache não pegou nada" — e esse é um diagnóstico de verdade. */
  cache?: number | null;
}

const numero = (x: unknown): number | null =>
  typeof x === 'number' && Number.isFinite(x) ? x : null;

/** Converte as linhas do resumo, DESCARTANDO as que não têm a forma acordada e
 *  contando quantas caíram. Numa tela de dinheiro, um `cost_usd` que chega
 *  como string ou `null` tem de virar aviso, não `NaN` na cara do usuário — e
 *  sumir com a linha em silêncio esconderia gasto, que é a falha desta tela. */
function lerLinhas(bruto: unknown, chave: 'feature' | 'model'): { linhas: Linha[]; descartadas: number } {
  if (!Array.isArray(bruto)) return { linhas: [], descartadas: 0 };
  const linhas: Linha[] = [];
  let descartadas = 0;
  for (const item of bruto) {
    const r = (item ?? {}) as Record<string, unknown>;
    const nome = r[chave];
    const custo = numero(r.cost_usd);
    const chamadas = numero(r.calls);
    if (typeof nome !== 'string' || !nome || custo === null || chamadas === null || custo < 0) {
      descartadas++;
      continue;
    }
    /* O cache é OPCIONAL e não entra no descarte: ele é informação extra sobre
       uma linha válida. Uma linha de gasto legítima não pode sumir da tela de
       dinheiro porque o backend não mandou um contador de cache. */
    const entrada = numero(r.input_tokens);
    const cache =
      entrada !== null
        ? cacheHitRate({
            input_tokens: entrada,
            cache_read_tokens: numero(r.cache_read_tokens) ?? 0,
            cache_write_tokens: numero(r.cache_write_tokens) ?? 0,
          })
        : null;
    linhas.push({ nome, custo, chamadas, cache });
  }
  return { linhas, descartadas };
}

/* ------------------------------------------------------------------ */
/*  Tela                                                               */
/* ------------------------------------------------------------------ */

export function CustosDetalheScreen({ onBack, onOpen }: ScreenProps) {
  const [resumo, setResumo] = useState<TelemetrySummary | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);

  // `null` = ainda não sabemos quem é flat → não classificar.
  const [flat, setFlat] = useState<Set<string> | null>(null);
  const [erroFlat, setErroFlat] = useState(false);

  const [sugestaoOculta, setSugestaoOculta] = useState(false);

  const carregar = useCallback(async (): Promise<void> => {
    setCarregando(true);
    setErro(false);
    try {
      const dado = await fetchTelemetrySummary(PERIODO);
      setResumo(dado);
    } catch {
      setErro(true);
      setResumo(null);
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  // A lista de backends flat não depende do período: uma busca no mount.
  useEffect(() => {
    let vivo = true;
    listFlatBackends()
      .then((lista) => { if (vivo) { setFlat(new Set(lista)); setErroFlat(false); } })
      .catch(() => { if (vivo) { setFlat(null); setErroFlat(true); } });
    return () => { vivo = false; };
  }, []);

  const dias = typeof resumo?.days === 'number' && Number.isFinite(resumo.days) ? resumo.days : PERIODO;

  const funcs = useMemo(() => lerLinhas(resumo?.by_feature, 'feature'), [resumo]);
  const modelos = useMemo(() => lerLinhas(resumo?.by_model, 'model'), [resumo]);
  const descartadas = funcs.descartadas + modelos.descartadas;

  /** Divisão flat vs medido do período, pela lista do backend. `null` enquanto
   *  ela não chegou (ou se falhou): sem ela não há afirmação de flat a fazer. */
  const divisao = useMemo(() => {
    if (!flat || !resumo) return null;
    let chamadasFlat = 0;
    let chamadasMedidas = 0;
    const nomesFlat: string[] = [];
    for (const linha of Array.isArray(resumo.by_backend) ? resumo.by_backend : []) {
      const chamadas = numero(linha?.calls) ?? 0;
      if (flat.has(String(linha?.backend).toLowerCase())) {
        chamadasFlat += chamadas;
        if (chamadas > 0) nomesFlat.push(String(linha.backend));
      } else {
        chamadasMedidas += chamadas;
      }
    }
    return { chamadasFlat, chamadasMedidas, nomesFlat };
  }, [flat, resumo]);

  /* A métrica que ordena e dimensiona as barras. Ordenar por custo com tudo
   * zerado dá uma lista que parece aleatória — o backend ordena por custo
   * DESC, e o empate em zero fica na ordem que o SQLite devolveu. Quando não
   * há custo nenhum, o que comunica uso é o volume. É o mesmo fallback do
   * `TelemetryView` no desktop, e ele é derivado dos números EXIBIDOS: não
   * depende da lista flat porque não afirma nada sobre por que são zero. */
  const algumCusto = funcs.linhas.some((l) => l.custo > 0) || modelos.linhas.some((l) => l.custo > 0);
  const porCusto = algumCusto;

  /* "Todo o período rodou sem custo marginal" é uma AFIRMAÇÃO, e por isso
   * precisa das duas pernas: a lista do backend dizendo que nenhuma chamada
   * foi medida, E nenhum custo gravado nas linhas. A segunda perna existe
   * porque a Task 1 mudou a lista: linhas gravadas ANTES dela podem carregar
   * um custo em backend que hoje é flat, e a frase contradiria, na mesma
   * tela, um cifrão visível ao lado. */
  const tudoFlat = !!divisao && divisao.chamadasMedidas === 0 && divisao.chamadasFlat > 0 && !algumCusto;

  const estado: 'erro' | 'esqueleto' | 'dado' =
    erro ? 'erro'
      : (!resumo || (flat === null && !erroFlat)) ? 'esqueleto'
        : 'dado';

  const ordenar = useCallback(
    (linhas: Linha[]) =>
      [...linhas].sort((a, b) => (porCusto ? b.custo - a.custo : b.chamadas - a.chamadas)),
    [porCusto],
  );

  const colunas = useMemo(() => ordenar(funcs.linhas), [ordenar, funcs.linhas]);
  const barras = useMemo(() => ordenar(modelos.linhas), [ordenar, modelos.linhas]);

  const somaFuncs = funcs.linhas.reduce((s, l) => s + l.custo, 0);
  const visiveis = colunas.slice(0, MAX_COLUNAS);
  const resto = colunas.slice(MAX_COLUNAS);
  const maxColuna = Math.max(0, ...visiveis.map((l) => (porCusto ? l.custo : l.chamadas)));
  const maxBarra = Math.max(0, ...barras.map((l) => (porCusto ? l.custo : l.chamadas)));

  /* O maior gasto só existe quando existe gasto: com tudo zerado ninguém é o
   * campeão, e pintar o primeiro de âmbar afirmaria um custo que não houve. */
  const maiorGasto = porCusto && colunas.length > 0 && colunas[0].custo > 0 ? colunas[0].nome : null;

  /* Sugestão DERIVADA: a funcionalidade mais cara e o quanto ela pesa. Some
   * quando não há o que dizer — uma funcionalidade só não dá comparação, e
   * período sem custo não dá conselho de custo. Conselho inventado sobre
   * dinheiro é pior que silêncio. */
  const sugestao = estado === 'dado' && !sugestaoOculta && porCusto
    && colunas.length >= 2 && colunas[0].custo > 0 && somaFuncs > 0
    ? { nome: colunas[0].nome, custo: colunas[0].custo, total: somaFuncs, pct: (colunas[0].custo / somaFuncs) * 100 }
    : null;

  return (
    <div className="ms-custosdet">
      <header className="ms-custosdet-head">
        <button type="button" className="ms-custosdet-voltar" aria-label="Voltar" onClick={onBack}>
          <ArrowLeftIcon size={18} />
        </button>
        <div className="ms-custosdet-head__texto">
          <h1 className="ms-custosdet-titulo">Onde foi o custo</h1>
          <p className="ms-custosdet-sub">Últimos {dias} dias</p>
        </div>
      </header>

      <div className="ms-custosdet-corpo" aria-busy={carregando}>
        {/* Único `role="alert"` da tela: a falha do resumo, que é a que apaga
            os números. As demais avisam em `role="status"`. */}
        {erro && (
          <div className="ms-custosdet-erro" role="alert">
            <p>Não consegui carregar o detalhe de custos do período.</p>
            <button type="button" className="ms-custosdet-retry" onClick={() => void carregar()}>
              Tentar de novo
            </button>
          </div>
        )}

        {descartadas > 0 && (
          <p className="ms-custosdet-status" role="status">
            {descartadas === 1
              ? 'Uma linha do período veio num formato que não reconheço e ficou de fora das somas abaixo.'
              : `${fmtCount(descartadas)} linhas do período vieram num formato que não reconheço e ficaram de fora das somas abaixo.`}
          </p>
        )}

        {erroFlat && estado !== 'erro' && (
          <p className="ms-custosdet-status" role="status">
            Não consegui confirmar quais backends não têm custo marginal — os valores
            abaixo são os gravados, sem essa marcação.
          </p>
        )}

        {/* ── por funcionalidade: colunas verticais ── */}
        <section className="ms-custosdet-func">
          <div className="ms-custosdet-cabeca">
            <h2 className="ms-custosdet-cabeca__titulo">Por funcionalidade</h2>
            {estado === 'dado' && colunas.length > 0 && (
              <span className="ms-custosdet-cabeca__total">{fmtCusto(somaFuncs)} no total</span>
            )}
          </div>

          {estado === 'erro' ? (
            <p className="ms-custosdet-indisp">Detalhe por funcionalidade indisponível.</p>
          ) : estado === 'esqueleto' ? (
            <Esqueleto testId="custosdet-func-esqueleto" linhas={3} />
          ) : colunas.length === 0 ? (
            <p className="ms-custosdet-vazio">
              Nenhuma chamada nos últimos {dias} dias — o detalhe aparece conforme você
              conversa com a Seraphine.
            </p>
          ) : (
            <>
              <div className="ms-custosdet-colunas">
                {visiveis.map((l) => {
                  const zero = l.custo <= 0;
                  const ambar = l.nome === maiorGasto;
                  /* O verde de "sem custo marginal" só é aplicado quando a
                     lista do backend confirmou o período. Sem ela, `$0` é só o
                     custo gravado, e vai em tinta neutra. */
                  const marcaZero = zero && !!divisao;
                  return (
                    <div
                      key={l.nome}
                      className={`ms-custosdet-col${ambar ? ' ms-custosdet-col--ambar' : ''}${marcaZero ? ' ms-custosdet-col--zero' : ''}`}
                      data-nome={l.nome}
                      data-custo={l.custo}
                      data-chamadas={l.chamadas}
                    >
                      <span className="ms-custosdet-col__custo">{fmtCusto(l.custo)}</span>
                      <span className="ms-custosdet-col__trilho">
                        <span
                          className="ms-custosdet-col__barra"
                          style={{ height: proporcao(porCusto ? l.custo : l.chamadas, maxColuna) }}
                        />
                      </span>
                      <span className="ms-custosdet-col__nome" title={l.nome}>{l.nome}</span>
                    </div>
                  );
                })}
              </div>
              {resto.length > 0 && (
                <p className="ms-custosdet-resto">
                  {`+${fmtCount(resto.length)} outras · ${fmtCusto(resto.reduce((s, l) => s + l.custo, 0))} · ${fmtCount(resto.reduce((s, l) => s + l.chamadas, 0))}×`}
                </p>
              )}
            </>
          )}
        </section>

        {/* ── por modelo: barras horizontais ── */}
        <section className="ms-custosdet-modelos">
          <div className="ms-custosdet-cabeca">
            <h2 className="ms-custosdet-cabeca__titulo">Por modelo</h2>
          </div>

          {estado === 'erro' ? (
            <p className="ms-custosdet-indisp">Detalhe por modelo indisponível.</p>
          ) : estado === 'esqueleto' ? (
            <Esqueleto testId="custosdet-modelos-esqueleto" linhas={3} />
          ) : barras.length === 0 ? (
            <p className="ms-custosdet-vazio">Nenhuma chamada nos últimos {dias} dias.</p>
          ) : (
            <>
              {barras.map((l) => {
                const provedor = provedorDe(l.nome);
                const cor = corDoProvedor(provedor);
                const marcaZero = l.custo <= 0 && !!divisao;
                return (
                  <div
                    key={l.nome}
                    className="ms-custosdet-linha"
                    data-modelo={l.nome}
                    data-provedor={provedor}
                    data-custo={l.custo}
                    data-chamadas={l.chamadas}
                  >
                    <div className="ms-custosdet-linha__topo">
                      <span className="ms-custosdet-linha__id">
                        <span
                          className="ms-custosdet-linha__ponto"
                          style={{ background: cor }}
                          aria-hidden="true"
                        />
                        <span className="ms-custosdet-linha__nome" title={l.nome}>{l.nome}</span>
                      </span>
                      <span className="ms-custosdet-linha__meta">
                        <span className={`ms-custosdet-linha__custo${marcaZero ? ' ms-custosdet-linha__custo--flat' : ''}`}>
                          {fmtCusto(l.custo)}
                        </span>
                        {/* Cache por modelo: ele é por prefixo de prompt, então
                            um modelo pode estar acertando enquanto outro nunca
                            aquece. Omitido quando não há dado — nunca zerado. */}
                        {l.cache !== null && l.cache !== undefined && (
                          <span className="ms-custosdet-linha__cache">
                            cache {Math.round(l.cache * 100)}%
                          </span>
                        )}
                        <span className="ms-custosdet-linha__chamadas">{fmtCount(l.chamadas)}×</span>
                      </span>
                    </div>
                    <span className="ms-custosdet-linha__trilho">
                      <span
                        className={`ms-custosdet-linha__fill${marcaZero ? ' ms-custosdet-linha__fill--flat' : ''}`}
                        style={{
                          width: proporcao(porCusto ? l.custo : l.chamadas, maxBarra),
                          ...(marcaZero ? {} : { background: cor }),
                        }}
                      />
                    </span>
                  </div>
                );
              })}

              {/* Duas frases com fundamentos diferentes, e por isso separadas.
                  A primeira explica a ORDEM e sai dos números exibidos. A
                  segunda é a afirmação de flat, e só existe com a lista do
                  backend em mãos — é ela que a sustenta. */}
              {!porCusto && (
                <p className="ms-custosdet-nota" role="status">
                  Nenhuma chamada do período teve custo gravado — a lista está ordenada por
                  volume de chamadas, que é o que sobra para comparar.
                </p>
              )}
              {divisao && divisao.nomesFlat.length > 0 && (
                <p className="ms-custosdet-nota" role="status">
                  {tudoFlat
                    ? `Todas as ${fmtCount(divisao.chamadasFlat)} chamadas do período rodaram sem custo marginal (${divisao.nomesFlat.join(' · ')}).`
                    : `${fmtCount(divisao.chamadasFlat)} chamadas do período rodaram sem custo marginal (${divisao.nomesFlat.join(' · ')}).`}
                </p>
              )}
            </>
          )}
        </section>

        <Energia />

        {sugestao && (
          <section className="ms-custosdet-sugestao">
            <span className="ms-custosdet-sugestao__icone" aria-hidden="true"><SparkleIcon size={15} /></span>
            <div className="ms-custosdet-sugestao__corpo">
              <p className="ms-custosdet-sugestao__texto">
                <strong>{sugestao.nome}</strong> levou <strong>{fmtCusto(sugestao.custo)}</strong>
                {` dos ${fmtCusto(sugestao.total)} do período — ${fmtPct(sugestao.pct)}% do custo. Se for cortar, comece por ela.`}
              </p>
              <div className="ms-custosdet-sugestao__acoes">
                {/* Botão que não navega é botão morto: só existe com `onOpen`. */}
                {onOpen && (
                  <button
                    type="button"
                    className="ms-custosdet-botao ms-custosdet-botao--primario"
                    onClick={() => onOpen({ key: 'seletor-modelo', title: 'Modelo' })}
                  >
                    Trocar modelo
                  </button>
                )}
                <button
                  type="button"
                  className="ms-custosdet-botao"
                  onClick={() => setSugestaoOculta(true)}
                >
                  Agora não
                </button>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Energia (Mac local) — comando Tauri `read_power`                    */
/* ------------------------------------------------------------------ */

/** Três medidores em watts, amostrados a cada 3s enquanto a tela está montada.
 *
 *  `readPower()` nunca lança: fora do Tauri (navegador, teste) o comando não
 *  existe e a resposta é `{ supported: false }` — AUSÊNCIA, não erro, e por
 *  isso nada aqui usa `role="alert"`.
 *
 *  A distinção que este bloco existe para preservar: enquanto a primeira
 *  amostra não voltou, NÃO SABEMOS se há suporte, e afirmar "indisponível"
 *  antes de saber é o mesmo erro de mostrar um zero — só que na outra direção.
 *  Por isso a espera é esqueleto: o `null` inicial é um terceiro estado de
 *  verdade, não um atalho para o estado sem suporte. */
function Energia() {
  const [amostra, setAmostra] = useState<PowerSample | null>(null);

  useEffect(() => {
    let vivo = true;
    const ler = async (): Promise<void> => {
      const s = await readPower();
      if (vivo) setAmostra(s);
    };
    void ler();
    const id = window.setInterval(() => { void ler(); }, 3000);
    return () => { vivo = false; window.clearInterval(id); };
  }, []);

  const suportado = amostra?.supported === true;

  return (
    <section className="ms-custosdet-energia">
      <div className="ms-custosdet-cabeca">
        <h2 className="ms-custosdet-cabeca__titulo">Energia (Mac local)</h2>
        {suportado && (
          <span className="ms-custosdet-vivo">
            <span className="ms-custosdet-vivo__ponto" aria-hidden="true" />
            ao vivo
          </span>
        )}
      </div>

      {amostra === null ? (
        <Esqueleto testId="custosdet-energia-esqueleto" linhas={1} />
      ) : suportado ? (
        <div className="ms-custosdet-medidores">
          <Medidor rotulo="CPU" mw={amostra.cpu_mw} />
          <Medidor rotulo="GPU" mw={amostra.gpu_mw} />
          <Medidor rotulo="Pacote" mw={amostra.package_mw} />
        </div>
      ) : (
        /* Sem suporte é uma FRASE, nunca um zero: zero afirma que não houve
           consumo, e o que há aqui é a falta da medida. São coisas diferentes,
           e no celular a segunda é o caso normal. */
        <p className="ms-custosdet-status" role="status">
          Energia indisponível — a leitura vem do <code>powermetrics</code>, que só roda
          no app do Mac. Sem medição, não há watt para mostrar.
        </p>
      )}
    </section>
  );
}

/** Um medidor. `mw` ausente (o comando serializa como `null` o campo que não
 *  parseou) vira travessão: o mesmo motivo do bloco inteiro, uma escala abaixo. */
function Medidor({ rotulo, mw }: { rotulo: string; mw?: number }) {
  const tem = typeof mw === 'number' && Number.isFinite(mw);
  return (
    <div className="ms-custosdet-medidor" data-medidor={rotulo}>
      <span className="ms-custosdet-medidor__rotulo">{rotulo}</span>
      <span className="ms-custosdet-medidor__valor">
        {tem ? <>{fmtWatts(mw)}<small>W</small></> : '—'}
      </span>
    </div>
  );
}

/** Espera sem texto: nenhum bloco pode piscar um número antes do dado. */
function Esqueleto({ linhas = 2, testId }: { linhas?: number; testId?: string }) {
  return (
    <span className="ms-custosdet-skel" aria-hidden="true" data-testid={testId}>
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </span>
  );
}
