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

// Own-property guard — evita walk na prototype chain (constructor, __proto__, hasOwnProperty…).
const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

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
        if (!has(FUNCS, name)) throw new Error(`função desconhecida '${t.v}'`);
        eat('(');
        const args: Expr[] = [expr()];
        while (peek()?.t === 'op' && peek().v === ',') { eat(); args.push(expr()); }
        eat(')');
        return { k: 'call', fn: name, args };
      }
      if (has(CONSTS, name)) return { k: 'num', v: CONSTS[name] };
      return { k: 'var', name: t.v };
    }
    if (t.t === 'op' && t.v === '(') { eat('('); const e = expr(); eat(')'); return e; }
    throw new Error(`token inesperado '${'v' in t ? t.v : '?'}'`);
  }
  const root = expr();
  if (p !== toks.length) throw new Error('sobrou conteúdo após a expressão');
  return root;
}

export function exprVars(ast: Expr): Set<string> {
  const out = new Set<string>();
  const walk = (e: Expr): void => {
    switch (e.k) {
      case 'var': out.add(e.name); break;
      case 'neg': walk(e.a); break;
      case 'bin': walk(e.a); walk(e.b); break;
      case 'call': e.args.forEach(walk); break;
      case 'num': break;
    }
  };
  walk(ast);
  return out;
}

export function evalExpr(ast: Expr, vars: Record<string, number>): number {
  switch (ast.k) {
    case 'num': return ast.v;
    case 'var': {
      if (!has(vars, ast.name)) throw new Error(`variável '${ast.name}' ausente`);
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
