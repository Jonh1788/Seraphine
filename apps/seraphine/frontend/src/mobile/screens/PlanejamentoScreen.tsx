import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, ClockIcon, SparkleIcon } from '../../icons/Icons';
import { acceptPlan, fetchPlan, updateBlock } from '../../planning/api';
import type { DailyPlan, TimeBlock } from '../../planning/types';
import type { ScreenProps } from './registry';
import './PlanejamentoScreen.css';

/* Tela PLANEJAMENTO (handoff v3, frame "Planejamento"). Espelha o
 * `planning/PlanningView.tsx` do desktop e consome a mesma `planning/api.ts`.
 *
 * ── O QUE O FRAME DESENHA E A API NÃO TEM ───────────────────────────────────
 * O frame escreve no bloco de foco "90 min · seu melhor horário" e na reunião
 * "1h · Google Meet". `TimeBlock` tem id, start, end, type, title, linked_id e
 * reason — e nada mais. Não há campo de local, e "seu melhor horário" não é
 * escrito por ninguém: o que o backend escreve em `reason` é
 * "N tarefa(s) prioritaria(s)" ou, sem prioridades, a frase derivada da energia
 * (`_focus_reason_for_energy`, em planning/service.py); com LLM disponível, a
 * razão vem reescrita pelo modelo. Então a linha de meta é
 * `duração · reason`, com a razão REAL, e sem razão fica só a duração.
 * A duração é calculada de start/end — é o único número que o dado sustenta.
 *
 * O sparkle é a marca de autoria da Seraphine em toda esta base, e só
 * `context.ai_generated` diz que um modelo de fato escreveu algo (o desktop já
 * trata assim, PlanningView linhas 125-136). O rótulo "FOCO SUGERIDO" fica
 * sempre — o backend sugere mesmo o bloco, por heurística —, mas a marca só
 * aparece quando houve LLM.
 *
 * ── "ACEITAR PLANO" EXISTE ──────────────────────────────────────────────────
 * `POST /planning/accept` existe e faz coisa real: marca o dia como aceito e
 * cria os eventos de calendário dos blocos focus/exercise/admin, devolvendo
 * `calendar_events_created`. O botão do frame não finge nada. E o número que
 * ele devolve é o que a tela diz depois — inclusive quando é ZERO (Google
 * desconectado cria zero eventos e ainda responde ok:true; dizer "pronto" ali
 * seria mentira).
 *
 * ── ARRASTAR: NÃO ──────────────────────────────────────────────────────────
 * As fichas de "A ENCAIXAR" são as `priorities` — tarefas pendentes, não
 * blocos. Não existe rota que agende uma tarefa: `PATCH /planning/blocks/{id}`
 * só aceita start/end/title/type de um bloco QUE JÁ EXISTE (o corpo é
 * `extra: forbid`), e não há POST de bloco novo. Então o gesto do desenho —
 * arrastar a ficha para dentro da linha do tempo — não tem para onde persistir,
 * além de disputar com a rolagem vertical em iOS.
 *
 * O que existe de verdade e é a mesma intenção: escolher um BLOCO DE FOCO e
 * dar a ele o nome da tarefa. É um toque na ficha, um toque no horário, e um
 * PATCH que o backend guarda; quando o plano for aceito, o evento vai para a
 * agenda com o nome da tarefa. Sem gesto: funciona com leitor de tela, tem alvo
 * de 44pt, e é testável sem sintetizar pointerdown/move/up.
 * Só blocos de FOCO são vaga. Um bloco `free` só viraria evento na agenda se a
 * tela também trocasse o `type` dele por baixo do pano, e reunião/exercício já
 * são outra coisa — encaixar dentro deles seria renomear o compromisso alheio.
 *
 * ── ENCAIXAR NÃO RECARREGA ─────────────────────────────────────────────────
 * `GET /planning/today` não lê o plano do dia: chama `generate_plan()`, que
 * REGENERA tudo e sobrescreve a linha (`ON CONFLICT DO UPDATE SET plan_json =
 * excluded.plan_json, accepted = 0`). Recarregar depois de um PATCH joga o
 * PATCH fora — é o que o desktop faz hoje (`handleBlockSave` chama
 * `loadPlan()`), e por isso a edição dele não sobrevive. Aqui o encaixe é
 * aplicado no estado local, que é exatamente o que o servidor gravou.
 * "Refazer" é o único caminho que regenera, e regenerar é o que ele promete.
 */

/** Cores das categorias — as mesmas do desktop (`BLOCK_COLORS`) e as mesmas que
 *  o frame desenha. Vivem no CSS, uma classe por tipo. */
const TIPOS_CONHECIDOS = new Set(['focus', 'meeting', 'break', 'exercise', 'admin', 'free']);

const FORMATO_DATA = new Intl.DateTimeFormat('pt-BR', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
});

function dataDeHoje(): string {
  const bruto = FORMATO_DATA.format(new Date());
  return bruto.charAt(0).toUpperCase() + bruto.slice(1);
}

function emMinutos(hm: string): number {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}

/** Duração real do bloco. `null` quando o par de horários não sustenta um
 *  número positivo (um evento que atravessa a meia-noite, por exemplo) — aí a
 *  tela não escreve duração nenhuma em vez de escrever uma negativa.
 *
 *  O formato reproduz os dois exemplos do frame: 60 min vira "1h", 90 min vira
 *  "90 min". */
function duracao(inicio: string, fim: string): string | null {
  const min = emMinutos(fim) - emMinutos(inicio);
  if (!Number.isFinite(min) || min <= 0) return null;
  if (min % 60 === 0) return `${min / 60}h`;
  return `${min} min`;
}

/** Espera sem texto: nada pisca "nenhum bloco" antes do plano chegar. */
function Esqueleto(): JSX.Element {
  return (
    <div className="ms-plan-skel" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <span key={i} />)}
    </div>
  );
}

interface Aceite {
  eventos: number;
}

export function PlanejamentoScreen({ onBack }: ScreenProps): JSX.Element {
  const [plano, setPlano] = useState<DailyPlan | null>(null);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState(false);

  const [escolhendo, setEscolhendo] = useState<string | null>(null);
  const [erroEncaixe, setErroEncaixe] = useState(false);

  const [aceitando, setAceitando] = useState(false);
  const [aceite, setAceite] = useState<Aceite | null>(null);
  const [erroAceite, setErroAceite] = useState(false);

  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; };
  }, []);

  /* Guardas de reentrada. O atributo `disabled` NÃO serve para isto: dois
     toques no mesmo quadro chegam aos dois manipuladores antes de qualquer
     re-render, e o `disabled` que o React ainda não pintou não impede o
     segundo. Um duplo POST /planning/accept criaria os eventos do dia duas
     vezes na agenda. A ref muda no mesmo tique do primeiro toque. */
  const aceitandoRef = useRef(false);
  const encaixandoRef = useRef(false);

  const carregar = useCallback(async (): Promise<void> => {
    setCarregando(true);
    setErro(false);
    try {
      const p = await fetchPlan();
      if (!vivo.current) return;
      setPlano(p);
      // O plano é OUTRO: o que estava escolhido, encaixado ou aceito era do
      // anterior. O backend também zera o `accepted` ao regenerar.
      setEscolhendo(null);
      setErroEncaixe(false);
      setAceite(null);
      setErroAceite(false);
    } catch {
      if (!vivo.current) return;
      setErro(true);
      setPlano(null);
    } finally {
      if (vivo.current) setCarregando(false);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const blocos = plano?.time_blocks ?? [];
  const prioridades = plano?.priorities ?? [];
  const contexto = plano?.context;
  const comIA = contexto?.ai_generated === true;

  /* Uma prioridade está encaixada quando ALGUM bloco de foco carrega o título
     dela — que é exatamente o efeito do PATCH. Derivar do plano, em vez de
     guardar uma lista à parte, mantém a tela contando a mesma verdade que o
     servidor guardou (e, depois de um "Refazer", a mesma que ele regenerou). */
  const encaixes = useMemo(() => {
    const m = new Map<string, TimeBlock>();
    for (const p of prioridades) {
      const b = blocos.find((x) => x.type === 'focus' && x.title === p.title);
      if (b) m.set(p.id, b);
    }
    return m;
  }, [blocos, prioridades]);

  const ocupados = useMemo(
    () => new Set([...encaixes.values()].map((b) => b.id)),
    [encaixes],
  );
  /** Vagas: blocos de foco que ainda não carregam nenhuma tarefa. Reaproveitar
   *  um ocupado apagaria a tarefa que já estava lá. */
  const vagas = useMemo(
    () => blocos.filter((b) => b.type === 'focus' && !ocupados.has(b.id)),
    [blocos, ocupados],
  );

  const aEncaixar = prioridades.length - encaixes.size;
  const tarefaEscolhida = prioridades.find((p) => p.id === escolhendo);

  const encaixar = useCallback((bloco: TimeBlock, titulo: string): void => {
    if (encaixandoRef.current) return;
    encaixandoRef.current = true;
    setErroEncaixe(false);
    updateBlock(bloco.id, { title: titulo })
      .then(() => {
        if (!vivo.current) return;
        // Aplicado localmente de propósito: recarregar aqui REGENERA o plano
        // no backend e apaga este PATCH.
        setPlano((p) => (p
          ? { ...p, time_blocks: p.time_blocks.map((b) => (b.id === bloco.id ? { ...b, title: titulo } : b)) }
          : p));
        setEscolhendo(null);
      })
      .catch(() => { if (vivo.current) setErroEncaixe(true); })
      .finally(() => { encaixandoRef.current = false; });
  }, []);

  const aceitar = useCallback((): void => {
    if (aceitandoRef.current) return;
    aceitandoRef.current = true;
    setAceitando(true);
    setErroAceite(false);
    acceptPlan()
      .then((r) => {
        if (!vivo.current) return;
        setAceite({ eventos: r.calendar_events_created });
      })
      .catch(() => { if (vivo.current) setErroAceite(true); })
      .finally(() => {
        aceitandoRef.current = false;
        if (vivo.current) setAceitando(false);
      });
  }, []);

  const temPlano = !carregando && !erro && plano !== null;
  const temBlocos = temPlano && blocos.length > 0;

  /* Cartão de sugestão: a frase do modelo quando houve modelo; caso contrário,
     os números que a tela já tem — sem narrativa inventada, e sem assinar como
     Seraphine o que a Seraphine não escreveu. */
  const nFoco = blocos.filter((b) => b.type === 'focus').length;
  const horasSemReuniao = Math.round((contexto?.free_slots_min ?? 0) / 60);
  const resumoDoModelo = comIA && contexto?.summary ? contexto.summary : null;
  const textoSugestao = resumoDoModelo
    ?? `${nFoco === 0 ? 'Sem bloco de foco' : `${nFoco} bloco${nFoco === 1 ? '' : 's'} de foco`} · ${horasSemReuniao}h sem reunião`;

  return (
    <div className="ms-plan">
      <header className="ms-plan-topo">
        {onBack && (
          <button type="button" className="ms-plan-voltar" aria-label="Voltar" onClick={() => onBack()}>
            <ArrowLeftIcon size={20} />
          </button>
        )}
        <div className="ms-plan-titulos">
          <h1 className="ms-plan-titulo">Seu dia</h1>
          <p className="ms-plan-data">{dataDeHoje()}</p>
        </div>
        <button
          type="button"
          className="ms-plan-refazer"
          disabled={carregando}
          onClick={() => { void carregar(); }}
        >
          Refazer
        </button>
      </header>

      <div className="ms-plan-corpo">
        {carregando ? <Esqueleto />
          : erro ? (
            <p className="ms-plan-erro" role="alert">
              Não consegui carregar seu plano de hoje.
            </p>
          ) : (
            <>
              {temBlocos ? (
                <ul className="ms-plan-linhas">
                  {blocos.map((b) => {
                    const foco = b.type === 'focus';
                    const tipo = TIPOS_CONHECIDOS.has(b.type) ? b.type : 'admin';
                    const meta = [duracao(b.start, b.end), b.reason].filter(Boolean).join(' · ');
                    return (
                      <li
                        key={b.id}
                        data-testid={`ms-plan-linha-${b.id}`}
                        className={`ms-plan-linha${foco ? ' ms-plan-linha--focus' : ''}`}
                      >
                        <span className="ms-plan-hora">{b.start}</span>
                        <div className={`ms-plan-bloco ms-plan-bloco--${tipo}`}>
                          {foco && (
                            <div className="ms-plan-eyebrow">
                              {comIA && (
                                <span className="ms-plan-ia" data-testid={`ms-plan-ia-${b.id}`}>
                                  <SparkleIcon size={13} />
                                </span>
                              )}
                              FOCO SUGERIDO
                            </div>
                          )}
                          <div className="ms-plan-bloco__titulo">{b.title}</div>
                          {meta !== '' && <div className="ms-plan-bloco__meta">{meta}</div>}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="ms-plan-vazio">
                  Nenhum bloco no plano de hoje. Toque em Refazer para a Seraphine montar um.
                </p>
              )}

              <section className="ms-plan-encaixar">
                <p className="ms-plan-rotulo">A ENCAIXAR · {aEncaixar}</p>
                {prioridades.length === 0 ? (
                  <p className="ms-plan-recado">Nada pendente para encaixar.</p>
                ) : (
                  <div className="ms-plan-fichas">
                    {prioridades.map((p) => {
                      const onde = encaixes.get(p.id);
                      const ativa = escolhendo === p.id;
                      return (
                        <button
                          key={p.id}
                          type="button"
                          data-testid={`ms-plan-chip-${p.id}`}
                          className={`ms-plan-chip${onde ? ' ms-plan-chip--encaixada' : ''}${ativa ? ' ms-plan-chip--escolhida' : ''}`}
                          disabled={onde !== undefined}
                          aria-expanded={onde ? undefined : ativa}
                          onClick={() => {
                            setErroEncaixe(false);
                            setEscolhendo(ativa ? null : p.id);
                          }}
                        >
                          <span className="ms-plan-chip__icone" aria-hidden="true"><ClockIcon size={13} /></span>
                          {p.title}
                          {onde && <span className="ms-plan-chip__hora">{onde.start}</span>}
                        </button>
                      );
                    })}
                  </div>
                )}

                {tarefaEscolhida && (
                  <div className="ms-plan-seletor" role="group" aria-label={`Encaixar ${tarefaEscolhida.title}`}>
                    {vagas.length === 0 ? (
                      <p className="ms-plan-recado" role="status">
                        Nenhum bloco de foco livre hoje — refaça o plano para abrir um.
                      </p>
                    ) : (
                      <>
                        <span className="ms-plan-seletor__rotulo">Encaixar às</span>
                        {vagas.map((b) => (
                          <button
                            key={b.id}
                            type="button"
                            data-testid={`ms-plan-slot-${b.id}`}
                            className="ms-plan-slot"
                            aria-label={`Encaixar ${tarefaEscolhida.title} às ${b.start}`}
                            onClick={() => encaixar(b, tarefaEscolhida.title)}
                          >
                            {b.start}
                          </button>
                        ))}
                        <button
                          type="button"
                          className="ms-plan-slot ms-plan-slot--cancelar"
                          onClick={() => setEscolhendo(null)}
                        >
                          Cancelar
                        </button>
                      </>
                    )}
                  </div>
                )}

                {erroEncaixe && (
                  <p className="ms-plan-recado ms-plan-recado--erro" role="status">
                    Não consegui encaixar essa tarefa. Tente de novo.
                  </p>
                )}
              </section>

              {temBlocos && (
                <div className="ms-plan-sug">
                  {resumoDoModelo && (
                    <span className="ms-plan-sug__marca" aria-hidden="true"><SparkleIcon size={15} /></span>
                  )}
                  <div className="ms-plan-sug__corpo">
                    <span className="ms-plan-sug__head">
                      {resumoDoModelo ? 'Sugerido pela Seraphine' : 'Plano do dia'}
                    </span>
                    <p className="ms-plan-sug__texto">{textoSugestao}</p>
                  </div>
                </div>
              )}
            </>
          )}
      </div>

      {temBlocos && (
        <div className="ms-plan-rodape">
          {aceite ? (
            <button type="button" className="ms-plan-cta ms-plan-cta--aceito" disabled>
              Plano aceito
            </button>
          ) : (
            <button
              type="button"
              className="ms-plan-cta"
              disabled={aceitando}
              onClick={aceitar}
            >
              {aceitando ? 'Aceitando…' : 'Aceitar plano'}
            </button>
          )}
          {aceite && (
            <p className="ms-plan-recado ms-plan-recado--ok" role="status">
              {aceite.eventos > 0
                ? `${aceite.eventos} evento${aceite.eventos === 1 ? '' : 's'} na sua agenda.`
                : 'Nenhum evento foi criado na agenda — confira a conexão com o Google.'}
            </p>
          )}
          {erroAceite && (
            <p className="ms-plan-recado ms-plan-recado--erro" role="status">
              Não consegui aceitar o plano. Tente de novo.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
