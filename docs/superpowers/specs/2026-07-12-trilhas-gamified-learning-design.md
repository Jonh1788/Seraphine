# Trilhas — aprendizado gamificado (estilo Duolingo/Mimo)

**Data:** 2026-07-12
**Status:** Aprovado (aguardando review da spec)

## Problema / motivação

Os **flashcards v2** hoje são uma pilha plana de cards `{front, back}` com repetição espaçada (SM-2). Falta a experiência de *aprender de fato* um assunto: ninguém ensina antes de testar, não há trilha, progressão nem gamificação. O usuário quer transformar isso num app estilo **Duolingo/Mimo**: pesquisa extensa sobre um tópico → ensino gamificado com exemplos → perguntas interativas, com XP, streak e progressão.

Decisão de posicionamento (brainstorm): o novo modo **Trilhas** vira a experiência principal; os flashcards SM-2 **não somem** — os conceitos aprendidos numa lição viram cards de revisão espaçada, reaproveitando o motor SM-2 que já existe.

## Objetivo (v1 — fatia vertical completa)

Um curso de ponta a ponta: **gerar** (de um tópico, via pesquisa) → **trilha** de lições → **tocar** uma lição (ensino + exemplos, depois exercícios dos 4 tipos com feedback imediato) → **XP + streak + SM-2**. Nome da feature: **Trilhas**.

Fora do v1 (fase 2): expandir trilha (preencher assuntos/lições que faltaram), vidas/corações, editor das lições geradas, fontes além de tópico (nota/artigo/chat), voz/avatar.

## Decisões (brainstorm)

1. **Relação com flashcards:** novo modo principal (curso/trilha/lições); os cards viram **um tipo de exercício/revisão** reaproveitando o SM-2.
2. **Criação:** um **tópico → curso inteiro auto** (pesquisa profunda gera a trilha completa). Expansível na fase 2 (adicionar assuntos/lições faltantes).
3. **Tipos de exercício (todos no v1):** múltipla escolha, completar lacuna (cloze), digitar resposta curta, parear/ordenar.
4. **Gamificação (v1):** XP + progresso na trilha, streak diário, revisão espaçada (SM-2). **Sem** vidas/corações.
5. **Arquitetura:** modelo hierárquico (course → lesson → exercise) + geração em 3 estágios ancorada em pesquisa (anti-alucinação/anti-injection, igual flashcards v2).
6. **Nome:** **Trilhas**.

## Contexto do código (na main)

- `seraphine/flashcards/service.py` — SM-2 (`review`, `due`), geração grounded (`make_cards`), CRUD de card/deck, imagem por card. **Reaproveitado** pela camada de revisão (semear cards, `review`).
- `seraphine/flashcards/routes.py` — `/flashcards/*` (due, decks, cards, review, image, delete). Referência de padrão de rota/serviço.
- **Deepsearch** (`project_deepsearch`): serviço de pesquisa multi-step (Quick+Deep) reutilizado no estágio 1 da geração. Precisa de cliproxy(:8317) up ou chave OpenRouter.
- `MemoryStore` + `register_migrator(name, migrate)` + `store._connect()` — padrão de schema/DB (sqlite). Trabalho de DB via closure síncrona em `asyncio.to_thread`.
- `ImageGenService` — reuso opcional (imagem de lição/curso) fica fora do v1.
- Frontend: `src/flashcards/FlashcardsView.tsx`, `src/api.ts` (`API_BASE`), `src/Icons.tsx` (SVGs, **sem emoji**), `obsidian.css` (tokens `obs-*` + per-feature `obsidian.css`).
- Padrão de job em background com status pollável (ex.: geração de flashcards / deepsearch run).

## Arquitetura

```
CRIAR CURSO (job em background, status pollável)
  topic ──▶ [1] deepsearch(topic) ──▶ digest (corpus de grounding)
        ──▶ [2] LLM make_outline(digest) ──▶ lições [{title, objective}] (5–12)
        ──▶ [3] por lição: LLM make_lesson(digest, objective)
                 ──▶ concept_md (ensino + exemplos) + exercises[] (mix dos 4 tipos, ~4–6)
        ──▶ persiste course/lesson/exercise ; course.status: generating → ready|failed

TOCAR
  trilha (mapa de nós locked/unlocked/done)
   └─ lição: [ensino: concept_md] → exercícios um a um (feedback imediato) → resultado
        ├─ mcq/cloze/match: corrige no CLIENTE (payload tem a resposta) → instantâneo
        └─ type: POST /courses/answer → normalize + LLM-judge (sinônimos) → veredito
   └─ ao concluir: XP += ; streak atualiza ; lesson_progress=done ; libera N+1 ;
                   conceitos ──▶ cards SM-2 (deck do curso) via flashcards service
```

## Componentes

### 1. Módulo `seraphine/courses/` (backend)

- **`schema.py`** — migrator `courses`; tabelas:
  - `course(id, topic, title, description, status, source_ref, created_ts, meta_json)`
  - `lesson(id, course_id, order_idx, title, concept_md, status)`
  - `exercise(id, lesson_id, order_idx, type, prompt, payload_json, explanation, concept_key)`
  - `lesson_progress(lesson_id, status, best_score, completed_ts)`
  - `learning_stats(id=1, xp_total, streak_count, streak_last_day)` (singleton)
- **`generate.py`** — pipeline de 3 estágios:
  - `research_topic(topic, deepsearch) -> str` (digest) — estágio 1.
  - `make_outline(llm, digest, topic) -> list[LessonSpec]` — tool-call, 5–12 lições, ordenadas.
  - `make_lesson(llm, digest, lesson_spec) -> LessonContent` (concept_md + exercises) — tool-call grounded, framing anti-injection (`<material>…</material>` = dado).
  - `generate_course(topic, store, llm, deepsearch) -> course_id` — orquestra, roda em `asyncio.create_task`, persiste, seta status.
  - **Exercises schema (payload_json por tipo):**
    - `mcq`: `{"options": [str], "answer_idx": int}`
    - `cloze`: `{"text": "... ___ ...", "answers": [str], "options"?: [str]}`
    - `type`: `{"accepted": [str], "rubric": str}`
    - `match`: `{"pairs": [[str,str]]}` **ou** `{"steps": [str]}` (ordem correta) — distinguidos por chave presente.
  - Limites: outline 5–12 lições; por lição 4–6 exercícios; strings clampadas; dedup; validação de shape por tipo (descarta exercício malformado).
- **`service.py`** — `CoursesService(store, llm, deepsearch, flashcards)`:
  - `create_course(topic) -> {course_id, status}` (dispara o job).
  - `get_course(course_id)`, `list_courses()`, `get_lesson(lesson_id)` (com exercícios; para o player).
  - `complete_lesson(lesson_id, score) -> {xp_gained, streak, seeded_cards}` — atualiza `lesson_progress`, XP, streak, libera próxima, semeia cards SM-2 dos conceitos.
  - `grade_type(exercise_id, answer) -> {correct, feedback}` — normalize + LLM-judge.
  - `award_xp` / `update_streak` — helpers internos (streak: mesma data = mantém; ontem = +1; gap = reset 1).
- **`routes.py`** — router `/courses`:
  - `POST /courses` `{topic}` → cria + dispara job → `{course_id, status}`.
  - `GET /courses` → lista (com progresso).
  - `GET /courses/{id}` → curso + trilha (lições + status/lock).
  - `GET /courses/lessons/{lesson_id}` → lição + exercícios (payload; para mcq/cloze/match o cliente corrige).
  - `POST /courses/answer` `{exercise_id, answer}` → grading do `type`.
  - `POST /courses/lessons/{lesson_id}/complete` `{score}` → XP/streak/desbloqueio/SM-2.
  - `GET /courses/stats` → `{xp_total, streak_count, streak_last_day}`.

### 2. Frontend `src/courses/`

- **`api.ts`** — `createCourse(topic)`, `listCourses()`, `getCourse(id)`, `getLesson(id)`, `gradeType(exId, answer)`, `completeLesson(id, score)`, `getStats()`.
- **`TrilhasView.tsx`** — lista de cursos + criar (input de tópico → poll de status enquanto `generating`) + header com XP/streak.
- **`CourseMap.tsx`** — mapa vertical de nós de lição (locked/unlocked/done) + barra de progresso.
- **`LessonPlayer.tsx`** — máquina de telas: ensino (`concept_md` render markdown) → exercícios (um a um) → resultado. Feedback imediato (verde/erro + explanation). Sem vidas.
- **Renderers:** `ExerciseMCQ`, `ExerciseCloze`, `ExerciseType`, `ExerciseMatch`. mcq/cloze/match corrigem local; `type` chama `gradeType`.
- **`obsidian.css`** (per-feature) — mapa, nós, player. Ícones via `Icons.tsx` (SVG, sem emoji).

### 3. Reuso do SM-2 (flashcards)

`complete_lesson` chama o `FlashcardsService` (ou a camada de persistência de card) para criar um deck `curso:<title>` e semear cards `{front: pergunta do conceito, back: resposta}` a partir dos exercícios/conceitos da lição. A aba de revisão (SM-2) atual passa a incluir esses cards em `/flashcards/due`. Sem duplicar SM-2.

## Dados / correção / erros

- **Grounding + anti-injection:** todo material de pesquisa é passado como dado entre marcadores; o prompt instrui a NUNCA seguir instruções contidas nele (padrão flashcards v2).
- **Correção cliente vs servidor:** mcq/cloze/match têm a resposta no payload (feedback instantâneo, single-user, baixo risco); `type` corrige no servidor (normalize acento/caixa; se não bate, LLM-judge aceita equivalentes; judge indisponível → fallback normalize-only).
- **Job de geração:** falha em qualquer estágio → `course.status='failed'` + motivo em `meta_json`; o front mostra erro e permite re-tentar. Deepsearch/LLM down → falha graciosa (não trava a aba).
- **Validação de exercício:** shape inválido por tipo é descartado na geração; se a lição fica com 0 exercícios válidos, `make_lesson` é re-tentado **uma vez**; persistindo vazia, a lição é marcada `status='incomplete'` (o curso ainda vira `ready`, e o mapa mostra a lição como indisponível).
- **XP/streak idempotência:** re-concluir uma lição já `done` não dá XP de novo (só atualiza `best_score`); streak é por dia-calendário.

## Testes

- **Geração:** mock deepsearch (digest fixo) + LLM scriptado (`make_outline` → N lições; `make_lesson` → concept + exercícios dos 4 tipos) → asserta course/lesson/exercise persistidos, status `ready`, shapes válidos, exercício malformado descartado.
- **Grading `type`:** normalize (acento/caixa/trim) casa; sinônimo via LLM-judge stub; judge down → normalize-only.
- **Gamificação:** `complete_lesson` dá XP e libera N+1; re-concluir não re-XP; streak: mesmo dia mantém, ontem +1, gap reseta; `get_stats` reflete.
- **SM-2:** `complete_lesson` semeia cards no deck do curso; aparecem em `/flashcards/due`.
- **Rotas:** app mínimo → criar curso (status generating), poll → ready; get lesson; answer (type); complete; stats. Body inválido → 400.
- **Frontend:** build/typecheck; renderers corrigem localmente (mcq/cloze/match) e chamam `gradeType` no `type`.

## Fora de escopo (v1)

Expandir trilha (assuntos/lições faltantes); vidas/corações; editor das lições geradas (CRUD); fontes além de tópico (nota/artigo/chat/anexo); imagem de lição/curso; voz/avatar; ranking/social; refresh live entre abas.
