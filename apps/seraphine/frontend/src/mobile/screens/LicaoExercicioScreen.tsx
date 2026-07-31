import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { CheckIcon, XIcon } from '../../icons/Icons';
import { listCourses, getCourse, getLesson, gradeType, completeLesson } from '../../courses/api';
import type { Course, CourseSummary, Exercise, Lesson, LessonNode } from '../../courses/api';
import { checkCloze, checkMCQ } from '../../courses/exercises/grading';
import type { ScreenProps } from './registry';
import './LicaoExercicioScreen.css';

/* ═══ Tela LIÇÃO · EXERCÍCIO — handoff mobile, linha 436 ════════════════════
   Tela empurrada: o `PushedScreen` não desenha cabeçalho nenhum, então o X, a
   barra de progresso e o "3/5" são desta tela — e o X é a ÚNICA saída, ligado
   ao `onBack` do `ScreenProps`.

   Sobre a correção: quem decide se a resposta está certa NUNCA é uma regra
   inventada aqui. Ela vem de `courses/exercises/grading.ts`, que é a mesma
   função que o player do desktop usa, aplicada ao gabarito que a própria api
   manda no `payload` (`answer_idx` no mcq, `answers` no cloze, a ordem dos
   `pairs` no match). O tipo `type` é o único cujo gabarito fica no servidor:
   ali a correção é um POST (`gradeType`) e, se ele falhar, a tela diz que não
   deu para corrigir em vez de chutar um veredito. */

/* ── escolha do que abrir ──────────────────────────────────────────────────
   Quem empurra a tela diz QUAL lição abrir pelo `id` do `ScreenProps` — é o
   caminho normal, e é por ele que a tela de teoria manda o aluno para cá sem
   trocar de lição no meio.

   O `id` é opcional dos dois lados, então `undefined` é caso real (a tela
   montada direto pelo registry, sem ninguém ter empurrado). Aí ela resolve
   sozinha, pela mesma regra do mapa: a trilha em andamento, e dentro dela a
   lição destravada. As duas funções abaixo são esse plano B. */

/** A trilha que a tela abre: a primeira pronta e inacabada; senão a primeira
 *  pronta; senão a primeira que existir. `null` quando não há nenhuma. */
export function cursoEmFoco(cursos: CourseSummary[]): CourseSummary | null {
  const prontos = cursos.filter((c) => c.status === 'ready');
  return prontos.find((c) => c.total > 0 && c.done < c.total) ?? prontos[0] ?? cursos[0] ?? null;
}

/** A lição que a tela abre: a destravada; senão a última concluída (para
 *  revisar); senão a primeira. `null` quando a trilha não tem lição. */
export function licaoEmFoco(licoes: LessonNode[]): LessonNode | null {
  if (!licoes.length) return null;
  const feitas = licoes.filter((l) => l.lock === 'done');
  return licoes.find((l) => l.lock === 'unlocked') ?? feitas[feitas.length - 1] ?? licoes[0];
}

/* ── rótulos ───────────────────────────────────────────────────────────── */

const OLHO: Record<Exercise['type'], string> = {
  mcq: 'MÚLTIPLA ESCOLHA',
  cloze: 'COMPLETE A FRASE',
  type: 'DIGITE A RESPOSTA',
  match: 'RELACIONAR',
  graph: 'AJUSTE O GRÁFICO',
};

/* ── três saídas de cada bloco ─────────────────────────────────────────── */

/** Linha de "não há nada": o bloco continua de pé e diz o que falta. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-licao-ex-vazio">{children}</p>;
}

/** Linha de falha, em tinta de perigo, para nunca ser lida como vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-licao-ex-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pisca "sem exercícios" antes do dado chegar. */
function Esqueleto() {
  return (
    <div className="ms-licao-ex-skel" aria-hidden="true">
      <span /><span /><span /><span />
    </div>
  );
}

/* ── veredito de um exercício ──────────────────────────────────────────── */

interface Veredito { certo: boolean; texto: string }
type Corrigir = (certo: boolean, texto: string) => void;

/* ── impasse: exercício que esta tela não consegue aplicar ─────────────────
   Dado malformado ou tipo que só roda no Mac. Some nada e, principalmente,
   não vira beco sem saída: o aluno pula e a lição continua — o pulo conta
   como não-acerto, porque ninguém respondeu. */
function Impasse({ ex, corrigir, respondido, motivo }:
  { ex: Exercise; corrigir: Corrigir; respondido: boolean; motivo: string }) {
  return (
    <div className="ms-licao-ex-impasse">
      <Vazio>{motivo}</Vazio>
      {!respondido && (
        <button
          type="button"
          className="ms-licao-ex-verificar"
          onClick={() => corrigir(false, ex.explanation ?? 'Refaça este exercício no Mac para contar como acerto.')}
        >
          Pular por agora
        </button>
      )}
    </div>
  );
}

/* ── múltipla escolha (o desenho do handoff) ───────────────────────────── */

function ExMultipla({ ex, corrigir, respondido }:
  { ex: Exercise; corrigir: Corrigir; respondido: boolean }) {
  const [escolhida, setEscolhida] = useState<number | null>(null);
  const opcoes = ex.payload.options ?? [];

  if (!opcoes.length) {
    return (
      <Impasse ex={ex} corrigir={corrigir} respondido={respondido}
        motivo="Esta pergunta veio sem alternativas — a Seraphine precisa gerá-la de novo." />
    );
  }

  const escolher = (i: number) => {
    if (respondido || escolhida !== null) return;
    setEscolhida(i);
    corrigir(checkMCQ(ex.payload.answer_idx, i), ex.explanation ?? '');
  };

  return (
    <div className="ms-licao-ex-alts">
      {opcoes.map((opcao, i) => {
        const marcada = escolhida === i;
        // Depois de responder errado, a certa aparece — o handoff mobile só
        // desenha a selecionada em accent, mas errar sem ver a resposta é
        // aprender nada.
        const revelada = respondido && !marcada && i === ex.payload.answer_idx;
        return (
          <button
            key={i}
            type="button"
            aria-pressed={marcada}
            disabled={respondido}
            className={`ms-licao-ex-alt${marcada ? ' ms-licao-ex-alt--marcada' : ''}${revelada ? ' ms-licao-ex-alt--certa' : ''}`}
            onClick={() => escolher(i)}
          >
            <span className="ms-licao-ex-num">{i + 1}</span>
            {opcao}
          </button>
        );
      })}
    </div>
  );
}

/* ── completar a lacuna ────────────────────────────────────────────────── */

function ExLacuna({ ex, corrigir, respondido }:
  { ex: Exercise; corrigir: Corrigir; respondido: boolean }) {
  const [valor, setValor] = useState('');
  const texto = ex.payload.text ?? '';
  const banco = ex.payload.options ?? [];
  const [antes, depois] = texto.includes('___') ? texto.split('___') : [texto, ''];

  if (!texto) {
    return (
      <Impasse ex={ex} corrigir={corrigir} respondido={respondido}
        motivo="Esta frase veio sem texto — a Seraphine precisa gerá-la de novo." />
    );
  }

  const verificar = () => {
    if (respondido || !valor.trim()) return;
    corrigir(checkCloze(ex.payload.answers, valor), ex.explanation ?? '');
  };

  return (
    <div className="ms-licao-ex-lacuna">
      <p className="ms-licao-ex-frase">
        {antes}
        {valor
          ? (
            <button
              type="button"
              className="ms-licao-ex-chip ms-licao-ex-chip--posta"
              disabled={respondido}
              onClick={() => setValor('')}
            >
              {valor}
            </button>
          )
          : <span className="ms-licao-ex-buraco" />}
        {depois}
      </p>
      {banco.length ? (
        <div className="ms-licao-ex-banco">
          {banco.map((palavra, i) => (
            <button
              key={i}
              type="button"
              className={`ms-licao-ex-chip${valor === palavra ? ' ms-licao-ex-chip--usada' : ''}`}
              disabled={respondido || valor === palavra}
              onClick={() => setValor(palavra)}
            >
              {palavra}
            </button>
          ))}
        </div>
      ) : (
        <input
          className="ms-licao-ex-campo"
          value={valor}
          disabled={respondido}
          placeholder="Digite…"
          onChange={(e) => setValor(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') verificar(); }}
        />
      )}
      {!respondido && (
        <button type="button" className="ms-licao-ex-verificar" disabled={!valor.trim()} onClick={verificar}>
          Verificar
        </button>
      )}
    </div>
  );
}

/* ── digitar a resposta: o único corrigido pelo servidor ───────────────── */

function ExDigitar({ ex, corrigir, respondido }:
  { ex: Exercise; corrigir: Corrigir; respondido: boolean }) {
  const [valor, setValor] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [falhou, setFalhou] = useState(false);

  const verificar = async () => {
    if (respondido || enviando || !valor.trim()) return;
    setEnviando(true);
    setFalhou(false);
    try {
      const r = await gradeType(ex.id, valor);
      corrigir(r.correct, r.feedback || ex.explanation || '');
    } catch {
      // Sem resposta do servidor não há veredito: dizer "certo" aqui seria
      // ensinar errado. A tela admite a falha e deixa tentar de novo.
      setFalhou(true);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="ms-licao-ex-digitar">
      <input
        className="ms-licao-ex-campo"
        value={valor}
        disabled={respondido || enviando}
        placeholder="Digite…"
        onChange={(e) => setValor(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') void verificar(); }}
      />
      {falhou && <Erro>Não consegui corrigir agora — tente de novo.</Erro>}
      {!respondido && (
        <button
          type="button"
          className="ms-licao-ex-verificar"
          disabled={!valor.trim() || enviando}
          onClick={() => void verificar()}
        >
          {enviando ? 'Corrigindo…' : 'Verificar'}
        </button>
      )}
    </div>
  );
}

/* ── relacionar colunas ────────────────────────────────────────────────── */

function embaralhado(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function ExRelacionar({ ex, corrigir, respondido }:
  { ex: Exercise; corrigir: Corrigir; respondido: boolean }) {
  const pares = ex.payload.pairs ?? [];
  const [ordemB] = useState(() => embaralhado(pares.length));
  const [selA, setSelA] = useState<number | null>(null);
  const [selB, setSelB] = useState<number | null>(null);
  const [travados, setTravados] = useState<number[]>([]);
  const [erros, setErros] = useState(0);
  const [piscando, setPiscando] = useState<{ a: number; b: number } | null>(null);

  if (!pares.length) {
    // O `match` da api também vem como lista de passos para ordenar; arrastar
    // ordem não está desenhado no handoff mobile, então esse caso sai por aqui
    // em vez de virar tela em branco.
    const motivo = ex.payload.steps?.length
      ? 'Este exercício pede ordenar os passos arrastando, o que por enquanto só dá no Mac.'
      : 'Este exercício veio sem pares para relacionar — a Seraphine precisa gerá-lo de novo.';
    return <Impasse ex={ex} corrigir={corrigir} respondido={respondido} motivo={motivo} />;
  }

  const tentar = (a: number | null, b: number | null, jaTravados: number[], jaErros: number) => {
    if (a === null || b === null) return;
    if (a === b) {
      const proximos = [...jaTravados, a];
      setTravados(proximos);
      setSelA(null);
      setSelB(null);
      // Acerto só quando fechou tudo sem nenhuma tentativa errada — mesma
      // regra do player do desktop.
      if (proximos.length === pares.length) corrigir(jaErros === 0, ex.explanation ?? '');
    } else {
      setErros(jaErros + 1);
      setPiscando({ a, b });
      setTimeout(() => { setPiscando(null); setSelA(null); setSelB(null); }, 300);
    }
  };

  const bloqueado = (i: number) => respondido || piscando !== null || travados.includes(i);

  const item = (indice: number, rotulo: string, lado: 'a' | 'b') => {
    const sel = lado === 'a' ? selA : selB;
    const errado = piscando && (lado === 'a' ? piscando.a : piscando.b) === indice;
    const ok = travados.includes(indice);
    return (
      <button
        key={`${lado}${indice}`}
        type="button"
        aria-pressed={sel === indice}
        disabled={bloqueado(indice)}
        className={`ms-licao-ex-par${ok ? ' ms-licao-ex-par--ok' : ''}${sel === indice ? ' ms-licao-ex-par--sel' : ''}${errado ? ' ms-licao-ex-par--err' : ''}`}
        onClick={() => {
          if (bloqueado(indice)) return;
          if (lado === 'a') { setSelA(indice); tentar(indice, selB, travados, erros); }
          else { setSelB(indice); tentar(selA, indice, travados, erros); }
        }}
      >
        {ok && <CheckIcon size={13} />}
        {rotulo}
      </button>
    );
  };

  return (
    <div className="ms-licao-ex-relacionar">
      <div className="ms-licao-ex-colunas">
        <div className="ms-licao-ex-coluna">{pares.map((p, i) => item(i, p[0], 'a'))}</div>
        <div className="ms-licao-ex-coluna">{ordemB.map((orig) => item(orig, pares[orig][1], 'b'))}</div>
      </div>
      <p className="ms-licao-ex-dica">
        Toque num item de cada coluna pra formar o par · {travados.length} de {pares.length} pares
      </p>
    </div>
  );
}

/* ── tela ──────────────────────────────────────────────────────────────── */

export function LicaoExercicioScreen({ onBack, id }: ScreenProps) {
  const [licao, setLicao] = useState<Lesson | null>(null);
  const [vazio, setVazio] = useState<string | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [idx, setIdx] = useState(0);
  const [veredito, setVeredito] = useState<Veredito | null>(null);
  const [acertos, setAcertos] = useState(0);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    let vivo = true;
    // Trocar de lição é recomeçar: sem isto, o índice e o placar da lição
    // anterior sobreviveriam à nova.
    setCarregando(true);
    setErro(false);
    setVazio(null);
    setLicao(null);
    setIdx(0);
    setVeredito(null);
    setAcertos(0);
    (async () => {
      try {
        // Caminho normal: quem empurrou disse qual lição. Nem lista cursos.
        let licaoId = id;
        if (!licaoId) {
          const cursos = await listCourses();
          if (!vivo) return;
          const curso = cursoEmFoco(cursos);
          if (!curso) {
            setVazio('Você ainda não começou nenhuma trilha — crie uma no Mac e os exercícios aparecem aqui.');
            setCarregando(false);
            return;
          }
          const cheio: Course = await getCourse(curso.id);
          if (!vivo) return;
          const alvo = licaoEmFoco(cheio.lessons);
          if (!alvo) {
            setVazio('A Seraphine ainda está montando as lições desta trilha — volte em instantes.');
            setCarregando(false);
            return;
          }
          licaoId = alvo.id;
        }
        const l = await getLesson(licaoId);
        if (!vivo) return;
        setLicao(l);
        setVazio(l.exercises.length ? null : 'Esta lição ainda não tem exercícios — por enquanto ela é só teoria.');
        setCarregando(false);
      } catch {
        if (!vivo) return;
        setErro(true);
        setCarregando(false);
      }
    })();
    return () => { vivo = false; };
  }, [id]);

  const exercicios = licao?.exercises ?? [];
  const total = exercicios.length;
  const ex = idx < total ? exercicios[idx] : null;
  const ultimo = total > 0 && idx === total - 1;
  // 3 de 5 = 60%, exatamente a barra do handoff.
  const pct = total ? Math.round(((idx + 1) / total) * 100) : 0;

  const corrigir = useCallback<Corrigir>((certo, texto) => {
    setVeredito({ certo, texto });
    if (certo) setAcertos((n) => n + 1);
  }, []);

  const avancar = async () => {
    setVeredito(null);
    if (!ultimo) { setIdx((i) => i + 1); return; }
    if (licao) {
      setSalvando(true);
      // O XP e o streak vivem no servidor; se a gravação cair, a lição já foi
      // feita — volta do mesmo jeito em vez de prender o aluno na tela.
      try { await completeLesson(licao.id, acertos); } catch { /* segue */ }
      setSalvando(false);
    }
    onBack?.();
  };

  const respondido = veredito !== null;

  return (
    <div className="ms-licao-ex">
      <header className="ms-licao-ex-topo">
        <button
          type="button"
          className="ms-licao-ex-x"
          aria-label="Sair da lição"
          onClick={() => onBack?.()}
        >
          <XIcon size={16} />
        </button>
        <div className="ms-licao-ex-barra">
          <span className="ms-licao-ex-barra__feita" style={{ width: `${pct}%` }} />
        </div>
        <span className="ms-licao-ex-fracao">{total ? `${idx + 1}/${total}` : '—'}</span>
      </header>

      <div className="ms-licao-ex-corpo">
        {carregando ? <Esqueleto />
          : erro ? <Erro>Não consegui carregar os exercícios desta lição.</Erro>
          : vazio ? <Vazio>{vazio}</Vazio>
          : ex ? (
            <>
              <div className="ms-licao-ex-cabeca">
                <p className="ms-licao-ex-olho">{OLHO[ex.type]}</p>
                <h1 className="ms-licao-ex-pergunta">{ex.prompt}</h1>
              </div>
              <div key={ex.id} className="ms-licao-ex-slot">
                {ex.type === 'mcq' && <ExMultipla ex={ex} corrigir={corrigir} respondido={respondido} />}
                {ex.type === 'cloze' && <ExLacuna ex={ex} corrigir={corrigir} respondido={respondido} />}
                {ex.type === 'type' && <ExDigitar ex={ex} corrigir={corrigir} respondido={respondido} />}
                {ex.type === 'match' && <ExRelacionar ex={ex} corrigir={corrigir} respondido={respondido} />}
                {ex.type === 'graph' && (
                  <Impasse ex={ex} corrigir={corrigir} respondido={respondido}
                    motivo="Este exercício precisa do gráfico interativo, que por enquanto só roda no Mac." />
                )}
              </div>
            </>
          ) : <Vazio>Esta lição ainda não tem exercícios — por enquanto ela é só teoria.</Vazio>}
      </div>

      {veredito && (
        <footer
          className={`ms-licao-ex-feedback ms-licao-ex-feedback--${veredito.certo ? 'ok' : 'nao'}`}
          role="status"
        >
          <span className="ms-licao-ex-selo">
            {veredito.certo ? <CheckIcon size={19} /> : <XIcon size={19} />}
          </span>
          <div className="ms-licao-ex-diz">
            <p className="ms-licao-ex-diz__titulo">{veredito.certo ? 'Certo!' : 'Quase…'}</p>
            {veredito.texto && <p className="ms-licao-ex-diz__expl">{veredito.texto}</p>}
          </div>
          <button
            type="button"
            className="ms-licao-ex-continuar"
            disabled={salvando}
            onClick={() => void avancar()}
          >
            {ultimo ? 'Concluir' : 'Continuar'}
          </button>
        </footer>
      )}
    </div>
  );
}
