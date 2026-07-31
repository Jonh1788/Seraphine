import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { fetchBalance, fetchSummary, listEntries } from '../../finance/api';
import type { CategorySummary, FinanceEntry, FinanceSummary } from '../../finance/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../finance/types';
import { ArrowLeftIcon, PlusIcon } from '../../icons/Icons';
import type { ScreenProps } from './registry';
import './FinancasScreen.css';

// REGRA DA TELA (a mesma do Hoje e do Hábitos): nenhum bloco devolve `null`.
// Hero, barras por categoria, transações e saldo geral têm cada um as três
// saídas — dado, vazio desenhado e erro — com frase própria, para o teste
// apontar um bloco só.
//
// REGRA DO DINHEIRO: número errado aqui não quebra, mente. Por isso:
//   · o mês vai para a api em BASE 1 (`getMonth() + 1`); sem o +1 a tela
//     inteira mostraria o mês passado parecendo certa;
//   · o saldo do hero é `receitas − despesas` — as duas parcelas que estão
//     desenhadas ao lado dele — e não um terceiro campo do servidor;
//   · valor ausente vira estado vazio, nunca `?? 0` (um "R$ 0,00" inventado é
//     indistinguível de um saldo zerado de verdade);
//   · mês sem lançamento lê "nenhuma movimentação neste mês", não R$ 0,00 —
//     que é exatamente o estado do mês corrente hoje.

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

const BRL = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "R$ 1.200,00". Centavos sempre: o handoff arredonda, o extrato não. */
function fmtBRL(v: number): string {
  return BRL.format(Math.abs(v));
}

/** Saldo: só o negativo ganha sinal, com o menos tipográfico do handoff (−). */
function saldoTexto(v: number): string {
  return v < 0 ? `−${fmtBRL(v)}` : fmtBRL(v);
}

/** Lançamento: sinal sempre explícito, porque a lista mistura os dois tipos. */
function comSinal(v: number, receita: boolean): string {
  return `${receita ? '+' : '−'}${fmtBRL(v)}`;
}

/** Número de verdade ou nada. `null` manda o bloco para o estado vazio em vez
 *  de deixar um `?? 0` inventar dinheiro que ninguém tem. */
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Rótulo da taxonomia do desktop, sem o emoji que ela carrega — ícone neste
 *  projeto é SVG inline, nunca emoji. */
function rotuloCategoria(key: string): string {
  const bruto = CATEGORY_LABELS[key] ?? key;
  const limpo = bruto.replace(/[\p{Extended_Pictographic}️]/gu, '').trim();
  return limpo || key;
}

function corCategoria(key: string): string {
  return CATEGORY_COLORS[key] ?? CATEGORY_COLORS.outros;
}

/** Hoje / Ontem / N dias / dd/mm — a mesma régua da lista do desktop. */
function diaRelativo(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return iso;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);
  const dias = Math.round((hoje.getTime() - new Date(y, m - 1, d).getTime()) / 86400000);
  if (dias <= 0) return 'Hoje';
  if (dias === 1) return 'Ontem';
  if (dias < 7) return `${dias} dias`;
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`;
}

/** Seta diagonal do handoff: sobe para entrada, desce para saída. Não existe
 *  equivalente no `Icons.tsx` e não é meu arquivo para mexer, então mora aqui
 *  — SVG inline, com o path exato do desenho. */
function Seta({ receita, size = 11 }: { receita: boolean; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      {receita ? <path d="M7 17L17 7M9 7h8v8" /> : <path d="M17 7L7 17M15 17H7V9" />}
    </svg>
  );
}

export function FinancasScreen({ onBack, onOpen }: ScreenProps) {
  // O recorte da tela é o mês corrente, fixado na montagem (o relógio não pode
  // virar no meio da sessão e trocar os números sem o usuário pedir).
  const agora = useMemo(() => new Date(), []);
  const mes = agora.getMonth() + 1; // BASE 1 na rota — Date#getMonth() é base 0
  const ano = agora.getFullYear();

  const [resumo, setResumo] = useState<FinanceSummary | null>(null);
  const [erroResumo, setErroResumo] = useState(false);
  const [carregandoResumo, setCarregandoResumo] = useState(true);

  const [lancamentos, setLancamentos] = useState<FinanceEntry[] | null>(null);
  const [erroLancamentos, setErroLancamentos] = useState(false);
  const [carregandoLancamentos, setCarregandoLancamentos] = useState(true);

  const [geral, setGeral] = useState<number | null>(null);
  const [erroGeral, setErroGeral] = useState(false);
  const [carregandoGeral, setCarregandoGeral] = useState(true);

  useEffect(() => {
    let vivo = true;
    setCarregandoResumo(true);
    setCarregandoLancamentos(true);

    fetchSummary(mes, ano)
      .then((s) => { if (vivo) { setResumo(s); setErroResumo(false); setCarregandoResumo(false); } })
      .catch(() => { if (vivo) { setResumo(null); setErroResumo(true); setCarregandoResumo(false); } });

    // `status: 'confirmed'` de propósito: importação pendente de revisão ainda
    // não é dinheiro que saiu, e somá-la aqui inflaria o mês.
    listEntries({ status: 'confirmed', month: mes, year: ano, limit: 100 })
      .then((e) => { if (vivo) { setLancamentos(e); setErroLancamentos(false); setCarregandoLancamentos(false); } })
      .catch(() => { if (vivo) { setLancamentos(null); setErroLancamentos(true); setCarregandoLancamentos(false); } });

    return () => { vivo = false; };
  }, [mes, ano]);

  useEffect(() => {
    let vivo = true;
    fetchBalance()
      .then((b) => { if (vivo) { setGeral(num(b?.balance)); setErroGeral(false); setCarregandoGeral(false); } })
      .catch(() => { if (vivo) { setGeral(null); setErroGeral(true); setCarregandoGeral(false); } });
    return () => { vivo = false; };
  }, []);

  const receitas = num(resumo?.income);
  const despesas = num(resumo?.expenses);
  const saldo = receitas !== null && despesas !== null ? receitas - despesas : null;
  const categorias: CategorySummary[] = (resumo?.by_category ?? []).filter((c) => num(c?.total) !== null);
  // Mês parado: o servidor respondeu, e a resposta é "não houve nada". Isso é
  // um vazio a ser dito, não um saldo zero a ser exibido.
  const semMovimento = receitas === 0 && despesas === 0 && categorias.length === 0;
  const mostraSaldo = !carregandoResumo && !erroResumo && saldo !== null && !semMovimento;

  // Denominador das barras: o total de despesas do mês (é o que o handoff usa —
  // 1200/2340 = 51%). Se ele não vier, a maior categoria vira a referência.
  const totalBarras = despesas && despesas > 0
    ? despesas
    : categorias.reduce((m, c) => Math.max(m, c.total), 0);

  const lista = useMemo(
    () => [...(lancamentos ?? [])].sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')),
    [lancamentos],
  );

  return (
    <div className="ms-financas">
      <header className="ms-financas-head">
        {/* O shell não desenha mais chrome: a seta é da tela. `onBack` é
            opcional no ScreenProps — sem ele não há para onde voltar, então o
            controle não aparece em vez de virar um botão morto. */}
        {onBack && (
          <button type="button" className="ms-financas-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-financas-head-txt">
          <h1 className="ms-financas-titulo">Finanças</h1>
          <p className="ms-financas-mes">{MESES[agora.getMonth()]} {ano}</p>
        </div>
        {/* O "+" do handoff. Não existe api de criar lançamento (a Task 7 expõe
            só leitura), e neste produto o lançamento nasce no chat ("gastei 40
            no mercado"), então é para lá que ele leva. Sem `onOpen` some. */}
        {onOpen && (
          <button
            type="button"
            className="ms-financas-add"
            aria-label="Registrar lançamento pelo chat"
            onClick={() => onOpen({ key: 'chat', title: 'Chat' })}
          >
            <PlusIcon size={19} />
          </button>
        )}
      </header>

      <div className="ms-financas-corpo">
        {/* ── hero: saldo do mês, gradiente verde, receitas e despesas dentro ── */}
        <section className={`ms-financas-hero${saldo !== null && saldo < 0 ? ' ms-financas-hero--negativo' : ''}`}>
          <p className="ms-financas-hero-label">Saldo do mês</p>
          {carregandoResumo ? <Skel linhas={1} />
            : erroResumo ? <Erro>Não consegui carregar o resumo deste mês.</Erro>
            : semMovimento ? <Vazio>Nenhuma movimentação neste mês — nada entrou nem saiu.</Vazio>
            : saldo === null ? <Vazio>O servidor não mandou os valores deste mês.</Vazio>
            : <p className="ms-financas-saldo">{saldoTexto(saldo)}</p>}

          <div className="ms-financas-tiles">
            <Tile
              receita
              rotulo="Receitas"
              valor={mostraSaldo ? receitas : null}
              carregando={carregandoResumo}
            />
            <Tile
              receita={false}
              rotulo="Despesas"
              valor={mostraSaldo ? despesas : null}
              carregando={carregandoResumo}
            />
          </div>

          {/* Saldo geral (todos os meses): api própria, erro próprio — uma falha
              aqui não pode derrubar o mês. */}
          <div className="ms-financas-geral">
            {carregandoGeral ? <Skel linhas={1} />
              : erroGeral ? <Erro>Não consegui carregar o saldo geral.</Erro>
              : geral === null ? <Vazio>Saldo geral indisponível.</Vazio>
              : (
                <p className="ms-financas-geral-txt">
                  <span className="ms-financas-geral-rotulo">Saldo geral</span>
                  <strong className={`ms-financas-geral-valor${geral < 0 ? ' ms-financas-geral-valor--neg' : ''}`}>
                    {saldoTexto(geral)}
                  </strong>
                </p>
              )}
          </div>
        </section>

        {/* ── barras por categoria ── */}
        <section className="ms-financas-card">
          <h2 className="ms-financas-card-titulo">Por categoria</h2>
          {carregandoResumo ? <SkelBarras />
            : erroResumo ? <Erro>Não consegui carregar suas categorias.</Erro>
            : categorias.length ? (
              <div className="ms-financas-barras">
                {categorias.map((c) => (
                  <Barra key={c.category} cat={c} total={totalBarras} />
                ))}
              </div>
            )
            : <Vazio>Nenhuma despesa por categoria neste mês.</Vazio>}
        </section>

        {/* ── transações ── */}
        <section className="ms-financas-card ms-financas-lista">
          {carregandoLancamentos ? <SkelLinhas />
            : erroLancamentos ? <Erro>Não consegui carregar suas transações.</Erro>
            : lista.length ? lista.map((e) => <Linha key={e.id} entry={e} />)
            : <Vazio>Nenhuma transação neste mês.</Vazio>}
        </section>
      </div>
    </div>
  );
}

/** Receitas / Despesas dentro do hero. Sem valor não inventa zero: mostra "—",
 *  que se lê como "não tenho esse número". */
function Tile({ receita, rotulo, valor, carregando }: {
  receita: boolean;
  rotulo: string;
  valor: number | null;
  carregando: boolean;
}) {
  return (
    <div className="ms-financas-tile">
      <span className={`ms-financas-tile-label ms-financas-tile-label--${receita ? 'receita' : 'despesa'}`}>
        <Seta receita={receita} />
        {rotulo}
      </span>
      {carregando ? <Skel linhas={1} />
        : (
          <span className={`ms-financas-tile-valor ms-financas-tile-valor--${receita ? 'receita' : 'despesa'}`}>
            {valor === null ? '—' : fmtBRL(valor)}
          </span>
        )}
    </div>
  );
}

function Barra({ cat, total }: { cat: CategorySummary; total: number }) {
  const cor = corCategoria(cat.category);
  const pct = total > 0 ? Math.max(1, Math.min(100, Math.round((cat.total / total) * 100))) : 0;
  return (
    <div className="ms-financas-barra">
      <div className="ms-financas-barra-topo">
        <span className="ms-financas-barra-nome">{rotuloCategoria(cat.category)}</span>
        <span className="ms-financas-barra-valor">{fmtBRL(cat.total)}</span>
      </div>
      <div className="ms-financas-barra-trilho">
        <span className="ms-financas-barra-fill" style={{ width: `${pct}%`, background: cor }} />
      </div>
    </div>
  );
}

function Linha({ entry }: { entry: FinanceEntry }) {
  const receita = entry.type === 'income';
  const cor = corCategoria(entry.category);
  const rotulo = rotuloCategoria(entry.category);
  // `amount` chega positivo e o sinal vem do `type` (é assim que o backend
  // grava). O `Math.abs` dentro do formatador impede que um valor já negativo
  // vire "−−R$".
  const valor = num(entry.amount);
  return (
    <div className="ms-financas-tx">
      <span className="ms-financas-tx-icone" style={{ background: `${cor}29`, color: cor }}>
        <Seta receita={receita} size={14} />
      </span>
      <div className="ms-financas-tx-corpo">
        <p className="ms-financas-tx-desc">{entry.description || rotulo}</p>
        <p className="ms-financas-tx-meta">{diaRelativo(entry.date)} · {rotulo}</p>
      </div>
      <span className={`ms-financas-tx-valor ms-financas-tx-valor--${receita ? 'receita' : 'despesa'}`}>
        {valor === null ? '—' : comSinal(valor, receita)}
      </span>
    </div>
  );
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-financas-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-financas-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nenhum número pode piscar antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-financas-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SkelBarras() {
  return (
    <div className="ms-financas-skel ms-financas-skel--barras" aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SkelLinhas() {
  return (
    <div className="ms-financas-skel ms-financas-skel--linhas" aria-hidden="true">
      {Array.from({ length: 3 }, (_, i) => <span key={i} />)}
    </div>
  );
}
