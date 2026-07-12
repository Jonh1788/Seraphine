# Trilhas — Obsidian Reskin (handoff) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Aplicar o redesign Obsidian do handoff `apps/seraphine/frontend/handoff_trilhas/` às 7 telas das Trilhas (lista, mapa serpenteado, teoria, MCQ, match, cloze, resultado), mantendo API/grading intactos.

**Architecture:** Reskin + upgrades de UX pontuais nos componentes existentes de `src/courses/`: troca-se markup + `obsidian.css`; `api.ts` e `exercises/grading.ts` NÃO mudam. Três interações novas fiéis ao handoff: match vira duas colunas clique-pra-parear (substitui os selects), cloze vira banco de palavras toque-pra-preencher (substitui o input quando há `options`), MCQ ganha atalhos de teclado 1-4. Mapa vira caminho serpenteado com SVG.

**Tech Stack:** React + TypeScript (Tauri), CSS puro (tokens do design system), vitest.

## Global Constraints

- **Referência de design:** `apps/seraphine/frontend/handoff_trilhas/README.md` (spec textual, valores exatos) + `handoff_trilhas/Seraphine Trilhas.dc.html` (protótipo hi-fi, TUDO inline-styled — localizar cada frame pelo rótulo de texto, ex. `Trilhas · lista`, e ler os styles inline próximos para valores exatos).
- **Tokens (verbatim do README):** `--bg-0 #0d0d11 · --app #0f0f14 · --surface #17171e · --elev #1f1f27 · --text #ececef · --text-dim #9594a0 · --text-faint #5f5e6b · --accent #9a93ff · --accent-hi #cac5ff · --accent-dim #6c63d6 · --accent-soft rgba(154,147,255,.14) · --accent-contrast #14141a · --border rgba(255,255,255,.08) · --border-strong rgba(255,255,255,.12)`. Gamificação: XP dourado `#ffd54f` (fundo `rgba(255,213,79,.1)`), streak laranja `#ff8a4c`, sucesso `#4ade80` (sombra dura `#2c7a4b`), gerando/aviso `#ffa726`, erro `#ef6b6b`.
- **Assinatura "Duolingo":** sombra dura deslocada `box-shadow: 0 4px 0 <cor escura>` (accent→`#4b44a8`, verde→`#2c7a4b`, elev→`#101016`, dourado→`#b87e1e`) SÓ nos elementos de ação do fluxo de aprendizado.
- **SEM EMOJI** — o mock usa 🦀/🔥/emoji de curso; substituir SEMPRE por SVG de `src/icons/Icons.tsx`. Ícones já existentes: `FlameIcon, SparkleIcon, PlayIcon, CheckIcon, XIcon, BookmarkIcon, TrilhasIcon, BookIcon, ArrowLeftIcon`. Task 1 adiciona `ZapIcon, TrophyIcon, LockIcon`.
- **Lógica intocável:** `src/courses/api.ts` e `src/courses/exercises/grading.ts` não mudam; contrato dos exercícios permanece `({ exercise, onResult }: { exercise: Exercise; onResult: (correct: boolean) => void })`; `onResult` dispara **exatamente uma vez** por exercício; `type` continua corrigindo via `gradeType()` no servidor.
- **Deviações aprovadas do handoff** (dados que não existem no v1): sem badge "N XP nesta trilha" no mapa (não há XP por curso); painel lateral mostra "Conceito + exercícios" sem contagem (o mapa não carrega a lição); cloze é drag OU toque no mock — implementar só **toque** (YAGNI).
- Typecheck: `pnpm exec tsc --noEmit` limpo. Testes: `pnpm exec vitest run src/courses` (grading 5/5 continua verde).
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Modify:**
- `apps/seraphine/frontend/src/icons/Icons.tsx` — +3 ícones (Task 1)
- `apps/seraphine/frontend/src/courses/obsidian.css` — REESCRITO por completo (Task 1 base + cada task adiciona sua seção)
- `apps/seraphine/frontend/src/courses/TrilhasView.tsx` — Tasks 2 e 4 (onNext)
- `apps/seraphine/frontend/src/courses/CourseMap.tsx` — Task 3
- `apps/seraphine/frontend/src/courses/LessonPlayer.tsx` — Task 4
- `apps/seraphine/frontend/src/courses/exercises/ExerciseMCQ.tsx` — Task 5
- `apps/seraphine/frontend/src/courses/exercises/ExerciseType.tsx` — Task 5
- `apps/seraphine/frontend/src/courses/exercises/ExerciseMatch.tsx` — Task 6
- `apps/seraphine/frontend/src/courses/exercises/ExerciseCloze.tsx` — Task 6

**Não tocar:** `api.ts`, `exercises/grading.ts`, `exercises/__tests__/grading.test.ts`, `AppLayout.tsx`.

### Como extrair valores do protótipo (todas as tasks)

```bash
# localizar um frame pelo rótulo e ler ~4KB de markup inline-styled a partir dele
python3 - <<'PY'
html = open("apps/seraphine/frontend/handoff_trilhas/Seraphine Trilhas.dc.html").read()
i = html.find("Trilhas · lista")   # trocar pelo rótulo do frame da task
print(html[i:i+4000])
PY
```
Rótulos: `Trilhas · lista` · `Mapa da trilha · caminho de lições` · `Player · teoria da lição` · e os frames de exercício/resultado seguintes (procurar `MÚLTIPLA ESCOLHA`, `RELACIONAR`, `COMPLETE A FRASE`, `Lição concluída`).

---

## Task 1: Ícones novos + fundação CSS (tokens, botões, pills, banners, keyframes)

**Files:**
- Modify: `apps/seraphine/frontend/src/icons/Icons.tsx`
- Modify: `apps/seraphine/frontend/src/courses/obsidian.css` (reescrever)

**Interfaces:**
- Produces: `ZapIcon`, `TrophyIcon`, `LockIcon` (mesma assinatura dos existentes: `({ size = 20 }: { size?: number })` retornando SVG inline stroke `currentColor` — copiar o padrão de `FlameIcon`).
- Produces (CSS compartilhado, usado pelas Tasks 2-6): `.tr-btn` (botão ação accent com sombra dura `#4b44a8`, `:disabled` = `rgba(255,255,255,.08)` texto faint), `.tr-btn--green` (verde `#4ade80`/sombra `#2c7a4b`, texto `#14141a`), `.tr-btn--ghost`, `.tr-pill` (+ `--xp` dourado, `--streak` laranja, `--accent`), `.tr-progress`/`.tr-progress__bar` (+ `--green`, `--shimmer`), `.tr-eyebrow` (11/700 uppercase accent, letter-spacing .08em), `.tr-feedback` banner fixo de rodapé (+ `--ok` verde 10%/25%, `--no` `#ef6b6b`) com slide-up 200ms, keyframes `nodePulse` (ring accent expandindo 2.2s infinite), `statusBlink` (opacity 1→.3), `shimmer` (translateX de gradiente), `trSlideIn` (slide+fade 250ms `cubic-bezier(.16,1,.3,1)`).

- [ ] **Step 1: Adicionar os 3 ícones** em `Icons.tsx`, seguindo exatamente o padrão dos existentes (Lucide-style, `viewBox="0 0 24 24"`, `fill="none"`, `stroke="currentColor"`, `strokeWidth={2}`):

```tsx
export function ZapIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  );
}

export function TrophyIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" /><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
      <path d="M4 22h16" /><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" />
      <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" />
      <path d="M18 2H6v7a6 6 0 0 0 12 0V2Z" />
    </svg>
  );
}

export function LockIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
```

(Confirmar antes o padrão real de assinatura com `grep -n "export function FlameIcon" -A6 src/icons/Icons.tsx` e replicar exatamente — se os existentes usam outra prop shape, seguir os existentes.)

- [ ] **Step 2: Reescrever a fundação de `src/courses/obsidian.css`** — substituir o conteúdo atual pela base (as Tasks 2-6 vão APPENDANDO as seções de tela abaixo dela):

```css
/* ── Trilhas · Obsidian reskin ─────────────────────────────────────── */
/* Fundação: botões/pills/progresso/eyebrow/feedback + keyframes.       */
/* Assinatura Duolingo: sombra dura deslocada — SÓ em ações do fluxo.   */

.tr-btn {
  display: inline-flex; align-items: center; justify-content: center; gap: 8px;
  padding: 13px 22px; border: none; border-radius: 14px; cursor: pointer;
  font: inherit; font-size: 15px; font-weight: 700;
  background: var(--accent, #9a93ff); color: var(--accent-contrast, #14141a);
  box-shadow: 0 4px 0 #4b44a8; transition: transform .1s, box-shadow .1s;
}
.tr-btn:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 1px 0 #4b44a8; }
.tr-btn:disabled { background: rgba(255,255,255,.08); color: var(--text-faint, #5f5e6b); box-shadow: none; cursor: not-allowed; }
.tr-btn--green { background: #4ade80; color: #14141a; box-shadow: 0 4px 0 #2c7a4b; }
.tr-btn--green:active:not(:disabled) { box-shadow: 0 1px 0 #2c7a4b; }
.tr-btn--ghost { background: transparent; color: var(--text-dim, #9594a0); box-shadow: none; border: 1px solid var(--border-strong, rgba(255,255,255,.12)); }
.tr-btn--full { width: 100%; }

.tr-pill {
  display: inline-flex; align-items: center; gap: 6px;
  font-size: 12.5px; font-weight: 700; padding: 6px 12px; border-radius: 999px;
  background: rgba(255,255,255,.06); color: var(--text, #ececef);
  border: 1px solid var(--border, rgba(255,255,255,.08));
}
.tr-pill--xp { color: #ffd54f; background: rgba(255,213,79,.1); border-color: rgba(255,213,79,.2); }
.tr-pill--streak { color: #ff8a4c; background: rgba(255,138,76,.1); border-color: rgba(255,138,76,.2); }
.tr-pill--accent { color: var(--accent, #9a93ff); background: var(--accent-soft, rgba(154,147,255,.14)); border-color: rgba(154,147,255,.25); }

.tr-progress { height: 8px; border-radius: 4px; background: rgba(255,255,255,.08); overflow: hidden; }
.tr-progress__bar { height: 100%; border-radius: 4px; background: linear-gradient(90deg, var(--accent-dim, #6c63d6), var(--accent, #9a93ff)); transition: width .3s; }
.tr-progress__bar--green { background: #4ade80; }
.tr-progress__bar--shimmer {
  width: 40%; background: linear-gradient(90deg, transparent, var(--accent-soft, rgba(154,147,255,.14)), transparent);
  animation: trShimmer 1.4s infinite;
}

.tr-eyebrow { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--accent, #9a93ff); }

.tr-feedback {
  position: sticky; bottom: 0; margin-top: 16px; padding: 16px 18px; border-radius: 16px;
  display: flex; align-items: flex-start; gap: 12px;
  animation: trSlideUp .2s ease-out;
}
.tr-feedback--ok { background: rgba(74,222,128,.1); border: 1px solid rgba(74,222,128,.25); }
.tr-feedback--no { background: rgba(239,107,107,.1); border: 1px solid rgba(239,107,107,.25); }
.tr-feedback__dot { flex: none; width: 30px; height: 30px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #14141a; }
.tr-feedback--ok .tr-feedback__dot { background: #4ade80; }
.tr-feedback--no .tr-feedback__dot { background: #ef6b6b; }
.tr-feedback__title { font-weight: 700; font-size: 15px; }
.tr-feedback--ok .tr-feedback__title { color: #4ade80; }
.tr-feedback--no .tr-feedback__title { color: #ef6b6b; }
.tr-feedback__expl { font-size: 13.5px; color: var(--text-dim, #9594a0); margin-top: 4px; line-height: 1.5; }
.tr-feedback__actions { margin-left: auto; align-self: center; }

@keyframes trShimmer { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
@keyframes statusBlink { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }
@keyframes nodePulse {
  0% { box-shadow: 0 0 0 0 rgba(154,147,255,.45); }
  70% { box-shadow: 0 0 0 14px rgba(154,147,255,0); }
  100% { box-shadow: 0 0 0 0 rgba(154,147,255,0); }
}
@keyframes trSlideUp { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes trSlideIn { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: none; } }
```

> As classes `trilha-*` antigas serão removidas conforme cada tela migra (Tasks 2-6). Nesta task, manter as antigas AINDA no arquivo (abaixo da fundação) pra não quebrar as telas não migradas; cada task seguinte remove as que substituiu.

- [ ] **Step 3: Typecheck + testes**

Run: `pnpm exec tsc --noEmit` → limpo. `pnpm exec vitest run src/courses` → grading 5/5.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/icons/Icons.tsx apps/seraphine/frontend/src/courses/obsidian.css
git commit -m "feat(trilhas-ui): reskin foundation — Zap/Trophy/Lock icons + shared Obsidian primitives"
```

---

## Task 2: Tela 1 — Lista (`TrilhasView`, mode `list`)

**Files:**
- Modify: `apps/seraphine/frontend/src/courses/TrilhasView.tsx` (só o branch `list` + header)
- Modify: `apps/seraphine/frontend/src/courses/obsidian.css` (append seção `.tr-list*`; remover `.trilha-create/.trilha-list/.trilha-card/.trilha-empty/.trilha-stats` antigas)

**Interfaces:**
- Consumes: `.tr-pill--xp/--streak`, `.tr-btn`, `.tr-progress` (Task 1); `ZapIcon`, `FlameIcon`, `SparkleIcon`, `TrilhasIcon`, `CheckIcon` de `../icons/Icons`; estado/handlers existentes (`courses`, `stats`, `topic`, `creating`, `create`, `loadCourse`, poll de 4s — NÃO mudam).
- Produces: nada consumido por outras tasks (tela folha).

**Referência:** frame `Trilhas · lista` no dc.html + README Tela 1.

- [ ] **Step 1: Reescrever o branch `list` do JSX** (manter TODOS os hooks/handlers; só markup):

```tsx
  // list
  return (
    <div className="tr-view">
      <header className="tr-head">
        <button type="button" className="tr-back" onClick={onBack}>
          <ArrowLeftIcon size={18} /><span>Voltar</span>
        </button>
        <div className="tr-head__text">
          <h2 className="tr-head__title">Trilhas</h2>
          <p className="tr-head__sub">Aprenda qualquer coisa, uma lição por vez</p>
        </div>
        {stats && (
          <div className="tr-head__stats">
            <span className="tr-pill tr-pill--xp"><ZapIcon size={14} />{stats.xp_total.toLocaleString('pt-BR')} XP</span>
            <span className="tr-pill tr-pill--streak"><FlameIcon size={14} />{stats.streak_count} dias</span>
          </div>
        )}
      </header>

      <div className="tr-create">
        <span className="tr-create__icon"><SparkleIcon size={20} /></span>
        <input className="tr-create__input" value={topic} onChange={(e) => setTopic(e.target.value)}
          placeholder="Aprender sobre… (ex: Redes neurais)"
          onKeyDown={(e) => { if (e.key === 'Enter') create(); }} />
        <button type="button" className="tr-btn" disabled={creating || !topic.trim()} onClick={create}>
          {creating ? 'Criando…' : 'Criar trilha'}
        </button>
      </div>

      <ul className="tr-grid">
        {courses.map((c) => {
          const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
          const isDone = c.status === 'ready' && c.total > 0 && c.done === c.total;
          return (
            <li key={c.id}>
              <button type="button" className={`tr-card${isDone ? ' tr-card--done' : ''}`}
                disabled={c.status !== 'ready'} onClick={() => loadCourse(c.id)}>
                <span className="tr-card__icon"><TrilhasIcon size={20} /></span>
                <span className={`tr-card__status tr-card__status--${c.status === 'generating' ? 'gen' : isDone ? 'done' : 'active'}`}>
                  {c.status === 'generating' ? (<><span className="tr-card__blink" />gerando…</>)
                    : c.status === 'failed' ? 'falhou'
                    : isDone ? (<><CheckIcon size={12} />concluída</>) : 'em andamento'}
                </span>
                <span className="tr-card__title">{c.title || c.topic}</span>
                <span className="tr-card__meta">
                  {c.status === 'generating' ? 'A Seraphine está montando as lições' : `${c.done}/${c.total} lições`}
                </span>
                <span className="tr-progress">
                  {c.status === 'generating'
                    ? <span className="tr-progress__bar tr-progress__bar--shimmer" />
                    : <span className={`tr-progress__bar${pct === 100 ? ' tr-progress__bar--green' : ''}`} style={{ width: `${pct}%` }} />}
                </span>
              </button>
            </li>
          );
        })}
        {!courses.length && <li className="tr-empty">Crie sua primeira trilha.</li>}
      </ul>
    </div>
  );
```

- [ ] **Step 2: CSS da tela** (append em `obsidian.css`; extrair paddings/raios exatos do frame `Trilhas · lista`):

```css
/* ── Tela: lista ── */
.tr-view { display: flex; flex-direction: column; gap: 18px; padding: 20px 24px; height: 100%; overflow-y: auto; }
.tr-head { display: flex; align-items: center; gap: 16px; }
.tr-back { display: inline-flex; align-items: center; gap: 6px; background: none; border: none; color: var(--text-dim); cursor: pointer; font: inherit; font-size: 13px; }
.tr-head__title { font-size: 24px; font-weight: 700; letter-spacing: -0.01em; }
.tr-head__sub { font-size: 13px; color: var(--text-dim); margin-top: 2px; }
.tr-head__stats { margin-left: auto; display: inline-flex; gap: 8px; }
.tr-create {
  display: flex; align-items: center; gap: 12px; padding: 16px 18px; border-radius: 16px;
  background: linear-gradient(135deg, var(--accent-soft), transparent 60%);
  border: 1px solid rgba(154,147,255,.25);
}
.tr-create__icon { flex: none; width: 40px; height: 40px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); }
.tr-create__input { flex: 1; padding: 11px 14px; border-radius: 12px; border: 1px solid var(--border-strong); background: var(--surface, #17171e); color: var(--text); font: inherit; font-size: 14px; }
.tr-grid { list-style: none; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.tr-card {
  position: relative; width: 100%; display: flex; flex-direction: column; align-items: flex-start; gap: 8px; text-align: left;
  padding: 18px; border-radius: 18px; border: 1px solid var(--border); background: var(--surface, #17171e);
  color: var(--text); cursor: pointer; font: inherit;
}
.tr-card:disabled { cursor: default; }
.tr-card--done { opacity: .65; }
.tr-card__icon { width: 42px; height: 42px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); }
.tr-card__status { position: absolute; top: 14px; right: 14px; display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 999px; }
.tr-card__status--active { color: var(--accent); background: var(--accent-soft); }
.tr-card__status--gen { color: #ffa726; background: rgba(255,167,38,.12); }
.tr-card__status--done { color: #4ade80; background: rgba(74,222,128,.12); }
.tr-card__blink { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: statusBlink 1.2s infinite; }
.tr-card__title { font-size: 17px; font-weight: 700; }
.tr-card__meta { font-size: 12.5px; color: var(--text-dim); }
.tr-card .tr-progress { width: 100%; margin-top: 4px; }
.tr-empty { grid-column: 1 / -1; color: var(--text-dim); text-align: center; padding: 32px; }
```

Remover do arquivo as classes antigas substituídas (`.trilha-view__header`, `.trilha-stats`, `.trilha-create`, `.trilha-list`, `.trilha-card*`, `.trilha-empty`) — o mapa/player antigos ainda usam `.trilha-back`? Se sim, migrar o import de classe usado pelos modos `map`/`lesson` pro `.tr-back`/`.tr-view` mínimos SEM redesenhar essas telas (elas mudam nas Tasks 3-4).

- [ ] **Step 3: Verificar** — `pnpm exec tsc --noEmit` limpo; app builda; sem emoji (`grep -nP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/courses/TrilhasView.tsx` vazio).

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/courses/TrilhasView.tsx apps/seraphine/frontend/src/courses/obsidian.css
git commit -m "feat(trilhas-ui): list screen — stats pills, create card, 2-col course grid"
```

---

## Task 3: Tela 2 — Mapa serpenteado (`CourseMap`) + painel lateral

**Files:**
- Modify: `apps/seraphine/frontend/src/courses/CourseMap.tsx` (reescrever)
- Modify: `apps/seraphine/frontend/src/courses/obsidian.css` (append `.tr-map*`; remover `.trilha-map*/.trilha-nodes/.trilha-node*` antigas)

**Interfaces:**
- Consumes: assinatura existente `CourseMap({ course, onOpenLesson }: { course: Course; onOpenLesson: (lessonId: string) => void })` — NÃO muda (TrilhasView continua chamando igual). `PlayIcon, CheckIcon, LockIcon, TrophyIcon, TrilhasIcon` + `.tr-progress`, `.tr-btn`, keyframe `nodePulse` (Task 1).
- Produces: nada novo pra outras tasks.

**Referência:** frame `Mapa da trilha · caminho de lições` + README Tela 2. **Deviações aprovadas:** sem badge de XP por trilha; painel "PRÓXIMA LIÇÃO" sem contagem de exercícios ("Conceito + exercícios").

- [ ] **Step 1: Reescrever `CourseMap.tsx`** — caminho serpenteado com SVG gerado por posição dos nós (lanes determinísticas), nós em 4 estados, painel lateral:

```tsx
import type { Course, LessonNode } from './api';
import { PlayIcon, CheckIcon, LockIcon, TrophyIcon, TrilhasIcon } from '../icons/Icons';

const LANE_X = [0, 90, 0, -90]; // zigue-zague determinístico (px do centro)
const STEP_Y = 110;             // distância vertical entre nós
const TOP = 40;

function nodeX(i: number) { return 260 + LANE_X[i % 4]; } // coluna de 520px → centro 260
function nodeY(i: number) { return TOP + i * STEP_Y; }

function pathD(from: number, to: number) {
  // curva suave entre nós consecutivos [from..to]
  let d = `M ${nodeX(from)} ${nodeY(from)}`;
  for (let i = from + 1; i <= to; i++) {
    const x0 = nodeX(i - 1), y0 = nodeY(i - 1), x1 = nodeX(i), y1 = nodeY(i);
    const my = (y0 + y1) / 2;
    d += ` C ${x0} ${my}, ${x1} ${my}, ${x1} ${y1}`;
  }
  return d;
}

export function CourseMap({ course, onOpenLesson }:
  { course: Course; onOpenLesson: (lessonId: string) => void }) {
  const lessons = course.lessons;
  const doneCount = lessons.filter((l) => l.lock === 'done').length;
  const next = lessons.find((l) => l.lock === 'unlocked');
  const total = lessons.length + 1; // +1 = nó-troféu final
  const height = TOP + total * STEP_Y;
  // trecho percorrido = até o último done contíguo (ou até o nó next)
  const solidUntil = Math.max(doneCount, 0);

  return (
    <div className="tr-map">
      <div className="tr-map__main">
        <header className="tr-map__head">
          <span className="tr-map__icon"><TrilhasIcon size={22} /></span>
          <div>
            <h2 className="tr-map__title">{course.title || course.topic}</h2>
            <p className="tr-map__sub">{doneCount} de {lessons.length} lições{next ? ' · continue de onde parou' : ''}</p>
          </div>
        </header>
        <div className="tr-progress tr-map__progress">
          <span className="tr-progress__bar" style={{ width: `${lessons.length ? (doneCount / lessons.length) * 100 : 0}%` }} />
        </div>

        <div className="tr-map__path" style={{ height }}>
          <svg className="tr-map__svg" width="520" height={height} aria-hidden="true">
            {solidUntil > 0 && (
              <path d={pathD(0, Math.min(solidUntil, total - 1))} fill="none"
                stroke="var(--accent)" strokeWidth="4" strokeLinecap="round" />
            )}
            <path d={pathD(Math.min(solidUntil, total - 1), total - 1)} fill="none"
              stroke="rgba(154,147,255,.35)" strokeWidth="4" strokeLinecap="round" strokeDasharray="1 9" />
          </svg>
          {lessons.map((l, i) => <MapNode key={l.id} lesson={l} i={i} onOpen={onOpenLesson} />)}
          {/* nó final: troféu */}
          <div className="tr-node tr-node--end" style={{ left: nodeX(lessons.length), top: nodeY(lessons.length) }}>
            <span className="tr-node__circle tr-node__circle--end"><TrophyIcon size={24} /></span>
            <span className="tr-node__label tr-node__label--faint">Fim da trilha</span>
          </div>
        </div>
      </div>

      <aside className="tr-map__side">
        {next && (
          <div className="tr-side-card">
            <span className="tr-eyebrow">Próxima lição</span>
            <p className="tr-side-card__title">{next.title}</p>
            <p className="tr-side-card__meta">Conceito + exercícios</p>
            <button type="button" className="tr-btn tr-btn--full" onClick={() => onOpenLesson(next.id)}>Continuar</button>
          </div>
        )}
        <div className="tr-side-card tr-side-card--muted">
          <p className="tr-side-card__meta">Ao concluir uma lição, os conceitos viram <strong>flashcards</strong> automaticamente pra revisão.</p>
        </div>
      </aside>
    </div>
  );
}

function MapNode({ lesson, i, onOpen }: { lesson: LessonNode; i: number; onOpen: (id: string) => void }) {
  const { lock } = lesson;
  return (
    <div className="tr-node" style={{ left: nodeX(i), top: nodeY(i) }}>
      {lock === 'unlocked' && <span className="tr-node__tooltip">COMEÇAR</span>}
      <button type="button" disabled={lock === 'locked'}
        className={`tr-node__circle tr-node__circle--${lock}`}
        onClick={() => onOpen(lesson.id)} aria-label={lesson.title}>
        {lock === 'done' ? <CheckIcon size={22} /> : lock === 'unlocked' ? <PlayIcon size={24} /> : <LockIcon size={20} />}
      </button>
      <span className={`tr-node__label${lock === 'locked' ? ' tr-node__label--faint' : ''}`}>{lesson.title}</span>
    </div>
  );
}
```

- [ ] **Step 2: CSS do mapa** (append; valores finos do frame do dc.html):

```css
/* ── Tela: mapa ── */
.tr-map { display: flex; gap: 28px; align-items: flex-start; }
.tr-map__main { flex: 1; min-width: 0; }
.tr-map__head { display: flex; align-items: center; gap: 14px; }
.tr-map__icon { width: 46px; height: 46px; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; background: var(--accent-soft); color: var(--accent); }
.tr-map__title { font-size: 20px; font-weight: 700; }
.tr-map__sub { font-size: 13px; color: var(--text-dim); margin-top: 2px; }
.tr-map__progress { margin: 14px 0 8px; }
.tr-map__path { position: relative; width: 520px; margin: 12px auto 0; }
.tr-map__svg { position: absolute; inset: 0; }
.tr-node { position: absolute; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; width: 130px; margin-top: -29px; }
.tr-node__circle {
  width: 58px; height: 58px; border-radius: 50%; border: none; cursor: pointer;
  display: inline-flex; align-items: center; justify-content: center; font: inherit;
}
.tr-node__circle--done { background: linear-gradient(135deg, #8bc34a, #4ade80); color: #14141a; box-shadow: 0 5px 0 #2c7a4b; }
.tr-node__circle--unlocked {
  width: 66px; height: 66px; background: linear-gradient(135deg, var(--accent-hi), var(--accent-dim));
  color: #14141a; box-shadow: 0 6px 0 #4b44a8; animation: nodePulse 2.2s infinite;
}
.tr-node__circle--locked { background: var(--elev, #1f1f27); border: 1px solid var(--border-strong); color: var(--text-faint); box-shadow: 0 4px 0 #101016; cursor: default; }
.tr-node__circle--end { background: transparent; border: 2px dashed rgba(255,213,79,.5); color: #ffd54f; box-shadow: none; cursor: default; }
.tr-node__label { font-size: 11px; font-weight: 600; color: var(--text-dim); text-align: center; }
.tr-node__label--faint { color: var(--text-faint); }
.tr-node__tooltip {
  position: absolute; top: -30px; font-size: 10px; font-weight: 800; letter-spacing: .08em;
  padding: 4px 10px; border-radius: 999px; background: var(--accent); color: #14141a;
}
.tr-map__side { flex: none; width: 250px; display: flex; flex-direction: column; gap: 12px; position: sticky; top: 12px; }
.tr-side-card { padding: 16px; border-radius: 16px; background: var(--surface, #17171e); border: 1px solid var(--border); display: flex; flex-direction: column; gap: 8px; }
.tr-side-card--muted { background: transparent; }
.tr-side-card__title { font-size: 15px; font-weight: 700; }
.tr-side-card__meta { font-size: 12.5px; color: var(--text-dim); line-height: 1.5; }
```

Remover as classes antigas `.trilha-map*`, `.trilha-nodes`, `.trilha-node*`.

- [ ] **Step 3: Verificar** — `pnpm exec tsc --noEmit`; render mental do lock chain: done=verde ✓, próxima=pulso+COMEÇAR, locked=cadeado disabled, fim=troféu tracejado; SVG sólido cobre o trecho done.

- [ ] **Step 4: Commit**

```bash
git add apps/seraphine/frontend/src/courses/CourseMap.tsx apps/seraphine/frontend/src/courses/obsidian.css
git commit -m "feat(trilhas-ui): serpentine course map + side panel"
```

---

## Task 4: Telas 3+7 — Player frame, teoria e resultado (`LessonPlayer`) + onNext

**Files:**
- Modify: `apps/seraphine/frontend/src/courses/LessonPlayer.tsx` (reescrever markup; manter máquina/estado)
- Modify: `apps/seraphine/frontend/src/courses/TrilhasView.tsx` (passar `onNext`)
- Modify: `apps/seraphine/frontend/src/courses/obsidian.css` (append `.tr-player*`/`.tr-result*`; remover `.trilha-player/.trilha-concept/.trilha-feedback/.trilha-result*` antigas)

**Interfaces:**
- Consumes: `.tr-btn/.tr-eyebrow/.tr-progress/.tr-feedback/.tr-pill` (Task 1); `XIcon, BookmarkIcon, SparkleIcon, TrophyIcon, ZapIcon, FlameIcon, FlashcardIcon, CheckIcon` de Icons.
- Produces: `LessonPlayer({ lessonId, onDone, onNext }: { lessonId: string; onDone: () => void; onNext?: () => void })` — **novo prop opcional `onNext`**; comportamento intacto quando ausente. Contrato com exercícios INTACTO (`key={ex.id}` wrapper preservado; `onResult` uma vez; feedback banner é do player).

**Referência:** frames `Player · teoria da lição` e o de resultado (`Lição concluída`) + README Telas 3 e 7.

- [ ] **Step 1: Reescrever `LessonPlayer.tsx`** — manter TODA a máquina (`loading/error/teach/exercise/result`, `idx`, `correct` com functional updater, `answered`, `completeLesson` uma vez, wrapper `key={ex.id}`), trocando markup:

```tsx
import { useEffect, useState } from 'react';
import { getLesson, completeLesson, type Lesson, type CompleteResult } from './api';
import { ExerciseMCQ } from './exercises/ExerciseMCQ';
import { ExerciseCloze } from './exercises/ExerciseCloze';
import { ExerciseType } from './exercises/ExerciseType';
import { ExerciseMatch } from './exercises/ExerciseMatch';
import { XIcon, BookmarkIcon, SparkleIcon, TrophyIcon, ZapIcon, FlameIcon, FlashcardIcon, CheckIcon } from '../icons/Icons';

type Screen = 'loading' | 'error' | 'teach' | 'exercise' | 'result';

const EYEBROW: Record<string, string> = {
  mcq: 'Múltipla escolha', cloze: 'Complete a frase', type: 'Digite a resposta', match: 'Relacionar',
};

export function LessonPlayer({ lessonId, onDone, onNext }:
  { lessonId: string; onDone: () => void; onNext?: () => void }) {
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [screen, setScreen] = useState<Screen>('loading');
  const [idx, setIdx] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [answered, setAnswered] = useState(false);
  const [lastCorrect, setLastCorrect] = useState(false);
  const [result, setResult] = useState<CompleteResult | null>(null);

  useEffect(() => {
    let ok = true;
    getLesson(lessonId)
      .then((l) => { if (ok) { setLesson(l); setScreen('teach'); } })
      .catch(() => { if (ok) setScreen('error'); });
    return () => { ok = false; };
  }, [lessonId]);

  if (screen === 'loading') return <div className="tr-player">Carregando…</div>;
  if (screen === 'error' || !lesson) return (
    <div className="tr-player">
      <p>Não deu pra abrir a lição.</p>
      <button type="button" className="tr-btn" onClick={onDone}>Voltar</button>
    </div>
  );

  const total = lesson.exercises.length;
  const frameProgress = screen === 'teach' ? 0 : screen === 'result' ? 100 : (idx / Math.max(total, 1)) * 100;

  const frame = (
    <div className="tr-player__top">
      <button type="button" className="tr-player__x" onClick={onDone} aria-label="Sair"><XIcon size={18} /></button>
      <div className="tr-progress tr-player__progress">
        <span className="tr-progress__bar" style={{ width: `${frameProgress}%` }} />
      </div>
      {screen === 'teach' && (
        <span className="tr-pill tr-pill--accent"><BookmarkIcon size={13} />Teoria</span>
      )}
      {screen === 'exercise' && <span className="tr-player__count">{idx + 1}/{total}</span>}
    </div>
  );

  if (screen === 'teach') {
    const hasEx = total > 0;
    return (
      <div className="tr-player">
        {frame}
        <p className="tr-eyebrow">Lição {/* order não vem na lição; usar título da trilha se quiser */}· {lesson.title}</p>
        <h2 className="tr-player__title">{lesson.title}</h2>
        <div className="tr-concept">{lesson.concept_md}</div>
        <div className="tr-tip">
          <span className="tr-tip__icon"><SparkleIcon size={16} /></span>
          <p>Dica da Seraphine: leia o exemplo com calma — os exercícios usam exatamente esses conceitos.</p>
        </div>
        <button type="button" className="tr-btn tr-btn--full" onClick={() => setScreen(hasEx ? 'exercise' : 'result')}>
          {hasEx ? 'Começar exercícios' : 'Concluir'}
        </button>
      </div>
    );
  }

  if (screen === 'result') {
    return <ResultScreen lessonId={lessonId} lessonTitle={lesson.title} correct={correct} total={total}
      result={result} setResult={setResult} onDone={onDone} onNext={onNext} />;
  }

  const ex = lesson.exercises[idx];
  const onResult = (c: boolean) => { setAnswered(true); setLastCorrect(c); if (c) setCorrect((n) => n + 1); };
  const next = () => {
    setAnswered(false);
    if (idx + 1 < total) setIdx(idx + 1);
    else setScreen('result');
  };
  return (
    <div className="tr-player">
      {frame}
      <div key={ex.id} className="tr-ex-slot">
        <p className="tr-eyebrow">{EYEBROW[ex.type] ?? 'Exercício'}</p>
        {ex.type === 'mcq' && <ExerciseMCQ exercise={ex} onResult={onResult} />}
        {ex.type === 'cloze' && <ExerciseCloze exercise={ex} onResult={onResult} />}
        {ex.type === 'type' && <ExerciseType exercise={ex} onResult={onResult} />}
        {ex.type === 'match' && <ExerciseMatch exercise={ex} onResult={onResult} />}
      </div>
      {answered && (
        <div className={`tr-feedback tr-feedback--${lastCorrect ? 'ok' : 'no'}`}>
          <span className="tr-feedback__dot"><CheckIcon size={16} /></span>
          <div>
            <p className="tr-feedback__title">{lastCorrect ? 'Certo!' : 'Quase…'}</p>
            {ex.explanation && <p className="tr-feedback__expl">{ex.explanation}</p>}
          </div>
          <div className="tr-feedback__actions">
            <button type="button" className={`tr-btn${lastCorrect ? ' tr-btn--green' : ''}`} onClick={next}>Continuar</button>
          </div>
        </div>
      )}
    </div>
  );
}

function ResultScreen({ lessonId, lessonTitle, correct, total, result, setResult, onDone, onNext }: {
  lessonId: string; lessonTitle: string; correct: number; total: number;
  result: CompleteResult | null; setResult: (r: CompleteResult) => void;
  onDone: () => void; onNext?: () => void;
}) {
  const [saving, setSaving] = useState(true);
  useEffect(() => {
    let ok = true;
    completeLesson(lessonId, correct)
      .then((r) => { if (ok) { setResult(r); setSaving(false); } })
      .catch(() => { if (ok) setSaving(false); });
  }, [lessonId, correct, setResult]);
  return (
    <div className="tr-player tr-result">
      <span className="tr-result__trophy"><TrophyIcon size={48} /></span>
      <h2 className="tr-player__title">Lição concluída!</h2>
      <p className="tr-result__sub">{lessonTitle} · {correct}/{total} certos</p>
      {saving ? <p className="tr-result__saving">Salvando…</p> : result && (
        <div className="tr-result__stats">
          <div className="tr-stat tr-stat--xp"><ZapIcon size={18} /><strong>+{result.xp_gained}</strong><span>XP</span></div>
          <div className="tr-stat tr-stat--streak"><FlameIcon size={18} /><strong>{result.streak_count}</strong><span>dias</span></div>
          {result.seeded_cards > 0 && (
            <div className="tr-stat tr-stat--cards"><FlashcardIcon size={18} /><strong>{result.seeded_cards}</strong><span>p/ revisão</span></div>
          )}
        </div>
      )}
      <div className="tr-result__actions">
        <button type="button" className="tr-btn tr-btn--ghost" onClick={onDone}>Voltar à trilha</button>
        {onNext && <button type="button" className="tr-btn" onClick={onNext}>Próxima lição</button>}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `TrilhasView.tsx` — passar `onNext`** no branch `lesson`:

```tsx
  if (mode.kind === 'lesson') {
    return (
      <div className="tr-view">
        <LessonPlayer lessonId={mode.lessonId}
          onDone={() => loadCourse(mode.courseId)}
          onNext={async () => {
            const c = await getCourse(mode.courseId);
            setCourse(c);
            const nxt = c.lessons.find((l) => l.lock === 'unlocked');
            if (nxt) setMode({ kind: 'lesson', courseId: mode.courseId, lessonId: nxt.id });
            else setMode({ kind: 'map', courseId: mode.courseId });
          }} />
      </div>
    );
  }
```

- [ ] **Step 3: CSS do player/resultado** (append; código do bloco `concept_md`: manter `white-space: pre-wrap` — o markdown não é renderizado no v1, é texto; NÃO introduzir lib de markdown nesta task):

```css
/* ── Tela: player (frame, teoria, resultado) ── */
.tr-player { display: flex; flex-direction: column; gap: 16px; max-width: 720px; margin: 0 auto; padding: 8px 0 24px; animation: trSlideIn .25s cubic-bezier(.16,1,.3,1); }
.tr-player__top { display: flex; align-items: center; gap: 14px; }
.tr-player__x { flex: none; background: none; border: none; color: var(--text-dim); cursor: pointer; padding: 6px; }
.tr-player__progress { flex: 1; }
.tr-player__count { font-size: 12px; font-weight: 700; color: var(--text-dim); }
.tr-player__title { font-size: 26px; font-weight: 700; letter-spacing: -0.01em; }
.tr-concept { white-space: pre-wrap; font-size: 15px; line-height: 1.75; color: var(--text); }
.tr-tip { display: flex; gap: 10px; align-items: flex-start; padding: 14px; border-radius: 14px; background: var(--accent-soft); border: 1px solid rgba(154,147,255,.25); font-size: 13.5px; line-height: 1.5; color: var(--text-dim); }
.tr-tip__icon { flex: none; color: var(--accent); }
.tr-ex-slot { display: flex; flex-direction: column; gap: 12px; animation: trSlideIn .25s cubic-bezier(.16,1,.3,1); }
.tr-result { align-items: center; text-align: center; gap: 12px; padding-top: 36px; }
.tr-result__trophy {
  width: 104px; height: 104px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
  background: linear-gradient(135deg, #ffd54f, #ffa726); color: #14141a; box-shadow: 0 6px 0 #b87e1e;
}
.tr-result__sub { color: var(--text-dim); font-size: 14px; }
.tr-result__saving { color: var(--text-faint); font-size: 13px; }
.tr-result__stats { display: flex; gap: 12px; margin-top: 8px; }
.tr-stat { display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 14px 20px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border); font-size: 12px; color: var(--text-dim); }
.tr-stat strong { font-size: 18px; color: var(--text); }
.tr-stat--xp { color: #ffd54f; } .tr-stat--xp strong { color: #ffd54f; }
.tr-stat--streak { color: #ff8a4c; } .tr-stat--streak strong { color: #ff8a4c; }
.tr-stat--cards { color: var(--accent); } .tr-stat--cards strong { color: var(--accent); }
.tr-result__actions { display: flex; gap: 12px; margin-top: 16px; }
```

Remover as classes antigas `.trilha-player*`, `.trilha-concept`, `.trilha-feedback*`, `.trilha-result*`, `.trilha-badge`.

- [ ] **Step 4: Verificar** — `pnpm exec tsc --noEmit` limpo; invariantes: `completeLesson` 1×, `key={ex.id}` presente, `onResult` funcional-updater, zero emoji.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/courses/LessonPlayer.tsx apps/seraphine/frontend/src/courses/TrilhasView.tsx apps/seraphine/frontend/src/courses/obsidian.css
git commit -m "feat(trilhas-ui): player frame + teach + result screens, onNext navigation"
```

---

## Task 5: Tela 4 — MCQ com atalhos 1-4 + Type reskin

**Files:**
- Modify: `apps/seraphine/frontend/src/courses/exercises/ExerciseMCQ.tsx`
- Modify: `apps/seraphine/frontend/src/courses/exercises/ExerciseType.tsx`
- Modify: `apps/seraphine/frontend/src/courses/obsidian.css` (append `.tr-opt*`/`.tr-type*`; remover `.trilha-opt*`, `.trilha-input`, `.trilha-check`, `.trilha-ex*` antigas que estas telas usavam)

**Interfaces:**
- Consumes: contrato `({ exercise, onResult })` intacto; `checkMCQ` de `./grading`; `gradeType` de `../api`; `.tr-btn` (Task 1).
- Produces: nada novo (o eyebrow/prompt-frame vem do LessonPlayer, Task 4 — os componentes renderizam só prompt + interação).

- [ ] **Step 1: `ExerciseMCQ.tsx`** — cards numerados + teclado 1-4 (uma resposta só; listener removido após responder):

```tsx
import { useEffect, useState } from 'react';
import type { Exercise } from '../api';
import { checkMCQ } from './grading';

export function ExerciseMCQ({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [chosen, setChosen] = useState<number | null>(null);
  const options = exercise.payload.options ?? [];
  const answered = chosen !== null;

  const pick = (i: number) => {
    if (answered || i < 0 || i >= options.length) return;
    setChosen(i);
    onResult(checkMCQ(exercise.payload.answer_idx, i));
  };

  useEffect(() => {
    if (answered) return;
    const onKey = (e: KeyboardEvent) => {
      const n = Number(e.key);
      if (n >= 1 && n <= options.length) pick(n - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answered, options.length]);

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      <div className="tr-opts">
        {options.map((opt, i) => {
          const state = !answered ? '' :
            i === exercise.payload.answer_idx ? 'correct' :
            i === chosen ? 'wrong' : '';
          return (
            <button key={i} type="button" disabled={answered}
              className={`tr-opt${state ? ` tr-opt--${state}` : ''}${chosen === i ? ' tr-opt--chosen' : ''}`}
              onClick={() => pick(i)}>
              <span className="tr-opt__num">{i + 1}</span>
              <span>{opt}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `ExerciseType.tsx`** — mesma moldura, input grande (lógica intacta: `gradeType`, estados idle/checking/done, catch → onResult(false)):

```tsx
import { useState } from 'react';
import type { Exercise } from '../api';
import { gradeType } from '../api';

export function ExerciseType({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [value, setValue] = useState('');
  const [state, setState] = useState<'idle' | 'checking' | 'done'>('idle');
  const [feedback, setFeedback] = useState('');
  const submit = async () => {
    if (state !== 'idle' || !value.trim()) return;
    setState('checking');
    try {
      const r = await gradeType(exercise.id, value);
      setFeedback(r.feedback);
      setState('done');
      onResult(r.correct);
    } catch {
      setFeedback('Não deu pra corrigir agora.');
      setState('done');
      onResult(false);
    }
  };
  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <input className="tr-type__input" value={value} disabled={state !== 'idle'}
          onChange={(e) => setValue(e.target.value)} placeholder="Sua resposta…" autoFocus />
        {state === 'idle' && (
          <button type="submit" className="tr-btn tr-btn--full tr-type__submit" disabled={!value.trim()}>Verificar</button>
        )}
      </form>
      {state === 'checking' && <p className="tr-ex__hint">Verificando…</p>}
      {state === 'done' && <p className="tr-ex__hint">{feedback}</p>}
    </div>
  );
}
```

- [ ] **Step 3: CSS** (append):

```css
/* ── Exercícios: moldura, MCQ, type ── */
.tr-ex { display: flex; flex-direction: column; gap: 14px; }
.tr-ex__prompt { font-size: 21px; font-weight: 700; letter-spacing: -0.01em; }
.tr-ex__hint { font-size: 13.5px; color: var(--text-dim); }
.tr-opts { display: flex; flex-direction: column; gap: 10px; }
.tr-opt {
  display: flex; align-items: center; gap: 14px; width: 100%; text-align: left;
  padding: 15px 18px; border-radius: 14px; font: inherit; font-size: 15px; cursor: pointer;
  background: var(--surface, #17171e); border: 1px solid var(--border-strong); color: var(--text);
}
.tr-opt:disabled { cursor: default; }
.tr-opt__num {
  flex: none; width: 26px; height: 26px; border-radius: 8px; display: inline-flex; align-items: center; justify-content: center;
  font-size: 12.5px; font-weight: 700; background: rgba(255,255,255,.06); color: var(--text-dim);
  border: 1px solid var(--border);
}
.tr-opt--chosen { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 3px rgba(154,147,255,.12); }
.tr-opt--chosen .tr-opt__num { background: var(--accent); color: #14141a; border-color: transparent; }
.tr-opt--correct { border-color: rgba(74,222,128,.5); background: rgba(74,222,128,.08); }
.tr-opt--wrong { border-color: rgba(239,107,107,.5); background: rgba(239,107,107,.08); }
.tr-type__input {
  width: 100%; padding: 16px 18px; border-radius: 14px; font: inherit; font-size: 16px;
  background: var(--surface); border: 1px solid var(--border-strong); color: var(--text);
}
.tr-type__input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px rgba(154,147,255,.12); }
.tr-type__submit { margin-top: 12px; }
```

- [ ] **Step 4: Verificar** — `pnpm exec tsc --noEmit`; `pnpm exec vitest run src/courses` (grading intacto); invariantes: onResult 1× (teclado não dispara após answered), disabled após resposta.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/courses/exercises/ExerciseMCQ.tsx apps/seraphine/frontend/src/courses/exercises/ExerciseType.tsx apps/seraphine/frontend/src/courses/obsidian.css
git commit -m "feat(trilhas-ui): MCQ numbered cards + 1-4 keyboard, type big input"
```

---

## Task 6: Telas 5+6 — Match clique-pra-parear + Cloze banco de palavras

**Files:**
- Modify: `apps/seraphine/frontend/src/courses/exercises/ExerciseMatch.tsx` (reescrever)
- Modify: `apps/seraphine/frontend/src/courses/exercises/ExerciseCloze.tsx` (reescrever)
- Modify: `apps/seraphine/frontend/src/courses/obsidian.css` (append `.tr-match*`/`.tr-cloze*`; remover `.trilha-match*`, `.trilha-cloze`, `.trilha-steps/.trilha-step*` antigas)

**Interfaces:**
- Consumes: contrato `({ exercise, onResult })`; `checkCloze`, `checkSteps` de `./grading` (`checkMatchPairs` deixa de ser usado pelo componente mas PERMANECE em grading.ts — não tocar em grading).
- Produces: nada novo. **Política de acerto (decisão):** match/steps completam sempre; `onResult(true)` só se **zero erros** no caminho (par errado ou "Verificar" de ordem errada conta erro). Cloze mantém verificação única via `checkCloze`.

**Referência:** frames `RELACIONAR` e `COMPLETE A FRASE` + README Telas 5-6.

- [ ] **Step 1: `ExerciseMatch.tsx`** — duas colunas clique-pra-parear; par certo trava (verde), par errado shake+flash e volta; termina quando todos pareados → `onResult(errors === 0)`. Sub-modo `steps` mantém reorder ↑/↓ com o novo visual:

```tsx
import { useState } from 'react';
import type { Exercise } from '../api';
import { checkSteps } from './grading';

export function ExerciseMatch({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const pairs = exercise.payload.pairs;
  const steps = exercise.payload.steps;
  if (pairs && pairs.length) return <MatchPairs pairs={pairs} prompt={exercise.prompt} onResult={onResult} />;
  if (steps && steps.length) return <OrderSteps steps={steps} prompt={exercise.prompt} onResult={onResult} />;
  return <div className="tr-ex">Exercício indisponível.</div>;
}

function shuffled(n: number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function MatchPairs({ pairs, prompt, onResult }:
  { pairs: [string, string][]; prompt: string; onResult: (c: boolean) => void }) {
  const [rightOrder] = useState(() => shuffled(pairs.length)); // exibição embaralhada da coluna B
  const [selLeft, setSelLeft] = useState<number | null>(null);
  const [selRight, setSelRight] = useState<number | null>(null);
  const [lockedLeft, setLockedLeft] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState(0);
  const [flash, setFlash] = useState<{ l: number; r: number } | null>(null);
  const done = lockedLeft.size === pairs.length;

  const tryPair = (l: number | null, r: number | null) => {
    if (l === null || r === null) return;
    if (l === r) { // índices originais iguais = par correto
      const next = new Set(lockedLeft); next.add(l);
      setLockedLeft(next); setSelLeft(null); setSelRight(null);
      if (next.size === pairs.length) onResult(errors === 0);
    } else {
      setErrors((n) => n + 1);
      setFlash({ l, r });
      setTimeout(() => { setFlash(null); setSelLeft(null); setSelRight(null); }, 300);
    }
  };

  const pickLeft = (i: number) => {
    if (done || lockedLeft.has(i) || flash) return;
    setSelLeft(i); tryPair(i, selRight);
  };
  const pickRight = (origIdx: number) => {
    if (done || lockedLeft.has(origIdx) || flash) return;
    setSelRight(origIdx); tryPair(selLeft, origIdx);
  };

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{prompt}</p>
      <div className="tr-match">
        <div className="tr-match__col">
          {pairs.map((p, i) => (
            <button key={i} type="button" disabled={lockedLeft.has(i) || done}
              className={`tr-match__item${lockedLeft.has(i) ? ' tr-match__item--ok' : ''}${selLeft === i ? ' tr-match__item--sel' : ''}${flash?.l === i ? ' tr-match__item--err' : ''}`}
              onClick={() => pickLeft(i)}>{p[0]}</button>
          ))}
        </div>
        <div className="tr-match__col">
          {rightOrder.map((orig) => (
            <button key={orig} type="button" disabled={lockedLeft.has(orig) || done}
              className={`tr-match__item${lockedLeft.has(orig) ? ' tr-match__item--ok' : ''}${selRight === orig ? ' tr-match__item--sel' : ''}${flash?.r === orig ? ' tr-match__item--err' : ''}`}
              onClick={() => pickRight(orig)}>{pairs[orig][1]}</button>
          ))}
        </div>
      </div>
      <p className="tr-ex__hint">Toque num item de cada coluna pra formar o par · {lockedLeft.size} de {pairs.length} pares</p>
    </div>
  );
}

function OrderSteps({ steps, prompt, onResult }:
  { steps: string[]; prompt: string; onResult: (c: boolean) => void }) {
  const [order, setOrder] = useState<string[]>(() => shuffled(steps.length).map((i) => steps[i]));
  const [answered, setAnswered] = useState(false);
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (answered || j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setOrder(next);
  };
  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{prompt}</p>
      <ol className="tr-steps">
        {order.map((s, i) => (
          <li key={s} className="tr-steps__item">
            <span>{s}</span>
            <span className="tr-steps__ctrl">
              <button type="button" disabled={answered} onClick={() => move(i, -1)} aria-label="Subir">↑</button>
              <button type="button" disabled={answered} onClick={() => move(i, 1)} aria-label="Descer">↓</button>
            </span>
          </li>
        ))}
      </ol>
      {!answered && (
        <button type="button" className="tr-btn tr-btn--full"
          onClick={() => { setAnswered(true); onResult(checkSteps(steps, order)); }}>Verificar</button>
      )}
    </div>
  );
}
```

> Nota: o shuffle usa `Math.random` em lazy `useState` — roda uma vez por mount (o `key={ex.id}` do player garante remount por exercício). Se `pairs.length === 1` ou o shuffle sair identidade, o exercício segue válido (só fica fácil).

- [ ] **Step 2: `ExerciseCloze.tsx`** — banco de palavras (quando `payload.options` existe) toque-pra-preencher; sem options → input estilizado; Verificar gateado; correção via `checkCloze` (uma lacuna, garantido pelo backend):

```tsx
import { useState } from 'react';
import type { Exercise } from '../api';
import { checkCloze } from './grading';

export function ExerciseCloze({ exercise, onResult }: { exercise: Exercise; onResult: (c: boolean) => void }) {
  const [value, setValue] = useState('');        // conteúdo da lacuna
  const [answered, setAnswered] = useState(false);
  const text = exercise.payload.text ?? '';
  const options = exercise.payload.options;
  const [before, after] = text.split('___');

  const verify = () => {
    if (answered || !value) return;
    setAnswered(true);
    onResult(checkCloze(exercise.payload.answers, value));
  };

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      <div className="tr-cloze__sentence">
        {before}
        {value
          ? <button type="button" className="tr-cloze__chip tr-cloze__chip--placed" disabled={answered}
              onClick={() => { if (!answered) setValue(''); }}>{value}</button>
          : <span className="tr-cloze__blank" />}
        {after}
      </div>
      {options && options.length ? (
        <div className="tr-cloze__bank">
          {options.map((opt, i) => (
            <button key={i} type="button" disabled={answered || value === opt}
              className={`tr-cloze__chip${value === opt ? ' tr-cloze__chip--used' : ''}`}
              onClick={() => { if (!answered) setValue(opt); }}>{opt}</button>
          ))}
        </div>
      ) : (
        <input className="tr-type__input" value={value} disabled={answered}
          onChange={(e) => setValue(e.target.value)} placeholder="Digite…"
          onKeyDown={(e) => { if (e.key === 'Enter') verify(); }} />
      )}
      {!answered && (
        <button type="button" className="tr-btn tr-btn--full" disabled={!value} onClick={verify}>Verificar</button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: CSS** (append):

```css
/* ── Exercícios: match, cloze ── */
.tr-match { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 28px; }
.tr-match__col { display: flex; flex-direction: column; gap: 12px; }
.tr-match__item {
  width: 100%; text-align: left; padding: 14px 16px; border-radius: 14px; font: inherit; font-size: 14px;
  background: var(--surface); border: 1px solid var(--border-strong); color: var(--text); cursor: pointer;
}
.tr-match__item--sel { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 3px rgba(154,147,255,.12); }
.tr-match__item--ok { border-color: rgba(74,222,128,.4); background: rgba(74,222,128,.08); color: var(--text-dim); cursor: default; }
.tr-match__item--err { border-color: #ef6b6b; background: rgba(239,107,107,.12); animation: trShake .3s; }
@keyframes trShake { 0%, 100% { transform: none; } 25% { transform: translateX(-5px); } 75% { transform: translateX(5px); } }
.tr-cloze__sentence { padding: 20px; border-radius: 16px; background: var(--surface); border: 1px solid var(--border); font-size: 17px; line-height: 2.15; }
.tr-cloze__blank { display: inline-block; min-width: 120px; border-bottom: 2px dashed var(--border-strong); vertical-align: bottom; }
.tr-cloze__chip {
  display: inline-flex; padding: 6px 14px; border-radius: 999px; font: inherit; font-size: 14px; font-weight: 600; cursor: pointer;
  background: var(--elev, #1f1f27); border: 1px solid var(--border-strong); color: var(--text); box-shadow: 0 4px 0 #101016;
}
.tr-cloze__chip--placed { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); font-weight: 700; box-shadow: none; }
.tr-cloze__chip--used { opacity: .3; cursor: default; box-shadow: none; }
.tr-cloze__bank { display: flex; flex-wrap: wrap; justify-content: center; gap: 10px; padding: 8px 0; }
.tr-steps { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.tr-steps__item { display: flex; justify-content: space-between; align-items: center; padding: 14px 16px; border-radius: 14px; background: var(--surface); border: 1px solid var(--border-strong); }
.tr-steps__ctrl { display: inline-flex; gap: 6px; }
.tr-steps__ctrl button { background: var(--elev); border: 1px solid var(--border-strong); color: var(--text-dim); border-radius: 8px; width: 30px; height: 30px; cursor: pointer; }
```

- [ ] **Step 4: Verificar** — `pnpm exec tsc --noEmit`; `pnpm exec vitest run src/courses` (grading 5/5 — arquivo intocado); invariantes: onResult 1× no match (só quando todos pareados) e no cloze (Verificar único); par errado NÃO trava o exercício.

- [ ] **Step 5: Commit**

```bash
git add apps/seraphine/frontend/src/courses/exercises/ExerciseMatch.tsx apps/seraphine/frontend/src/courses/exercises/ExerciseCloze.tsx apps/seraphine/frontend/src/courses/obsidian.css
git commit -m "feat(trilhas-ui): match click-to-pair + cloze word bank"
```

---

## Task 7: Verificação final

**Files:** nenhum (só checks; remoção de sobras se houver).

- [ ] **Step 1:** `pnpm exec tsc --noEmit` → limpo.
- [ ] **Step 2:** `pnpm exec vitest run src/courses` → grading 5/5 (intocado).
- [ ] **Step 3:** Zero emoji + zero classes órfãs:

```bash
grep -rnP "[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]" src/courses/ && echo "EMOJI FOUND" || echo "emoji clean"
grep -rn "trilha-" src/courses/*.tsx src/courses/exercises/*.tsx && echo "OLD CLASSES REMAIN" || echo "classes migrated"
grep -c "trilha-" src/courses/obsidian.css   # deve ser 0 (todas as antigas removidas)
```

- [ ] **Step 4 (manual):** subir `pnpm dev` e percorrer as 7 telas com a trilha "Fotossíntese" de prod (ou stub) — lista (pills XP/streak, shimmer no gerando), mapa (serpentina, pulso na próxima, troféu), teoria, MCQ (teclado 1-4), match (par errado shake), cloze (banco de chips), resultado (troféu + stats + Próxima lição).

---

## Self-Review (cobertura do handoff)

- Tela 1 lista (header/badges, criar, grid 2-col, status badges, shimmer): Task 2. ✓
- Tela 2 mapa (serpentina SVG sólido/pontilhado, 4 estados de nó, pulso+COMEÇAR, troféu, painel lateral): Task 3. ✓ (deviações: sem XP por trilha, sem contagem de exercícios — aprovadas)
- Tela 3 teoria (X+progresso+pill Teoria, eyebrow, concept, dica, CTA sombra dura): Task 4. ✓ (bloco de código com syntax colors: fora — concept_md é texto no v1; anotado)
- Tela 4 MCQ (cards numerados, atalhos, feedback banner rodapé): Tasks 1+4+5. ✓
- Tela 5 match (2 colunas, par trava verde, errado shake, hint N de M): Task 6. ✓
- Tela 6 cloze (chips banco, lacuna tracejada, Verificar gateado, devolver chip): Task 6. ✓ (drag: fora, só toque — aprovado)
- Tela 7 resultado (troféu, 3 stat-cards, Voltar/Próxima, Salvando…): Task 4. ✓
- Animações (nodePulse, statusBlink, shimmer, slide 250ms, feedback slide-up): Task 1 + usos. ✓
- Sem emoji; sombra dura só em ações; tokens verbatim: Global + Task 7 gate. ✓
- Lógica intacta (api/grading/contratos/onResult 1×/key={ex.id}/completeLesson 1×): Global. ✓
