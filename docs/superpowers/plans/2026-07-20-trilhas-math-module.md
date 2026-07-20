# Trilhas — Módulo Mat/Física — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar trilha a partir de código colado (foco matemática/código), fórmulas KaTeX no player, gráficos interativos na teoria (blocos ```graph) e 5º tipo de exercício `graph` (ajustar parâmetro até o alvo) — com um avaliador de expressões próprio e seguro nas duas pontas.

**Architecture:** Backend: `_valid_expr` (whitelist pura) + tipo `graph` no `valid_exercise`; caminho `code` no `resolve_source`; prompts com framing por foco + instruções KaTeX/graph; rota `{code, focus}`. Frontend: `mathexpr.ts` (parser recursive-descent, zero eval) compartilhado por `GraphBlock` (bloco ```graph na teoria, fail-soft) e `ExerciseGraph` (5º renderer, tolerância no cliente); `remark-math`+`rehype-katex` no player; expander "colar código" no card de criação.

**Tech Stack:** Python/FastAPI, React/TS, katex + remark-math@6 + rehype-katex@7 (compatíveis com react-markdown@10 já instalado), SVG puro.

## Global Constraints

- **NUNCA `eval`/`Function`:** toda avaliação de expressão via `mathexpr.ts` (frontend) e validação via `_valid_expr` (backend). Token fora da whitelist → throw (front, fail-soft) / rejeição (back).
- **Whitelist de expressão:** números, variáveis declaradas, `+ - * / ^ ( ) ,`, funções `sin cos tan exp log sqrt abs pow min max`, constantes `pi e`.
- **Payload do exercício `graph`:** `{expr, x:{var,min,max}, params:[{name,min,max,default}] (1-3), target:{param,value,tol}}`; `min<max`, `min≤default≤max`, `target.param ∈ params`, `tol>0`. Correção NO CLIENTE: `|params[target.param] − target.value| ≤ tol`. Payload não é zerado no get_lesson (decisão de spec).
- **Fontes/cursos existentes intactos:** tópico/URL sem `focus` → prompts atuais + instruções KaTeX/graph (aditivas). `focus ∈ {'math','code'}`; rota exige `topic` OU `code`; `code` cap 200_000 chars no request → 400 acima.
- **Fail-soft:** bloco ```graph malformado na teoria → renderiza como `<pre>`; exercício graph inválido → descartado na geração (lição segue).
- **Anti-injection inalterado:** código do usuário entre `<material>…</material>`.
- **Contrato dos exercícios preservado:** `({exercise, onResult})`, `onResult` exatamente 1×; slot keyed by `ex.id` no player.
- Backend `uv run pytest tests/courses/`; frontend `pnpm exec tsc --noEmit` + `pnpm exec vitest run src/courses`. SEM emoji (SVG only).
- **Subagents (execução):** toda invocação de Agent passa `model: "opus"`.

---

## Arquivos

**Backend — Modify:** `seraphine/courses/generate.py` (`_valid_expr`, `EX_TYPES`+`valid_exercise` graph, `LESSON_TOOL` enum, prompts, `generate_course(code=None, focus="math")`) · `seraphine/courses/sources.py` (caminho code) · `seraphine/courses/service.py` (`create_course(topic=None, code=None, focus='math', tutor_model=None)`) · `seraphine/courses/routes.py` (`TopicIn`)
**Backend — Testes:** `tests/courses/test_validate.py` (append) · `tests/courses/test_expr.py` (novo) · `tests/courses/test_sources.py` (append) · `tests/courses/test_routes.py` (append)
**Frontend — Create:** `src/courses/mathexpr.ts` · `src/courses/GraphBlock.tsx` · `src/courses/exercises/ExerciseGraph.tsx` · `src/courses/__tests__/mathexpr.test.ts` · `src/courses/exercises/__tests__/graph-grading.test.ts`
**Frontend — Modify:** `package.json` (deps) · `src/courses/LessonPlayer.tsx` (katex plugins + code renderer + case graph) · `src/courses/api.ts` (tipos + createCourse objeto) · `src/courses/TrilhasView.tsx` (expander) · `src/courses/obsidian.css` (seções graph/expander)

---

## Task 1: `_valid_expr` (whitelist pura, backend)

**Files:**
- Modify: `seraphine/courses/generate.py` (adicionar após `clamp_outline`)
- Test: `tests/courses/test_expr.py` (novo)

**Interfaces:**
- Produces: `_ALLOWED_FUNCS = {"sin","cos","tan","exp","log","sqrt","abs","pow","min","max"}`; `_valid_expr(expr: str, allowed_vars: set[str]) -> bool`.

- [ ] **Step 1: teste falhando** — `tests/courses/test_expr.py`:

```python
from seraphine.courses.generate import _valid_expr

V = {"t", "k"}


def test_accepts_real_expressions():
    assert _valid_expr("1 - exp(-k*t)", V)
    assert _valid_expr("sin(2*pi*t) + k^2", V)
    assert _valid_expr("pow(t, 2.1) / (k + 1)", V)
    assert _valid_expr("min(t, k) * e", V)


def test_rejects_unknown_tokens():
    assert not _valid_expr("__import__('os')", V)
    assert not _valid_expr("foo(t)", V)          # função fora da whitelist
    assert not _valid_expr("t; k", V)            # separador estranho
    assert not _valid_expr("x + 1", V)           # variável não declarada
    assert not _valid_expr("k = 2", V)
    assert not _valid_expr("", V)
    assert not _valid_expr("2 ** 3", V)          # ** não é ^ da whitelist
```

- [ ] **Step 2:** `uv run pytest tests/courses/test_expr.py -v` → FAIL (import).

- [ ] **Step 3: implementação** (em `generate.py`, após `clamp_outline`):

```python
_ALLOWED_FUNCS = {"sin", "cos", "tan", "exp", "log", "sqrt", "abs", "pow", "min", "max"}
_ALLOWED_CONSTS = {"pi", "e"}
_EXPR_TOKEN = re.compile(r"\s*(\d+\.?\d*|[A-Za-z_][A-Za-z_0-9]*|[-+*/^(),])")


def _valid_expr(expr: str, allowed_vars: set[str]) -> bool:
    """Whitelist estrita: números, vars declaradas, operadores, funções e
    constantes conhecidas. Qualquer resto (incl. '**', ';', '=') → False.
    NÃO avalia nada — só tokeniza e classifica."""
    s = (expr or "").strip()
    if not s:
        return False
    pos = 0
    while pos < len(s):
        m = _EXPR_TOKEN.match(s, pos)
        if not m:
            return False
        tok = m.group(1)
        pos = m.end()
        if tok[0].isdigit():
            continue
        if tok in "-+*/^(),":
            # '**' chegaria como dois '*' seguidos — permitido? Não: rejeitar
            # explicitamente pra não normalizar silenciosamente.
            if tok == "*" and pos < len(s) and s[pos] == "*":
                return False
            continue
        low = tok.lower()
        if low in _ALLOWED_FUNCS or low in _ALLOWED_CONSTS or tok in allowed_vars:
            continue
        return False
    # sobra de espaço no fim é ok; '=' nunca casa no regex → já falhou acima
    return True
```

(`import re` já existe? Conferir o topo do generate.py — se não, adicionar.)

- [ ] **Step 4:** PASS. `uv run pytest tests/courses/ -q` sem regressão.
- [ ] **Step 5:** commit `feat(courses): _valid_expr — whitelist de expressões matemáticas`

---

## Task 2: Tipo `graph` no `valid_exercise` + `LESSON_TOOL`

**Files:**
- Modify: `seraphine/courses/generate.py`
- Test: `tests/courses/test_validate.py` (append)

**Interfaces:**
- Consumes: `_valid_expr` (T1).
- Produces: `EX_TYPES` inclui `"graph"`; `valid_exercise` valida/normaliza payload graph (shape da Global Constraint); `LESSON_TOOL` enum de type inclui `"graph"`.

- [ ] **Step 1: testes falhando** (append em `test_validate.py`):

```python
def _graph_payload(**over):
    p = {
        "expr": "1 - exp(-k*t)",
        "x": {"var": "t", "min": 0, "max": 1},
        "params": [{"name": "k", "min": 1, "max": 20, "default": 5}],
        "target": {"param": "k", "value": 10, "tol": 1.5},
    }
    p.update(over)
    return p


def test_valid_graph_exercise():
    out = valid_exercise({
        "type": "graph", "prompt": "Ajuste k até a curva atingir 63% em t=0.1",
        "payload": _graph_payload(), "explanation": "k=10 dá tau=0.1",
    })
    assert out["type"] == "graph"
    assert out["payload"]["target"]["tol"] == 1.5
    assert out["payload"]["x"]["var"] == "t"


def test_graph_bad_expr_rejected():
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(expr="__import__('os')"),
    }) is None


def test_graph_target_param_must_exist():
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(target={"param": "zz", "value": 1, "tol": 1}),
    }) is None


def test_graph_bad_ranges_rejected():
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(x={"var": "t", "min": 5, "max": 1}),
    }) is None
    assert valid_exercise({
        "type": "graph", "prompt": "Ajuste:",
        "payload": _graph_payload(target={"param": "k", "value": 1, "tol": 0}),
    }) is None


def test_ex_types_includes_graph():
    assert "graph" in EX_TYPES
```

E ATUALIZAR `test_ex_types_frozen` (asserta o set antigo): novo set esperado `{"mcq","cloze","type","match","graph"}`.

- [ ] **Step 2:** FAIL. **Step 3: implementação** — `EX_TYPES = {"mcq","cloze","type","match","graph"}`; novo branch antes do `else:  # match`:

```python
    elif etype == "graph":
        expr = _s(payload_in.get("expr"), 300)
        x = payload_in.get("x") if isinstance(payload_in.get("x"), dict) else {}
        params_in = payload_in.get("params") or []
        target = payload_in.get("target") if isinstance(payload_in.get("target"), dict) else {}
        xvar = _s(x.get("var"), 20)
        params = []
        for p in params_in[:3]:
            if not isinstance(p, dict):
                continue
            name = _s(p.get("name"), 20)
            try:
                lo, hi, df = float(p["min"]), float(p["max"]), float(p["default"])
            except (KeyError, TypeError, ValueError):
                continue
            if name and name.isidentifier() and lo < hi and lo <= df <= hi:
                params.append({"name": name, "min": lo, "max": hi, "default": df})
        try:
            xmin, xmax = float(x.get("min")), float(x.get("max"))
            tval, ttol = float(target.get("value")), float(target.get("tol"))
        except (TypeError, ValueError):
            return None
        tparam = _s(target.get("param"), 20)
        allowed = {xvar} | {p["name"] for p in params}
        if (not xvar or not xvar.isidentifier() or not params
                or xmin >= xmax or ttol <= 0
                or tparam not in {p["name"] for p in params}
                or not _valid_expr(expr, allowed)):
            return None
        payload = {
            "expr": expr, "x": {"var": xvar, "min": xmin, "max": xmax},
            "params": params, "target": {"param": tparam, "value": tval, "tol": ttol},
        }
```

`LESSON_TOOL` enum: `"enum": ["mcq", "cloze", "type", "match", "graph"]`.

- [ ] **Step 4:** PASS; suite courses verde.
- [ ] **Step 5:** commit `feat(courses): graph exercise type — validated declarative spec`

---

## Task 3: Caminho `code` no sources + prompts (foco/KaTeX/graph) + generate

**Files:**
- Modify: `seraphine/courses/sources.py`, `seraphine/courses/generate.py`, `seraphine/courses/service.py`
- Test: `tests/courses/test_sources.py` (append) + `tests/courses/test_service_code.py` (novo)

**Interfaces:**
- Consumes: `_DIGEST_CAP_IMPORT` (existente).
- Produces:
  - `sources.resolve_code_source(code: str, *, topic: str | None, focus: str) -> dict` → `{title, digest, source_ref="code"}` (`title = topic or ("Matemática do código" if focus=="math" else "Entendendo o código")`, digest = code cap 120k).
  - `generate._FOCUS_FRAMING = {"math": "...", "code": "..."}`; `_OUTLINE_SYSTEM`/`_LESSON_SYSTEM` viram funções `def _outline_system(focus: str | None) -> str` / `_lesson_system(focus)` (None → texto atual + instruções KaTeX/graph; focus → prefixo de framing).
  - `generate_course(store, *, course_id, topic, llm, engine, code: str | None = None, focus: str = "math")` — code presente → `resolve_code_source`; senão `resolve_source` (atual). `make_outline`/`make_lesson` ganham kwarg `focus: str | None = None` repassado aos system prompts.
  - `service.create_course(self, topic: str | None = None, code: str | None = None, focus: str = "math", tutor_model: str | None = None)` — exige topic ou code (senão `ValueError`); topic do INSERT = `topic or ("Matemática do código" if focus == "math" else "Entendendo o código")`; `source_ref = "code"` quando code; spawn repassa `code=code, focus=focus`.

- [ ] **Step 1: instruções novas nos prompts** (texto exato a somar em `_lesson_system` pra TODA fonte):

```
"Fórmulas matemáticas SEMPRE em LaTeX entre $...$ (inline) ou $$...$$ (bloco). "
"Quando um conceito tiver forma visual (curvas, interpolação, formas), inclua no "
"concept_md um bloco cercado de linguagem graph com JSON: "
'```graph\n{"expr": "1 - exp(-k*t)", "x": {"var": "t", "min": 0, "max": 1}, '
'"params": [{"name": "k", "min": 1, "max": 20, "default": 5}]}\n``` '
"usando SÓ as funções sin cos tan exp log sqrt abs pow min max e constantes pi, e. "
```

E o framing por foco (prefixo quando a fonte é código):

```python
_FOCUS_FRAMING = {
    "math": ("O material é CÓDIGO-FONTE. Monte o curso sobre a MATEMÁTICA presente "
             "nele: cada lição ancora numa função/fórmula real do código (cite o "
             "trecho), explica o conceito matemático por trás e generaliza. "),
    "code": ("O material é CÓDIGO-FONTE. Monte o curso sobre o CÓDIGO em si: "
             "estruturas, fluxo, APIs e padrões usados, na ordem do arquivo. "),
}
```

- [ ] **Step 2: testes falhando** — append em `test_sources.py`:

```python
def test_resolve_code_source_math():
    out = sources.resolve_code_source("float f = 1.0f - expf(-k*t);" * 10,
                                      topic=None, focus="math")
    assert out["source_ref"] == "code"
    assert out["title"] == "Matemática do código"
    assert "expf" in out["digest"]


def test_resolve_code_source_topic_and_cap():
    out = sources.resolve_code_source("x" * 200_000, topic="Meu firmware", focus="code")
    assert out["title"] == "Meu firmware"
    assert len(out["digest"]) == 120_000
```

Novo `tests/courses/test_service_code.py`:

```python
import pytest

from seraphine.courses.schema import migrate
from seraphine.courses.service import CoursesService
from seraphine.memory.store import MemoryStore


async def _store(tmp_path):
    s = MemoryStore(tmp_path / "t.sqlite")
    s.register_migrator("courses", migrate)
    await s.ensure_schema()
    return s


@pytest.mark.asyncio
async def test_create_course_from_code(tmp_path):
    store = await _store(tmp_path)
    svc = CoursesService(store, llm=object(), engine=object())
    captured = {}
    def spawn(coro):
        captured["coro"] = coro
        coro.close()
    svc._spawn = spawn
    out = await svc.create_course(code="int main() { return 0; }", focus="math")
    assert out["status"] == "generating"
    with store._connect() as conn:
        row = conn.execute("SELECT topic, source_ref FROM course WHERE id=?",
                           (out["course_id"],)).fetchone()
    assert row == ("Matemática do código", "code")


@pytest.mark.asyncio
async def test_create_course_requires_topic_or_code(tmp_path):
    store = await _store(tmp_path)
    svc = CoursesService(store)
    with pytest.raises(ValueError):
        await svc.create_course()
```

E em `test_generate.py`: os testes atuais (tópico) devem continuar passando SEM edição — `focus=None` mantém os prompts com o mesmo prefixo de sempre (as instruções KaTeX/graph são sufixo aditivo; se algum teste assertar o texto exato do system prompt, ajustar só esse assert).

- [ ] **Step 3:** FAIL → implementar conforme Interfaces (código completo curto: `resolve_code_source` é ~8 linhas espelhando o retorno do resolve_source; `_outline_system(focus)`/`_lesson_system(focus)` concatenam `(_FOCUS_FRAMING.get(focus, "") if focus else "") + BASE + SUFIXO_KATEX_GRAPH`; `generate_course` escolhe a fonte; `create_course` monta título/source_ref e valida presença).
- [ ] **Step 4:** `uv run pytest tests/courses/ -q` verde; import main ok.
- [ ] **Step 5:** commit `feat(courses): code→course source + focus framing + KaTeX/graph prompt instructions`

---

## Task 4: Rota `{code, focus}` + caps

**Files:**
- Modify: `seraphine/courses/routes.py`
- Test: `tests/courses/test_routes.py` (append)

**Interfaces:**
- Consumes: `create_course(topic=None, code=None, focus='math', tutor_model=None)` (T3).
- Produces: `TopicIn{topic: str | None = None, code: str | None = None, focus: str = "math", tutor_model: str | None = None}`; validações: um de topic/code (400), `focus ∈ {"math","code"}` (400), `len(code) ≤ 200_000` (400), tutor regex atual.

- [ ] **Step 1: testes** (append):

```python
def test_create_from_code_ok(client):
    r = client.post("/courses", json={"code": "int main(){}", "focus": "math"})
    assert r.status_code == 200
    assert r.json()["status"] == "generating"


def test_create_requires_topic_or_code(client):
    assert client.post("/courses", json={}).status_code == 400


def test_create_bad_focus_400(client):
    r = client.post("/courses", json={"code": "x", "focus": "banana"})
    assert r.status_code == 400


def test_create_code_too_big_400(client):
    r = client.post("/courses", json={"code": "x" * 200_001})
    assert r.status_code == 400
```

- [ ] **Step 2:** FAIL → **Step 3:** implementar em `create_course` da rota:

```python
    if not (payload.topic or payload.code):
        raise HTTPException(status_code=400, detail="informe topic ou code")
    if payload.focus not in ("math", "code"):
        raise HTTPException(status_code=400, detail="focus inválido")
    if payload.code and len(payload.code) > 200_000:
        raise HTTPException(status_code=400, detail="code grande demais (200k)")
    # tutor regex igual; chamada:
    return await _svc(request).create_course(
        topic=payload.topic, code=payload.code, focus=payload.focus,
        tutor_model=payload.tutor_model,
    )
```

(Os testes antigos mandam `{"topic": "X"}` — continuam válidos.)

- [ ] **Step 4:** suite verde; import main ok. **Step 5:** commit `feat(courses): route accepts code+focus`

---

## Task 5: `mathexpr.ts` — parser/avaliador seguro (frontend puro)

**Files:**
- Create: `src/courses/mathexpr.ts`, `src/courses/__tests__/mathexpr.test.ts`

**Interfaces:**
- Produces: `parseExpr(src: string): Expr` (AST; throw `Error` em sintaxe/token inválido); `evalExpr(ast: Expr, vars: Record<string, number>): number` (var ausente → throw); tipo `Expr` opaco exportado.

- [ ] **Step 1: teste falhando** — `src/courses/__tests__/mathexpr.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseExpr, evalExpr } from '../mathexpr';

const ev = (src: string, vars: Record<string, number> = {}) => evalExpr(parseExpr(src), vars);

describe('mathexpr', () => {
  it('precedence and parens', () => {
    expect(ev('2+3*4')).toBe(14);
    expect(ev('(2+3)*4')).toBe(20);
    expect(ev('10-4-3')).toBe(3);          // esquerda-assoc
  });
  it('^ right-assoc and unary minus', () => {
    expect(ev('2^3^2')).toBe(512);
    expect(ev('-2^2')).toBe(-4);           // unário aplica depois do ^
    expect(ev('(-2)^2')).toBe(4);
  });
  it('functions, constants, vars', () => {
    expect(ev('exp(0)')).toBe(1);
    expect(ev('sqrt(9) + abs(-2)')).toBe(5);
    expect(ev('pow(2, 10)')).toBe(1024);
    expect(ev('min(3, k)', { k: 2 })).toBe(2);
    expect(ev('sin(pi)', {})).toBeCloseTo(0, 10);
    expect(ev('1 - exp(-k*t)', { k: 10, t: 0.1 })).toBeCloseTo(1 - Math.exp(-1), 10);
  });
  it('rejects garbage', () => {
    expect(() => parseExpr('foo(1)')).toThrow();
    expect(() => parseExpr('1;2')).toThrow();
    expect(() => parseExpr('a b')).toThrow();
    expect(() => parseExpr('')).toThrow();
    expect(() => evalExpr(parseExpr('x+1'), {})).toThrow();  // var ausente
  });
});
```

- [ ] **Step 2:** FAIL. **Step 3: implementação** — `src/courses/mathexpr.ts`:

```typescript
// Parser/avaliador de expressões matemáticas — recursive descent, SEM eval.
// Gramática: expr := term (('+'|'-') term)* ; term := unary (('*'|'/') unary)* ;
// unary := '-' unary | power ; power := atom ('^' unary)?  (dir-assoc) ;
// atom := number | const | var | func '(' expr (',' expr)* ')' | '(' expr ')'

export type Expr =
  | { k: 'num'; v: number }
  | { k: 'var'; name: string }
  | { k: 'bin'; op: string; a: Expr; b: Expr }
  | { k: 'neg'; a: Expr }
  | { k: 'call'; fn: string; args: Expr[] };

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, exp: Math.exp, log: Math.log,
  sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow, min: Math.min, max: Math.max,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.]/.test(c)) {
      const m = /^\d*\.?\d+/.exec(src.slice(i));
      if (!m) throw new Error(`número inválido em ${i}`);
      out.push({ t: 'num', v: parseFloat(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z_0-9]*/.exec(src.slice(i))!;
      out.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if ('+-*/^(),'.includes(c)) { out.push({ t: 'op', v: c }); i++; continue; }
    throw new Error(`token inválido '${c}'`);
  }
  if (!out.length) throw new Error('expressão vazia');
  return out;
}

export function parseExpr(src: string): Expr {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (v?: string): Tok => {
    const t = toks[p];
    if (!t || (v !== undefined && !(t.t === 'op' && t.v === v))) {
      throw new Error(`esperado '${v ?? 'token'}' na posição ${p}`);
    }
    p++; return t;
  };
  function expr(): Expr {
    let a = term();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = (eat() as { v: string }).v;
      a = { k: 'bin', op, a, b: term() };
    }
    return a;
  }
  function term(): Expr {
    let a = unary();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = (eat() as { v: string }).v;
      a = { k: 'bin', op, a, b: unary() };
    }
    return a;
  }
  function unary(): Expr {
    if (peek()?.t === 'op' && peek().v === '-') { eat(); return { k: 'neg', a: unary() }; }
    return power();
  }
  function power(): Expr {
    const a = atom();
    if (peek()?.t === 'op' && peek().v === '^') { eat(); return { k: 'bin', op: '^', a, b: unary() }; }
    return a;
  }
  function atom(): Expr {
    const t = peek();
    if (!t) throw new Error('fim inesperado');
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'id') {
      p++;
      const name = t.v.toLowerCase();
      if (peek()?.t === 'op' && peek().v === '(') {
        if (!(name in FUNCS)) throw new Error(`função desconhecida '${t.v}'`);
        eat('(');
        const args: Expr[] = [expr()];
        while (peek()?.t === 'op' && peek().v === ',') { eat(); args.push(expr()); }
        eat(')');
        return { k: 'call', fn: name, args };
      }
      if (name in CONSTS) return { k: 'num', v: CONSTS[name] };
      return { k: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') { eat('('); const e = expr(); eat(')'); return e; }
    throw new Error(`token inesperado '${'v' in t ? t.v : '?'}'`);
  }
  const root = expr();
  if (p !== toks.length) throw new Error('sobrou conteúdo após a expressão');
  return root;
}

export function evalExpr(ast: Expr, vars: Record<string, number>): number {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'var': {
      if (!(ast.name in vars)) throw new Error(`variável '${ast.name}' ausente`);
      return vars[ast.name];
    }
    case 'neg': return -evalExpr(ast.a, vars);
    case 'bin': {
      const a = evalExpr(ast.a, vars), b = evalExpr(ast.b, vars);
      switch (ast.op) {
        case '+': return a + b; case '-': return a - b;
        case '*': return a * b; case '/': return a / b;
        case '^': return Math.pow(a, b);
        default: throw new Error(`op '${ast.op}'`);
      }
    }
    case 'call': return FUNCS[ast.fn](...ast.args.map((x) => evalExpr(x, vars)));
  }
}
```

- [ ] **Step 4:** `pnpm exec vitest run src/courses` → PASS; tsc limpo.
- [ ] **Step 5:** commit `feat(courses-ui): mathexpr — safe recursive-descent expression evaluator`

---

## Task 6: KaTeX no player + `GraphBlock` (blocos ```graph)

**Files:**
- Modify: `package.json` (deps: `katex`, `remark-math@^6`, `rehype-katex@^7`), `src/courses/LessonPlayer.tsx`, `src/courses/obsidian.css`
- Create: `src/courses/GraphBlock.tsx`

**Interfaces:**
- Consumes: `parseExpr`/`evalExpr` (T5).
- Produces: `GraphBlock({ spec }: { spec: GraphSpec })` com `type GraphSpec = { expr: string; x: { var: string; min: number; max: number }; params?: { name: string; min: number; max: number; default: number }[] }` (exportado de GraphBlock.tsx — T7 reusa). Player renderiza `$...$` via KaTeX e intercepta `language-graph`.

- [ ] **Step 1: deps** — `pnpm add katex remark-math rehype-katex` (confirmar que resolvem com react-markdown@10; `rehype-raw` já presente prova o pipeline rehype).

- [ ] **Step 2: GraphBlock** — `src/courses/GraphBlock.tsx`:

```tsx
import { useMemo, useState } from 'react';
import { parseExpr, evalExpr, type Expr } from './mathexpr';

export type GraphSpec = {
  expr: string;
  x: { var: string; min: number; max: number };
  params?: { name: string; min: number; max: number; default: number }[];
};

const W = 560, H = 220, PAD = 28, SAMPLES = 120;

export function GraphBlock({ spec }: { spec: GraphSpec }) {
  const ast: Expr = useMemo(() => parseExpr(spec.expr), [spec.expr]);
  const [params, setParams] = useState<Record<string, number>>(() =>
    Object.fromEntries((spec.params ?? []).map((p) => [p.name, p.default])));

  const pts = useMemo(() => {
    const out: [number, number][] = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const x = spec.x.min + (i / SAMPLES) * (spec.x.max - spec.x.min);
      const y = evalExpr(ast, { ...params, [spec.x.var]: x });
      if (Number.isFinite(y)) out.push([x, y]);
    }
    return out;
  }, [ast, params, spec]);

  if (!pts.length) return null;
  const ys = pts.map(([, y]) => y);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const ySpan = yMax - yMin || 1;
  const sx = (x: number) => PAD + ((x - spec.x.min) / (spec.x.max - spec.x.min)) * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - yMin) / ySpan) * (H - 2 * PAD);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ');

  return (
    <figure className="tr-graph">
      <svg viewBox={`0 0 ${W} ${H}`} className="tr-graph__svg" role="img" aria-label={spec.expr}>
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD} className="tr-graph__axis" />
        <line x1={PAD} y1={PAD} x2={PAD} y2={H - PAD} className="tr-graph__axis" />
        <path d={d} className="tr-graph__curve" fill="none" />
        <text x={W - PAD} y={H - 8} className="tr-graph__lbl" textAnchor="end">{spec.x.var}</text>
      </svg>
      <figcaption className="tr-graph__expr"><code>{spec.expr}</code></figcaption>
      {(spec.params ?? []).map((p) => (
        <label key={p.name} className="tr-graph__slider">
          <span>{p.name} = {params[p.name].toFixed(2)}</span>
          <input type="range" min={p.min} max={p.max} step={(p.max - p.min) / 100}
            value={params[p.name]}
            onChange={(e) => setParams({ ...params, [p.name]: Number(e.target.value) })} />
        </label>
      ))}
    </figure>
  );
}
```

- [ ] **Step 3: player** — em `LessonPlayer.tsx`:

```tsx
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import { GraphBlock, type GraphSpec } from './GraphBlock';

function MaybeGraph({ className, children }: { className?: string; children?: React.ReactNode }) {
  if (className === 'language-graph') {
    try {
      const spec = JSON.parse(String(children)) as GraphSpec;
      // valida o mínimo antes de montar (parseExpr valida o resto e MaybeGraph
      // é envolvido por try — spec ruim cai no <code> normal)
      if (spec && typeof spec.expr === 'string' && spec.x) return <GraphBlock spec={spec} />;
    } catch { /* fail-soft */ }
  }
  return <code className={className}>{children}</code>;
}
```

e o `<Markdown>` da teoria vira:

```tsx
<Markdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}
  components={{ code: MaybeGraph }}>{lesson.concept_md}</Markdown>
```

ATENÇÃO: `GraphBlock` chama `parseExpr` no `useMemo` SEM try — envolver a montagem: dentro do `MaybeGraph`, embrulhar `<GraphBlock>` num error boundary simples OU (mais simples) validar com `parseExpr(spec.expr)` dentro do try do MaybeGraph antes de retornar o componente. Implementar a segunda (parse no try; se passou, o GraphBlock re-parseia com sucesso garantido).

CSS (append em `obsidian.css`):

```css
/* ── gráficos interativos ── */
.tr-graph { margin: 0 0 14px; padding: 12px; border-radius: 14px; background: var(--surface, #17171e); border: 1px solid var(--border, rgba(255,255,255,.08)); }
.tr-graph__svg { width: 100%; height: auto; }
.tr-graph__axis { stroke: var(--border-strong, rgba(255,255,255,.12)); stroke-width: 1; }
.tr-graph__curve { stroke: var(--accent, #9a93ff); stroke-width: 2.5; }
.tr-graph__lbl { fill: var(--text-faint, #5f5e6b); font-size: 11px; }
.tr-graph__expr { font-size: 12px; color: var(--text-dim, #9594a0); margin: 6px 0 8px; }
.tr-graph__slider { display: flex; align-items: center; gap: 12px; font-size: 13px; color: var(--text, #ececef); padding: 4px 0; }
.tr-graph__slider span { min-width: 90px; font-family: ui-monospace, Menlo, monospace; }
.tr-graph__slider input { flex: 1; accent-color: var(--accent, #9a93ff); }
```

- [ ] **Step 4:** tsc limpo; vitest verde; smoke manual: lição com `$x^2$` e bloco graph renderiza (dev).
- [ ] **Step 5:** commit `feat(courses-ui): KaTeX no player + GraphBlock interativo (blocos graph)`

---

## Task 7: `ExerciseGraph` — 5º renderer

**Files:**
- Create: `src/courses/exercises/ExerciseGraph.tsx`, `src/courses/exercises/__tests__/graph-grading.test.ts`
- Modify: `src/courses/LessonPlayer.tsx` (case + eyebrow), `src/courses/api.ts` (payload type)

**Interfaces:**
- Consumes: `GraphBlock`/`GraphSpec` (T6), contrato `({exercise, onResult})`.
- Produces: helper puro `checkGraphTarget(value: number, target: number, tol: number): boolean` (em `exercises/grading.ts` — append); `ExerciseGraph`; `Exercise.payload` ganha campos opcionais `expr/x/params/target` (api.ts); eyebrow `graph: 'Ajuste o gráfico'`.

- [ ] **Step 1: teste puro** (append em grading.ts + novo test):

```typescript
// grading.ts (append)
export function checkGraphTarget(value: number, target: number, tol: number): boolean {
  return Number.isFinite(value) && Math.abs(value - target) <= tol;
}
```

```typescript
// exercises/__tests__/graph-grading.test.ts
import { describe, it, expect } from 'vitest';
import { checkGraphTarget } from '../grading';

describe('checkGraphTarget', () => {
  it('within tolerance', () => {
    expect(checkGraphTarget(9.2, 10, 1)).toBe(true);
    expect(checkGraphTarget(11, 10, 1)).toBe(true);
  });
  it('outside', () => {
    expect(checkGraphTarget(11.01, 10, 1)).toBe(false);
    expect(checkGraphTarget(NaN, 10, 1)).toBe(false);
  });
});
```

- [ ] **Step 2:** FAIL → helper → PASS.

- [ ] **Step 3: componente** — `src/courses/exercises/ExerciseGraph.tsx`:

```tsx
import { useState } from 'react';
import type { Exercise } from '../api';
import { GraphBlock, type GraphSpec } from '../GraphBlock';
import { checkGraphTarget } from './grading';

export function ExerciseGraph({ exercise, onResult }:
  { exercise: Exercise; onResult: (c: boolean) => void }) {
  const p = exercise.payload;
  const spec: GraphSpec | null = p.expr && p.x
    ? { expr: p.expr, x: p.x, params: p.params } : null;
  const target = p.target;
  const [values, setValues] = useState<Record<string, number>>(() =>
    Object.fromEntries((p.params ?? []).map((q) => [q.name, q.default])));
  const [touched, setTouched] = useState(false);
  const [answered, setAnswered] = useState(false);

  if (!spec || !target) return <div className="tr-ex">Exercício indisponível.</div>;

  const verify = () => {
    if (answered) return;
    setAnswered(true);
    onResult(checkGraphTarget(values[target.param], target.value, target.tol));
  };

  return (
    <div className="tr-ex">
      <p className="tr-ex__prompt">{exercise.prompt}</p>
      {/* GraphBlock com sliders controlados aqui: passa spec com defaults = values */}
      <GraphBlock spec={{ ...spec, params: (spec.params ?? []).map((q) => ({ ...q, default: values[q.name] })) }}
        key={JSON.stringify(values) /* re-render simples do plot com os valores atuais */} />
      {(spec.params ?? []).map((q) => (
        <label key={q.name} className="tr-graph__slider">
          <span>{q.name} = {values[q.name].toFixed(2)}</span>
          <input type="range" min={q.min} max={q.max} step={(q.max - q.min) / 100}
            disabled={answered} value={values[q.name]}
            onChange={(e) => { setTouched(true); setValues({ ...values, [q.name]: Number(e.target.value) }); }} />
        </label>
      ))}
      {!answered && (
        <button type="button" className="tr-btn tr-btn--full" disabled={!touched} onClick={verify}>
          Verificar
        </button>
      )}
    </div>
  );
}
```

> Nota de implementação: o GraphBlock também renderiza sliders próprios — pra não duplicar, adicionar prop opcional `hideSliders?: boolean` ao GraphBlock (T6 prevê? adicionar AQUI: `{ spec, hideSliders = false }` e `{!hideSliders && (spec.params ?? []).map(...)}`) e usar `hideSliders` no ExerciseGraph. Ajuste pequeno no GraphBlock nesta task.

- [ ] **Step 4: player** — `EYEBROW` ganha `graph: 'Ajuste o gráfico'`; case `{ex.type === 'graph' && <ExerciseGraph exercise={ex} onResult={onResult} />}`; `api.ts` `Exercise.payload` ganha `expr?: string; x?: { var: string; min: number; max: number }; params?: { name: string; min: number; max: number; default: number }[]; target?: { param: string; value: number; tol: number };` e `ExerciseType` union ganha `'graph'`.
- [ ] **Step 5:** tsc + vitest verdes. **Step 6:** commit `feat(courses-ui): graph exercise renderer (adjust-the-parameter)`

---

## Task 8: Card de criação — expander "colar código" + foco

**Files:**
- Modify: `src/courses/TrilhasView.tsx`, `src/courses/api.ts`, `src/courses/obsidian.css`

**Interfaces:**
- Consumes: rota `{code, focus}` (T4).
- Produces: `createCourse(input: { topic?: string; code?: string; focus?: 'math' | 'code'; tutorModel?: string })` (migra a assinatura; ajustar o call-site existente).

- [ ] **Step 1: api.ts** — substituir `createCourse`:

```typescript
export interface CreateCourseInput {
  topic?: string;
  code?: string;
  focus?: 'math' | 'code';
  tutorModel?: string;
}

export async function createCourse(input: CreateCourseInput): Promise<{ course_id: string; status: string }> {
  const body: Record<string, unknown> = {};
  if (input.topic) body.topic = input.topic;
  if (input.code) { body.code = input.code; body.focus = input.focus ?? 'math'; }
  if (input.tutorModel) body.tutor_model = input.tutorModel;
  return j(await fetch(`${API_BASE}/courses`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}
```

- [ ] **Step 2: TrilhasView** — estados novos `codeMode` (bool), `code` (string), `focus` (`'math' | 'code'`, default `'math'`); no card `tr-create`: botão-toggle "colar código" (ícone `CommandIcon` ou similar SVG existente); quando `codeMode`: textarea `tr-create__code` (mono, rows≈10, placeholder "Cole o código aqui…") + radios de foco + o campo de tópico vira "Título (opcional)". `create()` → `createCourse({ topic: topic.trim() || undefined, code: codeMode ? code : undefined, focus, tutorModel: tutorModel || undefined })`; gate do botão: `codeMode ? code.trim() : topic.trim()`.

- [ ] **Step 3: CSS** (append):

```css
.tr-create__toggle { background: none; border: 1px solid var(--border-strong, rgba(255,255,255,.12)); border-radius: 10px; color: var(--text-dim, #9594a0); font: inherit; font-size: 12px; padding: 8px 12px; cursor: pointer; }
.tr-create__toggle--on { color: var(--accent, #9a93ff); border-color: rgba(154,147,255,.4); }
.tr-create__code { width: 100%; min-height: 180px; resize: vertical; font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; padding: 12px; border-radius: 12px; background: var(--app, #0f0f14); color: var(--text, #ececef); border: 1px solid var(--border-strong, rgba(255,255,255,.12)); }
.tr-create__focus { display: flex; gap: 14px; font-size: 12.5px; color: var(--text-dim, #9594a0); }
.tr-create__focus label { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
```

(O layout do card muda pra coluna quando `codeMode` — wrapper `tr-create--code { flex-direction: column; align-items: stretch; }`.)

- [ ] **Step 4:** tsc + vitest verdes; smoke dev (colar código → criar). **Step 5:** commit `feat(courses-ui): paste-code expander with focus selector`

---

## Task 9: Verificação E2E

- [ ] **Step 1:** `uv run pytest tests/courses/ -q` verde; `import seraphine.main` ok; `pnpm exec tsc --noEmit` limpo; `pnpm exec vitest run src/courses` verde; emoji grep limpo em `src/courses/` + `seraphine/courses/`.
- [ ] **Step 2 (manual pós-deploy):** colar o firmware `.ino` dos olhos EVA com foco "Matemática do código" → trilha com lições ancoradas em `smoothTo`/`smoothStep`/`drawEvaEye`; fórmulas renderizadas; bloco graph com slider mexendo a curva; exercício graph corrigindo por tolerância.

## Self-Review (cobertura do spec)

- `_valid_expr` whitelist: T1 ✓ · tipo graph validado: T2 ✓ · caminho code + foco + prompts KaTeX/graph: T3 ✓ · rota {code,focus}+caps: T4 ✓ · mathexpr sem eval: T5 ✓ · KaTeX + GraphBlock fail-soft: T6 ✓ · ExerciseGraph tolerância/1× onResult: T7 ✓ · expander+focus na UI: T8 ✓ · fontes existentes intactas: T3/T4 (topic path) ✓ · deps só frontend: T6 ✓ · E2E: T9 ✓
- Consistência de tipos: `GraphSpec` (T6) reusada em T7; `createCourse` objeto (T8) compatível com a rota (T4); payload graph idêntico em T2 (server) e api.ts (T7).
