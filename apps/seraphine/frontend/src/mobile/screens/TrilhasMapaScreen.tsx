import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, CheckIcon, FlameIcon, LockIcon, PlayIcon, TrophyIcon } from '../../icons/Icons';
import { listCourses, getCourse, getStats } from '../../courses/api';
import type { Course, CourseSummary, LessonNode, Stats } from '../../courses/api';
import type { ScreenProps } from './registry';
import './TrilhasMapaScreen.css';

/* ── geometria do caminho ──────────────────────────────────────────────────
   O handoff desenha seis nós num sistema de 390 de largura. Em vez de copiar
   aquele `d` (que só serve para uma trilha de cinco lições), a curva é gerada
   a partir da contagem de nós: as posições ciclam em três colunas — centro,
   direita, esquerda — descendo um passo fixo, e cada trecho vira um cúbico.
   Com seis nós o resultado cai em cima do traçado do handoff; com onze, ele
   simplesmente continua. */

/** Eixo vertical do traçado, no sistema de coordenadas de 390 do handoff. */
const EIXO = 195;
/** As três colunas por onde a serpente passa, em ciclo. */
const COLUNAS = [195, 283, 105];
/** Centro do primeiro nó. */
const Y_INICIAL = 40;
/** Distância vertical entre dois nós. */
const PASSO = 92;
/** Largura do sistema de coordenadas do SVG (o do handoff). */
export const LARGURA = 390;

/** Centro do i-ésimo nó (0 = primeira lição). */
export function pontoDoNo(i: number): { x: number; y: number } {
  return { x: COLUNAS[i % COLUNAS.length], y: Y_INICIAL + i * PASSO };
}

/** Um trecho cúbico entre dois nós, no formato do atributo `d`. */
function trecho(x0: number, y0: number, x1: number, y1: number): string {
  const dy = y1 - y0;
  const l0 = x0 - EIXO;
  const l1 = x1 - EIXO;
  if (l0 * l1 < 0) {
    // travessia de um lado ao outro: as duas alças na mesma altura, para dentro
    const puxa = x0 > x1 ? -30 : 30;
    const ym = y0 + dy * 0.5;
    return `C ${x0 + puxa} ${ym}, ${x1 - puxa} ${ym}, ${x1} ${y1}`;
  }
  if (Math.abs(l1) > Math.abs(l0)) {
    // afastando do eixo: a curva arqueia para fora, passando do destino
    const d = l1 > 0 ? 1 : -1;
    return `C ${x0 + d * 105} ${y0 + dy * 0.24}, ${x0 + d * 120} ${y0 + dy * 0.62}, ${x1} ${y1}`;
  }
  // voltando ao eixo: barriga curta, do lado de onde saiu
  const d = l0 > 0 ? 1 : -1;
  return `C ${x0 + d * 25} ${y0 + dy * 0.38}, ${x0 + d * 5} ${y0 + dy * 0.82}, ${x1} ${y1}`;
}

/** Caminho serpenteado passando por `nos` nós. Um nó só: um ponto, sem curva. */
export function caminhoSerpente(nos: number): string {
  if (nos < 1) return '';
  const p0 = pontoDoNo(0);
  let d = `M ${p0.x} ${p0.y}`;
  for (let i = 1; i < nos; i += 1) {
    const a = pontoDoNo(i - 1);
    const b = pontoDoNo(i);
    d += ` ${trecho(a.x, a.y, b.x, b.y)}`;
  }
  return d;
}

/* ── escolha da trilha ─────────────────────────────────────────────────── */

/** A trilha que o mapa mostra: a primeira em andamento; senão a primeira
 *  pronta; senão a primeira que existir (que pode ainda estar sendo gerada). */
export function trilhaEmFoco(cursos: CourseSummary[]): CourseSummary | null {
  const prontos = cursos.filter((c) => c.status === 'ready');
  return prontos.find((c) => c.total > 0 && c.done < c.total) ?? prontos[0] ?? cursos[0] ?? null;
}

/* ── três saídas de cada bloco ─────────────────────────────────────────── */

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-trilhas-vazio">{children}</p>;
}

/** Linha de falha, em tinta de perigo, para nunca ser lida como vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-trilhas-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pisca "trilha vazia" antes do dado chegar. */
function Skel({ linhas = 3 }: { linhas?: number }) {
  return (
    <div className="ms-trilhas-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

/* ── tela ──────────────────────────────────────────────────────────────── */

export function TrilhasMapaScreen({ onBack, onOpen }: ScreenProps) {
  const [curso, setCurso] = useState<Course | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(true);
  // O streak vive à parte de propósito: a queda dele não pode levar o mapa
  // junto, e a do mapa não pode apagar o streak.
  const [stats, setStats] = useState<Stats | null>(null);
  const [erroStats, setErroStats] = useState(false);
  const [carregandoStats, setCarregandoStats] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const cursos = await listCourses();
        if (!vivo) return;
        const foco = trilhaEmFoco(cursos);
        if (!foco) { setCurso(null); setErro(null); setCarregando(false); return; }
        const c = await getCourse(foco.id);
        if (!vivo) return;
        setCurso(c); setErro(null); setCarregando(false);
      } catch (e) {
        if (!vivo) return;
        setCurso(null);
        setErro(e instanceof Error ? e.message : String(e));
        setCarregando(false);
      }
    })();
    return () => { vivo = false; };
  }, []);

  useEffect(() => {
    let vivo = true;
    getStats()
      .then((s) => { if (vivo) { setStats(s); setErroStats(false); setCarregandoStats(false); } })
      .catch(() => { if (vivo) { setStats(null); setErroStats(true); setCarregandoStats(false); } });
    return () => { vivo = false; };
  }, []);

  const licoes: LessonNode[] = curso?.lessons ?? [];
  const total = licoes.length;
  const feitas = licoes.filter((l) => l.lock === 'done').length;
  const pct = total ? Math.round((feitas / total) * 100) : 0;
  const iAtiva = licoes.findIndex((l) => l.lock === 'unlocked');
  const ativa = iAtiva >= 0 ? licoes[iAtiva] : null;
  // Concluída é ter FEITO todas, não é "não achei lição liberada": o backend
  // devolve `locked` para toda lição `incomplete` (courses/service.py), então
  // uma trilha inteira travada cairia como terminada se olhássemos só o ativo.
  const concluida = total > 0 && feitas === total;
  // O trecho percorrido termina no nó ativo; trilha inteira feita, no troféu;
  // sem nenhuma liberada, ele para onde as concluídas pararam.
  const percorridos = (iAtiva >= 0 ? iAtiva : concluida ? total : feitas) + 1;
  // Um nó por lição, mais o troféu do fim.
  const nos = total + 1;
  const altura = Y_INICIAL + (nos - 1) * PASSO + 74;
  // O número só existe quando há trilha carregada: fora disso o bloco mostra
  // esqueleto ou travessão, nunca um "0/0" que o usuário leria como progresso.
  const temFracao = !carregando && !erro && total > 0;

  const abrir = (l: LessonNode) => {
    if (l.lock === 'locked') return;
    // O id viaja junto: sem ele a tela de teoria cai no fallback e resolve a
    // lição ATUAL — tocar num nó concluído abriria a lição errada.
    onOpen?.({ key: 'licao-teoria', title: l.title, id: l.id });
  };

  return (
    <div className="ms-trilhas">
      <header className="ms-trilhas-topo">
        <div className="ms-trilhas-topo__esq">
          <button type="button" className="ms-trilhas-voltar" aria-label="Voltar" onClick={() => onBack?.()}>
            <ArrowLeftIcon size={17} />
          </button>
          {carregando
            ? <span className="ms-trilhas-skel ms-trilhas-skel--titulo" aria-hidden="true"><span /></span>
            : <h1 className="ms-trilhas-titulo">{curso ? (curso.title || curso.topic) : 'Trilhas'}</h1>}
        </div>
        <span className="ms-trilhas-streak">
          {carregandoStats
            ? <span className="ms-trilhas-skel ms-trilhas-skel--chip" aria-hidden="true"><span /></span>
            : erroStats
            ? <span className="ms-trilhas-erro ms-trilhas-erro--curto" role="alert">streak fora do ar</span>
            : <><FlameIcon size={13} />{stats?.streak_count ?? 0}</>}
        </span>
      </header>

      <div className="ms-trilhas-progresso">
        <div className={`ms-trilhas-barra${carregando ? ' ms-trilhas-barra--esqueleto' : ''}`}>
          {temFracao && <span className="ms-trilhas-barra__preenchida" style={{ width: `${pct}%` }} />}
        </div>
        {carregando
          ? <span className="ms-trilhas-skel ms-trilhas-skel--chip" aria-hidden="true"><span /></span>
          : temFracao
          ? <span className="ms-trilhas-fracao">{feitas}/{total}</span>
          : <span className="ms-trilhas-fracao ms-trilhas-fracao--sem">—</span>}
      </div>

      <div className="ms-trilhas-mapa" style={{ height: total ? altura : undefined }}>
        {carregando ? <Skel linhas={4} />
          : erro ? <Erro>Não consegui carregar suas trilhas.</Erro>
          : !curso ? <Vazio>Você ainda não começou nenhuma trilha — crie uma no Mac e ela aparece aqui.</Vazio>
          : !total ? <Vazio>A Seraphine ainda está montando as lições desta trilha — volte em instantes.</Vazio>
          : (
            <>
              <svg
                className="ms-trilhas-caminho"
                viewBox={`0 0 ${LARGURA} ${altura}`}
                preserveAspectRatio="none"
                width="100%"
                height={altura}
                fill="none"
                aria-hidden="true"
              >
                {/* o que falta: pontilhado. A cor sai do token, e não do
                    #9a93ff cru, para acompanhar os temas de accent. */}
                <path
                  d={caminhoSerpente(nos)}
                  stroke="var(--accent, #9a93ff)"
                  strokeOpacity="0.3"
                  strokeWidth="4"
                  strokeLinecap="round"
                  strokeDasharray="1 9"
                  vectorEffect="non-scaling-stroke"
                />
                {/* o que já foi andado: sólido em accent */}
                <path
                  d={caminhoSerpente(percorridos)}
                  stroke="var(--accent, #9a93ff)"
                  strokeWidth="4"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>

              {licoes.map((l, i) => {
                const p = pontoDoNo(i);
                const estado = l.lock === 'done' ? 'feito' : l.lock === 'unlocked' ? 'ativo' : 'travado';
                const dito = l.lock === 'done' ? 'concluída' : l.lock === 'unlocked' ? 'lição atual' : 'bloqueada';
                const raio = estado === 'ativo' ? 30 : 26;
                return (
                  <button
                    key={l.id}
                    type="button"
                    data-testid="ms-trilhas-no"
                    className={`ms-trilhas-no ms-trilhas-no--${estado}`}
                    style={{ left: `${(p.x / LARGURA) * 100}%`, top: p.y - raio }}
                    aria-label={`${l.title} — ${dito}`}
                    disabled={l.lock === 'locked'}
                    onClick={() => abrir(l)}
                  >
                    <span className="ms-trilhas-bolawrap">
                      {estado === 'ativo' && <span className="ms-trilhas-comecar">COMEÇAR</span>}
                      <span className={`ms-trilhas-bola ms-trilhas-bola--${estado}`}>
                        {estado === 'feito' ? <CheckIcon size={22} />
                          : estado === 'ativo' ? <PlayIcon size={24} />
                          : <LockIcon size={18} />}
                      </span>
                    </span>
                    <span className="ms-trilhas-rotulo">{l.title}</span>
                  </button>
                );
              })}

              <div
                data-testid="ms-trilhas-trofeu"
                className="ms-trilhas-trofeu"
                style={{ left: `${(pontoDoNo(total).x / LARGURA) * 100}%`, top: pontoDoNo(total).y - 26 }}
                role="img"
                aria-label="Fim da trilha"
              >
                <TrophyIcon size={22} />
              </div>
            </>
          )}
      </div>

      <div className="ms-trilhas-rodape">
        {carregando ? <Skel linhas={2} />
          : ativa ? (
            <>
              <div className="ms-trilhas-rodape__texto">
                <p className="ms-trilhas-rodape__titulo">{ativa.title}</p>
                <p className="ms-trilhas-rodape__sub">Lição {iAtiva + 1} de {total} · conceito + exercícios</p>
              </div>
              <button type="button" className="ms-trilhas-continuar" onClick={() => abrir(ativa)}>Continuar</button>
            </>
          )
          : erro ? <Vazio>Nenhuma lição para continuar enquanto a trilha não carrega.</Vazio>
          : concluida ? <Vazio>Você terminou esta trilha — não há lição pendente para continuar.</Vazio>
          : total ? <Vazio>Nenhuma lição liberada agora — a Seraphine ainda está preparando esta trilha.</Vazio>
          : <Vazio>Nenhuma lição para continuar ainda.</Vazio>}
      </div>
    </div>
  );
}
