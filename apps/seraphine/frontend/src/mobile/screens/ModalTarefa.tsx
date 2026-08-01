import { useCallback, useEffect, useRef, useState, type KeyboardEvent as EventoDeTecla } from 'react';
import { MobileSheet } from '../MobileSheet';
import { deleteTask, updateTask } from '../../tasks/api';
import type { Task } from '../../tasks/types';
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../../finance/types';
import { AlertTriangleIcon, BellIcon, BookmarkIcon, BriefcaseIcon, CalendarIcon, CheckIcon, ClockIcon, FlagIcon, TrashIcon, XIcon } from '../../icons/Icons';
import './ModalTarefa.css';

// MODAL DE TAREFA (handoff: frame "Modal · nova tarefa").
//
// Não tem Cancelar nem Salvar: cada campo vira um `PATCH /tasks/:id` 800ms
// depois da última tecla, e o rodapé — que fica FORA da área rolável, por
// construção do `MobileSheet` — diz salvando… / salvo / erro ao salvar.
//
// O QUE ESTE ARQUIVO LEVA A SÉRIO, e por quê:
//  - o save que falha NÃO pode passar batido. Um PATCH perdido em silêncio faz
//    o usuário fechar o sheet achando que salvou; é o pior defeito possível
//    numa tela sem botão de salvar. Daí: estado de erro com `role="alert"`, o
//    patch que falhou VOLTA para a fila (o texto não some junto com o erro),
//    "tentar de novo" ao lado, e fechar com save pendente descarrega antes de
//    sair — e não sai se o descarregamento falhar.
//  - fechar duas vezes SAI. Se o backend estiver fora do ar, prender o usuário
//    dentro do sheet seria trocar um defeito por outro; a primeira tentativa
//    avisa, a segunda vale como "eu vi e quero sair".
//
// Não é tela de registry de propósito: modal é sobreposição sobre a tela atual,
// não destino de navegação. O shell só repassa `id/onBack/onOpen/onDone`, então
// roteá-lo pela registry descartaria calado os callbacks daqui — inclusive o
// `salvar`, que é justamente o que não pode sumir.

/** Os campos que o modal edita. É o corpo do `PATCH /tasks/:id`. */
export type PatchTarefa = Partial<
  Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'due_date' | 'due_time' | 'remind' | 'category' | 'tags'>
>;

export interface ModalTarefaProps {
  aberto: boolean;
  /** A tarefa a editar. Quem abre o modal já a tem em mãos (veio da lista), então
   *  nada é recarregado aqui: o sheet não pisca um esqueleto por dado que o
   *  chamador já possui. */
  tarefa: Task;
  onFechar: () => void;
  /** Persiste um patch. Injetável para o teste; o padrão é `updateTask` da
   *  camada, com a categoria que está NA TELA agora (ver o bloco acima). */
  salvar?: (id: number, patch: PatchTarefa) => Promise<void>;
  excluir?: (id: number) => Promise<void>;
  /** Cada PATCH que volta OK — quem abriu costuma querer relistar. */
  onSalvo?: () => void;
  onExcluida?: () => void;
}

// ── O QUE `tasks/api.ts` SUSTENTA, VERIFICADO NA FONTE ────────────────────────
// Este arquivo ENCOLHEU, como o comentário anterior previa. Enquanto a camada
// só tinha `listTasks`/`updateTaskStatus`/`createTask`, os adaptadores daqui
// erravam alto em tudo que não fosse `status` — o modal desenhava sete linhas
// e salvava uma. A task de integração acrescentou `updateTask`/`deleteTask` a
// `src/tasks/api.ts` (o backend sempre aceitou os dois: `TaskPatch` em
// routes.py:103 e o `DELETE /tasks/{id}` em routes.py:393), e agora todas as
// linhas gravam.
//
// O default do `salvar` nasce DENTRO do componente, e não como função de
// módulo, por um motivo concreto: `updateTask` precisa da categoria ATUAL para
// protegê-la (um patch com `tags` e sem `category` faz o backend rederivar a
// categoria a partir das tags — ver o comentário longo em `tasks/api.ts`). A
// categoria atual é estado deste componente, não do `tarefa` que chegou por
// prop: quem já trocou a categoria aqui dentro tem na tela um valor mais novo
// que o da lista que abriu o modal.

// ── Valores exatos do spec ───────────────────────────────────────────────────

const STATUS_CORES: Record<string, string> = {
  pending: '#9a93ff',
  approved: '#22d3ee',
  completed: '#4ade80',
  rejected: '#64748b',
};

const STATUS: { valor: string; rotulo: string }[] = [
  { valor: 'pending', rotulo: 'Pendente' },
  { valor: 'approved', rotulo: 'Em andamento' },
  { valor: 'completed', rotulo: 'Concluido' },
  { valor: 'rejected', rotulo: 'Descartado' },
];

const PRIORIDADE_CORES: Record<string, string> = { low: '#4ade80', med: '#f59e0b', high: '#ef4444' };

const PRIORIDADES: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: 'Selecionar' },
  { valor: 'low', rotulo: 'Baixa' },
  { valor: 'med', rotulo: 'Media' },
  { valor: 'high', rotulo: 'Alta' },
];

const LEMBRETES: { valor: string; rotulo: string }[] = [
  { valor: '', rotulo: 'Nao lembrar' },
  { valor: 'at_time', rotulo: 'Na hora' },
  { valor: '1h_before', rotulo: '1 hora antes' },
  { valor: '1d_before', rotulo: '1 dia antes' },
];

/** A taxonomia de finanças, sem o emoji do label — o design system da casa usa
 *  SVG inline, nunca emoji, e `CATEGORY_LABELS` guarda um prefixo pictográfico. */
const CATEGORIAS: { valor: string; rotulo: string; cor?: string }[] = [
  { valor: '', rotulo: 'Selecionar' },
  ...Object.keys(CATEGORY_COLORS).map((chave) => ({
    valor: chave,
    rotulo: (CATEGORY_LABELS[chave] || chave).replace(/^[^\p{L}]+/u, '').trim(),
    cor: CATEGORY_COLORS[chave],
  })),
];

const MESES = ['', 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

/** `#rrggbb` + alfa → `rgba(...)`, para o fundo do quadradinho do ícone seguir a
 *  cor do valor (é o que o handoff desenha: prioridade Alta em vermelho, moradia
 *  em índigo). */
function tinta(hex: string, alfa: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alfa})`;
}

/** "2026-06-20" → "20 de junho". Fatiado da string, nunca via `new Date`, que
 *  interpreta a data pura como UTC e devolve o dia anterior em São Paulo. */
function dataPorExtenso(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return '';
  return `${Number(m[3])} de ${MESES[Number(m[2])] ?? m[2]}`;
}

/** "2026-06-20T09:00:00" → "20/06/2026", pela mesma razão. */
function dataCurta(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

type Estado = 'ocioso' | 'salvando' | 'salvo' | 'erro' | 'excluindo' | 'erro-exclusao';

export function ModalTarefa({
  aberto,
  tarefa,
  onFechar,
  salvar,
  excluir = deleteTask,
  onSalvo,
  onExcluida,
}: ModalTarefaProps): JSX.Element {
  const [titulo, setTitulo] = useState(tarefa.title ?? '');
  const [descricao, setDescricao] = useState(tarefa.description ?? '');
  const [status, setStatus] = useState(tarefa.status || 'pending');
  const [prioridade, setPrioridade] = useState(tarefa.priority ?? '');
  const [categoria, setCategoria] = useState((tarefa.category ?? '').toLowerCase());
  const [data, setData] = useState(tarefa.due_date ?? '');
  const [hora, setHora] = useState(tarefa.due_time ?? '');
  const [lembrete, setLembrete] = useState(tarefa.remind ?? '');
  const [tags, setTags] = useState<string[]>(Array.isArray(tarefa.tags) ? tarefa.tags : []);
  const [rascunho, setRascunho] = useState('');
  const [estado, setEstado] = useState<Estado>('ocioso');
  const [confirmando, setConfirmando] = useState(false);

  /** O patch acumulado que ainda não foi enviado. Sobrevive ao erro: um save que
   *  falha devolve o patch para cá, senão o texto sumiria junto com a falha. */
  const pendente = useRef<PatchTarefa | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voando = useRef<Promise<boolean> | null>(null);
  const vivo = useRef(true);

  /** A categoria que está na tela AGORA, lida por `salvar` na hora do PATCH.
   *  Em ref, não em dependência: se ela entrasse nas deps de `enviar`, trocar a
   *  categoria recriaria `enviar` e `agendar` no meio de um debounce em curso. */
  const categoriaAtual = useRef(categoria);
  categoriaAtual.current = categoria;

  /** O padrão do `salvar`: `updateTask` com a categoria viva, que é o que
   *  impede o backend de rederivá-la a partir das tags do próprio patch. */
  const gravar = useCallback(
    (id: number, patch: PatchTarefa) =>
      updateTask({ id, category: categoriaAtual.current || null }, patch),
    [],
  );
  const persistir = salvar ?? gravar;

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
      // Sem isto, um sheet fechado ainda dispararia o PATCH agendado.
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // Trocou a tarefa editada: recomeça dos valores dela, e a fila da anterior
  // não pode vazar para o id novo.
  useEffect(() => {
    setTitulo(tarefa.title ?? '');
    setDescricao(tarefa.description ?? '');
    setStatus(tarefa.status || 'pending');
    setPrioridade(tarefa.priority ?? '');
    setCategoria((tarefa.category ?? '').toLowerCase());
    setData(tarefa.due_date ?? '');
    setHora(tarefa.due_time ?? '');
    setLembrete(tarefa.remind ?? '');
    setTags(Array.isArray(tarefa.tags) ? tarefa.tags : []);
    setRascunho('');
    setEstado('ocioso');
    setConfirmando(false);
    pendente.current = null;
    if (timer.current) clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tarefa.id]);

  /** Manda o que estiver na fila. Devolve `false` se o PATCH falhou — é o que o
   *  fechamento consulta para decidir se pode sair. */
  const enviar = useCallback((): Promise<boolean> => {
    const anterior = voando.current;
    const promessa = (async () => {
      // UM PATCH DE CADA VEZ. Numa rede lenta — justo a de celular — o segundo
      // envio sairia com o primeiro ainda em voo, e os dois carregam o mesmo
      // campo: se o mais VELHO chegar por último, o servidor fica com o texto
      // antigo enquanto a tela mostra o novo. Divergência calada, que é o
      // defeito que esta tela inteira existe para não ter.
      if (anterior) await anterior;
      const patch = pendente.current;
      if (!patch) return true;
      pendente.current = null;
      setEstado('salvando');
      try {
        await persistir(tarefa.id, patch);
        if (vivo.current) {
          setEstado('salvo');
          onSalvo?.();
        }
        return true;
      } catch {
        // O patch volta para a fila POR BAIXO do que tiver sido digitado
        // depois: o valor mais novo é o que vale.
        pendente.current = { ...patch, ...(pendente.current ?? {}) };
        if (vivo.current) setEstado('erro');
        return false;
      }
    })();
    voando.current = promessa;
    void promessa.then(() => {
      if (voando.current === promessa) voando.current = null;
    });
    return promessa;
  }, [persistir, tarefa.id, onSalvo]);

  /** Acumula a mudança e reinicia o debounce de 800ms. */
  const agendar = useCallback((patch: PatchTarefa): void => {
    pendente.current = { ...(pendente.current ?? {}), ...patch };
    // "salvo" não pode continuar no rodapé com mudança na fila: seria afirmar
    // que está gravado o que ainda nem saiu. O erro, esse fica — some só quando
    // um PATCH voltar OK.
    setEstado((atual) => (atual === 'salvo' ? 'ocioso' : atual));
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void enviar();
    }, 800);
  }, [enviar]);

  /** Esvazia tudo o que está em voo ou agendado. `false` = alguma coisa falhou. */
  const descarregar = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    let ok = true;
    if (voando.current) ok = await voando.current;
    if (pendente.current) ok = (await enviar()) && ok;
    return ok;
  }, [enviar]);

  const fechar = useCallback(async (): Promise<void> => {
    // Já avisado uma vez: a segunda tentativa de sair vale como "eu vi". Sem
    // esta saída, um backend fora do ar prenderia o usuário no sheet.
    if (estado === 'erro' || estado === 'erro-exclusao') {
      onFechar();
      return;
    }
    if (await descarregar()) onFechar();
  }, [estado, descarregar, onFechar]);

  const mudarTags = (proximas: string[]): void => {
    setTags(proximas);
    agendar({ tags: proximas });
  };

  const adicionarTag = (cru: string): void => {
    const limpa = cru.trim().replace(/^#+/, '').trim();
    setRascunho('');
    if (!limpa) return;
    if (tags.some((t) => t.toLowerCase() === limpa.toLowerCase())) return;
    mudarTags([...tags, limpa]);
  };

  const teclaDaTag = (e: EventoDeTecla<HTMLInputElement>): void => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      adicionarTag(rascunho);
    } else if (e.key === 'Backspace' && !rascunho && tags.length) {
      e.preventDefault();
      mudarTags(tags.slice(0, -1));
    }
  };

  const excluirAgora = async (): Promise<void> => {
    setEstado('excluindo');
    try {
      await excluir(tarefa.id);
      if (!vivo.current) return;
      onExcluida?.();
      onFechar();
    } catch {
      if (!vivo.current) return;
      setConfirmando(false);
      setEstado('erro-exclusao');
    }
  };

  const corStatus = STATUS_CORES[status] ?? '#64748b';
  const corPrioridade = PRIORIDADE_CORES[prioridade] ?? '';
  const corCategoria = CATEGORY_COLORS[categoria] ?? '';
  const rotuloStatus = STATUS.find((o) => o.valor === status)?.rotulo ?? status;
  const rotuloPrioridade = PRIORIDADES.find((o) => o.valor === prioridade)?.rotulo ?? 'Selecionar';
  const rotuloCategoria = CATEGORIAS.find((o) => o.valor === categoria)?.rotulo ?? 'Selecionar';
  const rotuloLembrete = LEMBRETES.find((o) => o.valor === lembrete)?.rotulo ?? 'Nao lembrar';

  const cabecalho = (
    <div className="ms-mtarefa-cabecalho">
      <input
        type="text"
        className="ms-mtarefa-titulo"
        aria-label="Título da tarefa"
        placeholder="Titulo da tarefa..."
        value={titulo}
        onChange={(e) => {
          setTitulo(e.target.value);
          agendar({ title: e.target.value });
        }}
      />
      <div className="ms-mtarefa-acoes">
        {confirmando ? (
          <>
            <button
              type="button"
              className="ms-mtarefa-acao ms-mtarefa-acao--texto ms-mtarefa-acao--perigo"
              onClick={() => void excluirAgora()}
              disabled={estado === 'excluindo'}
            >
              Sim
            </button>
            <button
              type="button"
              className="ms-mtarefa-acao ms-mtarefa-acao--texto"
              onClick={() => setConfirmando(false)}
            >
              Não
            </button>
          </>
        ) : (
          <button
            type="button"
            className="ms-mtarefa-acao ms-mtarefa-acao--icone ms-mtarefa-acao--perigo"
            aria-label="Excluir tarefa"
            onClick={() => setConfirmando(true)}
          >
            <TrashIcon size={14} />
          </button>
        )}
        <button
          type="button"
          className="ms-mtarefa-acao ms-mtarefa-acao--icone"
          aria-label="Fechar tarefa"
          onClick={() => void fechar()}
        >
          <XIcon size={14} />
        </button>
      </div>
    </div>
  );

  const rodape = (
    <div className="ms-mtarefa-rodape">
      <span className="ms-mtarefa-criada">{dataCurta(tarefa.created_at ?? '')}</span>
      {estado === 'erro' || estado === 'erro-exclusao' ? (
        // A ÚNICA região com `role="alert"` do modal — inclusive a falha de
        // exclusão passa por aqui, para não haver dois alertas competindo.
        <span className="ms-mtarefa-status ms-mtarefa-status--erro" role="alert">
          <AlertTriangleIcon size={12} />
          {estado === 'erro' ? 'erro ao salvar' : 'erro ao excluir'}
          {estado === 'erro' ? (
            <button type="button" className="ms-mtarefa-retentar" onClick={() => void enviar()}>
              tentar de novo
            </button>
          ) : null}
        </span>
      ) : (
        <span className={`ms-mtarefa-status ms-mtarefa-status--${estado}`} role="status">
          {estado === 'salvando' ? 'salvando…' : null}
          {estado === 'excluindo' ? 'excluindo…' : null}
          {estado === 'salvo' ? (
            <>
              <CheckIcon size={12} />
              salvo
            </>
          ) : null}
        </span>
      )}
    </div>
  );

  return (
    <MobileSheet aberto={aberto} onFechar={() => void fechar()} rotulo="Editar tarefa" titulo={cabecalho} rodape={rodape}>
      <div className="ms-mtarefa-linha">
        <span className="ms-mtarefa-icone" style={{ backgroundColor: tinta(corStatus, 0.13), color: corStatus }} aria-hidden="true">
          <ClockIcon size={14} />
        </span>
        <span className="ms-mtarefa-rotulo">Status</span>
        <span className="ms-mtarefa-valor" style={{ color: corStatus }} aria-hidden="true">
          <span className="ms-mtarefa-ponto ms-mtarefa-ponto--status" style={{ backgroundColor: corStatus }} />
          {rotuloStatus}
        </span>
        <select
          className="ms-mtarefa-sobreposto"
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            agendar({ status: e.target.value });
          }}
        >
          {STATUS.map((o) => (
            <option key={o.valor} value={o.valor}>{o.rotulo}</option>
          ))}
        </select>
      </div>
      <div className="ms-mtarefa-divisoria" />

      <div className="ms-mtarefa-linha">
        <span
          className="ms-mtarefa-icone"
          style={corPrioridade ? { backgroundColor: tinta(corPrioridade, 0.12), color: corPrioridade } : undefined}
          aria-hidden="true"
        >
          <FlagIcon size={14} />
        </span>
        <span className="ms-mtarefa-rotulo">Prioridade</span>
        <span className="ms-mtarefa-valor" style={corPrioridade ? { color: corPrioridade } : undefined} aria-hidden="true">
          {rotuloPrioridade}
          {corPrioridade ? (
            <span className="ms-mtarefa-ponto ms-mtarefa-ponto--prioridade" style={{ backgroundColor: corPrioridade }} />
          ) : null}
        </span>
        <select
          className="ms-mtarefa-sobreposto"
          aria-label="Prioridade"
          value={prioridade}
          onChange={(e) => {
            setPrioridade(e.target.value);
            agendar({ priority: e.target.value });
          }}
        >
          {PRIORIDADES.map((o) => (
            <option key={o.valor} value={o.valor}>{o.rotulo}</option>
          ))}
        </select>
      </div>
      <div className="ms-mtarefa-divisoria" />

      <div className="ms-mtarefa-linha">
        <span
          className="ms-mtarefa-icone"
          style={corCategoria ? { backgroundColor: tinta(corCategoria, 0.16), color: corCategoria } : undefined}
          aria-hidden="true"
        >
          <BriefcaseIcon size={14} />
        </span>
        <span className="ms-mtarefa-rotulo">Categoria</span>
        <span className="ms-mtarefa-valor" style={corCategoria ? { color: corCategoria } : undefined} aria-hidden="true">
          {rotuloCategoria}
          {corCategoria ? (
            <span className="ms-mtarefa-ponto ms-mtarefa-ponto--categoria" style={{ backgroundColor: corCategoria }} />
          ) : null}
        </span>
        <select
          className="ms-mtarefa-sobreposto"
          aria-label="Categoria"
          value={categoria}
          onChange={(e) => {
            setCategoria(e.target.value);
            agendar({ category: e.target.value });
          }}
        >
          {CATEGORIAS.map((o) => (
            <option key={o.valor} value={o.valor}>{o.rotulo}</option>
          ))}
        </select>
      </div>
      <div className="ms-mtarefa-divisoria" />

      <div className="ms-mtarefa-linha">
        <span className="ms-mtarefa-icone ms-mtarefa-icone--data" aria-hidden="true">
          <CalendarIcon size={14} />
        </span>
        <span className="ms-mtarefa-rotulo">Data</span>
        <span className="ms-mtarefa-valor ms-mtarefa-valor--data">
          <span className="ms-mtarefa-campo">
            <span className={data ? 'ms-mtarefa-data' : 'ms-mtarefa-data ms-mtarefa-data--vazia'} aria-hidden="true">
              {data ? dataPorExtenso(data) : 'Selecionar data'}
            </span>
            {/* O input nativo cobre o rótulo: no iPhone o toque abre o seletor do
                sistema, e o alvo tem os 44pt sem engordar a linha de 48. */}
            <input
              type="date"
              className="ms-mtarefa-sobreposto"
              aria-label="Data"
              value={data}
              onChange={(e) => {
                setData(e.target.value);
                agendar({ due_date: e.target.value });
              }}
            />
          </span>
          <span className="ms-mtarefa-campo ms-mtarefa-campo--hora">
            <ClockIcon size={14} />
            <span aria-hidden="true">{hora || '--:--'}</span>
            <input
              type="time"
              className="ms-mtarefa-sobreposto"
              aria-label="Hora"
              value={hora}
              onChange={(e) => {
                setHora(e.target.value);
                agendar({ due_time: e.target.value });
              }}
            />
          </span>
        </span>
      </div>
      <div className="ms-mtarefa-divisoria" />

      <div className="ms-mtarefa-linha">
        <span className="ms-mtarefa-icone ms-mtarefa-icone--lembrete" aria-hidden="true">
          <BellIcon size={14} />
        </span>
        <span className="ms-mtarefa-rotulo">Lembrete</span>
        <span className="ms-mtarefa-valor ms-mtarefa-valor--neutro" aria-hidden="true">{rotuloLembrete}</span>
        <select
          className="ms-mtarefa-sobreposto"
          aria-label="Lembrete"
          value={lembrete}
          onChange={(e) => {
            setLembrete(e.target.value);
            agendar({ remind: e.target.value });
          }}
        >
          {LEMBRETES.map((o) => (
            <option key={o.valor} value={o.valor}>{o.rotulo}</option>
          ))}
        </select>
      </div>
      <div className="ms-mtarefa-divisoria" />

      <div className="ms-mtarefa-linha ms-mtarefa-linha--tags">
        <span className="ms-mtarefa-icone ms-mtarefa-icone--tags" aria-hidden="true">
          <BookmarkIcon size={14} />
        </span>
        <span className="ms-mtarefa-rotulo ms-mtarefa-rotulo--fixo">Tags</span>
        <span className="ms-mtarefa-tags">
          {tags.map((tag) => (
            <span key={tag} className="ms-mtarefa-chip">
              {tag}
              <button
                type="button"
                className="ms-mtarefa-chip-x"
                aria-label={`Remover tag ${tag}`}
                onClick={() => mudarTags(tags.filter((t) => t !== tag))}
              >
                <XIcon size={16} />
              </button>
            </span>
          ))}
          <input
            type="text"
            className="ms-mtarefa-tag-input"
            aria-label="Adicionar tag"
            placeholder="adicionar tag..."
            value={rascunho}
            onChange={(e) => setRascunho(e.target.value)}
            onKeyDown={teclaDaTag}
            // Sem isto, uma tag digitada e não confirmada some no fechamento —
            // sumiço silencioso, o mesmo pecado do save calado.
            onBlur={() => adicionarTag(rascunho)}
          />
        </span>
      </div>

      <textarea
        className="ms-mtarefa-descricao"
        aria-label="Descrição"
        placeholder="Escreva os detalhes..."
        value={descricao}
        onChange={(e) => {
          setDescricao(e.target.value);
          agendar({ description: e.target.value });
        }}
      />
    </MobileSheet>
  );
}
