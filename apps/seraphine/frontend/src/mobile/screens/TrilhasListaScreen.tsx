import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, FlameIcon, SparkleIcon, TrilhasIcon, ZapIcon } from '../../icons/Icons';
import { createCourse, getStats, listCourses } from '../../courses/api';
import type { CourseSummary, Stats } from '../../courses/api';
import type { ScreenProps } from './registry';
import './TrilhasListaScreen.css';

/* Tela TRILHAS · LISTA (handoff v3, frame "Trilhas · lista"). Espelha o
 * `courses/TrilhasView.tsx` do desktop e consome a mesma `courses/api.ts`.
 *
 * ── A BARRA DE 35% DO MOCKUP É DECORATIVA ───────────────────────────────────
 * O handoff desenha o cartão "gerando…" com a barra preenchida até 35%. Esse
 * número não existe em lugar nenhum: `GET /courses` monta `total` contando as
 * lições da tabela (`courses/service.py`) e as lições só são INSERIDAS na mesma
 * transação que vira o status para `ready` (`courses/generate.py`, `_persist`).
 * Enquanto o curso gera, portanto, a api devolve `total: 0, done: 0` — zero
 * progresso, não 35%. E a geração leva minutos (deepsearch + N lições): uma
 * barra parada em 35% durante três minutos não informa, mente, e o que o
 * usuário lê é "travou".
 *
 * Então a barra do "gerando…" é INDETERMINADA: uma faixa que corre, sem
 * `aria-valuenow` (é assim que ARIA distingue indeterminado de zero) e sem
 * largura em percentual. No lugar do número que não existe, o cartão diz o que
 * é verdade e é útil: que pode levar alguns minutos.
 *
 * ── O POLL MORRE NO DESMONTE ────────────────────────────────────────────────
 * O `setInterval` de 4s existe só enquanto ALGUMA trilha está gerando, e o
 * cleanup do efeito o encerra — no desmonte e também quando a última geração
 * termina. O efeito depende do booleano `gerando`, não do array de cursos:
 * dependendo do array (como faz o desktop), toda resposta do poll derruba e
 * recria o intervalo, o que reinicia a contagem dos 4s a cada volta.
 * `vivo` fecha a outra metade do vazamento: uma resposta em voo no momento do
 * desmonte não pode voltar e chamar `setState`.
 *
 * ── uma região com `role="alert"` ───────────────────────────────────────────
 * A lista é o conteúdo da tela: a falha dela é o alerta. XP/sequência e a falha
 * de criar são regiões secundárias e falam por `role="status"` — anunciadas,
 * sem interromper, e visíveis em tinta de perigo.
 */

/** De quanto em quanto tempo a lista é reconsultada enquanto algo gera. O
 *  desktop usa o mesmo valor; é ritmo de espera, não de rede. */
const POLL_MS = 4000;

/** O que o cartão mostra. `falhou` não está no handoff, mas está na api
 *  (`status: 'failed'`) — e um curso que falhou exibido como "em andamento"
 *  ficaria esperando eternamente por lições que não virão. */
type Estado = 'gerando' | 'falhou' | 'concluida' | 'andamento';

export function estadoDoCurso(c: CourseSummary): Estado {
  if (c.status === 'generating') return 'gerando';
  if (c.status === 'failed') return 'falhou';
  if (c.total > 0 && c.done >= c.total) return 'concluida';
  return 'andamento';
}

const ROTULO: Record<Estado, string> = {
  gerando: 'gerando…',
  falhou: 'falhou',
  concluida: 'concluída',
  andamento: 'em andamento',
};

/** Espera sem texto: nada pisca "nenhuma trilha" antes do dado chegar. */
function Esqueleto({ linhas = 3 }: { linhas?: number }) {
  return (
    <div className="ms-trilhaslista-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

export function TrilhasListaScreen({ onBack }: ScreenProps) {
  const [cursos, setCursos] = useState<CourseSummary[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(false);

  // XP/sequência vivem à parte de propósito: a queda de um não pode apagar o
  // outro nem levar a lista junto.
  const [stats, setStats] = useState<Stats | null>(null);
  const [carregandoStats, setCarregandoStats] = useState(true);
  const [erroStats, setErroStats] = useState(false);

  const [topico, setTopico] = useState('');
  const [criando, setCriando] = useState(false);
  const [erroCriar, setErroCriar] = useState(false);

  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; };
  }, []);

  /** Recarrega só a lista. O poll não reconsulta XP: nada do que a geração faz
   *  mexe em XP (ele muda ao concluir lição), e uma chamada a mais por ciclo é
   *  uma chance a mais de a tela piscar erro por causa de rede. */
  const recarregar = useCallback(async (): Promise<void> => {
    try {
      const cs = await listCourses();
      if (!vivo.current) return;
      setCursos(cs);
      setErro(false);
    } catch {
      if (!vivo.current) return;
      setErro(true);
    } finally {
      if (vivo.current) setCarregando(false);
    }
  }, []);

  useEffect(() => { void recarregar(); }, [recarregar]);

  useEffect(() => {
    getStats()
      .then((s) => { if (vivo.current) { setStats(s); setErroStats(false); setCarregandoStats(false); } })
      .catch(() => { if (vivo.current) { setStats(null); setErroStats(true); setCarregandoStats(false); } });
  }, []);

  const gerando = cursos.some((c) => c.status === 'generating');
  useEffect(() => {
    if (!gerando) return;
    const t = setInterval(() => { void recarregar(); }, POLL_MS);
    return () => clearInterval(t);
  }, [gerando, recarregar]);

  const criar = async (): Promise<void> => {
    const t = topico.trim();
    if (!t || criando) return;
    setCriando(true);
    setErroCriar(false);
    try {
      await createCourse({ topic: t });
      if (!vivo.current) return;
      // Só limpa o campo depois do sucesso: apagar antes faria o usuário
      // redigitar o tópico quando a rede cai.
      setTopico('');
      await recarregar();
    } catch {
      if (vivo.current) setErroCriar(true);
    } finally {
      if (vivo.current) setCriando(false);
    }
  };

  return (
    <div className="ms-trilhaslista">
      <header className="ms-trilhaslista-topo">
        {/* O frame do handoff não desenha ‹ (Trilhas é aba). Empurrada por
            outra tela, a saída existe — quem empurrou passa o `onBack`. */}
        {onBack && (
          <button type="button" className="ms-trilhaslista-voltar" aria-label="Voltar" onClick={() => onBack()}>
            <ArrowLeftIcon size={17} />
          </button>
        )}
        <h1 className="ms-trilhaslista-titulo">Trilhas</h1>
        <div className="ms-trilhaslista-pills">
          {carregandoStats ? (
            <>
              <span className="ms-trilhaslista-skel ms-trilhaslista-skel--chip" aria-hidden="true"><span /></span>
              <span className="ms-trilhaslista-skel ms-trilhaslista-skel--chip" aria-hidden="true"><span /></span>
            </>
          ) : erroStats ? (
            <span className="ms-trilhaslista-aviso" role="status">XP e sequência fora do ar</span>
          ) : (
            <>
              <span className="ms-trilhaslista-pill ms-trilhaslista-pill--xp">
                <ZapIcon size={13} />{(stats?.xp_total ?? 0).toLocaleString('pt-BR')}
              </span>
              <span className="ms-trilhaslista-pill ms-trilhaslista-pill--streak">
                <FlameIcon size={13} />{stats?.streak_count ?? 0}
              </span>
            </>
          )}
        </div>
      </header>

      <section className="ms-trilhaslista-criar">
        <p className="ms-trilhaslista-criar__rotulo"><SparkleIcon size={14} />CRIAR TRILHA</p>
        {/* Só o tópico: o modo "colar código", o foco e a escolha de tutor do
            desktop não estão no frame do handoff e não cabem nesta caixa. */}
        <input
          className="ms-trilhaslista-campo"
          aria-label="Aprender sobre"
          placeholder="Aprender sobre…"
          value={topico}
          onChange={(e) => setTopico(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void criar(); }}
        />
        <button
          type="button"
          className="ms-trilhaslista-botao"
          disabled={criando || !topico.trim()}
          onClick={() => { void criar(); }}
        >
          {criando ? 'Criando…' : 'Criar'}
        </button>
        {erroCriar && (
          <p className="ms-trilhaslista-erro ms-trilhaslista-erro--criar" role="status">
            Não consegui criar essa trilha. O texto continua aí — tente de novo.
          </p>
        )}
      </section>

      <div className="ms-trilhaslista-lista">
        {carregando ? <Esqueleto linhas={3} />
          : erro ? <p className="ms-trilhaslista-erro" role="alert">Não consegui carregar suas trilhas.</p>
          : cursos.length === 0 ? (
            <p className="ms-trilhaslista-vazio">
              Você ainda não criou nenhuma trilha — escreva um assunto aí em cima e a Seraphine monta as lições.
            </p>
          ) : (
            <ul className="ms-trilhaslista-cards">
              {cursos.map((c) => {
                const estado = estadoDoCurso(c);
                const nome = c.title || c.topic;
                // A fração só existe quando há lições: fora disso o cartão não
                // escreve "0 de 0", que seria lido como progresso.
                const temFracao = c.total > 0;
                const pct = temFracao ? Math.round((c.done / c.total) * 100) : 0;
                return (
                  <li
                    key={c.id}
                    data-testid={`ms-trilhaslista-card-${c.id}`}
                    className={`ms-trilhaslista-card ms-trilhaslista-card--${estado}`}
                  >
                    <span className="ms-trilhaslista-icone" aria-hidden="true"><TrilhasIcon size={22} /></span>
                    <div className="ms-trilhaslista-corpo">
                      <div className="ms-trilhaslista-cabeca">
                        <span className="ms-trilhaslista-nome">{nome}</span>
                        <span className={`ms-trilhaslista-badge ms-trilhaslista-badge--${estado}`}>
                          {estado === 'gerando' && <span className="ms-trilhaslista-ponto" aria-hidden="true" />}
                          {estado === 'concluida' && <CheckIcon size={11} />}
                          {ROTULO[estado]}
                        </span>
                      </div>
                      <p className="ms-trilhaslista-meta">
                        {estado === 'gerando' ? 'montando as lições — pode levar alguns minutos'
                          : estado === 'falhou' ? 'a geração não terminou; crie a trilha de novo'
                          : temFracao ? `${c.done} de ${c.total} ${c.total === 1 ? 'lição' : 'lições'}`
                          : 'nenhuma lição nesta trilha'}
                      </p>
                      {estado === 'gerando' ? (
                        // Indeterminada: sem `aria-valuenow`, sem largura.
                        <div className="ms-trilhaslista-barra" role="progressbar" aria-label={`Montando ${nome}`}>
                          <span className="ms-trilhaslista-barra__correndo" />
                        </div>
                      ) : temFracao ? (
                        <div
                          className="ms-trilhaslista-barra"
                          role="progressbar"
                          aria-label={`Progresso de ${nome}`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={pct}
                          aria-valuetext={`${c.done} de ${c.total}`}
                        >
                          <span className="ms-trilhaslista-barra__feita" style={{ width: `${pct}%` }} />
                        </div>
                      ) : (
                        // Nada a reportar (falhou, ou pronta e sem lição): o
                        // trilho fica, vazio e mudo, para o cartão não pular.
                        <div className="ms-trilhaslista-barra" aria-hidden="true" />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
      </div>
    </div>
  );
}
