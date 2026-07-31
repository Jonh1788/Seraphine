import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, PlusIcon, SearchIcon } from '../../icons/Icons';
import { createNote, listNotes } from '../../notes/api';
import type { Note } from '../../notes/types';
import type { ScreenProps } from './registry';
import './NotasScreen.css';

// O handoff NÃO desenha uma tela de Notas: Notas só existe como cartão do grid
// do Mais (linha 384, ícone de arquivo, "12 notas"). Sem autoridade de pixel, a
// tela é feita do vocabulário que as outras empurradas já estabeleceram — a
// Memória (linha 491) dá a medida exata do cabeçalho (‹ 18px + título 20/700 +
// contagem 11px + botão 38px raio 12), do campo de busca (raio 13, 10px 14px) e
// do cartão (raio 15, 13px 15px, intervalo 9). Nada aqui é inventado: o que não
// tem precedente no handoff nem respaldo no `notes/api.ts` simplesmente não
// existe nesta tela.
//
// O que ficou de fora, de propósito:
//  · filtro por etiqueta — `fetchTags` existe, mas a task lista "‹ + busca +
//    cartões" e mais nada; as etiquetas aparecem como DADO no cartão, não como
//    uma superfície de filtro que o desenho nunca mostrou;
//  · abrir/editar/apagar a nota — não há tela de detalhe no registry e o
//    registry é de outro dono; um cartão que promete abrir e não abre é pior
//    que um cartão quieto. O corpo inteiro fica no backend até existir destino.
//
// O "+" FICA porque `notes/api.ts` tem `createNote`: é o mesmo botão accent que
// o handoff desenha no cabeçalho da Memória, agora com escrita atrás dele.
//
// REGRA DA TELA (igual à do Hoje, Memória e Diário): nenhum bloco devolve
// `null`. Cabeçalho, lista e cartão têm cada um as três saídas — dado, vazio
// desenhado e erro — e cada bloco erra com a SUA frase, para o teste apontar
// um bloco só.

/** Quantas notas pedir. O mesmo teto que a tela de desktop usa. */
const LIMITE = 100;

/** Espera antes de rebuscar enquanto o dedo ainda digita. */
const DEBOUNCE_MS = 200;

/** Quantos caracteres de prévia cabem em duas linhas do cartão. */
const PREVIA = 90;

/** O "+" diz `aria-expanded`; com o `aria-controls` ele também diz o QUÊ abre. */
const COMPOSITOR_ID = 'ms-notas-compositor';

/** Data curta do cartão: hora quando é de hoje, dia/mês quando é mais velha —
 *  a mesma regra da lista de notas do desktop, para a mesma nota não aparecer
 *  com dois formatos diferentes nas duas telas. */
function formatarData(iso: string): string {
  if (!iso || iso.length < 10) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hoje = new Date();
  const doDia =
    d.getFullYear() === hoje.getFullYear() &&
    d.getMonth() === hoje.getMonth() &&
    d.getDate() === hoje.getDate();
  if (doDia) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Markdown vira uma linha de texto: o cartão mostra a nota, não a marcação. */
function previa(conteudo: string): string {
  const limpo = (conteudo || '').replace(/[#*_>`\-]+/g, '').replace(/\s+/g, ' ').trim();
  if (!limpo) return '';
  return limpo.length <= PREVIA ? limpo : `${limpo.slice(0, PREVIA - 1).trimEnd()}…`;
}

export function NotasScreen({ onBack }: ScreenProps) {
  const [notas, setNotas] = useState<Note[] | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState('');

  // compositor
  const [compondo, setCompondo] = useState(false);
  const [titulo, setTitulo] = useState('');
  const [corpo, setCorpo] = useState('');
  const [salvando, setSalvando] = useState(false);
  const [erroSalvar, setErroSalvar] = useState(false);
  const [recarga, setRecarga] = useState(0);

  // O `vivo` é re-armado no corpo do efeito, não só desligado na limpeza: sob
  // StrictMode (o `main.tsx` embrulha o app) o dev roda montar → limpar →
  // montar, e sem esta linha o `vivo.current` ficava `false` para sempre —
  // salvar escrevia no servidor e a tela não fechava o compositor, não parava
  // de dizer "Salvando" e engolia até a mensagem de falha. É a forma que o
  // Diário já usa (`DiarioScreen.tsx:57`).
  const vivo = useRef(true);
  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; };
  }, []);

  const termo = busca.trim();

  // A busca é do servidor (`listNotes` manda `q`), refeita a cada termo, para a
  // tela nunca guardar uma lista recortada achando que é o caderno inteiro.
  useEffect(() => {
    let ativo = true;
    const buscar = () => {
      listNotes(termo || undefined, LIMITE)
        .then((n) => { if (ativo) { setNotas(n); setErro(false); setCarregando(false); } })
        .catch(() => { if (ativo) { setNotas(null); setErro(true); setCarregando(false); } });
    };
    // A primeira carga (sem termo) não espera: a tela abre com dado.
    if (!termo) { buscar(); return () => { ativo = false; }; }
    const t = setTimeout(buscar, DEBOUNCE_MS);
    return () => { ativo = false; clearTimeout(t); };
  }, [termo, recarga]);

  const lista = notas ?? [];

  const salvar = async () => {
    const t = titulo.trim();
    if (!t || salvando) return;
    setSalvando(true);
    setErroSalvar(false);
    try {
      await createNote({ title: t, content: corpo.trim() });
      if (!vivo.current) return;
      // só limpa depois do servidor aceitar: texto perdido é pior que repetido
      setTitulo('');
      setCorpo('');
      setCompondo(false);
      setRecarga((n) => n + 1);
    } catch {
      if (vivo.current) setErroSalvar(true);
    } finally {
      if (vivo.current) setSalvando(false);
    }
  };

  return (
    <div className="ms-notas">
      <header className="ms-notas-head">
        {/* O shell não desenha chrome nenhum: a seta de voltar é da tela.
            `onBack` é opcional no ScreenProps — sem ele não há para onde
            voltar, então o controle não aparece em vez de virar botão morto. */}
        {onBack && (
          <button type="button" className="ms-notas-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-notas-head-txt">
          <h1 className="ms-notas-titulo">Notas</h1>
          {carregando ? <Skel linhas={1} />
            : erro ? <Erro>Não consegui contar suas notas.</Erro>
            : lista.length ? <p className="ms-notas-sub">{lista.length} {lista.length === 1 ? 'nota' : 'notas'}</p>
            : termo ? <Vazio>nenhuma nota casa com a busca</Vazio>
            : <Vazio>nenhuma nota ainda</Vazio>}
        </div>
        <button
          type="button"
          className="ms-notas-novo"
          aria-label="Nova nota"
          aria-expanded={compondo}
          aria-controls={COMPOSITOR_ID}
          onClick={() => { setCompondo((c) => !c); setErroSalvar(false); }}
        >
          <PlusIcon size={18} />
        </button>
      </header>

      <div className="ms-notas-busca">
        <span className="ms-notas-busca-icone"><SearchIcon size={15} /></span>
        <input
          type="search"
          className="ms-notas-busca-campo"
          placeholder="Buscar nas notas…"
          aria-label="Buscar nas notas"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>

      <div className="ms-notas-lista">
        {/* Compositor: só aparece pelo "+", porque o desenho não pede um
            formulário aberto na cara de quem só queria reler uma nota. */}
        {compondo && (
          <section id={COMPOSITOR_ID} className="ms-notas-card ms-notas-compositor">
            <input
              type="text"
              className="ms-notas-campo-titulo"
              aria-label="Título da nota"
              placeholder="Título"
              value={titulo}
              onChange={(e) => setTitulo(e.target.value)}
              disabled={salvando}
            />
            <textarea
              className="ms-notas-campo"
              aria-label="Conteúdo da nota"
              placeholder="Escreva a nota…"
              rows={3}
              value={corpo}
              onChange={(e) => setCorpo(e.target.value)}
              disabled={salvando}
            />
            <div className="ms-notas-compositor-pe">
              <button
                type="button"
                className="ms-notas-cancelar"
                onClick={() => { setCompondo(false); setErroSalvar(false); }}
                disabled={salvando}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="ms-notas-salvar"
                onClick={() => void salvar()}
                disabled={salvando || !titulo.trim()}
              >
                {salvando ? 'Salvando' : 'Salvar'}
              </button>
            </div>
            {erroSalvar && <Erro>Não consegui salvar sua nota — o texto continua aqui.</Erro>}
          </section>
        )}

        {carregando ? <SkelCartoes />
          : erro ? <div className="ms-notas-card"><Erro>Não consegui carregar suas notas.</Erro></div>
          : lista.length ? lista.map((n) => <Cartao key={n.id} nota={n} />)
          : termo ? (
            <div className="ms-notas-card">
              <Vazio>{`Nada nas notas casa com “${termo}”.`}</Vazio>
            </div>
          )
          : (
            <div className="ms-notas-card">
              <Vazio>Você ainda não escreveu nenhuma nota — toque no + para começar a primeira.</Vazio>
            </div>
          )}
      </div>
    </div>
  );
}

/** Cartão da nota: título e data em cima, prévia embaixo, etiquetas no pé.
 *  Uma nota sem etiqueta não é dado faltando — é uma nota sem etiqueta, e por
 *  isso a fila de chips some inteira. Já o conteúdo vazio ganha linha: quem
 *  criou a nota só com título precisa ver que o corpo está vazio de fato, e não
 *  que o cartão engoliu o texto. */
function Cartao({ nota }: { nota: Note }) {
  const quando = formatarData(nota.updated_at || nota.created_at);
  const texto = previa(nota.content);
  const tags = nota.tags ?? [];
  return (
    <article className="ms-notas-card ms-notas-nota">
      <div className="ms-notas-card-topo">
        <h2 className="ms-notas-card-titulo">{nota.title?.trim() || 'Sem título'}</h2>
        {quando && <span className="ms-notas-data">{quando}</span>}
      </div>
      {texto ? <p className="ms-notas-previa">{texto}</p> : <Vazio>ainda sem conteúdo</Vazio>}
      {tags.length > 0 && (
        <div className="ms-notas-tags">
          {tags.map((t) => <span key={t} className="ms-notas-tag">{t}</span>)}
        </div>
      )}
    </article>
  );
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-notas-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-notas-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pode piscar "nenhuma nota" antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-notas-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SkelCartoes() {
  return (
    <div className="ms-notas-skel-cartoes" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <span key={i} className="ms-notas-skel-card" />)}
    </div>
  );
}
