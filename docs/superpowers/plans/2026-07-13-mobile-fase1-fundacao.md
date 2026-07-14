# Seraphine Mobile — Fase 1: Fundação — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shell phone (tab bar com orb central, safe areas, navegação empurrada) + telas Hoje e Mais, gateado por `data-shell="phone"`, com as tabs interinas abrindo as views existentes — desktop intocado.

**Architecture:** Módulo novo `src/mobile/` montado pelo `App.tsx` quando `data-shell === 'phone'` (1 branch; `AppBootstrap` continua montado nos dois caminhos — o `wsRef` do `RefsContext` serve o ChatView embrulhado). Telas novas (Hoje, Mais) fazem fetch direto das APIs existentes com fail-soft por bloco. CSS per-feature `src/mobile/obsidian.css`, todas as regras sob `html[data-shell='phone']`.

**Tech Stack:** React + TypeScript (Tauri iOS/desktop single-codebase), CSS puro (tokens do design system), vitest + testing-library.

## Global Constraints

- **Referência de design:** `apps/seraphine/frontend/handoff_mobile/README.md` (spec) + `handoff_mobile/Seraphine Mobile.dc.html` (20 frames inline-styled; localizar por rótulo de texto, ex. buscar `Hoje` / `Mais` no HTML).
- **Tokens verbatim (idênticos ao desktop):** `--app #0f0f14 · --nav #131319 · --surface #17171e · --elev #1f1f27 · --text #ececef · --text-dim #9594a0 · --text-faint #5f5e6b · --accent #9a93ff · --accent-hi #cac5ff · --accent-dim #6c63d6 · --accent-soft rgba(154,147,255,.14) · --border rgba(255,255,255,.08) · --border-strong rgba(255,255,255,.12)`. XP `#ffd54f`, streak `#ff8a4c`, sucesso `#4ade80`.
- **Orb (identidade, verbatim):** `radial-gradient(circle at 32% 26%, #efedff 0%, #cac5ff 22%, #9a93ff 55%, #4d45b8 85%, #332d85 100%)` + `inset -5px -7px 14px rgba(15,10,60,.55)` + `inset 3px 4px 8px rgba(255,255,255,.35)` + glow `rgba(154,147,255,.45)` + brilho especular (elipse branca blur, rotate -24°).
- **Safe areas:** topo `calc(12px + env(safe-area-inset-top, 44px))`; tab bar padding-bottom `calc(10px + env(safe-area-inset-bottom, 20px))`. Alvos de toque ≥44px. Cards raio 15-18, padding 13-16.
- **SEM EMOJI** — ícones SVG de `src/icons/Icons.tsx` (padrão `IconProps`: `size`, `className`).
- **Desktop intocado:** nenhum arquivo do AppLayout muda; `App.tsx` ganha só o branch. CSS mobile 100% sob `html[data-shell='phone']`.
- **Fail-soft:** cada bloco do Hoje trata loading/erro/vazio isolado (erro/vazio → bloco não renderiza); shell/tab bar nunca dependem de rede.
- Typecheck `pnpm exec tsc --noEmit` limpo; `pnpm exec vitest run src/mobile src/courses` verde.
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Criar:**
- `src/mobile/Orb.tsx` · `src/mobile/PhoneShell.tsx` · `src/mobile/TabBar.tsx` · `src/mobile/PushedScreen.tsx` · `src/mobile/ChatTab.tsx` · `src/mobile/HojeScreen.tsx` · `src/mobile/MaisScreen.tsx` · `src/mobile/hoje.ts` (helpers puros) · `src/mobile/obsidian.css`
- Testes: `src/mobile/__tests__/{orb.test.tsx,shell.test.tsx,hoje-helpers.test.ts}`

**Modificar:**
- `src/App.tsx` — branch phone (AppBootstrap SEMPRE montado; AppLayout ↔ PhoneShell).

**Interfaces reais já verificadas (usar exatamente):**
- `TasksView({ onBack, focusId })` de `src/tasks/TasksView.tsx`; `TrilhasView({ onBack })`; `ChatView` (export nomeado, memo) com props `{ ws: SeraphineWS; status: 'connected'|'disconnected'; speak?; think?; talking: boolean; onTalkStart: () => Promise<void>; onTalkEnd: () => void; onTalkCancel: () => void; ... }` (ler a interface completa em `src/chat/ChatView.tsx:295` na implementação).
- `FinanceDashboard({ onBack })` · `HabitsView({ onBack })` · `JournalView({ onBack })` · `UnifiedInboxView({ onBack, onNavigate, onOpenEmail })` · `CalendarView({ onNavigateToTask })` · `MemoryView({ onBack, ws? })` · `InsightsView({ onBack })` · `NotesView({ onBack, initialNoteId? })`.
- `useAppRefs()` de `src/stores/RefsContext` → `{ wsRef, ... }` (o `AppBootstrap` popula `wsRef.current`).
- APIs: `GET /tasks?limit=200` → `{tasks}`; `listHabits()`/`toggleHabit(id)` de `src/habits/api`; `GET /notifications/queue` → `{queue: [{id,type,title,body,payload_json,priority,queued_at}]}`; `getStats()` de `src/courses/api` → `{xp_total,streak_count}`; `GET /finance/entries?status=confirmed&limit=100`; calendário: grep `src/calendar/` + `/calendar` backend na implementação pro endpoint de eventos do dia (existe agregador `/calendar`).

---

## Task 1: `Orb` + fundação CSS mobile

**Files:**
- Create: `src/mobile/Orb.tsx`, `src/mobile/obsidian.css`
- Test: `src/mobile/__tests__/orb.test.tsx`

**Interfaces:**
- Produces: `Orb({ size, float = false, halo = false }: { size: number; float?: boolean; halo?: boolean })` → esfera com camadas; `.mshell-*` primitivas CSS (card, eyebrow) + keyframes `orbFloat`/`orbSpin`/`statusBlink`.

- [ ] **Step 1: teste falhando**

```tsx
// src/mobile/__tests__/orb.test.tsx
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Orb } from '../Orb';

describe('Orb', () => {
  it('renders at the given size', () => {
    const { container } = render(<Orb size={56} />);
    const el = container.querySelector('.morb') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.style.width).toBe('56px');
  });
  it('adds float/halo modifiers', () => {
    const { container } = render(<Orb size={38} float halo />);
    expect(container.querySelector('.morb--float')).toBeTruthy();
    expect(container.querySelector('.morb__halo')).toBeTruthy();
  });
});
```

- [ ] **Step 2:** `pnpm exec vitest run src/mobile` → FAIL (módulo inexistente).

- [ ] **Step 3: implementação**

```tsx
// src/mobile/Orb.tsx
import './obsidian.css';

export function Orb({ size, float = false, halo = false }:
  { size: number; float?: boolean; halo?: boolean }) {
  return (
    <span className={`morb-wrap${halo ? ' morb-wrap--halo' : ''}`} style={{ width: size, height: size }}>
      {halo && <span className="morb__halo" aria-hidden="true" />}
      <span className={`morb${float ? ' morb--float' : ''}`}
        style={{ width: size, height: size }} aria-hidden="true">
        <span className="morb__spec" />
      </span>
    </span>
  );
}
```

```css
/* src/mobile/obsidian.css — fundação (tudo funciona em qualquer shell;
   as regras de LAYOUT do shell ficam sob html[data-shell='phone'] nas tasks seguintes) */
.morb-wrap { position: relative; display: inline-flex; align-items: center; justify-content: center; flex: none; }
.morb {
  position: relative; display: inline-block; border-radius: 50%;
  background: radial-gradient(circle at 32% 26%, #efedff 0%, #cac5ff 22%, #9a93ff 55%, #4d45b8 85%, #332d85 100%);
  box-shadow: inset -5px -7px 14px rgba(15,10,60,.55), inset 3px 4px 8px rgba(255,255,255,.35),
              0 4px 18px rgba(154,147,255,.45);
}
.morb__spec {
  position: absolute; left: 22%; top: 14%; width: 34%; height: 20%;
  border-radius: 50%; background: rgba(255,255,255,.75); filter: blur(2px);
  transform: rotate(-24deg);
}
.morb--float { animation: orbFloat 5s ease-in-out infinite; }
.morb__halo {
  position: absolute; inset: -18%; border-radius: 50%; z-index: -1;
  background: conic-gradient(from 0deg, rgba(154,147,255,.0), rgba(154,147,255,.5), rgba(202,197,255,.25), rgba(154,147,255,.0));
  filter: blur(7px); animation: orbSpin 6s linear infinite;
}
.mshell-card { background: var(--surface, #17171e); border: 1px solid var(--border, rgba(255,255,255,.08)); border-radius: 16px; padding: 14px; }
.mshell-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--text-faint, #5f5e6b); }
@keyframes orbFloat { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
@keyframes orbSpin { to { transform: rotate(360deg); } }
@keyframes statusBlink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
```

- [ ] **Step 4:** `pnpm exec vitest run src/mobile` → PASS (2). `pnpm exec tsc --noEmit` limpo.
- [ ] **Step 5:** commit `feat(mobile): Orb identity component + mobile CSS foundation`

---

## Task 2: `PhoneShell` + `TabBar` + `PushedScreen` + gate no `App.tsx`

**Files:**
- Create: `src/mobile/PhoneShell.tsx`, `src/mobile/TabBar.tsx`, `src/mobile/PushedScreen.tsx`
- Modify: `src/App.tsx`
- Modify: `src/mobile/obsidian.css` (append seção shell)
- Test: `src/mobile/__tests__/shell.test.tsx`

**Interfaces:**
- Consumes: `Orb` (T1); `TasksView({onBack})`, `TrilhasView({onBack})` existentes.
- Produces: `type Tab = 'hoje'|'tarefas'|'chat'|'trilhas'|'mais'`; `type Pushed = { key: string; title: string } | null`; `PhoneShell()`; `TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void })`; `PushedScreen({ title, onBack, children })`. `HojeScreen`/`MaisScreen`/`ChatTab` entram como placeholders internos nesta task (`<div className="mshell-pending">Em construção</div>`) substituídos nas Tasks 3-5.

- [ ] **Step 1: teste falhando**

```tsx
// src/mobile/__tests__/shell.test.tsx
import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { TabBar } from '../TabBar';

describe('TabBar', () => {
  it('renders 5 tabs with central chat orb and marks active', () => {
    const { container, getByText } = render(<TabBar tab="hoje" onTab={() => {}} />);
    expect(container.querySelectorAll('.mtab').length).toBe(5);
    expect(container.querySelector('.mtab--chat .morb')).toBeTruthy();
    expect(getByText('Hoje').closest('.mtab')?.className).toContain('mtab--active');
  });
  it('fires onTab', () => {
    let picked = '';
    const { getByText } = render(<TabBar tab="hoje" onTab={(t) => { picked = t; }} />);
    fireEvent.click(getByText('Trilhas'));
    expect(picked).toBe('trilhas');
  });
});
```

- [ ] **Step 2:** vitest → FAIL.

- [ ] **Step 3: implementação**

```tsx
// src/mobile/TabBar.tsx
import { Orb } from './Orb';
import { DashboardIcon, TasksIcon, TrilhasIcon, CommandIcon } from '../icons/Icons';

export type Tab = 'hoje' | 'tarefas' | 'chat' | 'trilhas' | 'mais';

const TABS: { id: Tab; label: string }[] = [
  { id: 'hoje', label: 'Hoje' }, { id: 'tarefas', label: 'Tarefas' },
  { id: 'chat', label: 'Chat' },
  { id: 'trilhas', label: 'Trilhas' }, { id: 'mais', label: 'Mais' },
];

function iconFor(id: Tab) {
  switch (id) {
    case 'hoje': return <DashboardIcon size={22} />;
    case 'tarefas': return <TasksIcon size={22} />;
    case 'trilhas': return <TrilhasIcon size={22} />;
    case 'mais': return <CommandIcon size={22} />;
    default: return null;
  }
}

export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <nav className="mtabbar">
      {TABS.map(({ id, label }) => (
        <button key={id} type="button"
          className={`mtab${id === 'chat' ? ' mtab--chat' : ''}${tab === id ? ' mtab--active' : ''}`}
          onClick={() => onTab(id)}>
          {id === 'chat' ? <Orb size={56} /> : iconFor(id)}
          <span className="mtab__label">{label}</span>
        </button>
      ))}
    </nav>
  );
}
```

```tsx
// src/mobile/PushedScreen.tsx
import type { ReactNode } from 'react';
import { ArrowLeftIcon } from '../icons/Icons';

export function PushedScreen({ title, onBack, children }:
  { title: string; onBack: () => void; children: ReactNode }) {
  return (
    <div className="mpushed">
      <header className="mpushed__head">
        <button type="button" className="mpushed__back" onClick={onBack} aria-label="Voltar">
          <ArrowLeftIcon size={20} />
        </button>
        <span className="mpushed__title">{title}</span>
      </header>
      <div className="mpushed__body">{children}</div>
    </div>
  );
}
```

```tsx
// src/mobile/PhoneShell.tsx
import { useState } from 'react';
import { TabBar, type Tab } from './TabBar';
import { PushedScreen } from './PushedScreen';
import { TasksView } from '../tasks/TasksView';
import { TrilhasView } from '../courses/TrilhasView';
import './obsidian.css';

export type Pushed = { key: string; title: string } | null;

export function PhoneShell() {
  const [tab, setTab] = useState<Tab>('hoje');
  const [pushed, setPushed] = useState<Pushed>(null);

  if (pushed) {
    return (
      <div className="mshell">
        <PushedScreen title={pushed.title} onBack={() => setPushed(null)}>
          {renderModule(pushed.key, () => setPushed(null))}
        </PushedScreen>
      </div>
    );
  }

  return (
    <div className="mshell">
      <main className="mshell__content">
        {tab === 'hoje' && <div className="mshell-pending">Em construção</div>}
        {tab === 'tarefas' && <TasksView onBack={() => setTab('hoje')} />}
        {tab === 'chat' && <div className="mshell-pending">Em construção</div>}
        {tab === 'trilhas' && <TrilhasView onBack={() => setTab('hoje')} />}
        {tab === 'mais' && <div className="mshell-pending">Em construção</div>}
      </main>
      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}

// Task 5 preenche o mapa completo de módulos; aqui só o esqueleto.
export function renderModule(key: string, onBack: () => void) {
  void key;
  return <div className="mshell-pending">Em construção</div>;
}
```

```tsx
// src/App.tsx — substituir o conteúdo por:
import { RefsProvider } from './stores/RefsContext';
import { FocusProvider } from './focus/FocusContext';
import { AppBootstrap } from './AppBootstrap';
import { AppLayout } from './AppLayout';
import { PhoneShell } from './mobile/PhoneShell';

const isPhone = typeof document !== 'undefined'
  && document.documentElement.dataset.shell === 'phone';

export function App(): JSX.Element {
  return (
    <RefsProvider>
      <FocusProvider>
        <AppBootstrap />
        {isPhone ? <PhoneShell /> : <AppLayout />}
      </FocusProvider>
    </RefsProvider>
  );
}
```

CSS (append):

```css
/* ── shell (layout phone) ── */
html[data-shell='phone'] .mshell { display: flex; flex-direction: column; height: 100dvh; background: var(--app, #0f0f14); }
html[data-shell='phone'] .mshell__content { flex: 1; min-height: 0; overflow-y: auto; padding: calc(12px + env(safe-area-inset-top, 44px)) 16px 16px; }
html[data-shell='phone'] .mtabbar {
  flex: none; display: flex; align-items: flex-end; justify-content: space-around;
  background: var(--nav, #131319); border-top: 1px solid var(--border, rgba(255,255,255,.08));
  padding: 8px 6px calc(10px + env(safe-area-inset-bottom, 20px));
}
html[data-shell='phone'] .mtab {
  display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 56px; min-height: 44px;
  background: none; border: none; font: inherit; color: var(--text-faint, #5f5e6b); cursor: pointer;
}
html[data-shell='phone'] .mtab__label { font-size: 10px; font-weight: 600; }
html[data-shell='phone'] .mtab--active { color: var(--accent, #9a93ff); }
html[data-shell='phone'] .mtab--active .mtab__label { font-weight: 700; }
html[data-shell='phone'] .mtab--chat { margin-top: -22px; }
html[data-shell='phone'] .mtab--chat .morb { box-shadow: inset -5px -7px 14px rgba(15,10,60,.55), inset 3px 4px 8px rgba(255,255,255,.35), 0 6px 20px rgba(154,147,255,.4), 0 0 0 5px var(--app, #0f0f14); }
html[data-shell='phone'] .mpushed { display: flex; flex-direction: column; height: 100dvh; background: var(--app, #0f0f14); }
html[data-shell='phone'] .mpushed__head { flex: none; display: flex; align-items: center; gap: 10px; padding: calc(10px + env(safe-area-inset-top, 44px)) 14px 10px; border-bottom: 1px solid var(--border, rgba(255,255,255,.08)); }
html[data-shell='phone'] .mpushed__back { min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; background: none; border: none; color: var(--text-dim, #9594a0); cursor: pointer; }
html[data-shell='phone'] .mpushed__title { font-size: 16px; font-weight: 700; color: var(--text, #ececef); }
html[data-shell='phone'] .mpushed__body { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: env(safe-area-inset-bottom, 20px); }
html[data-shell='phone'] .mshell-pending { padding: 40px 16px; text-align: center; color: var(--text-faint, #5f5e6b); }
```

> Ícones das tabs: confirmar por grep que `DashboardIcon/TasksIcon/CommandIcon` existem (lista já verificada contém os três); se algum divergir, escolher o SVG existente mais próximo — nunca emoji.

- [ ] **Step 4:** vitest src/mobile → PASS; tsc limpo; smoke manual `pnpm dev` com devtools em iPhone (UA) → shell com tab bar; janela desktop normal → AppLayout intocado.
- [ ] **Step 5:** commit `feat(mobile): PhoneShell + TabBar + PushedScreen, phone gate in App`

---

## Task 3: `ChatTab` — ChatView embrulhada com ws do RefsContext

**Files:**
- Create: `src/mobile/ChatTab.tsx`
- Modify: `src/mobile/PhoneShell.tsx` (tab chat usa `<ChatTab/>`)

**Interfaces:**
- Consumes: `useAppRefs()` → `wsRef` (populado pelo `AppBootstrap`, que está montado no caminho phone); `ChatView` (export nomeado) — **ler a interface `ChatViewProps` completa em `src/chat/ChatView.tsx:295`** e satisfazê-la: `ws={wsRef.current}` (aguardar não-nulo), `status` rastreado via `ws.onStatus`, `talking={false}`, `onTalkStart={async () => {}}`, `onTalkEnd/onTalkCancel={() => {}}`, `speak/think` omitidos se opcionais; props adicionais obrigatórias que existirem → valor neutro seguindo o uso no AppLayout (grep `<ChatView` no AppLayout.tsx como referência de wiring).
- Produces: `ChatTab()` — auto-suficiente.

- [ ] **Step 1: implementação** (sem teste unitário próprio — integração com ws real; o gate é tsc + smoke manual):

```tsx
// src/mobile/ChatTab.tsx
import { useEffect, useState } from 'react';
import { useAppRefs } from '../stores/RefsContext';
import { ChatView } from '../chat/ChatView';

export function ChatTab() {
  const { wsRef } = useAppRefs();
  const [ready, setReady] = useState(!!wsRef.current);
  const [status, setStatus] = useState<'connected' | 'disconnected'>('disconnected');

  useEffect(() => {
    // AppBootstrap cria o ws async; poll curto até existir.
    if (wsRef.current) { setReady(true); return; }
    const t = setInterval(() => {
      if (wsRef.current) { setReady(true); clearInterval(t); }
    }, 100);
    return () => clearInterval(t);
  }, [wsRef]);

  useEffect(() => {
    const ws = wsRef.current;
    if (!ready || !ws) return;
    const off = ws.onStatus((s: string) => setStatus(s === 'connected' ? 'connected' : 'disconnected'));
    return () => { off?.(); };
  }, [ready, wsRef]);

  if (!ready || !wsRef.current) return <div className="mshell-pending">Conectando…</div>;
  return (
    <ChatView
      ws={wsRef.current}
      status={status}
      talking={false}
      onTalkStart={async () => {}}
      onTalkEnd={() => {}}
      onTalkCancel={() => {}}
    />
  );
}
```

(Se `ChatViewProps` exigir mais props obrigatórias, replicar o wiring do `AppLayout` com valores neutros; anotar no report o que foi preciso.)

Em `PhoneShell.tsx`: `{tab === 'chat' && <ChatTab />}` (substitui o placeholder) + import.

- [ ] **Step 2:** tsc limpo; vitest inalterado; smoke manual: tab Chat conecta e conversa (backend local ou prod).
- [ ] **Step 3:** commit `feat(mobile): chat tab wraps ChatView with shared ws`

---

## Task 4: `HojeScreen` — saudação + 4 blocos fail-soft

**Files:**
- Create: `src/mobile/hoje.ts`, `src/mobile/HojeScreen.tsx`
- Modify: `src/mobile/PhoneShell.tsx` (tab hoje), `src/mobile/obsidian.css` (append seção hoje)
- Test: `src/mobile/__tests__/hoje-helpers.test.ts`

**Interfaces:**
- Consumes: `Orb`, `.mshell-card`; `API_BASE` de `src/api.ts`; `listHabits`/`toggleHabit` de `src/habits/api`; `SparkleIcon`/ícones existentes.
- Produces: `greeting(hour: number): string`; `monthExpenses(entries: {amount: number; kind?: string; type?: string; date?: string; ts?: string}[], now: Date): number` (helpers puros em `hoje.ts`); `HojeScreen({ onOpen }: { onOpen: (p: {key: string; title: string}) => void })`.

- [ ] **Step 1: teste falhando (helpers puros)**

```ts
// src/mobile/__tests__/hoje-helpers.test.ts
import { describe, it, expect } from 'vitest';
import { greeting, monthExpenses } from '../hoje';

describe('greeting', () => {
  it('bom dia até 11h', () => expect(greeting(8)).toBe('Bom dia'));
  it('boa tarde 12-17', () => expect(greeting(15)).toBe('Boa tarde'));
  it('boa noite 18+', () => expect(greeting(21)).toBe('Boa noite'));
  it('boa noite madrugada', () => expect(greeting(3)).toBe('Boa noite'));
});

describe('monthExpenses', () => {
  const now = new Date('2026-07-13T12:00:00');
  it('soma só despesas do mês corrente', () => {
    expect(monthExpenses([
      { amount: 100, kind: 'expense', date: '2026-07-02' },
      { amount: 50, kind: 'expense', date: '2026-06-30' },   // mês passado
      { amount: 999, kind: 'income', date: '2026-07-05' },   // receita
    ], now)).toBe(100);
  });
  it('vazio → 0', () => expect(monthExpenses([], now)).toBe(0));
});
```

- [ ] **Step 2:** vitest → FAIL.

- [ ] **Step 3: helpers**

```ts
// src/mobile/hoje.ts
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Bom dia';
  if (hour >= 12 && hour < 18) return 'Boa tarde';
  return 'Boa noite';
}

export function monthExpenses(
  entries: { amount: number; kind?: string; type?: string; date?: string; ts?: string }[],
  now: Date,
): number {
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return entries
    .filter((e) => (e.kind ?? e.type) === 'expense')
    .filter((e) => ((e.date ?? e.ts) || '').startsWith(ym))
    .reduce((s, e) => s + Math.abs(e.amount || 0), 0);
}
```

(Adequar os nomes de campo ao shape REAL de `/finance/entries` — grep `src/finance/types.ts`; o helper aceita `kind|type` e `date|ts` pra acomodar; se o shape real divergir, ajustar helper + teste juntos.)

- [ ] **Step 4: HojeScreen** — cada bloco com fetch próprio, estado `loading|ok|hidden` e render nulo em erro/vazio:

```tsx
// src/mobile/HojeScreen.tsx
import { useEffect, useState } from 'react';
import { API_BASE } from '../api';
import { Orb } from './Orb';
import { greeting, monthExpenses } from './hoje';
import { listHabits, toggleHabit } from '../habits/api';
import type { HabitWithStatus } from '../habits/types';
import { SparkleIcon, CheckIcon } from '../icons/Icons';

type Notif = { id: string; type: string; title: string; body: string };
type Task = { id: string; title: string; status?: string; due_date?: string | null };
type Open = (p: { key: string; title: string }) => void;

const DISMISS_KEY = 'seraphine.mobile.sugere.dismissed';

export function HojeScreen({ onOpen }: { onOpen: Open }) {
  return (
    <div className="mhoje">
      <header className="mhoje__head">
        <Orb size={38} float halo />
        <div>
          <p className="mhoje__hi">{greeting(new Date().getHours())}</p>
          <p className="mhoje__sub">aqui está o seu dia</p>
        </div>
      </header>
      <SugereCard onOpen={onOpen} />
      <AgendaBlock onOpen={onOpen} />
      <div className="mhoje__row">
        <TarefasBlock onOpen={onOpen} />
        <HabitosBlock onOpen={onOpen} />
      </div>
      <OrcamentoBlock onOpen={onOpen} />
    </div>
  );
}

function useFetchJson<T>(url: string): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let ok = true;
    fetch(url).then((r) => (r.ok ? r.json() : null)).then((d) => { if (ok) setData(d); }).catch(() => {});
    return () => { ok = false; };
  }, [url]);
  return data;
}

function SugereCard({ onOpen }: { onOpen: Open }) {
  const data = useFetchJson<{ queue: Notif[] }>(`${API_BASE}/notifications/queue`);
  const [dismissed, setDismissed] = useState<string>(() => localStorage.getItem(DISMISS_KEY) ?? '');
  const today = new Date().toISOString().slice(0, 10);
  const item = (data?.queue ?? []).find((n) => dismissed !== `${n.id}:${today}`);
  if (!item) return null;
  const later = () => { localStorage.setItem(DISMISS_KEY, `${item.id}:${today}`); setDismissed(`${item.id}:${today}`); };
  return (
    <section className="msugere">
      <span className="msugere__icon"><SparkleIcon size={18} /></span>
      <div className="msugere__text">
        <p className="msugere__title">{item.title}</p>
        {item.body && <p className="msugere__body">{item.body}</p>}
      </div>
      <div className="msugere__actions">
        <button type="button" className="msugere__go" onClick={() => onOpen(targetFor(item))}>Resolver</button>
        <button type="button" className="msugere__later" onClick={later}>Depois</button>
      </div>
    </section>
  );
}

// mapeia tipo de notificação → módulo (fallback: inbox)
function targetFor(n: Notif): { key: string; title: string } {
  const t = n.type || '';
  if (t.includes('task')) return { key: 'tarefas-view', title: 'Tarefas' };
  if (t.includes('finance') || t.includes('budget')) return { key: 'financas', title: 'Finanças' };
  if (t.includes('habit')) return { key: 'habitos', title: 'Hábitos' };
  if (t.includes('calendar') || t.includes('event')) return { key: 'calendario', title: 'Calendário' };
  return { key: 'inbox', title: 'Inbox' };
}

function AgendaBlock({ onOpen }: { onOpen: Open }) {
  // endpoint: confirmar na implementação com grep em src/calendar/ e
  // backend /calendar (agregador calendar_agg). Usar o endpoint de eventos
  // do dia que o CalendarView usa; se só houver mês, filtrar client-side.
  const data = useFetchJson<{ events?: { id: string; title: string; start?: string; time?: string; category?: string }[] }>(
    `${API_BASE}/calendar/today`,
  );
  const events = (data?.events ?? []).slice(0, 4);
  if (!events.length) return null;
  return (
    <section className="mshell-card mhoje-agenda" onClick={() => onOpen({ key: 'calendario', title: 'Calendário' })}>
      <p className="mshell-eyebrow">Agenda</p>
      {events.map((e) => (
        <div key={e.id} className="mhoje-agenda__row">
          <span className="mhoje-agenda__time">{(e.time ?? e.start ?? '').slice(11, 16) || (e.time ?? '')}</span>
          <span className="mhoje-agenda__title">{e.title}</span>
        </div>
      ))}
    </section>
  );
}

function TarefasBlock({ onOpen }: { onOpen: Open }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  useEffect(() => {
    let ok = true;
    fetch(`${API_BASE}/tasks?limit=200`).then((r) => (r.ok ? r.json() : { tasks: [] }))
      .then((d) => { if (ok) setTasks((d.tasks ?? []).filter((t: Task) => t.status !== 'done').slice(0, 3)); })
      .catch(() => {});
    return () => { ok = false; };
  }, []);
  if (!tasks.length) return null;
  const complete = async (id: string) => {
    setTasks((ts) => ts.filter((t) => t.id !== id));
    try {
      await fetch(`${API_BASE}/tasks/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'done' }) });
    } catch { /* otimista; a view completa corrige */ }
  };
  return (
    <section className="mshell-card mhoje-tarefas">
      <p className="mshell-eyebrow" onClick={() => onOpen({ key: 'tarefas-view', title: 'Tarefas' })}>Tarefas</p>
      {tasks.map((t) => (
        <label key={t.id} className="mhoje-tarefas__row">
          <button type="button" className="mhoje-tarefas__check" aria-label="Concluir" onClick={() => complete(t.id)}>
            <CheckIcon size={13} />
          </button>
          <span>{t.title}</span>
        </label>
      ))}
    </section>
  );
}

function HabitosBlock({ onOpen }: { onOpen: Open }) {
  const [habits, setHabits] = useState<HabitWithStatus[] | null>(null);
  useEffect(() => { listHabits().then(setHabits).catch(() => setHabits(null)); }, []);
  if (!habits || !habits.length) return null;
  const done = habits.filter((h) => (h as { done_today?: boolean }).done_today).length;
  const pct = Math.round((done / habits.length) * 100);
  return (
    <section className="mshell-card mhoje-habitos" onClick={() => onOpen({ key: 'habitos', title: 'Hábitos' })}>
      <p className="mshell-eyebrow">Hábitos</p>
      <div className="mhoje-habitos__ring" style={{ background: `conic-gradient(var(--accent, #9a93ff) ${pct}%, rgba(255,255,255,.08) 0)` }}>
        <span>{done}/{habits.length}</span>
      </div>
    </section>
  );
}
// (campo done_today: confirmar o nome real em src/habits/types.ts — HabitWithStatus;
// ajustar o accessor se for `completed_today`/`status.done` etc.)

function OrcamentoBlock({ onOpen }: { onOpen: Open }) {
  const data = useFetchJson<{ entries?: { amount: number; kind?: string; type?: string; date?: string; ts?: string }[] }>(
    `${API_BASE}/finance/entries?status=confirmed&limit=100`,
  );
  const total = monthExpenses(data?.entries ?? [], new Date());
  if (!total) return null;
  return (
    <section className="mshell-card mhoje-orcamento" onClick={() => onOpen({ key: 'financas', title: 'Finanças' })}>
      <p className="mshell-eyebrow">Gasto do mês</p>
      <p className="mhoje-orcamento__value">R$ {total.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</p>
    </section>
  );
}
```

Em `PhoneShell.tsx`: `{tab === 'hoje' && <HojeScreen onOpen={setPushed} />}`.

CSS (append):

```css
/* ── hoje ── */
html[data-shell='phone'] .mhoje { display: flex; flex-direction: column; gap: 14px; }
html[data-shell='phone'] .mhoje__head { display: flex; align-items: center; gap: 12px; padding: 4px 0 2px; }
html[data-shell='phone'] .mhoje__hi { font-size: 22px; font-weight: 700; color: var(--text, #ececef); }
html[data-shell='phone'] .mhoje__sub { font-size: 13px; color: var(--text-dim, #9594a0); }
html[data-shell='phone'] .msugere {
  display: flex; gap: 12px; align-items: flex-start; padding: 14px; border-radius: 16px;
  background: linear-gradient(135deg, rgba(154,147,255,.14), rgba(154,147,255,.04));
  border: 1px solid rgba(154,147,255,.22);
}
html[data-shell='phone'] .msugere__icon { flex: none; width: 34px; height: 34px; border-radius: 10px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent-soft, rgba(154,147,255,.14)); color: var(--accent, #9a93ff); }
html[data-shell='phone'] .msugere__title { font-size: 14px; font-weight: 700; color: var(--text, #ececef); }
html[data-shell='phone'] .msugere__body { font-size: 12.5px; color: var(--text-dim, #9594a0); margin-top: 2px; }
html[data-shell='phone'] .msugere__actions { margin-left: auto; display: flex; flex-direction: column; gap: 6px; }
html[data-shell='phone'] .msugere__go { padding: 8px 14px; border-radius: 10px; border: none; background: var(--accent, #9a93ff); color: var(--accent-contrast, #14141a); font: inherit; font-size: 12.5px; font-weight: 700; cursor: pointer; min-height: 34px; }
html[data-shell='phone'] .msugere__later { background: none; border: none; color: var(--text-faint, #5f5e6b); font: inherit; font-size: 12px; cursor: pointer; min-height: 30px; }
html[data-shell='phone'] .mhoje__row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
html[data-shell='phone'] .mhoje-agenda__row { display: flex; gap: 10px; padding: 6px 0; font-size: 13.5px; color: var(--text, #ececef); }
html[data-shell='phone'] .mhoje-agenda__time { color: var(--accent, #9a93ff); font-weight: 700; min-width: 44px; }
html[data-shell='phone'] .mhoje-tarefas__row { display: flex; align-items: center; gap: 10px; padding: 7px 0; font-size: 13.5px; color: var(--text, #ececef); }
html[data-shell='phone'] .mhoje-tarefas__check { width: 22px; height: 22px; border-radius: 7px; border: 1.5px solid var(--border-strong, rgba(255,255,255,.12)); background: none; color: transparent; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
html[data-shell='phone'] .mhoje-tarefas__check:active { color: var(--accent, #9a93ff); border-color: var(--accent, #9a93ff); }
html[data-shell='phone'] .mhoje-habitos__ring { width: 64px; height: 64px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin: 8px auto 0; font-size: 13px; font-weight: 700; color: var(--text, #ececef); }
html[data-shell='phone'] .mhoje-habitos__ring span { background: var(--surface, #17171e); width: 48px; height: 48px; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
html[data-shell='phone'] .mhoje-orcamento__value { font-size: 20px; font-weight: 700; color: var(--text, #ececef); margin-top: 4px; }
```

- [ ] **Step 5:** vitest src/mobile → PASS (helpers + anteriores); tsc limpo; smoke manual da tela Hoje com backend rodando.
- [ ] **Step 6:** commit `feat(mobile): Hoje screen — greeting, sugere card, agenda, tasks+habits, budget`

---

## Task 5: `MaisScreen` + mapa de módulos empurrados

**Files:**
- Create: `src/mobile/MaisScreen.tsx`
- Modify: `src/mobile/PhoneShell.tsx` (tab mais + `renderModule` completo)
- Modify: `src/mobile/obsidian.css` (append seção mais)

**Interfaces:**
- Consumes: `Orb`; `getStats` de `src/courses/api`; `.tr-pill--xp/--streak` (globais do reskin Trilhas — verificar que aplicam fora da TrilhasView; senão replicar como `.mmais-pill`); views: `FinanceDashboard({onBack})`, `HabitsView({onBack})`, `JournalView({onBack})`, `UnifiedInboxView({onBack, onNavigate, onOpenEmail})` (handlers extras = no-op), `CalendarView({onNavigateToTask: () => {}})`, `MemoryView({onBack, ws: wsRef.current ?? undefined})`, `InsightsView({onBack})`, `NotesView({onBack})`, `TasksView({onBack})` (pro alvo 'tarefas-view' do SugereCard).
- Produces: `MaisScreen({ onOpen })`; `renderModule(key, onBack)` completo no PhoneShell.

- [ ] **Step 1: MaisScreen**

```tsx
// src/mobile/MaisScreen.tsx
import { useEffect, useState } from 'react';
import { Orb } from './Orb';
import { getStats, type Stats } from '../courses/api';
import {
  FinanceIcon, FlameIcon, ZapIcon, TasksIcon, InboxIcon, CalendarIcon,
  BrainIcon, InsightsIcon, NotesIcon, HeartIcon,
} from '../icons/Icons';

const MODULES: { key: string; title: string; icon: JSX.Element }[] = [
  { key: 'financas', title: 'Finanças', icon: <FinanceIcon size={20} /> },
  { key: 'habitos', title: 'Hábitos', icon: <HeartIcon size={20} /> },
  { key: 'diario', title: 'Diário', icon: <NotesIcon size={20} /> },
  { key: 'inbox', title: 'Inbox', icon: <InboxIcon size={20} /> },
  { key: 'calendario', title: 'Calendário', icon: <CalendarIcon size={20} /> },
  { key: 'memoria', title: 'Memória', icon: <BrainIcon size={20} /> },
  { key: 'insights', title: 'Insights', icon: <InsightsIcon size={20} /> },
  { key: 'notas', title: 'Notas', icon: <TasksIcon size={20} /> },
];

export function MaisScreen({ onOpen }: { onOpen: (p: { key: string; title: string }) => void }) {
  const [stats, setStats] = useState<Stats | null>(null);
  useEffect(() => { getStats().then(setStats).catch(() => {}); }, []);
  return (
    <div className="mmais">
      <header className="mmais__profile mshell-card">
        <Orb size={42} />
        <div className="mmais__stats">
          {stats && (
            <>
              <span className="mmais-pill mmais-pill--xp"><ZapIcon size={13} />{stats.xp_total} XP</span>
              <span className="mmais-pill mmais-pill--streak"><FlameIcon size={13} />{stats.streak_count} dias</span>
            </>
          )}
        </div>
      </header>
      <div className="mmais__grid">
        {MODULES.map((m) => (
          <button key={m.key} type="button" className="mmais__mod mshell-card"
            onClick={() => onOpen({ key: m.key, title: m.title })}>
            <span className="mmais__mod-icon">{m.icon}</span>
            <span className="mmais__mod-title">{m.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
```

(Ícones: usar os que EXISTEM em Icons.tsx — a lista acima foi verificada exceto `InsightsIcon`/`HeartIcon`/`NotesIcon` que constam do grep anterior; qualquer divergência → escolher o SVG mais próximo, nunca emoji.)

- [ ] **Step 2: `renderModule` completo no PhoneShell**

```tsx
// substituir o renderModule stub por (imports correspondentes no topo):
import { FinanceDashboard } from '../finance/FinanceDashboard';
import { HabitsView } from '../habits/HabitsView';
import { JournalView } from '../journal/JournalView';
import { UnifiedInboxView } from '../inbox/UnifiedInboxView';
import { CalendarView } from '../calendar/CalendarView';
import { MemoryView } from '../memory/MemoryView';
import { InsightsView } from '../insights/InsightsView';
import { NotesView } from '../notes/NotesView';
import { useAppRefs } from '../stores/RefsContext';

// dentro do componente (precisa do wsRef pro MemoryView):
function ModuleHost({ keyName, onBack }: { keyName: string; onBack: () => void }) {
  const { wsRef } = useAppRefs();
  switch (keyName) {
    case 'financas': return <FinanceDashboard onBack={onBack} />;
    case 'habitos': return <HabitsView onBack={onBack} />;
    case 'diario': return <JournalView onBack={onBack} />;
    case 'inbox': return <UnifiedInboxView onBack={onBack} onNavigate={() => {}} onOpenEmail={() => {}} />;
    case 'calendario': return <CalendarView onNavigateToTask={() => {}} />;
    case 'memoria': return <MemoryView onBack={onBack} ws={wsRef.current ?? undefined} />;
    case 'insights': return <InsightsView onBack={onBack} />;
    case 'notas': return <NotesView onBack={onBack} />;
    case 'tarefas-view': return <TasksView onBack={onBack} />;
    default: return <div className="mshell-pending">Em construção</div>;
  }
}
```

(As assinaturas acima foram verificadas por grep; se alguma view exigir prop a mais na leitura real, valor neutro/no-op. Se os exports/paths divergirem — ex. via `index.ts` — ajustar imports.)

E a tab: `{tab === 'mais' && <MaisScreen onOpen={setPushed} />}`; o `pushed` renderiza `<ModuleHost keyName={pushed.key} onBack={() => setPushed(null)} />`.

CSS (append):

```css
/* ── mais ── */
html[data-shell='phone'] .mmais { display: flex; flex-direction: column; gap: 14px; }
html[data-shell='phone'] .mmais__profile { display: flex; align-items: center; gap: 12px; }
html[data-shell='phone'] .mmais__stats { display: flex; gap: 8px; }
html[data-shell='phone'] .mmais-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; padding: 5px 11px; border-radius: 999px; }
html[data-shell='phone'] .mmais-pill--xp { color: #ffd54f; background: rgba(255,213,79,.1); border: 1px solid rgba(255,213,79,.2); }
html[data-shell='phone'] .mmais-pill--streak { color: #ff8a4c; background: rgba(255,138,76,.1); border: 1px solid rgba(255,138,76,.2); }
html[data-shell='phone'] .mmais__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
html[data-shell='phone'] .mmais__mod { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; min-height: 84px; cursor: pointer; font: inherit; color: var(--text, #ececef); }
html[data-shell='phone'] .mmais__mod-icon { width: 36px; height: 36px; border-radius: 11px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent-soft, rgba(154,147,255,.14)); color: var(--accent, #9a93ff); }
html[data-shell='phone'] .mmais__mod-title { font-size: 14px; font-weight: 700; }
```

- [ ] **Step 3:** tsc limpo; vitest verde; smoke: Mais → cada módulo abre empurrado com ‹ voltar.
- [ ] **Step 4:** commit `feat(mobile): Mais screen — profile stats + module grid with pushed views`

---

## Task 6: Verificação Fase 1

**Files:** nenhum.

- [ ] **Step 1:** `pnpm exec tsc --noEmit` → limpo; `pnpm exec vitest run src/mobile src/courses` → verde.
- [ ] **Step 2:** Zero emoji: `grep -rnP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/mobile/` → vazio.
- [ ] **Step 3:** Desktop intocado: `git diff main -- src/AppLayout.tsx src/stores src/chat src/tasks src/courses` → vazio (só `src/App.tsx` + `src/mobile/` novos). CSS mobile 100% sob `html[data-shell='phone']`: `grep -v "data-shell" src/mobile/obsidian.css | grep -E "^\.m(shell|tab|pushed|hoje|sugere|mais)" ` → só as classes agnósticas de layout (`.morb*`, `.mshell-card`, `.mshell-eyebrow`) podem aparecer fora do guard.
- [ ] **Step 4 (manual):** `pnpm dev` + devtools iPhone → shell/tab bar/Hoje/Mais; desktop → AppLayout normal. Ideal: `pnpm tauri ios dev` no simulador pra safe areas reais.

---

## Self-Review (cobertura do spec)

- Gate por `data-shell` + AppBootstrap nos 2 caminhos: Task 2. ✓
- Orb (gradiente/spec/glow/float/halo, 20-158px): Task 1. ✓
- Tab bar 5 posições, chat orb central elevado, safe areas, alvos ≥44px: Task 2. ✓
- Tabs interinas com views atuais (Tarefas/Trilhas na T2, Chat com ws na T3): ✓
- Hoje: saudação (sem sino), SugereCard (/notifications/queue + Resolver/Depois + dispensa local), Agenda, Tarefas+Hábitos, Orçamento — todos fail-soft: Task 4. ✓
- Mais: perfil XP/streak + grid 8 módulos → pushed: Task 5. ✓
- PushedScreen (‹, sem tab bar): Task 2 + uso T5. ✓
- Desktop intocado + CSS guarded + sem emoji: Global + Task 6. ✓
- Fora de escopo respeitado (sem badges/sino/voz/onboarding/widget): por omissão. ✓

## Notas de execução

- Shapes verificados por grep ANTES do plano: ChatViewProps (ws/status/talk), TasksView/TrilhasView/views do Mais, /notifications/queue, /tasks?limit. Pontos EXPLICITAMENTE a confirmar na implementação (anotados nos passos): endpoint de eventos do dia do /calendar, campo `done_today` de HabitWithStatus, shape de /finance/entries, ícones exatos disponíveis. São adaptações a padrões existentes, não placeholders.
- `model: "opus"` em todo subagent.
