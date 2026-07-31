import { useEffect, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { XIcon, SparkleIcon } from '../../icons/Icons';
import { listCourses, getCourse, getLesson } from '../../courses/api';
import type { Course, CourseSummary, Lesson, LessonNode } from '../../courses/api';
import type { ScreenProps } from './registry';
import './LicaoTeoriaScreen.css';

/* ── qual lição a tela abre ────────────────────────────────────────────────
   `ScreenProps` não carrega id: quem empurra a tela manda só `{key, title}`, e
   o shell não repassa o título. Então a tela resolve sozinha a lição da vez —
   a mesma leitura que o mapa de trilhas faz — em vez de inventar um parâmetro
   que o contrato não tem. */

/** A trilha em foco: a primeira pronta em andamento; senão a primeira pronta;
 *  senão a primeira que existir (que pode ainda estar sendo gerada). */
export function trilhaDaVez(cursos: CourseSummary[]): CourseSummary | null {
  const prontos = cursos.filter((c) => c.status === 'ready');
  return prontos.find((c) => c.total > 0 && c.done < c.total) ?? prontos[0] ?? cursos[0] ?? null;
}

/** A lição da vez: a desbloqueada. Trilha inteira concluída, a última — a tela
 *  vira revisão em vez de ficar sem conteúdo. */
export function licaoEmFoco(licoes: LessonNode[]): LessonNode | null {
  return licoes.find((l) => l.lock === 'unlocked') ?? licoes[licoes.length - 1] ?? null;
}

/* ── as três saídas de cada bloco ──────────────────────────────────────── */

/** Linha de "não há": o bloco continua de pé e diz o que falta. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-licao-teoria-vazio">{children}</p>;
}

/** Falha, em tinta de perigo, para nunca ser lida como "não há nada". */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-licao-teoria-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pisca uma frase antes do dado chegar. */
function Skel() {
  return (
    <div className="ms-licao-teoria-skel" aria-hidden="true">
      <span /><span /><span /><span />
    </div>
  );
}

/* ── conceito ──────────────────────────────────────────────────────────────
   `concept_md` é markdown vindo do LLM — o mesmo campo que o player do desktop
   renderiza com react-markdown. Aqui vale o mesmo renderizador (sem
   `rehype-raw`): HTML cru NÃO vira marcação, e o conteúdo de dentro da cerca
   sai como texto, com as quebras de linha preservadas pelo `<pre>`.

   Sobre as cores do handoff (keywords `#c586c0`, identificadores `#9cdcfe`,
   strings `#ce9178`, erro `#ef6b6b`): o payload não traz token nenhum e o
   projeto não tem tokenizador. Pintar por regex erraria em código real —
   `"http://x"` viraria comentário, `let` dentro de string viraria keyword — e
   erro colorido em lugar errado ensina errado. Fica só a base `#d4d4d4`; o dia
   que a lição vier tokenizada, é só mapear as classes. */
const COMPONENTES = {
  pre: ({ children }: { children?: ReactNode }) => <pre className="ms-licao-teoria-codigo">{children}</pre>,
  strong: ({ children }: { children?: ReactNode }) => <strong className="ms-licao-teoria-forte">{children}</strong>,
};

/* ── tela ──────────────────────────────────────────────────────────────── */

export function LicaoTeoriaScreen({ onBack, onOpen }: ScreenProps) {
  const [curso, setCurso] = useState<Course | null>(null);
  const [no, setNo] = useState<LessonNode | null>(null);
  const [licao, setLicao] = useState<Lesson | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const cursos = await listCourses();
        if (!vivo) return;
        const foco = trilhaDaVez(cursos);
        if (!foco) { setCarregando(false); return; }

        const c = await getCourse(foco.id);
        if (!vivo) return;
        setCurso(c);
        const alvo = licaoEmFoco(c.lessons);
        if (!alvo) { setCarregando(false); return; }
        setNo(alvo);

        const l = await getLesson(alvo.id);
        if (!vivo) return;
        setLicao(l);
        setCarregando(false);
      } catch {
        if (!vivo) return;
        setErro(true);
        setCarregando(false);
      }
    })();
    return () => { vivo = false; };
  }, []);

  const trilha = curso ? (curso.title || curso.topic) : '';
  const conceito = licao?.concept_md.trim() ?? '';
  const exercicios = licao?.exercises.length ?? 0;
  // A barra mede o passo dentro da lição: teoria é o primeiro de
  // (1 teoria + N exercícios). Nada de tempo estimado — o payload não tem
  // duração, e a tela de exercício conta a partir do mesmo total.
  const passos = exercicios + 1;

  const comecar = () => {
    if (!licao || exercicios === 0) return;
    onOpen?.({ key: 'licao-exercicio', title: licao.title });
  };

  return (
    <div className="ms-licao-teoria">
      <header className="ms-licao-teoria-topo">
        {onBack && (
          <button type="button" className="ms-licao-teoria-x" aria-label="Sair da lição" onClick={() => onBack()}>
            <XIcon size={16} />
          </button>
        )}
        <div className="ms-licao-teoria-barra">
          {licao ? (
            <span
              className="ms-licao-teoria-barra__preenchida"
              role="progressbar"
              aria-label="Progresso da lição"
              aria-valuemin={0}
              aria-valuenow={1}
              aria-valuemax={passos}
              style={{ width: `${(1 / passos) * 100}%` }}
            />
          ) : null}
        </div>
        <span className="ms-licao-teoria-pill">Teoria</span>
      </header>

      <div className="ms-licao-teoria-corpo">
        {carregando ? <Skel />
          : erro ? <Erro>Não consegui carregar esta lição.</Erro>
          : !curso ? <Vazio>Você ainda não começou nenhuma trilha — crie uma no Mac e ela aparece aqui.</Vazio>
          : !no ? <Vazio>A Seraphine ainda está montando as lições desta trilha — volte em instantes.</Vazio>
          : !licao ? <Erro>Não consegui carregar esta lição.</Erro>
          : (
            <>
              <div>
                <p className="ms-licao-teoria-eyebrow">
                  LIÇÃO {no.order_idx + 1} · {trilha.toLocaleUpperCase('pt-BR')}
                </p>
                <h1 className="ms-licao-teoria-titulo">{licao.title}</h1>
              </div>

              {conceito
                ? (
                  <div className="ms-licao-teoria-conceito">
                    <Markdown
                      remarkPlugins={[remarkGfm, remarkMath]}
                      rehypePlugins={[rehypeKatex]}
                      components={COMPONENTES}
                    >
                      {conceito}
                    </Markdown>
                  </div>
                )
                : <Vazio>Esta lição ainda não tem a teoria escrita — os exercícios já valem.</Vazio>}

              <div className="ms-licao-teoria-dica">
                <SparkleIcon size={15} />
                <span>Leia o exemplo com calma: os exercícios usam exatamente esses conceitos.</span>
              </div>
            </>
          )}
      </div>

      <div className="ms-licao-teoria-rodape">
        {licao && exercicios === 0 && (
          <Vazio>Esta lição ainda não tem exercícios — a Seraphine termina de montá-los em breve.</Vazio>
        )}
        <button
          type="button"
          className="ms-licao-teoria-cta"
          disabled={!licao || exercicios === 0}
          onClick={comecar}
        >
          Começar exercícios
        </button>
      </div>
    </div>
  );
}
