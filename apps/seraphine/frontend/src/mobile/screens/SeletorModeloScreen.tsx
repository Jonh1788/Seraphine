import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeftIcon, CheckIcon, SearchIcon, SparkleIcon } from '../../icons/Icons';
import {
  getChatEffort,
  getChatModel,
  getConfig,
  listModels,
  putChatEffort,
  putChatModel,
} from '../../research/api';
import type { Effort, ModelOption } from '../../research/types';
import { EffortPicker } from '../../ui';
import type { ScreenProps } from './registry';
import './SeletorModeloScreen.css';

/* Tela SELETOR DE MODELO (handoff v3, frame "Seletor de modelo").
 *
 * Adaptação para toque do `settings/ChatModelPanel.tsx`, cujo `<select>` chega
 * a ter 300+ opções do OpenRouter — usável com mouse, inutilizável com o
 * polegar. A adaptação é a navegação, não o dado: busca no topo, card do Padrão
 * destacado, catálogo agrupado por provedor.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A REGRA DESTE ARQUIVO, e é literal: `m.id` é gravado como veio.
 *
 * `GET /deepsearch/models` já devolve o id prefixado — o backend monta
 * `{"id": f"openrouter:{m['id']}"}` em `deepsearch/service.list_models()`.
 * Em 2026-07-31 o app prefixou de novo: gravou
 * `openrouter:openrouter:google/gemini-2.5-flash`, o strip de um nível deixou
 * `openrouter:google/...` como model id e a OpenRouter respondeu 400 "is not a
 * valid model ID". Não foi esta tela que quebrou: foi o CHAT INTEIRO, porque
 * `chat_model` é quem roteia toda conversa.
 *
 * O backend hoje normaliza na escrita e na leitura (`normalize_model_spec`),
 * mas isso é rede de segurança para os clientes já instalados — não licença
 * para reintroduzir o bug. Aqui não há concatenação de prefixo em lugar nenhum:
 * o único ponto que deriva algo de um id é `vendorDe()`, e o que ele deriva
 * serve SÓ para escolher o cabeçalho do grupo, nunca para gravar.
 * ───────────────────────────────────────────────────────────────────────── */

/** Valor do roteamento padrão (cliproxy/Claude), o mesmo do painel do desktop. */
const PADRAO = 'cliproxy';

/* ------------------------------------------------------------------ */
/*  Agrupamento por provedor (apresentação, e só)                      */
/* ------------------------------------------------------------------ */

/* Em 2026-08-02 o backend parou de cortar o catálogo em 80 (o corte era
 * alfabético e mudo — ver `deepsearch/service.list_models`). Com ~400 modelos
 * chegando, os três provedores nomeados do handoff deixariam ~330 itens num
 * único OUTROS, que é uma lista sem estrutura nenhuma. Os nomeados aqui são os
 * vendors que de fato aparecem no catálogo em volume; o resto continua em
 * OUTROS, e quem procura um específico usa a busca do topo.
 *
 * A ORDEM importa: ANTHROPIC antes de GOOGLE antes de DEEPSEEK é o que o
 * handoff pede, e OUTROS é sempre o último. */
const GRUPOS = [
  { chave: 'anthropic', rotulo: 'ANTHROPIC' },
  { chave: 'openai', rotulo: 'OPENAI' },
  { chave: 'google', rotulo: 'GOOGLE' },
  { chave: 'x-ai', rotulo: 'X-AI' },
  { chave: 'deepseek', rotulo: 'DEEPSEEK' },
  { chave: 'qwen', rotulo: 'QWEN' },
  { chave: 'meta-llama', rotulo: 'META' },
  { chave: 'mistralai', rotulo: 'MISTRAL' },
  { chave: 'outros', rotulo: 'OUTROS' },
] as const;

type ChaveGrupo = (typeof GRUPOS)[number]['chave'];

/** Vendors com cabeçalho próprio — derivado de GRUPOS para os dois não
 *  divergirem quando alguém acrescentar um provedor. */
const NOMEADOS = new Set<string>(
  GRUPOS.map((g) => g.chave).filter((c) => c !== 'outros'),
);

/** Vendor de um id do catálogo — `openrouter:anthropic/claude-x` → `anthropic`.
 *
 *  Existe para ESCOLHER O CABEÇALHO, e o valor que sai daqui nunca volta para
 *  o backend: quem é gravado é sempre a string original de `m.id`. Deixar essa
 *  fronteira explícita é o ponto — foi exatamente misturar "derivar do id" com
 *  "gravar o id" que produziu o `openrouter:openrouter:` de 2026-07-31. */
function vendorDe(id: string): string {
  const semPrefixo = id.startsWith('openrouter:') ? id.slice('openrouter:'.length) : id;
  const barra = semPrefixo.indexOf('/');
  return (barra > 0 ? semPrefixo.slice(0, barra) : semPrefixo).toLowerCase();
}

/** Vendor nomeado ganha cabeçalho próprio; o resto cai em OUTROS — que segue
 *  grande de propósito (o catálogo tem uma cauda longa de provedores com um ou
 *  dois modelos), e é para ela que a busca do topo existe. */
function grupoDe(id: string): ChaveGrupo {
  const v = vendorDe(id);
  return (NOMEADOS.has(v) ? v : 'outros') as ChaveGrupo;
}

/* ------------------------------------------------------------------ */
/*  Busca                                                              */
/* ------------------------------------------------------------------ */

/** Minúsculas sem acento: "padrao" tem de achar "Padrão" — no celular ninguém
 *  digita o til para filtrar uma lista. */
function norm(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  Tela                                                               */
/* ------------------------------------------------------------------ */

type Estado = 'lendo' | 'ok' | 'erro';

/** Chave do OpenRouter: `null` = não consegui verificar. Não é o mesmo que
 *  "não configurada", e a mensagem do catálogo vazio depende de qual é qual. */
type Chave = boolean | null;

export function SeletorModeloScreen({ onBack }: ScreenProps) {
  const [estado, setEstado] = useState<Estado>('lendo');
  const [modelo, setModelo] = useState<string>(PADRAO);
  const [catalogo, setCatalogo] = useState<ModelOption[]>([]);
  const [chave, setChave] = useState<Chave>(null);
  const [busca, setBusca] = useState('');
  /** Esforço de raciocínio: kv próprio, mesma tela — quem escolhe o modelo é
   *  quem decide quanto ele pensa, e separar em duas telas faria o usuário
   *  navegar para descobrir que o modelo escolhido nem aceita o ajuste. */
  const [esforco, setEsforco] = useState<string>('');
  const [salvandoEsforco, setSalvandoEsforco] = useState(false);

  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  /** Eco divergente: escolhi X, o backend gravou Y (normalização na escrita). */
  const [divergencia, setDivergencia] = useState<{ escolhido: string; gravado: string } | null>(null);

  const vivo = useRef(true);
  const flash = useRef<number | undefined>(undefined);
  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
      if (flash.current !== undefined) window.clearTimeout(flash.current);
    };
  }, []);

  /* O modelo gravado e o catálogo são o núcleo: sem os dois não dá para dizer
   * o que está selecionado, e marcar o Padrão "por enquanto" seria afirmar algo
   * que não sabemos. Por isso qualquer um dos dois falhando leva ao estado de
   * erro, em vez de meia tela. */
  const carregar = useCallback(async () => {
    setEstado('lendo');
    setErro(null);
    setDivergencia(null);
    try {
      const [cm, mdl, ef] = await Promise.all([
        getChatModel(),
        listModels(),
        // Secundário: falhar só o esforço não pode derrubar a tela inteira —
        // sem ele ainda dá para trocar de modelo, que é o principal daqui.
        getChatEffort().catch(() => ({ effort: '' })),
      ]);
      if (!vivo.current) return;
      setModelo(cm.chat_model || PADRAO);
      setCatalogo(mdl.openrouter);
      setEsforco(ef.effort || '');
      setEstado('ok');
    } catch (e) {
      if (!vivo.current) return;
      setErro(e instanceof Error ? e.message : String(e));
      setEstado('erro');
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  /* Secundária: só explica POR QUE o catálogo veio vazio. Falhar aqui não
   * derruba a tela nem vira alerta — vira "não consegui verificar". */
  useEffect(() => {
    getConfig()
      .then((c) => { if (vivo.current) setChave(c.openrouter_key_set); })
      .catch(() => { if (vivo.current) setChave(null); });
  }, []);

  const escolher = useCallback(async (id: string) => {
    if (id === modelo || salvando) return;
    const anterior = modelo;
    setModelo(id); // otimista: o toque responde na hora
    setSalvando(true);
    setSalvo(false);
    setErro(null);
    setDivergencia(null);
    try {
      /* `id` VERBATIM. Nenhuma template string, nenhuma concatenação, nenhum
         `openrouter:${...}` — ver o cabeçalho do arquivo. */
      const r = await putChatModel(id);
      if (!vivo.current) return;
      const gravado = r.chat_model || id;
      setModelo(gravado);
      /* Se o backend gravou outra coisa, ele normalizou o que mandamos — o que
         significa que mandamos algo malformado. Dizer isso na tela é o canário
         barato do bug do prefixo duplicado: em vez de o chat quebrar depois,
         a divergência aparece no instante da escolha. */
      if (gravado !== id) setDivergencia({ escolhido: id, gravado });
      setSalvo(true);
      if (flash.current !== undefined) window.clearTimeout(flash.current);
      flash.current = window.setTimeout(() => { if (vivo.current) setSalvo(false); }, 2200);
    } catch (e) {
      if (!vivo.current) return;
      // Devolve a seleção: deixar o otimismo de pé faria a tela afirmar um
      // roteamento que o backend não tem.
      setModelo(anterior);
      setErro(e instanceof Error ? e.message : String(e));
    } finally {
      if (vivo.current) setSalvando(false);
    }
  }, [modelo, salvando]);

  const escolherEsforco = useCallback(async (e: Effort) => {
    if (e === esforco || salvandoEsforco) return;
    const anterior = esforco;
    setEsforco(e); // otimista
    setSalvandoEsforco(true);
    setErro(null);
    try {
      const r = await putChatEffort(e);
      if (!vivo.current) return;
      setEsforco(r.effort ?? e);
      setSalvo(true);
      if (flash.current !== undefined) window.clearTimeout(flash.current);
      flash.current = window.setTimeout(() => { if (vivo.current) setSalvo(false); }, 2200);
    } catch (err) {
      if (!vivo.current) return;
      setEsforco(anterior);
      setErro(err instanceof Error ? err.message : String(err));
    } finally {
      if (vivo.current) setSalvandoEsforco(false);
    }
  }, [esforco, salvandoEsforco]);

  /* Quem aceita raciocínio é o catálogo que diz. O Padrão roteia por outro
     caminho (cliproxy), que não passa por este ajuste. */
  const modeloAtual = catalogo.find((m) => m.id === modelo);
  const suportaEsforco = Boolean(modeloAtual?.reasoning);
  const motivoSemEsforco =
    modelo === PADRAO
      ? 'O Padrão não passa por este ajuste. Escolha um modelo do OpenRouter que aceite raciocínio.'
      : modeloAtual
        ? `${modeloAtual.name} não aceita esforço de raciocínio.`
        // Modelo órfão: a seção SELECIONADO logo acima já explica que ele sumiu
        // do catálogo. Repetir o diagnóstico aqui só faria a tela dizer a mesma
        // coisa duas vezes — o que falta é o efeito sobre ESTE controle.
        : 'Não dá para saber se este modelo aceita raciocínio.';

  const alvo = norm(busca.trim());
  const casa = useCallback((...campos: string[]) =>
    alvo === '' || campos.some((c) => norm(c).includes(alvo)), [alvo]);

  const padraoVisivel = casa('Padrão — cliproxy / Claude', PADRAO);

  const agrupado = useMemo(() => {
    const visiveis = catalogo.filter((m) => casa(m.name, m.id));
    return GRUPOS.map((g) => ({
      ...g,
      modelos: visiveis.filter((m) => grupoDe(m.id) === g.chave),
    })).filter((g) => g.modelos.length > 0);
  }, [catalogo, casa]);

  /* O gravado pode não estar no catálogo: a chave foi trocada, o modelo saiu do
   * ar, ou o valor veio de uma versão anterior do app. Mostrá-lo cru é o único
   * jeito honesto — esconder faria a tela parecer dizer "Padrão ativo". */
  const conhecido = modelo === PADRAO || catalogo.some((m) => m.id === modelo);
  const orfaoVisivel = !conhecido && casa(modelo);

  const nadaNaBusca =
    estado === 'ok' && alvo !== '' && !padraoVisivel && !orfaoVisivel && agrupado.length === 0;

  return (
    <div className="ms-seletor">
      <header className="ms-seletor-head">
        <button
          type="button"
          className="ms-seletor-voltar"
          aria-label="Voltar"
          onClick={() => onBack?.()}
        >
          <ArrowLeftIcon size={20} />
        </button>
        <h1 className="ms-seletor-titulo">Modelo</h1>
      </header>

      <div className="ms-seletor-busca">
        <span className="ms-seletor-busca__icone" aria-hidden="true"><SearchIcon size={16} /></span>
        <input
          type="search"
          className="ms-seletor-busca__campo"
          aria-label="Buscar modelo"
          placeholder="Buscar modelo…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          disabled={estado !== 'ok'}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>

      <div className="ms-seletor-corpo" aria-busy={estado === 'lendo'}>
        {/* Único `role="alert"` da tela. Carregar e salvar nunca falham ao mesmo
            tempo (sem carregar não há o que salvar), então a região é uma só. */}
        {(estado === 'erro' || erro) && (
          <p className="ms-seletor-alerta" role="alert">
            {estado === 'erro'
              ? `Não consegui carregar os modelos disponíveis. ${erro ?? ''}`.trim()
              : `Não consegui trocar o modelo: ${erro}. O chat segue no modelo anterior.`}
          </p>
        )}

        {estado === 'lendo' ? (
          <Esqueleto />
        ) : estado === 'erro' ? (
          <button type="button" className="ms-seletor-retry" onClick={() => void carregar()}>
            Tentar de novo
          </button>
        ) : (
          <>
            {padraoVisivel && (
              <section className="ms-seletor-secao">
                <p className="ms-seletor-eyebrow">PADRÃO</p>
                <button
                  type="button"
                  className={`ms-seletor-padrao${modelo === PADRAO ? ' ms-seletor-padrao--ativo' : ''}`}
                  aria-pressed={modelo === PADRAO}
                  disabled={salvando}
                  onClick={() => void escolher(PADRAO)}
                >
                  <span className="ms-seletor-padrao__icone" aria-hidden="true">
                    <SparkleIcon size={18} />
                  </span>
                  <span className="ms-seletor-padrao__texto">
                    <span className="ms-seletor-padrao__nome">Padrão — cliproxy / Claude</span>
                    {/* O único selo de custo que a api sustenta para o Padrão.
                        Preço POR MODELO o `/deepsearch/models` não expõe — e
                        inventar um número aqui seria pior que não ter nenhum. */}
                    <span className="ms-seletor-padrao__selo">
                      <span className="ms-seletor-padrao__ponto" aria-hidden="true" />
                      flat $0 · sem custo por chamada
                    </span>
                  </span>
                  {modelo === PADRAO && (
                    <span className="ms-seletor-check" aria-hidden="true"><CheckIcon size={18} /></span>
                  )}
                </button>
              </section>
            )}

            {orfaoVisivel && (
              <section className="ms-seletor-secao">
                <p className="ms-seletor-eyebrow">SELECIONADO</p>
                <div className="ms-seletor-orfao">
                  <span className="ms-seletor-modelo__nome">{modelo}</span>
                  <p className="ms-seletor-orfao__nota">
                    Está gravado como modelo do chat, mas não está no catálogo que o
                    OpenRouter devolveu agora. Escolha outro se o chat estiver falhando.
                  </p>
                </div>
              </section>
            )}

            {/* Só fora da busca: quem está digitando está procurando modelo, e
                a escala de esforço no meio dos resultados seria ruído. */}
            {alvo === '' && (
              <section className="ms-seletor-secao">
                <p className="ms-seletor-eyebrow">ESFORÇO DE RACIOCÍNIO</p>
                <EffortPicker
                  value={esforco}
                  onChange={(e) => void escolherEsforco(e)}
                  suportado={suportaEsforco}
                  disabled={salvandoEsforco}
                  motivoNaoSuportado={motivoSemEsforco}
                />
              </section>
            )}

            <section className="ms-seletor-secao ms-seletor-secao--lista">
              <div className="ms-seletor-secao__head">
                <p className="ms-seletor-eyebrow">
                  OPENROUTER
                  {catalogo.length > 0 && (
                    <span className="ms-seletor-eyebrow__n">
                      {alvo === ''
                        ? `${catalogo.length}`
                        : `${agrupado.reduce((n, g) => n + g.modelos.length, 0)}/${catalogo.length}`}
                    </span>
                  )}
                </p>
                <span className="ms-seletor-medido-rotulo">custo medido</span>
              </div>

              {nadaNaBusca ? (
                <p className="ms-seletor-vazio" role="status">
                  {`Nenhum modelo corresponde a "${busca.trim()}".`}
                </p>
              ) : catalogo.length === 0 ? (
                <p className="ms-seletor-vazio" role="status">
                  {chave === false
                    ? 'Nenhum modelo para listar: a chave da OpenRouter não está configurada. Enquanto isso, o chat segue no Padrão.'
                    : chave === true
                      ? 'A chave está salva, mas o catálogo do OpenRouter voltou vazio agora. Tente de novo mais tarde.'
                      : 'Nenhum modelo para listar, e também não consegui verificar se a chave da OpenRouter está configurada.'}
                </p>
              ) : agrupado.length === 0 ? (
                <p className="ms-seletor-vazio" role="status">
                  {`Nenhum modelo corresponde a "${busca.trim()}".`}
                </p>
              ) : (
                <div className="ms-seletor-lista">
                  {agrupado.map((g) => (
                    <div className="ms-seletor-grupo" key={g.chave} data-grupo-rotulo={g.rotulo}>
                      <div className="ms-seletor-grupo__head">
                        <span
                          className={`ms-seletor-grupo__ponto ms-seletor-grupo__ponto--${g.chave}`}
                          aria-hidden="true"
                        />
                        <span className="ms-seletor-grupo__rotulo">{g.rotulo}</span>
                        {/* Quantos há ali: com o catálogo inteiro, OUTROS pode
                            ter centenas, e rolar até descobrir isso é pior que
                            ler o número. */}
                        <span className="ms-seletor-grupo__n">{g.modelos.length}</span>
                      </div>
                      {g.modelos.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          className={`ms-seletor-modelo${modelo === m.id ? ' ms-seletor-modelo--ativo' : ''}`}
                          aria-pressed={modelo === m.id}
                          disabled={salvando}
                          /* `m.id`, inteiro, sem tocar. */
                          onClick={() => void escolher(m.id)}
                        >
                          <span className="ms-seletor-modelo__nome">{m.name}</span>
                          {modelo === m.id && (
                            <span className="ms-seletor-check" aria-hidden="true"><CheckIcon size={16} /></span>
                          )}
                          <span className="ms-seletor-modelo__selo">medido</span>
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </section>

            <div className="ms-seletor-rodape">
              {salvando && <p className="ms-seletor-status" role="status">Salvando…</p>}
              {salvo && !salvando && <p className="ms-seletor-status ms-seletor-status--ok" role="status">salvo</p>}
              {divergencia && (
                <p className="ms-seletor-status" role="status">
                  Escolhi <code>{divergencia.escolhido}</code>, mas o backend gravou{' '}
                  <code>{divergencia.gravado}</code>.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Espera sem texto: nenhum modelo provisório pode piscar na tela antes de
 *  sabermos qual está gravado — um nome errado aqui é uma afirmação errada
 *  sobre quem responde no chat. */
function Esqueleto() {
  return (
    <span className="ms-seletor-skel" aria-hidden="true" data-testid="seletor-modelo-esqueleto">
      <span className="ms-seletor-skel__card" />
      <span className="ms-seletor-skel__linha" />
      <span className="ms-seletor-skel__linha" />
      <span className="ms-seletor-skel__linha" />
    </span>
  );
}
