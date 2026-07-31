# Seraphine Mobile — Fases 2-5 + widget nativo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Levar o app iOS das 3 telas mobile de hoje para as 20 do handoff, com dados reais, mais o widget nativo de lock screen.

**Architecture:** Telas mobile próprias em `src/mobile/screens/`, uma por arquivo, cada uma com seu CSS. Nenhuma chama `fetch` direto: consomem `<modulo>/api.ts`, camada compartilhada com as views de desktop (cinco módulos ainda precisam dessa extração). O `PhoneShell` passa a montar as telas por um registry criado uma única vez, para que as tasks de tela nunca disputem o mesmo arquivo. O widget é target Swift separado, comunicando por App Group.

**Tech Stack:** React 18 + TypeScript + Vite, vitest + @testing-library/react, Tauri 2 (iOS), Swift/WidgetKit.

## Global Constraints

- Handoff: `apps/seraphine/frontend/handoff_mobile 2/`. O `README.md` é o contrato de requisitos; o `Seraphine Mobile.dc.html` é a autoridade de pixel. Cada tela está delimitada por um comentário HTML (`<!-- ==== HÁBITOS ==== -->`); a tabela de âncoras está na seção "Mapa do handoff".
- Tokens **já existem** em `src/styles.css` e são idênticos aos do handoff. Nunca redefinir cor em hex numa tela — usar `var(--surface)`, `var(--accent)`, etc.
- Fonte Schibsted Grotesk já carregada em `index.html`. Não adicionar `<link>` novo.
- **Zero emoji.** O projeto usa SVG inline (`src/icons/Icons.tsx`). Se faltar um ícone, criar no `Icons.tsx`.
- Testes: `pnpm test <padrão>` (vitest) e `pnpm exec tsc --noEmit` limpo, ambos de `apps/seraphine/frontend`. Padrão de teste em `src/mobile/__tests__/shell.test.tsx` (`@testing-library/react` + `vitest`).
- **Ambiente já quebrado, não é sua task:** `pnpm lint` não roda (`eslint.config.js` importa `@eslint/js`, não instalado) e `pnpm test` completo trava em `src/App.test.tsx` (WebGL). Rode sempre testes por padrão, nunca a suíte inteira.
- **Nenhuma mudança visual no desktop.** A extração de dados é refatoração interna; se uma view de desktop mudar de aparência, é bug.
- Safe areas: conteúdo a `56px` do topo, barras inferiores com `30px` extras — via `env(safe-area-inset-*)`, como o `mobile/obsidian.css` já faz.
- Branch: `feat/mobile-fases2-5`. Spec: `docs/superpowers/specs/2026-07-31-mobile-fases2-5-design.md`.

## Padrão normativo das tasks de tela

**Esta seção é vinculante para todas as tasks da Onda 2.** Ela existe para as tasks não repetirem boilerplate; cada task de tela declara só o que é específico dela.

Toda task de tela:

1. **Reescreve** `src/mobile/screens/<Nome>.tsx` (o arquivo já existe como placeholder desde a Onda 0) e **cria** `src/mobile/screens/<Nome>.css`.
2. **Não toca em nenhum outro arquivo.** Nem `PhoneShell.tsx`, nem `obsidian.css`, nem o registry. Se você sentir necessidade de tocar, pare e reporte — é sinal de que a Onda 0 deixou lacuna.
3. Importa seu CSS no topo: `import './<Nome>.css';`
4. Prefixa **todas** as classes com `ms-<tela>-` (ex.: `ms-tarefas-row`), para dois CSS de tela nunca colidirem.
5. Consome só funções do `<modulo>/api.ts` declarado na task. Zero `fetch` direto, zero `API_BASE` importado.
6. **Estado vazio obrigatório.** Nenhum bloco pode sumir por falta de dado, e nenhum pode `return null`. Todo bloco tem três saídas: dado, vazio e erro.

   **O handoff NÃO desenha estados vazios** — o único é o do chat (tela 19). Não procure: não está lá. O padrão a seguir é o que a Task 3 estabeleceu no `HojeScreen`, já revisado e aprovado:
   - vazio → uma linha em `--text-dim` dizendo o que de fato não há ("nada na agenda hoje"), dentro do card, nunca um card em branco;
   - erro → texto em `--danger` com `role="alert"`, visualmente distinto do vazio, dizendo que não deu para carregar;
   - carregando → barras de esqueleto **sem texto**, para nenhum card piscar "tudo em dia" antes do dado chegar.

   Escreva a frase de vazio específica do domínio. "Nenhum item" é preguiça; "você ainda não registrou nenhum hábito" informa.
7. Abre o trecho do handoff pela âncora da task e recria fielmente: espaçamentos, raios, pesos de fonte, ordem dos elementos.
8. Testes em `src/mobile/screens/__tests__/<nome>.test.tsx`, mockando o módulo de api com `vi.mock`. Três casos no mínimo: **(a)** renderiza com dados; **(b)** renderiza o estado vazio quando a lista vem vazia; **(c)** renderiza erro quando a api rejeita. Mais casos conforme a task pedir.

Esqueleto do teste (adapte nomes; o formato é obrigatório):

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../<modulo>/api', () => ({ <fn>: vi.fn() }));
import { <fn> } from '../../../<modulo>/api';
import { <Nome> } from '../<Nome>';

describe('<Nome>', () => {
  beforeEach(() => vi.mocked(<fn>).mockReset());

  it('renderiza os itens', async () => {
    vi.mocked(<fn>).mockResolvedValue([/* … */]);
    render(<<Nome> />);
    await waitFor(() => expect(screen.getByText('…')).toBeTruthy());
  });

  it('mostra estado vazio, não some', async () => {
    vi.mocked(<fn>).mockResolvedValue([]);
    render(<<Nome> />);
    await waitFor(() => expect(screen.getByText(/…/)).toBeTruthy());
  });

  it('mostra erro quando a api falha', async () => {
    vi.mocked(<fn>).mockRejectedValue(new Error('rede'));
    render(<<Nome> />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar/i)).toBeTruthy());
  });
});
```

## Mapa do handoff

Linhas em `handoff_mobile 2/Seraphine Mobile.dc.html`:

| Tela | Linha | Tela | Linha |
|---|---|---|---|
| HOJE | 35 | LIÇÃO · TEORIA | 415 |
| CHAT | 78 | LIÇÃO · EXERCÍCIO | 436 |
| VOZ (REALTIME) | 122 | WHATSAPP · THREAD | 463 |
| TAREFAS | 159 | MEMÓRIA | 491 |
| TRILHAS | 192 | CALENDÁRIO | 518 |
| FINANÇAS | 234 | INSIGHTS | 549 |
| HÁBITOS | 276 | ONBOARDING · BOAS-VINDAS | 593 |
| DIÁRIO | 304 | ONBOARDING · PERMISSÕES | 615 |
| INBOX | 353 | ESTADO VAZIO | 647 |
| MAIS | 384 | LOCK SCREEN | 676 |

## File Structure

```
src/
  api.ts                              MODIFICAR — useFetchJson distingue erro de vazio
  mobile/
    obsidian.css                      só o comum: orb, card, eyebrow, animações, shell
    PhoneShell.tsx                    MODIFICAR (uma vez, Onda 0) — monta pelo registry
    ChatTab.tsx                       REMOVER (Onda 2, junto com ChatScreen)
    HojeScreen.tsx                    MODIFICAR — estados vazios + bug de filtro
    screens/
      registry.ts                     NOVO (Onda 0) — mapa tela → componente
      <19 telas>.tsx + .css           NOVO — placeholders na Onda 0, reais na Onda 2
      __tests__/<19>.test.tsx         NOVO
  tasks/api.ts    calendar/api.ts     NOVO — extração
  memory/api.ts   finance/api.ts      NOVO — extração
  inbox/api.ts                        NOVO — extração
src-tauri/gen/apple/
  SeraphineWidget/                    NOVO — target WidgetKit (Swift)
```

---

# ONDA 0 — fundação (sequencial; tudo depende)

### Task 1: `useFetchJson` distingue erro de vazio

Hoje `.catch(() => {})` transforma falha de rede em tela vazia silenciosa. Foi o que mascarou o problema do Hoje e tornaria impossível cumprir o requisito de estado vazio das telas novas.

**Files:**
- Modify: `src/mobile/HojeScreen.tsx:36-46` (mover o helper para `src/mobile/useFetchJson.ts`)
- Create: `src/mobile/useFetchJson.ts`
- Test: `src/mobile/__tests__/useFetchJson.test.tsx`

**Interfaces:**
- Produces: `useFetchJson<T>(url: string | null): { data: T | null; error: string | null; loading: boolean }`

- [ ] **Step 1: Escrever o teste falhando**

```tsx
import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFetchJson } from '../useFetchJson';

describe('useFetchJson', () => {
  beforeEach(() => { global.fetch = vi.fn() as never; });

  it('entrega os dados no caminho feliz', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: true, json: async () => ({ n: 1 }) } as never);
    const { result } = renderHook(() => useFetchJson<{ n: number }>('/x'));
    await waitFor(() => expect(result.current.data).toEqual({ n: 1 }));
    expect(result.current.error).toBeNull();
  });

  it('reporta erro em vez de virar vazio silencioso', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useFetchJson('/x'));
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeNull();
  });

  it('trata HTTP não-ok como erro, não como vazio', async () => {
    vi.mocked(global.fetch).mockResolvedValue({ ok: false, status: 500 } as never);
    const { result } = renderHook(() => useFetchJson('/x'));
    await waitFor(() => expect(result.current.error).toContain('500'));
  });

  it('não busca quando a url é null', async () => {
    const { result } = renderHook(() => useFetchJson(null));
    expect(result.current.loading).toBe(false);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Rodar o teste para vê-lo falhar**

Run: `cd apps/seraphine/frontend && pnpm test useFetchJson`
Expected: FAIL — módulo `../useFetchJson` não existe.

- [ ] **Step 3: Implementar**

```tsx
import { useEffect, useState } from 'react';

export interface FetchState<T> { data: T | null; error: string | null; loading: boolean }

/** Busca JSON distinguindo TRÊS estados: carregando, erro e dado (que pode ser vazio).
 *  O helper anterior engolia o erro com `.catch(() => {})`, e falha de rede ficava
 *  indistinguível de "não há dados" — a tela apenas sumia. */
export function useFetchJson<T>(url: string | null): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, error: null, loading: url !== null });

  useEffect(() => {
    if (url === null) { setState({ data: null, error: null, loading: false }); return; }
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetch(url)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return (await r.json()) as T;
      })
      .then((d) => { if (alive) setState({ data: d, error: null, loading: false }); })
      .catch((e: unknown) => {
        if (alive) setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false });
      });
    return () => { alive = false; };
  }, [url]);

  return state;
}
```

- [ ] **Step 4: Trocar o uso no HojeScreen**

Em `src/mobile/HojeScreen.tsx`, remover o helper local e importar de `./useFetchJson`. Os call sites passam a ler `.data` (antes recebiam o dado direto) — ajustar cada um.

- [ ] **Step 5: Rodar os testes**

Run: `pnpm test useFetchJson && pnpm test hoje && pnpm exec tsc --noEmit`
Expected: PASS nos dois, tsc limpo.

- [ ] **Step 6: Commit**

```bash
git add src/mobile/useFetchJson.ts src/mobile/__tests__/useFetchJson.test.tsx src/mobile/HojeScreen.tsx
git commit -m "fix(mobile): useFetchJson distingue erro de vazio"
```

---

### Task 2: Registry das telas + placeholders (destrava o paralelismo)

Cria os 19 arquivos de tela como placeholder e o registry, e faz o `PhoneShell` montar por ele. **É a única task que toca o `PhoneShell`.** Depois dela, cada task de tela mexe só no próprio arquivo — que é o que permite rodar a Onda 2 em paralelo.

**Files:**
- Create: `src/mobile/screens/registry.ts`
- Create: 19 × `src/mobile/screens/<Nome>.tsx` (placeholder)
- Modify: `src/mobile/PhoneShell.tsx`
- Test: `src/mobile/__tests__/registry.test.ts`

**Interfaces:**
- Produces: `SCREENS: Record<ScreenKey, React.LazyExoticComponent<React.ComponentType<ScreenProps>>>`
- Produces: `type ScreenKey = 'chat' | 'voz' | 'tarefas' | 'trilhas' | 'financas' | 'habitos' | 'diario' | 'inbox' | 'memoria' | 'calendario' | 'insights' | 'licao-teoria' | 'licao-exercicio' | 'whatsapp' | 'onboarding-boas-vindas' | 'onboarding-permissoes' | 'chat-vazio' | 'notas' | 'tarefas-view'`
- Produces: `interface ScreenProps { onBack?: () => void; onOpen?: (p: { key: ScreenKey; title: string }) => void }`

- [ ] **Step 1: Escrever o teste falhando**

```ts
import { describe, it, expect } from 'vitest';
import { SCREENS, SCREEN_KEYS } from '../screens/registry';

describe('registry de telas', () => {
  it('tem uma entrada para cada tela do handoff', () => {
    expect(SCREEN_KEYS.length).toBe(19);
  });
  it('toda chave aponta para um componente', () => {
    for (const k of SCREEN_KEYS) expect(SCREENS[k]).toBeTruthy();
  });
  it('não tem chave duplicada', () => {
    expect(new Set(SCREEN_KEYS).size).toBe(SCREEN_KEYS.length);
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm test registry`
Expected: FAIL — `../screens/registry` não existe.

- [ ] **Step 3: Criar o registry**

```ts
import { lazy } from 'react';

export interface ScreenProps {
  onBack?: () => void;
  onOpen?: (p: { key: ScreenKey; title: string }) => void;
}

export type ScreenKey =
  | 'chat' | 'voz' | 'tarefas' | 'trilhas' | 'financas' | 'habitos' | 'diario'
  | 'inbox' | 'memoria' | 'calendario' | 'insights' | 'licao-teoria'
  | 'licao-exercicio' | 'whatsapp' | 'onboarding-boas-vindas'
  | 'onboarding-permissoes' | 'chat-vazio' | 'notas' | 'tarefas-view';

export const SCREEN_KEYS: ScreenKey[] = [
  'chat', 'voz', 'tarefas', 'trilhas', 'financas', 'habitos', 'diario',
  'inbox', 'memoria', 'calendario', 'insights', 'licao-teoria',
  'licao-exercicio', 'whatsapp', 'onboarding-boas-vindas',
  'onboarding-permissoes', 'chat-vazio', 'notas', 'tarefas-view',
];

/** Cada tela é um arquivo próprio, carregado sob demanda. É o que permite
 *  às tasks de tela trabalharem em paralelo sem disputar arquivo. */
export const SCREENS: Record<ScreenKey, React.LazyExoticComponent<React.ComponentType<ScreenProps>>> = {
  'chat': lazy(() => import('./ChatScreen').then((m) => ({ default: m.ChatScreen }))),
  'voz': lazy(() => import('./VozScreen').then((m) => ({ default: m.VozScreen }))),
  'tarefas': lazy(() => import('./TarefasScreen').then((m) => ({ default: m.TarefasScreen }))),
  'trilhas': lazy(() => import('./TrilhasMapaScreen').then((m) => ({ default: m.TrilhasMapaScreen }))),
  'financas': lazy(() => import('./FinancasScreen').then((m) => ({ default: m.FinancasScreen }))),
  'habitos': lazy(() => import('./HabitosScreen').then((m) => ({ default: m.HabitosScreen }))),
  'diario': lazy(() => import('./DiarioScreen').then((m) => ({ default: m.DiarioScreen }))),
  'inbox': lazy(() => import('./InboxScreen').then((m) => ({ default: m.InboxScreen }))),
  'memoria': lazy(() => import('./MemoriaScreen').then((m) => ({ default: m.MemoriaScreen }))),
  'calendario': lazy(() => import('./CalendarioScreen').then((m) => ({ default: m.CalendarioScreen }))),
  'insights': lazy(() => import('./InsightsScreen').then((m) => ({ default: m.InsightsScreen }))),
  'licao-teoria': lazy(() => import('./LicaoTeoriaScreen').then((m) => ({ default: m.LicaoTeoriaScreen }))),
  'licao-exercicio': lazy(() => import('./LicaoExercicioScreen').then((m) => ({ default: m.LicaoExercicioScreen }))),
  'whatsapp': lazy(() => import('./WhatsAppThreadScreen').then((m) => ({ default: m.WhatsAppThreadScreen }))),
  'onboarding-boas-vindas': lazy(() => import('./OnboardingBoasVindasScreen').then((m) => ({ default: m.OnboardingBoasVindasScreen }))),
  'onboarding-permissoes': lazy(() => import('./OnboardingPermissoesScreen').then((m) => ({ default: m.OnboardingPermissoesScreen }))),
  'chat-vazio': lazy(() => import('./ChatVazioScreen').then((m) => ({ default: m.ChatVazioScreen }))),
  'notas': lazy(() => import('./NotasScreen').then((m) => ({ default: m.NotasScreen }))),
  'tarefas-view': lazy(() => import('./TarefasScreen').then((m) => ({ default: m.TarefasScreen }))),
};
```

- [ ] **Step 4: Criar os 18 arquivos de placeholder**

Um arquivo por tela (`tarefas-view` reusa `TarefasScreen`, então são 18 arquivos). Cada um com este conteúdo, trocando o nome:

```tsx
import type { ScreenProps } from './registry';

/** Placeholder. A task da Onda 2 substitui este arquivo inteiro. */
export function ChatScreen(_props: ScreenProps) {
  return <div className="mshell-pending">Em construção</div>;
}
```

Nomes: `ChatScreen`, `VozScreen`, `TarefasScreen`, `TrilhasMapaScreen`, `FinancasScreen`, `HabitosScreen`, `DiarioScreen`, `InboxScreen`, `MemoriaScreen`, `CalendarioScreen`, `InsightsScreen`, `LicaoTeoriaScreen`, `LicaoExercicioScreen`, `WhatsAppThreadScreen`, `OnboardingBoasVindasScreen`, `OnboardingPermissoesScreen`, `ChatVazioScreen`, `NotasScreen`.

- [ ] **Step 5: Ligar o PhoneShell ao registry**

Trocar o `ModuleHost` (switch com imports de desktop) e os branches de tab por lookup no registry, envolto em `<Suspense fallback={null}>`. As abas `hoje` e `mais` continuam apontando para `HojeScreen`/`MaisScreen`, que já são mobile.

- [ ] **Step 6: Rodar os testes**

Run: `pnpm test registry && pnpm test shell && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/mobile/screens src/mobile/PhoneShell.tsx src/mobile/__tests__/registry.test.ts
git commit -m "feat(mobile): registry de telas + placeholders

Uma única task toca o PhoneShell. Depois dela cada tela é um arquivo
isolado, o que permite as tasks da Onda 2 rodarem em paralelo."
```

---

### Task 3: Hoje — estados vazios e o bug de filtro

Os endpoints foram medidos em produção: `sugere` e `agenda` estão legitimamente vazios; `tarefas` e `orçamento` **têm dado** e mesmo assim não aparecem.

**Files:**
- Modify: `src/mobile/HojeScreen.tsx`
- Create: `src/mobile/screens/Hoje.css` (extrair o que hoje está no `obsidian.css` específico do Hoje)
- Test: `src/mobile/__tests__/hoje-blocos.test.tsx`

**Interfaces:**
- Consumes: `useFetchJson` (Task 1)

- [ ] **Step 1: Escrever o teste falhando**

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HojeScreen } from '../HojeScreen';

const json = (body: unknown) => ({ ok: true, json: async () => body }) as never;

describe('HojeScreen — blocos nunca somem', () => {
  beforeEach(() => { global.fetch = vi.fn() as never; });

  it('mostra estado vazio da agenda quando o dia está livre', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ days: [{ date: '2026-07-31', tasks: [], habits: [] }] }));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/nada na agenda|dia livre/i)).toBeTruthy());
  });

  it('lista tarefas abertas mesmo quando a primeira da API vem concluída', async () => {
    vi.mocked(global.fetch).mockResolvedValue(json({ tasks: [
      { id: 1, status: 'completed', title: 'Feita' },
      { id: 2, status: 'pending', title: 'Comprar pão' },
    ] }));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText('Comprar pão')).toBeTruthy());
  });

  it('mostra erro quando a busca falha, em vez de sumir', async () => {
    vi.mocked(global.fetch).mockRejectedValue(new Error('offline'));
    render(<HojeScreen onOpen={() => {}} />);
    await waitFor(() => expect(screen.getByText(/não consegui carregar/i)).toBeTruthy());
  });
});
```

- [ ] **Step 2: Rodar para ver falhar**

Run: `pnpm test hoje-blocos`
Expected: FAIL — os blocos hoje somem em vez de mostrar estado vazio/erro.

- [ ] **Step 3: Investigar o filtro de tarefas antes de mexer**

Ler `TarefasBlock` (`HojeScreen.tsx:105-135`) e o bloco de orçamento (`:154+`). Descobrir por que não renderizam com dado real: a API devolve `status: 'completed'` na primeira posição e entradas de finanças existem. **Reportar a causa encontrada no relatório** — não corrigir às cegas.

- [ ] **Step 4: Corrigir e adicionar os estados vazios**

Cada um dos quatro blocos (sugere, agenda, tarefas, orçamento) passa a ter três saídas: dado, vazio desenhado (conforme o handoff, linha 35) e erro. Nenhuma retorna `null`.

- [ ] **Step 5: Rodar os testes**

Run: `pnpm test hoje && pnpm exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mobile/HojeScreen.tsx src/mobile/screens/Hoje.css src/mobile/__tests__/hoje-blocos.test.tsx
git commit -m "fix(mobile): Hoje mostra estado vazio e erro em vez de sumir"
```

---

# ONDA 1 — camadas de dados (as 5 em paralelo; diretórios disjuntos)

Todas seguem o formato de `src/habits/api.ts`: funções tipadas sobre um `request<T>` interno, tipos em `types.ts`, nenhum componente React. Cada uma extrai **só o que a tela mobile consome** e faz a view de desktop passar a importar dali — sem mudança visual.

Teste obrigatório em cada: `fetch` mockado, caminho feliz e erro, para cada função exportada.

### Task 4: `tasks/api.ts`

**Files:** Create `src/tasks/api.ts`, `src/tasks/types.ts`, `src/tasks/__tests__/api.test.ts`; Modify `src/tasks/TasksView.tsx` (passa a importar da camada nova)

**Interfaces — Produces:**
- `listTasks(params?: { limit?: number }): Promise<Task[]>` → `GET /tasks?limit=`
- `updateTaskStatus(id: number, status: 'pending' | 'completed'): Promise<Task>` → `PATCH /tasks/{id}`
- `createTask(input: TaskCreateInput): Promise<Task>` → `POST /tasks`
- `type Task = { id: number; title: string; status: string; type: string; description?: string; due_date?: string | null; category?: string | null }`

Escopo: **só a parte de tarefas.** A `TasksView` também busca `/finance/entries`, `/recurring` e `/reminders` — isso fica onde está, intocado.

- [ ] **Step 1:** Escrever `__tests__/api.test.ts` com `fetch` mockado: `listTasks` devolve o array; `listTasks` rejeita em HTTP 500; `updateTaskStatus` manda `PATCH` com o corpo certo; `createTask` manda `POST`.
- [ ] **Step 2:** Rodar `pnpm test tasks/api` → FAIL (módulo não existe).
- [ ] **Step 3:** Implementar `types.ts` e `api.ts` no formato de `habits/api.ts`.
- [ ] **Step 4:** Trocar as chamadas de tarefas dentro de `TasksView.tsx` pelas funções novas.
- [ ] **Step 5:** Rodar `pnpm test tasks && pnpm exec tsc --noEmit` → PASS, e **conferir a TasksView no desktop** (`pnpm dev`, viewport largo) — nada pode ter mudado de aparência.
- [ ] **Step 6:** Commit `feat(tasks): extrair camada de dados para api.ts`.

### Task 5: `calendar/api.ts`

**Files:** Create `src/calendar/api.ts`, `src/calendar/types.ts`, `src/calendar/__tests__/api.test.ts`; Modify `src/calendar/CalendarView.tsx`

**Interfaces — Produces:**
- `fetchAggregate(start: string, end: string): Promise<AggregateDay[]>` → `GET /calendar/aggregate?start=&end=`
- `fetchTasksByRange(start: string, end: string): Promise<Task[]>` → `GET /tasks/by-date-range?`
- `type AggregateDay = { date: string; tasks: unknown[]; habits: unknown[]; health: unknown | null; water: unknown | null; mood: { avg_valence: number; predominant_label: string } | null; focus: unknown | null }`

Escopo: só agregado e tarefas por intervalo. As buscas de finanças/recorrências/lembretes da view ficam onde estão.

- [ ] **Step 1:** Teste com `fetch` mockado para as duas funções (feliz + erro).
- [ ] **Step 2:** `pnpm test calendar/api` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Trocar as duas chamadas na `CalendarView`.
- [ ] **Step 5:** `pnpm test calendar && pnpm exec tsc --noEmit` → PASS + conferência visual do desktop.
- [ ] **Step 6:** Commit `feat(calendar): extrair camada de dados para api.ts`.

### Task 6: `memory/api.ts`

**Files:** Create `src/memory/api.ts`, `src/memory/types.ts`, `src/memory/__tests__/api.test.ts`; Modify `src/memory/MemoryView.tsx`

**Interfaces — Produces:**
- `listFacts(params?: { limit?: number; q?: string }): Promise<Fact[]>` → `GET /memory/facts?limit=`
- `fetchProfile(): Promise<MemoryProfile>` → `GET /memory/profile`
- `type Fact = { id: number; text: string; category: string | null; confidence: number | null; created_at: string }`

Escopo: a tela mobile de Memória (handoff linha 491) mostra busca, filtros e cards com categoria + confiança. Extrair só isso — o browser de tabelas, export, decay e health da view de desktop ficam onde estão.

- [ ] **Step 1:** Teste com `fetch` mockado (feliz + erro) para as duas funções.
- [ ] **Step 2:** `pnpm test memory/api` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Trocar as chamadas correspondentes na `MemoryView`.
- [ ] **Step 5:** `pnpm test memory && pnpm exec tsc --noEmit` → PASS + conferência visual.
- [ ] **Step 6:** Commit `feat(memory): extrair camada de dados para api.ts`.

### Task 7: `finance/api.ts`

**Files:** Create `src/finance/api.ts`, `src/finance/__tests__/api.test.ts`; Modify `src/finance/FinanceDashboard.tsx` (hoje importa `API_BASE` direto); `src/finance/types.ts` já existe — estender se faltar tipo.

**Interfaces — Produces:**
- `listEntries(params: { status?: 'confirmed' | 'pending_review'; limit?: number; year?: number; month?: number }): Promise<FinanceEntry[]>` → `GET /finance/entries?`
- `fetchSummary(month: number, year: number): Promise<FinanceSummary>` → `GET /finance/summary?month=&year=` (o endpoint **existe** — confirmado em `FinanceDashboard.tsx`; `month` é 1-indexado na URL)
- `fetchBalance(): Promise<{ balance: number }>` → `GET /finance/balance` (também já existe)

- [ ] **Step 1:** Teste com `fetch` mockado (feliz + erro).
- [ ] **Step 2:** `pnpm test finance/api` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Trocar as chamadas no `FinanceDashboard`.
- [ ] **Step 5:** `pnpm test finance && pnpm exec tsc --noEmit` → PASS + conferência visual.
- [ ] **Step 6:** Commit `feat(finance): extrair camada de dados para api.ts`.

### Task 8: `inbox/api.ts`

**Files:** Create `src/inbox/api.ts`, `src/inbox/types.ts`, `src/inbox/__tests__/api.test.ts`; Modify `src/inbox/UnifiedInboxView.tsx`

**Interfaces — Produces:**
- `listInbox(filter: 'all' | 'email' | 'whatsapp'): Promise<InboxItem[]>`
- `listWhatsAppMessages(chatId: string): Promise<WhatsAppMessage[]>` → `GET /whatsapp/messages/{chatId}` (consumido pela Task 21)
- `type InboxItem = { id: string; source: 'email' | 'whatsapp'; sender: string; preview: string; at: string; unread: boolean }`
- `type WhatsAppMessage = { id: string; body: string; fromMe: boolean; at: string; ack?: number }`

**Atenção — não existe endpoint de inbox.** A `UnifiedInboxView` de desktop é um agregador de seis fontes (`/google/gmail/important`, `/memory/notifications`, `/tasks`, `/work/autopilot`, `/insights`, `/finance/entries`) e **não inclui WhatsApp**, embora o handoff peça o filtro.

Para a tela mobile, `listInbox` compõe **duas** fontes e só elas:
- `email` → `GET /google/gmail/important?limit=10`
- `whatsapp` → `GET /whatsapp/chats`
- `all` → as duas, ordenadas por data decrescente

As outras quatro fontes do desktop ficam fora: o handoff desenha uma caixa de mensagens, não o painel agregador. Se uma das duas chamadas falhar, a outra ainda renderiza e a que falhou aparece como erro — não deixe uma falha esvaziar a tela inteira.

- [ ] **Step 1:** Teste com `fetch` mockado (feliz + erro) para os três filtros.
- [ ] **Step 2:** `pnpm test inbox/api` → FAIL.
- [ ] **Step 3:** Implementar.
- [ ] **Step 4:** Trocar as chamadas na `UnifiedInboxView`.
- [ ] **Step 5:** `pnpm test inbox && pnpm exec tsc --noEmit` → PASS + conferência visual.
- [ ] **Step 6:** Commit `feat(inbox): extrair camada de dados para api.ts`.

---

# ONDA 2 — as telas (paralelo; cada task só toca o próprio arquivo)

**Todas seguem o "Padrão normativo das tasks de tela".** Cada task abaixo declara: o arquivo, a âncora do handoff, a api que consome, os elementos obrigatórios e as asserções específicas além das três do padrão.

### Task 9: ChatScreen — âncora linha 78

**Files:** Rewrite `src/mobile/screens/ChatScreen.tsx`; Create `.css` e teste; **Delete** `src/mobile/ChatTab.tsx`
**Api:** reusa o WebSocket compartilhado via `useAppRefs()` (o `ChatTab` atual mostra como) — não há `api.ts` de chat.
**Obrigatório:** header com orb + "ouvindo 'oi Sera'"; bolhas (usuário accent à direita, raio `17px 17px 5px 17px`); card de tarefa inline com botão Concluir; barra de orçamento inline; composer pill com mic e enviar.
**Asserções extras:** bolha do usuário tem classe distinta da da Seraphine; o composer envia ao submeter.

### Task 10: TarefasScreen — âncora linha 159

**Files:** Rewrite `src/mobile/screens/TarefasScreen.tsx` + `.css` + teste
**Api:** `tasks/api.ts` — `listTasks`, `updateTaskStatus` (Task 4)
**Obrigatório:** filtros Hoje/Semana/Todas; rows com checkbox 22px, chips de categoria e prazo; item "em foco" com borda accent + ring + progresso; seção CONCLUÍDAS com `opacity:.55`; FAB "+".
**Asserções extras:** o filtro Semana muda a lista; marcar o checkbox chama `updateTaskStatus` com `'completed'`.

### Task 11: TrilhasMapaScreen — âncora linha 192

**Files:** Rewrite `src/mobile/screens/TrilhasMapaScreen.tsx` + `.css` + teste
**Api:** `courses/api.ts` (já existe)
**Obrigatório:** header ‹ + título + streak; barra de progresso em gradiente; **caminho SVG serpenteado** (percorrido sólido accent, futuro pontilhado); nós: done verde com sombra dura `#2c7a4b`, ativo com rótulo "COMEÇAR" e sombra `#4b44a8`, locked em `--elev` com cadeado, troféu dourado tracejado no fim; barra fixa "Continuar" no rodapé.
**Asserções extras:** um nó locked não dispara navegação ao ser clicado; a contagem de nós renderizados bate com a de lições da api.

### Task 12: FinancasScreen — âncora linha 234

**Files:** Rewrite `src/mobile/screens/FinancasScreen.tsx` + `.css` + teste
**Api:** `finance/api.ts` (Task 7)
**Obrigatório:** hero de saldo com gradiente verde e Receitas/Despesas embutidas; barras por categoria; lista de transações.
**Asserções extras:** o saldo exibido é receitas menos despesas.

### Task 13: HabitosScreen — âncora linha 276

**Files:** Rewrite `src/mobile/screens/HabitosScreen.tsx` + `.css` + teste
**Api:** `habits/api.ts` (já existe)
**Obrigatório:** header + pill de streak; rows com ícone, check de 30px accent; **água com progresso e botão "+"**; pendente destacado com borda accent; card "Seraphine sugere".
**Asserções extras:** o "+" da água chama a função de registro; hábito concluído aparece com o estado marcado.

### Task 14: DiarioScreen — âncora linha 304

**Files:** Rewrite `src/mobile/screens/DiarioScreen.tsx` + `.css` + teste
**Api:** `journal/api.ts` e `mood/api.ts` (ambos já existem)
**Obrigatório:** seletor de humor com alvos de 52px (selecionado em `--accent-soft` + ring); prompt "O que te deu energia hoje?"; chips Gratidão/Desafios; botão Salvar; mapa de humor em grade de 10 colunas com hoje em accent; última entrada.
**Asserções extras:** selecionar um humor marca só aquele; Salvar chama a api com o humor e o texto.

### Task 15: InboxScreen — âncora linha 353

**Files:** Rewrite `src/mobile/screens/InboxScreen.tsx` + `.css` + teste
**Api:** `inbox/api.ts` — **use `listInboxDetailed(filter)`, NÃO `listInbox`** (Task 8)

> `listInbox` devolve `InboxItem[]` e não tem onde carregar erro parcial: com o filtro "Tudo" e o WhatsApp fora do ar, ele renderiza só os e-mails **em silêncio**, sem avisar que metade da caixa sumiu. `listInboxDetailed` devolve `{items, errors}` — mostre os itens que vieram e sinalize a fonte que falhou. Esta é a razão de a Task 8 ter criado a segunda função.

**Obrigatório:** filtros Tudo/E-mail/WhatsApp; rows com avatar da fonte, ícone do canal, hora e ponto de não-lido; lidas em `opacity:.7`; card da Seraphine oferecendo responder com botão Sim.
**Asserções extras:** o filtro E-mail remove itens de WhatsApp; item lido não mostra o ponto.

### Task 16: MemoriaScreen (empurrada) — âncora linha 491

**Files:** Rewrite `src/mobile/screens/MemoriaScreen.tsx` + `.css` + teste
**Api:** `memory/api.ts` (Task 6)
**Obrigatório:** header ‹ + busca + filtros; cards com CATEGORIA em eyebrow e confiança (ponto verde ou âmbar). Sem tab bar (usa `PushedScreen`).
**Asserções extras:** digitar na busca chama `listFacts` com `q`; confiança baixa rende o ponto âmbar.

### Task 17: CalendarioScreen (empurrada) — âncora linha 518

**Files:** Rewrite `src/mobile/screens/CalendarioScreen.tsx` + `.css` + teste
**Api:** `calendar/api.ts` (Task 5)
**Obrigatório:** header ‹ + mês; **semana em grade** com hoje em accent e bolinhas de categoria; lista do dia com `border-left` colorida.
**Asserções extras:** a grade renderiza **todos** os dias do mês (o bug atual do desktop cortava no 18 — o teste fixa a contagem); o dia de hoje recebe a classe de destaque.

### Task 18: InsightsScreen (empurrada) — âncora linha 549

**Files:** Rewrite `src/mobile/screens/InsightsScreen.tsx` + `.css` + teste
**Api:** `insights/api.ts` (já existe)
**Obrigatório:** header ‹; três stat-cards; gráfico de barras da semana com o pico em accent; bloco "SERAPHINE NOTOU"; barras de "onde foi seu tempo".
**Asserções extras:** a barra mais alta recebe a classe de pico.

### Task 19: LicaoTeoriaScreen (empurrada) — âncora linha 415

**Files:** Rewrite `src/mobile/screens/LicaoTeoriaScreen.tsx` + `.css` + teste
**Api:** `courses/api.ts` (já existe)
**Obrigatório:** X + progresso + pill "Teoria"; eyebrow "LIÇÃO N · TRILHA"; conceito; bloco de código em mono 12.5px com as cores do handoff (base `#d4d4d4`, keywords `#c586c0`, identificadores `#9cdcfe`, strings `#ce9178`, erro `#ef6b6b`); dica-analogia em `--accent-soft`; CTA "Começar exercícios" com sombra dura `#4b44a8`.
**Asserções extras:** o bloco de código preserva quebras de linha e não escapa HTML como texto visível.

### Task 20: LicaoExercicioScreen (empurrada) — âncora linha 436

**Files:** Rewrite `src/mobile/screens/LicaoExercicioScreen.tsx` + `.css` + teste
**Api:** `courses/api.ts` (já existe)
**Obrigatório:** X + progresso 3/5; MCQ com quadradinhos numerados; alternativa selecionada em accent; feedback verde fixo no rodapé (círculo ✓, "Certo!", botão Continuar com sombra `#2c7a4b`).
**Asserções extras:** selecionar uma alternativa marca só ela; responder certo mostra o feedback e habilita Continuar.

### Task 21: WhatsAppThreadScreen (empurrada) — âncora linha 463

**Files:** Rewrite `src/mobile/screens/WhatsAppThreadScreen.tsx` + `.css` + teste
**Api:** `inbox/api.ts` — `listWhatsAppMessages(chatId)` (Task 8)
**Obrigatório:** header ‹ + avatar + "online"; recebidas em `--surface` à esquerda, enviadas em `rgba(37,211,102,.16)` à direita; selo central "enviada pela Seraphine com sua aprovação"; card da Seraphine confirmando ação na agenda; composer com botão de enviar verde.

> **O duplo-check azul do handoff NÃO é implementável hoje, e a causa não está nesta camada.** O tipo `WhatsAppMessage` já declara `ack?: number`, mas o bridge nunca envia o campo: `services/whatsapp-bridge/src/routes/messages.ts:88-92` mapeia só `id/body/timestamp/fromMe`, e o token `ack` não existe em `services/whatsapp-bridge/src`. Renderize as enviadas **sem** o duplo-check e não invente um estado de entrega que o dado não sustenta. Quando o bridge passar a mandar `ack`, esta tela funciona sem mudança — o `api.ts` já repassa o campo.
**Asserções extras:** mensagem enviada e recebida têm classes distintas; o selo só aparece nas enviadas pela Seraphine.

### Task 22: VozScreen — âncora linha 122

**Files:** Rewrite `src/mobile/screens/VozScreen.tsx` + `.css` + teste
**Api:** nenhuma — comanda o `realtime/RealtimeController` que já existe. **Não** mexer em áudio, VPIO ou wake word.
**Obrigatório:** fundo radial escuro; pill "ao vivo" + timer; orb de 158px com dois anéis `ringPulse` (2.4s, o segundo com 1.2s de atraso); transcrição em 20px/700 com rótulo "você disse"; waveform de 8 barras com `wave` e atrasos escalonados; controles mute / encerrar (66px vermelho) / teclado.
**Asserções extras:** o botão encerrar chama o `stop` do controller; o timer formata mm:ss.

### Task 23: ChatVazioScreen — âncora linha 647

**Files:** Rewrite `src/mobile/screens/ChatVazioScreen.tsx` + `.css` + teste
**Api:** nenhuma
**Obrigatório:** orb de 88px; título "Sobre o que a gente conversa primeiro?"; quatro sugestões tocáveis; composer.
**Asserções extras:** tocar numa sugestão dispara o callback com o texto dela.
**Nota:** esta tela é o estado vazio do Chat (Task 9); a integração entre as duas fica na Task 27.

### Task 24: Onboarding — âncoras linhas 593 e 615

**Files:** Rewrite `src/mobile/screens/OnboardingBoasVindasScreen.tsx` e `OnboardingPermissoesScreen.tsx` + dois `.css` + dois testes
**Api:** as pontes Swift existentes de microfone e notificações. **Conferir se existe bridge de calendário antes de ligar o botão** — se não existir, o botão fica desabilitado com rótulo explicando, e isso vai no relatório.
**Obrigatório (17):** orb de 148px + anel; título; dots de progresso; CTA "Começar"; link "Já uso no Mac — sincronizar".
**Obrigatório (18):** cards de Microfone (estado "Permitido" em verde) / Notificações / Calendário com botões Permitir; toggle de wake word; botão Continuar.
**Asserções extras:** o onboarding só aparece no primeiro uso (flag persistida); conceder permissão troca o rótulo do card.

### Task 25: NotasScreen — sem âncora própria (item do grid do Mais, linha 384)

**Files:** Rewrite `src/mobile/screens/NotasScreen.tsx` + `.css` + teste
**Api:** `notes/api.ts` (já existe)
**Obrigatório:** o handoff não desenha uma tela dedicada de Notas — ela aparece como módulo no grid do Mais. Seguir o padrão visual das outras empurradas (header ‹ + busca + lista de cards `--surface`), sem inventar elementos que o handoff não mostra.

---

# ONDA 3 — nativo (paralelo com toda a Onda 2; é Swift)

### Task 26: Target WidgetKit + App Group + escrita do snapshot

**Files:**
- Create: `src-tauri/gen/apple/SeraphineWidget/` (Swift: `SeraphineWidget.swift`, `Provider.swift`, `Info.plist`)
- Modify: `src-tauri/gen/apple/project.yml` (registrar o target para sobreviver à regeneração do Tauri)
- Modify: o bridge Swift do app, para gravar o snapshot no container do App Group

**Interfaces — Produces:** JSON em `group.io.jonhdev.seraphine/widget-snapshot.json` com `{ agenda: {title, at}[], streak: number, xp: number, updatedAt: string }`

- [ ] **Step 1:** Criar o target no `project.yml` e confirmar que `pnpm tauri ios build` regenera o projeto **com** a extensão presente. Este passo é o risco principal — se a regeneração apagar o target, pare e reporte antes de seguir.
- [ ] **Step 2:** Configurar o App Group nos dois targets (app e extensão).
- [ ] **Step 3:** No app, gravar o snapshot no container compartilhado a cada sync.
- [ ] **Step 4:** Implementar o `TimelineProvider` lendo o JSON — **sem rede na extensão**.
- [ ] **Step 5:** Montar a UI do widget conforme o handoff (linha 676): agenda + 🔥 streak + ⚡ XP, glass `rgba(23,23,30,.72)` com blur 20, borda `rgba(255,255,255,.1)`, raio 20-22. (Os símbolos de fogo e raio aqui são ícones do widget nativo, não emoji em HTML.)
- [ ] **Step 6:** Rodar no simulador, adicionar o widget à tela de bloqueio e conferir que os dados aparecem.
- [ ] **Step 7:** Commit `feat(ios): widget de lock screen via App Group`.

### Task 27: Notificação rica com ações

**Files:** Modify o bridge de notificações Swift; Create `src-tauri/gen/apple/SeraphineNotificationContent/` se a UI customizada for necessária

**Interfaces — Consumes:** o App Group da Task 26

- [ ] **Step 1:** Registrar `UNNotificationCategory` com as ações "Marcar pago" e "Adiar 1h".
- [ ] **Step 2:** Tratar as respostas no app: "Marcar pago" chama a api de finanças; "Adiar 1h" reagenda o lembrete.
- [ ] **Step 3:** Disparar uma notificação de teste no simulador e acionar cada ação.
- [ ] **Step 4:** Conferir que o alerta "Streak em risco" do handoff usa a mesma categoria.
- [ ] **Step 5:** Commit `feat(ios): notificação rica com ações de pagamento e adiamento`.

---

# ONDA 4 — integração (sequencial, depois de tudo)

### Task 28: Passada de integração no simulador

**Files:** Modify o que a passada revelar; Modify `docs/superpowers/specs/2026-07-31-mobile-fases2-5-design.md` (acrescentar a seção "Verificação")

- [ ] **Step 1:** `pnpm tauri ios dev "iPhone 17"` e percorrer **as 20 telas**, comparando lado a lado com o handoff aberto.
- [ ] **Step 2:** Conferir os pontos que só aparecem no dispositivo: safe areas no topo e no home indicator, alvos de toque ≥44px, rolagem sem corte.
- [ ] **Step 3:** Integrar Chat e ChatVazio (a tela vazia aparece quando não há histórico).
- [ ] **Step 4:** Verificar que **nenhuma** tela ainda monta componente de desktop — `grep -rn "TasksView\|CalendarView\|MemoryView\|JournalView\|HabitsView\|FinanceDashboard\|UnifiedInboxView\|InsightsView\|NotesView\|TrilhasView" src/mobile/` deve voltar vazio.
- [ ] **Step 5:** `pnpm exec tsc --noEmit` limpo e `pnpm test mobile` verde.
- [ ] **Step 6:** Registrar no spec o que passou e o que ficou, e commitar.

---

## Notas para quem for implementar

- **Nunca toque em arquivo fora da sua task.** Se precisar, é sinal de lacuna na Onda 0 — reporte em vez de improvisar. É isso que mantém as ondas paralelas viáveis.
- **O handoff é a autoridade de pixel, o README é a de requisito.** Quando divergirem, o HTML vence para aparência e o README para comportamento.
- **Estado vazio não é opcional.** Foi o que fez a tela Hoje parecer quebrada. Um bloco que retorna `null` por falta de dado é bug, não economia.
- **A extração de dados não pode mudar o desktop.** Se a aparência mudou, você extraiu demais ou mudou semântica no caminho.
