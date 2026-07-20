# Trilhas — Módulo Mat/Física: código→trilha + KaTeX + gráficos interativos

**Data:** 2026-07-20
**Status:** Aprovado (aguardando review da spec)

## Problema / motivação

O usuário estuda C/C++ pra firmware (ESP32) e trava na **matemática** dos códigos que quer reescrever — interpolações exponenciais, smoothstep, formas paramétricas (caso real: firmware de olhos EVA em `.ino` com `1−e^(−kt)`, `3t²−2t³`, `1−y^c`). Quer um módulo de estudo de matemática/física na Seraphine. As Trilhas já geram cursos de tópico e URL; faltam três coisas pra esse caso: (1) **criar trilha a partir de código colado** ("a matemática deste código"), (2) **fórmulas renderizadas** (LaTeX/KaTeX — hoje `$1-e^{-kt}$` sai como texto), (3) **gráficos interativos** (mexer no parâmetro e VER a curva mudar).

## Decisões (brainstorm)

1. **Escopo total num incremento:** código→trilha + KaTeX + gráficos (teoria E exercício de gráfico).
2. **Gráficos na teoria + 5º tipo de exercício `graph`** ("ajuste o parâmetro até o alvo", correção por tolerância no cliente).
3. **Entrada de código:** expander "colar código" no card de criação (textarea) + foco `math` ("Matemática do código") ou `code` ("Entender o código").
4. **Motor de gráfico — abordagem A:** spec declarativa emitida pelo LLM + **parser/avaliador próprio** no frontend (~100 linhas, recursive descent, zero `eval`, zero dep) + whitelist de tokens no backend. (B mathjs = 700KB de dep; C pontos pré-computados = mata os sliders.)
5. **Gráficos de teoria sem mudança de schema:** blocos ` ```graph {json}``` ` dentro do `concept_md`, interceptados pelo renderer de código do react-markdown.

## Contexto do código (na main)

- `seraphine/courses/sources.py` — `resolve_source(raw, *, engine) -> {title, digest, source_ref}` (URL/tópico); caps `_DIGEST_CAP_IMPORT=120_000` / `_DIGEST_CAP=18000`.
- `seraphine/courses/generate.py` — `EX_TYPES`, `valid_exercise` (validação por tipo), `OUTLINE_TOOL`/`LESSON_TOOL`, `_OUTLINE_SYSTEM`/`_LESSON_SYSTEM` (anti-injection `<material>`), `generate_course`.
- `seraphine/courses/routes.py` — `TopicIn{topic, tutor_model?}`; `service.create_course(topic, tutor_model=None)`.
- Frontend: `src/courses/TrilhasView.tsx` (card `tr-create` com campo esperto + dropdown tutor), `LessonPlayer.tsx` (react-markdown + remark-gfm no `concept_md`), `exercises/` (4 renderers + `grading.ts` puro), `api.ts`.
- Player mobile (phone shell) embrulha a TrilhasView — herda tudo.

## Arquitetura

```
CRIAR
POST /courses {topic?, code?, focus?: 'math'|'code', tutor_model?}
  code presente → resolve_source caminho CODE: digest = código (cap 120k),
                  source_ref = "code", title = topic || "Curso do código (<focus>)"
  prompts de outline/lesson ganham FRAMING por focus:
    math → "explique a MATEMÁTICA deste código; cada lição ancora numa função/fórmula real"
    code → "explique o código em si (estruturas, fluxo, APIs)"
  prompts também instruem: fórmulas em $...$/$$...$$ (KaTeX) e blocos ```graph {json}```

GERAÇÃO (validação nova)
  valid_exercise ganha tipo 'graph':
    payload {expr, x:{var,min,max}, params:[{name,min,max,default}], target:{param,value,tol}}
    expr validada por whitelist de tokens (server)
  concept_md: blocos ```graph``` validados (expr whitelist); inválido → rebaixado a bloco de código comum

PLAYER
  react-markdown + remark-math + rehype-katex (fórmulas na teoria e nos prompts)
  renderer de code intercepta lang 'graph' → <GraphBlock spec> (plot SVG + sliders)
  ExerciseGraph (5º renderer): plot + sliders + Verificar → |param − target.value| ≤ tol (cliente)
  mathexpr.ts: parser/avaliador seguro compartilhado (GraphBlock + ExerciseGraph)
```

## Componentes

### 1. Backend — `sources.py` (caminho code)
- `resolve_source` ganha parâmetro `code: str | None = None` (ou função irmã `resolve_code_source(code, focus, topic)` — decisão de implementação; interface resultante idêntica `{title, digest, source_ref}`): digest = código integral (cap `_DIGEST_CAP_IMPORT`), `source_ref="code"`, `title = topic or None` (generate cai no fallback atual).
- `create_course(topic=None, code=None, focus='math', tutor_model=None)`: exige `topic` OU `code` (ambos vazios → ValueError→400); `focus` ∈ {'math','code'} (default 'math'; inválido → 400 na rota).

### 2. Backend — `generate.py` (prompts + tipo graph)
- `_OUTLINE_SYSTEM`/`_LESSON_SYSTEM` parametrizados por focus quando a fonte é código (prefixo de framing; fonte tópico/URL inalterada). Instrução nova em `_LESSON_SYSTEM` (todas as fontes): "fórmulas matemáticas em LaTeX entre $...$; quando um conceito tiver forma visual, inclua um bloco ```graph com JSON {expr, x, params}". `LESSON_TOOL` enum de exercícios ganha `graph`.
- `valid_exercise` tipo `graph`: `expr` não-vazia e válida na whitelist; `x.var` identificador; `min < max`; 1-3 `params` com `min ≤ default ≤ max`; `target.param` ∈ params; `tol > 0`. Inválido → None (descartado, padrão atual).
- `_valid_expr(expr, allowed_vars) -> bool` (função pura): tokeniza e aceita SÓ números, `allowed_vars`, `+ - * / ^ ( ) ,`, funções `sin cos tan exp log sqrt abs pow min max`, constantes `pi e`. Qualquer outro token → False. Usada também pros blocos ```graph do concept_md (bloco inválido → substituído por bloco de código comum no persist? NÃO — simplicidade: bloco de teoria inválido fica como está e o CLIENTE faz fail-soft; a whitelist server é obrigatória só no exercício, onde há correção).

### 3. Backend — rotas
- `TopicIn` → `{topic: str | None = None, code: str | None = None, focus: str = 'math', tutor_model: str | None = None}`; validações: um de topic/code obrigatório; focus ∈ {math, code}; tutor regex atual. `code` cap de tamanho no request (~200KB) pra não abusar.

### 4. Frontend — criação (`TrilhasView`)
- Botão "colar código" no card → expande textarea (mono, ~10 linhas) + radio de foco ("Matemática do código" | "Entender o código") + o mesmo dropdown de tutor; Criar → `createCourse({code, focus, tutorModel})`. Campo de tópico opcional vira o título. `api.ts`: `createCourse` aceita objeto `{topic?, code?, focus?, tutorModel?}` (mantém compat com chamada atual por string OU migra a assinatura — decisão de implementação, tsc guia).

### 5. Frontend — `mathexpr.ts` (puro, testado)
- `parseExpr(src: string): Expr` (AST) e `evalExpr(ast, vars: Record<string, number>): number`. Recursive descent: precedência `+- < */ < unário < ^ (dir-assoc) < átomo`; funções unárias/binárias da whitelist; `pi`/`e`; erro de sintaxe/token → throw (chamador trata). NUNCA `eval`/`Function`.

### 6. Frontend — `GraphBlock.tsx` + integração no player
- Player adiciona `remark-math` + `rehype-katex` (+ CSS do katex importado uma vez) ao `<Markdown>`; `components.code` intercepta `language-graph` → parseia JSON → `<GraphBlock spec>`; qualquer erro (JSON/expr/eval) → renderiza o bloco como `<pre>` normal (fail-soft).
- `GraphBlock`: SVG ~ largura do player, amostra a expr em ~120 pontos no range de x, eixos simples, 1 slider por param (min/max/default), re-render no input. Sem animação no v1.

### 7. Frontend — `ExerciseGraph.tsx` (5º renderer)
- Contrato igual aos outros: `({exercise, onResult})`, `onResult` 1×. Plot + sliders; botão Verificar (gateado até mexer em algum slider) → `Math.abs(params[target.param] − target.value) ≤ target.tol` → `onResult(bool)`. `LessonPlayer` ganha o case `graph` + eyebrow "Ajuste o gráfico". Payload do `graph` NÃO é zerado no `get_lesson` (o alvo viaja como no mcq — decisão consciente, baixo risco single-user).

### 8. Dependências novas (frontend apenas)
- `katex`, `remark-math`, `rehype-katex`. Backend: nenhuma.

## Erros / segurança

- **Nunca `eval`:** toda avaliação via `mathexpr.ts`; token fora da whitelist → throw → fail-soft (bloco vira código) ou exercício descartado (server).
- Anti-injection inalterado (código do usuário entre `<material>`).
- Bloco `graph` de teoria malformado → cai pra `<pre>`; exercício `graph` malformado → descartado na geração (lição segue).
- Cursos e fontes existentes intactos (topic/URL sem focus → prompts atuais + instrução KaTeX/graph que é aditiva e inofensiva).

## Fora de escopo (v1)

Foco em texto livre; upload de arquivo (colar resolve); gráficos paramétricos 2D/animações; exercício de gráfico com curva-alvo desenhada (v1 é alvo numérico com tolerância); MathML/acessibilidade avançada de fórmulas; renderização KaTeX na wiki/chat (só no player de Trilhas).

## Testes

- **`_valid_expr`:** aceita `1-exp(-k*t)`, `sin(2*pi*x)`, `pow(y,2.1)`; rejeita `__import__('os')`, `foo(x)`, `x;y`, var não declarada.
- **`valid_exercise` graph:** payload válido normaliza; expr inválida/target fora dos params/tol≤0 → None.
- **`resolve_source` code:** digest = código, source_ref="code", cap aplicado; sem code → caminhos atuais intactos.
- **Rotas:** code sem topic → 200; ambos vazios → 400; focus inválido → 400; code >cap → 400.
- **`mathexpr.ts`:** precedência (`2+3*4=14`), `^` dir-assoc (`2^3^2=512`), unário (`-x^2`), funções, `pi`, erro em token estranho.
- **`ExerciseGraph`:** tolerância (dentro→true, fora→false), onResult 1×, Verificar gateado.
- **Player:** bloco graph inválido → `<pre>` (fail-soft); fórmula `$x^2$` renderiza (smoke por presença de `.katex` no DOM).
- tsc/vitest/pytest verdes; prompts com instrução KaTeX/graph não quebram testes de geração existentes.
