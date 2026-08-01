import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftIcon, PlusIcon, SearchIcon } from '../../icons/Icons';
import { fetchProfile, listFacts } from '../../memory/api';
import type { Fact, MemoryProfile } from '../../memory/types';
import { ModalMemoria } from './ModalMemoria';
import type { ScreenProps } from './registry';
import './MemoriaScreen.css';

// REGRA DA TELA (igual à do Hoje e à do Hábitos): nenhum bloco devolve `null`.
// Cabeçalho, perfil e lista têm cada um as três saídas — dado, vazio desenhado
// e erro — e cada bloco erra com a SUA frase, para o teste apontar um bloco só.
//
// O "+" accent do cabeçalho (handoff linha 491) EXISTE agora. Ele foi recusado
// enquanto `memory/api.ts` só sabia ler: um "+" sem POST é botão morto, pior
// que ausente. A Task 10 abriu a escrita (`createFact`, sobre
// `POST /memory/facts`), e com ela a ausência deixou de ter justificativa — o
// que sustentava o argumento era a falta da rota, não uma decisão de desenho.
// O "+" abre o `ModalMemoria`, e é ele quem conhece o que a api aceita
// (confiança sim, categoria não).

/** Quantos fatos pedir. O mesmo teto que a tela de desktop usa. */
const LIMITE = 100;

/** Espera antes de rebuscar enquanto o dedo ainda digita. */
const DEBOUNCE_MS = 200;

/** Quantas linhas do perfil cabem no cartão do telefone sem virar parede. */
const MAX_PERFIL = 6;

const GRUPOS = ['Tudo', 'Pessoas', 'Rotina', 'Trabalho', 'Preferências', 'Metas'] as const;
type Grupo = (typeof GRUPOS)[number];

/** Eyebrow persistido pelo backend → chip que o agrupa. LOCAL entra em Pessoas
 *  e OUTROS em Preferências, exatamente como a tela de desktop agrupa. */
const EYEBROW_GRUPO: Record<string, Grupo> = {
  METAS: 'Metas',
  TRABALHO: 'Trabalho',
  ROTINA: 'Rotina',
  PESSOAS: 'Pessoas',
  LOCAL: 'Pessoas',
  PREFERENCIA: 'Preferências',
  OUTROS: 'Preferências',
};

/** Payloads antigos não têm `category` (a coluna é posterior). Para esses, o
 *  mesmo palpite por texto que o desktop faz — assim o mesmo fato recebe o
 *  mesmo eyebrow nas duas telas. */
function derivarCategoria(texto: string): string {
  const t = (texto || '').toLowerCase();
  if (/\b(meta|objetivo|lan[çc]ar|quero|pretendo|sonho)\b/.test(t)) return 'METAS';
  if (/\b(trabalh|desenvolved|empresa|projeto|c[oó]digo|react|rust|tauri|reuni[ãa]o|cliente|deploy)/.test(t)) return 'TRABALHO';
  if (/\b(acorda|treina|manh[ãa]|rotina|todo dia|toda manh|caf[ée]|dorme|h[áa]bito|sempre)/.test(t)) return 'ROTINA';
  if (/\b(namorad|amig|fam[íi]lia|m[ãa]e|pai|irm[ãa]|esposa|marido|filh|anivers[áa]rio)/.test(t)) return 'PESSOAS';
  if (/\b(mora|bairro|cidade|endere[çc]o|rua|casa|local)\b/.test(t)) return 'LOCAL';
  if (/\b(prefere|gosta|n[ãa]o gosta|odeia|chama|favorit|costuma)/.test(t)) return 'PREFERENCIA';
  return 'OUTROS';
}

function categoriaDoFato(f: Fact): { eyebrow: string; grupo: Grupo } {
  const salvo = (f.category || '').toUpperCase();
  const eyebrow = salvo && salvo in EYEBROW_GRUPO ? salvo : derivarCategoria(f.text);
  return { eyebrow, grupo: EYEBROW_GRUPO[eyebrow] ?? 'Preferências' };
}

/** Confiança em duas tintas, como o handoff: verde quando é alta, âmbar quando
 *  a Seraphine ainda não tem certeza (média ou baixa). */
function confianca(c: number): { palavra: string; tom: 'verde' | 'ambar' } {
  if (c >= 0.8) return { palavra: 'alta', tom: 'verde' };
  if (c >= 0.5) return { palavra: 'média', tom: 'ambar' };
  return { palavra: 'baixa', tom: 'ambar' };
}

export function MemoriaScreen({ onBack }: ScreenProps) {
  const [fatos, setFatos] = useState<Fact[] | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);
  const [busca, setBusca] = useState('');
  const [grupo, setGrupo] = useState<Grupo>('Tudo');
  const [criando, setCriando] = useState(false);
  const [recarga, setRecarga] = useState(0);

  const termo = busca.trim();

  // `q` é filtro de texto: a api aplica no cliente (o endpoint não tem busca),
  // mas a chamada é refeita a cada termo para a tela nunca guardar uma lista
  // recortada e achar que é a memória inteira.
  useEffect(() => {
    let vivo = true;
    const buscar = () => {
      listFacts(termo ? { limit: LIMITE, q: termo } : { limit: LIMITE })
        .then((f) => { if (vivo) { setFatos(f); setErro(false); setCarregando(false); } })
        .catch(() => { if (vivo) { setFatos(null); setErro(true); setCarregando(false); } });
    };
    // A primeira carga (sem termo) não espera: a tela abre com dado.
    if (!termo) { buscar(); return () => { vivo = false; }; }
    const t = setTimeout(buscar, DEBOUNCE_MS);
    return () => { vivo = false; clearTimeout(t); };
    // `recarga` entra nas deps para a lembrança recém-criada aparecer: o POST
    // devolve o fato, mas a lista é do servidor e a contagem do cabeçalho sai
    // dela — remontar o dado inteiro é mais honesto que enfiar uma linha local.
  }, [termo, recarga]);

  // Fato substituído já não vale: o backend guarda o histórico, a tela mostra
  // só o que a Seraphine considera verdade hoje.
  const ativos = useMemo(() => (fatos ?? []).filter((f) => !f.superseded_by), [fatos]);
  const visiveis = useMemo(
    () => (grupo === 'Tudo' ? ativos : ativos.filter((f) => categoriaDoFato(f).grupo === grupo)),
    [ativos, grupo],
  );

  return (
    <div className="ms-memoria">
      <header className="ms-memoria-head">
        {/* O shell não desenha mais chrome nenhum: a seta de voltar é da tela.
            É o mesmo arrow-left das telas empurradas do handoff (18px, --dim).
            `onBack` é opcional no ScreenProps — sem ele não há para onde
            voltar, então o controle não aparece em vez de virar botão morto. */}
        {onBack && (
          <button type="button" className="ms-memoria-voltar" aria-label="Voltar" onClick={onBack}>
            <ArrowLeftIcon size={18} />
          </button>
        )}
        <div className="ms-memoria-head-txt">
          <h1 className="ms-memoria-titulo">Memória</h1>
          {carregando ? <Skel linhas={1} />
            : erro ? <Erro>Não consegui contar suas lembranças.</Erro>
            : ativos.length ? <p className="ms-memoria-sub">{ativos.length} {ativos.length === 1 ? 'lembrança' : 'lembranças'}</p>
            : termo ? <Vazio>nenhuma lembrança casa com a busca</Vazio>
            : <Vazio>nenhuma lembrança guardada ainda</Vazio>}
        </div>
        <button
          type="button"
          className="ms-memoria-novo"
          aria-label="Nova lembrança"
          aria-haspopup="dialog"
          onClick={() => setCriando(true)}
        >
          <PlusIcon size={18} />
        </button>
      </header>

      <div className="ms-memoria-busca">
        <span className="ms-memoria-busca-icone"><SearchIcon size={15} /></span>
        <input
          type="search"
          className="ms-memoria-busca-campo"
          placeholder="Buscar na memória…"
          aria-label="Buscar na memória"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
        />
      </div>

      <div className="ms-memoria-filtros">
        {GRUPOS.map((g) => (
          <button
            key={g}
            type="button"
            className={`ms-memoria-chip${grupo === g ? ' ms-memoria-chip--on' : ''}`}
            aria-pressed={grupo === g}
            onClick={() => setGrupo(g)}
          >
            {g}
          </button>
        ))}
      </div>

      <div className="ms-memoria-lista">
        {/* O perfil é bloco à parte (api própria, vazio próprio): uma falha
            aqui não pode derrubar as lembranças. Ele sai de cena enquanto há
            busca ou chip ativo porque não é um fato e não pode casar com o
            recorte — some por filtro do usuário, nunca por falta de dado, e
            volta assim que o recorte é limpo. */}
        {!termo && grupo === 'Tudo' && <Perfil />}

        {carregando ? <SkelCartoes />
          : erro ? <div className="ms-memoria-card"><Erro>Não consegui carregar suas lembranças.</Erro></div>
          : visiveis.length ? visiveis.map((f) => <Cartao key={f.id} fato={f} />)
          : termo ? (
            <div className="ms-memoria-card">
              {/* Com um chip ligado o "nada" pode ser da categoria, não da
                  memória inteira — a frase diz qual dos dois é. */}
              <Vazio>
                {grupo !== 'Tudo' && ativos.length
                  ? `Nada em ${grupo} casa com “${termo}”.`
                  : `Nada na memória casa com “${termo}”.`}
              </Vazio>
            </div>
          )
          /* "estão em outras categorias" só é verdade se houver alguma: com a
             memória inteira vazia, a frase certa é a de baixo. */
          : grupo !== 'Tudo' && ativos.length ? <div className="ms-memoria-card"><Vazio>Nenhuma lembrança em {grupo} — as que existem estão em outras categorias.</Vazio></div>
          : <div className="ms-memoria-card"><Vazio>Nenhuma memória guardada ainda — a Seraphine anota o que você conta ao longo das conversas.</Vazio></div>}
      </div>

      {/* O modal fecha sozinho no 201; `onCriada` só refaz a leitura. Note que
          a lembrança nova pode NÃO aparecer na hora: com uma busca escrita ou
          um chip ligado, ela só entra se casar com o recorte — é filtro do
          usuário, e a contagem do cabeçalho sobe de qualquer jeito. */}
      <ModalMemoria
        aberto={criando}
        onFechar={() => setCriando(false)}
        onCriada={() => setRecarga((r) => r + 1)}
      />
    </div>
  );
}

/** Cartão do handoff: CATEGORIA em eyebrow, ponto de confiança à direita e o
 *  texto do fato embaixo. */
function Cartao({ fato }: { fato: Fact }) {
  const { eyebrow } = categoriaDoFato(fato);
  const { palavra, tom } = confianca(fato.confidence);
  return (
    <article className="ms-memoria-card ms-memoria-fato">
      <div className="ms-memoria-card-topo">
        <span className="ms-memoria-eyebrow">{eyebrow}</span>
        <span className="ms-memoria-conf">
          <span className={`ms-memoria-dot ms-memoria-dot--${tom}`} aria-hidden="true" />
          {palavra}
        </span>
      </div>
      <p className="ms-memoria-texto">{fato.text}</p>
    </article>
  );
}

/** Seções do perfil na ordem em que fazem sentido no telefone. */
const SECOES: Array<[string, string]> = [
  ['identity', 'Identidade'],
  ['preferences', 'Preferências'],
  ['work', 'Trabalho'],
  ['goals', 'Objetivos'],
  ['contacts', 'Contatos'],
  ['health', 'Saúde'],
  ['finances', 'Finanças'],
  ['activity', 'Atividade'],
];

function textoDoValor(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map((x) => textoDoValor(x)).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).map((x) => textoDoValor(x)).filter(Boolean).join(' · ');
  }
  return '';
}

function rotuloCampo(k: string): string {
  const limpo = k.replace(/_/g, ' ');
  return limpo.charAt(0).toUpperCase() + limpo.slice(1);
}

interface LinhaPerfil { chave: string; rotulo: string; valor: string }

function linhasDoPerfil(p: MemoryProfile): LinhaPerfil[] {
  const linhas: LinhaPerfil[] = [];
  for (const [chave, titulo] of SECOES) {
    const secao = p[chave];
    if (!secao || typeof secao !== 'object') continue;
    const pares: Array<[string, unknown]> = Array.isArray(secao)
      ? secao.map((v, i) => [String(i + 1), v])
      : Object.entries(secao as Record<string, unknown>);
    for (const [campo, valor] of pares) {
      const texto = textoDoValor(valor);
      if (!texto) continue;
      linhas.push({
        chave: `${chave}.${campo}`,
        rotulo: Array.isArray(secao) ? titulo : rotuloCampo(campo),
        valor: texto,
      });
    }
  }
  return linhas;
}

/** O retrato que a Seraphine montou de você. `fetchProfile()` devolvendo null é
 *  resposta normal — "ainda não montei" —, então vira vazio, nunca erro. */
function Perfil() {
  const [perfil, setPerfil] = useState<MemoryProfile | null>(null);
  const [erro, setErro] = useState(false);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    let vivo = true;
    fetchProfile()
      .then((p) => { if (vivo) { setPerfil(p); setErro(false); setCarregando(false); } })
      .catch(() => { if (vivo) { setPerfil(null); setErro(true); setCarregando(false); } });
    return () => { vivo = false; };
  }, []);

  const linhas = perfil ? linhasDoPerfil(perfil).slice(0, MAX_PERFIL) : [];

  return (
    <article className="ms-memoria-card ms-memoria-perfil">
      <div className="ms-memoria-card-topo">
        <span className="ms-memoria-eyebrow">PERFIL</span>
      </div>
      {carregando ? <Skel linhas={2} />
        : erro ? <Erro>Não consegui carregar o perfil.</Erro>
        : linhas.length ? (
          <dl className="ms-memoria-perfil-lista">
            {linhas.map((l) => (
              <div key={l.chave} className="ms-memoria-perfil-linha">
                <dt className="ms-memoria-perfil-rotulo">{l.rotulo}</dt>
                <dd className="ms-memoria-perfil-valor">{l.valor}</dd>
              </div>
            ))}
          </dl>
        )
        : <Vazio>Perfil ainda vazio — a Seraphine monta ele conforme vocês conversam.</Vazio>}
    </article>
  );
}

/** Linha de "não há nada": o bloco continua de pé e diz o porquê. */
function Vazio({ children }: { children: ReactNode }) {
  return <p className="ms-memoria-vazio">{children}</p>;
}

/** Linha de falha. Tinta de perigo para nunca ser confundida com vazio. */
function Erro({ children }: { children: ReactNode }) {
  return <p className="ms-memoria-erro" role="alert">{children}</p>;
}

/** Espera sem texto: nada pode piscar "nenhuma memória" antes do dado chegar. */
function Skel({ linhas = 2 }: { linhas?: number }) {
  return (
    <div className="ms-memoria-skel" aria-hidden="true">
      {Array.from({ length: linhas }, (_, i) => <span key={i} />)}
    </div>
  );
}

function SkelCartoes() {
  return (
    <div className="ms-memoria-skel-cartoes" aria-hidden="true">
      {Array.from({ length: 4 }, (_, i) => <span key={i} className="ms-memoria-skel-card" />)}
    </div>
  );
}
