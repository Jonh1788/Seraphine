import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCREEN_KEYS, type ScreenKey } from '../screens/registry';

// O QUE ESTE ARQUIVO PRENDE
//
// Seis telas do v3 (Configurações, Trilhas·lista, Planejamento, Seletor de
// modelo e as duas de Custos) nasceram COMPLETAS e INALCANÇÁVEIS: estavam no
// registry, tinham teste próprio, e nada em `src/mobile/` as empurrava. Cada
// uma passou no seu teste de tela enquanto o app inteiro não tinha como abri-la.
//
// A lição não é "faltou um teste para a porta X". Um teste por porta, escrito à
// mão, nasce depois da porta — e é exatamente por isso que as seis passaram: o
// arquivo de teste que provaria a falta nunca foi escrito, porque quem não abre
// a porta também não escreve o teste dela.
//
// Então a lista deste arquivo NÃO é escrita à mão: ela é o `SCREEN_KEYS` do
// registry. Registrar uma chave nova sem abrir porta para ela deixa este arquivo
// vermelho no mesmo commit — sem ninguém precisar lembrar de vir aqui.
//
// HONESTIDADE SOBRE O QUE DÁ PARA AFIRMAR AQUI: isto lê a FONTE, não a árvore
// renderizada. O que se afirma é que existe, no código, um `onOpen` com aquela
// chave, alcançável em cadeia a partir do que o shell monta — e que a tela do
// outro lado chama o `onBack` que o shell lhe dá. Se o `onOpen` está atrás de um
// `if` que nunca é verdade, isto passa; é o teste de cada tela que cobre aquilo.
// O que morre aqui é a classe do buraco: a tela que ninguém empurra, e a tela
// empurrada que ignora a saída (o beco sem saída da onda anterior).

const DIR_MOBILE = resolve(__dirname, '..');
const DIR_TELAS = resolve(DIR_MOBILE, 'screens');

/** O arquivo SEM COMENTÁRIOS. Sem isto, um `keyName="trilhas"` citado numa
 *  explicação (e há uma, no `PhoneShell`, contando justamente que a aba parou
 *  de montar o mapa) valeria por navegação de verdade: a chave voltava a ser
 *  raiz e o teste de alcance passava a verde por causa de uma frase. Vale para
 *  os dois lados — um `onOpen` comentado é uma porta fechada, e o grafo tem de
 *  dizer isso. O `(^|\s)` antes do `//` poupa o `//` de uma URL, que vem
 *  sempre depois de `:`. */
const semComentarios = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const fonte = (caminho: string): string => semComentarios(readFileSync(caminho, 'utf8'));
const fonteDeTela = (arquivo: string): string => fonte(resolve(DIR_TELAS, arquivo));

/** `'chave': lazy(() => import('./Arquivo')` — a única ligação entre uma chave
 *  do registry e o arquivo que a implementa. */
function arquivoPorChave(): Map<string, string> {
  const src = fonteDeTela('registry.ts');
  const mapa = new Map<string, string>();
  for (const [, chave, arquivo] of src.matchAll(
    /'([a-z-]+)':\s*lazy\(\(\)\s*=>\s*import\('\.\/([A-Za-z]+)'\)/g,
  )) {
    mapa.set(chave, `${arquivo}.tsx`);
  }
  return mapa;
}

const ARQUIVO = arquivoPorChave();
const CHAVES = new Set<string>(SCREEN_KEYS);
const ehChave = (s: string): s is ScreenKey => CHAVES.has(s);

/** As chaves que uma fonte empurra: todo `key: 'x'` de um `onOpen({ key, … })`
 *  ou de uma tabela de módulos que vira `onOpen`. */
function empurra(src: string): ScreenKey[] {
  return [...src.matchAll(/key:\s*'([a-z-]+)'/g)].map(([, k]) => k).filter(ehChave);
}

/** O que o SHELL monta sozinho: as abas (`keyName="…"`) e os passos de
 *  onboarding (que vêm ANTES das abas, sem `onOpen` nenhum).
 *
 *  As duas fontes são lidas SEPARADAMENTE, e não por um varredor de aspas
 *  solto. Um `/'([a-z-]+)'/g` sobre o arquivo inteiro também casava com o
 *  `tab === 'trilhas'` do estado da tab bar — e `trilhas` continuava passando
 *  por raiz depois de a aba deixar de montá-lo (Task 19). Uma raiz falsa é o
 *  pior defeito possível aqui: ela deixa VERDE o teste de alcance para uma tela
 *  que ninguém mais empurra, que é exatamente o buraco que este arquivo existe
 *  para achar. Nome de aba não é chave de tela. */
function montaDireto(src: string): ScreenKey[] {
  const abas = [...src.matchAll(/keyName="([a-z-]+)"/g)].map(([, k]) => k);
  // o onboarding não vem por `keyName`: é a lista de chaves da constante
  const lista = /const ONBOARDING:[^=]*=\s*\[([^\]]*)\]/.exec(src)?.[1] ?? '';
  const passos = [...lista.matchAll(/'([a-z-]+)'/g)].map(([, k]) => k);
  return [...abas, ...passos].filter(ehChave);
}

/** As duas telas que o shell importa direto, sem passar por chave: o que ELAS
 *  empurram é raiz tanto quanto uma aba. */
const TELAS_DO_SHELL = ['HojeScreen.tsx', 'MaisScreen.tsx'];

function raizes(): Set<ScreenKey> {
  const r = new Set<ScreenKey>(montaDireto(fonte(resolve(DIR_MOBILE, 'PhoneShell.tsx'))));
  for (const arquivo of TELAS_DO_SHELL) {
    for (const k of empurra(fonte(resolve(DIR_MOBILE, arquivo)))) r.add(k);
  }
  return r;
}

/** chave → chaves que a tela dela empurra. */
function arestas(): Map<ScreenKey, ScreenKey[]> {
  const g = new Map<ScreenKey, ScreenKey[]>();
  for (const k of SCREEN_KEYS) g.set(k, empurra(fonteDeTela(ARQUIVO.get(k)!)));
  return g;
}

/** Toda chave que se alcança saindo das raízes e seguindo os `onOpen`. */
function alcancaveis(): Set<ScreenKey> {
  const g = arestas();
  const vistas = new Set<ScreenKey>(raizes());
  const fila = [...vistas];
  while (fila.length) {
    for (const destino of g.get(fila.pop()!) ?? []) {
      if (!vistas.has(destino)) { vistas.add(destino); fila.push(destino); }
    }
  }
  return vistas;
}

/** Chaves que alguém empurra — as que chegam pela pilha, e não pela tab bar. */
function destinosDePush(): Set<ScreenKey> {
  const d = new Set<ScreenKey>();
  for (const [, ks] of arestas()) for (const k of ks) d.add(k);
  for (const arquivo of TELAS_DO_SHELL) {
    for (const k of empurra(fonte(resolve(DIR_MOBILE, arquivo)))) d.add(k);
  }
  return d;
}

/** A tela chama o `onBack` que o shell lhe deu — direto no `onClick` ou dentro
 *  de um handler. É o que separa "desenha a própria saída" de "beco sem saída":
 *  na pilha não há tab bar, e o contêiner não desenha cabeçalho nenhum. */
const CHAMA_ONBACK = /onClick=\{\s*onBack\s*\}|onBack\s*\??\.?\s*\(\)/;

describe('navegação do shell', () => {
  // Se o varredor parar de casar com o registry, tudo abaixo passaria calado
  // sobre um grafo vazio. Este teste é o fusível dele.
  it('acha o arquivo de cada chave do registry', () => {
    expect([...ARQUIVO.keys()].sort()).toEqual([...SCREEN_KEYS].sort());
  });

  it('toda tela do registry é alcançável a partir do que o shell monta', () => {
    const vistas = alcancaveis();
    expect(SCREEN_KEYS.filter((k) => !vistas.has(k))).toEqual([]);
  });

  // O beco sem saída da onda anterior: uma tela de ABA reusada como destino de
  // push. O ramo empurrado não monta tab bar, e a tela não desenhava saída
  // própria — ficava presa até reiniciar o app.
  it('toda tela empurrada desenha a própria saída', () => {
    const semSaida = [...destinosDePush()]
      .filter((k) => !CHAMA_ONBACK.test(fonteDeTela(ARQUIVO.get(k)!)))
      .sort();
    expect(semSaida).toEqual([]);
  });

  // As raízes são o outro lado do primeiro teste: se o shell parar de montar
  // as abas por chave, "alcançável" viraria vácuo e tudo passaria.
  it('as raízes são as abas e o onboarding, e não a lista inteira', () => {
    const r = raizes();
    expect(r.has('tarefas')).toBe(true);
    expect(r.has('chat')).toBe(true);
    // a aba Trilhas monta a LISTA; o mapa é empurrado por ela, com o id da
    // trilha tocada, e por isso NÃO é raiz. Enquanto era, a aba abria o
    // interior de uma trilha escolhida por ela mesma.
    expect(r.has('trilhas-lista')).toBe(true);
    expect(r.has('trilhas')).toBe(false);
    expect(r.has('onboarding-boas-vindas')).toBe(true);
    expect(r.size).toBeLessThan(SCREEN_KEYS.length);
  });
});
