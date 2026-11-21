// Tiny, safe expression language for scoring rules and end conditions.
//
//   max(0, teamTricks - 6)        score >= 5 && handsPlayed > 1
//   wonCount("suit", "Hearts")    tricks == 0 ? 10 : 0
//
// Numbers, "strings", variables (looked up in a scope object), functions
// (also from the scope), + - * / %, comparisons, && || !, and ?: .
// No property access, no assignment, no eval - designers' text is never run as code.

const OPS = {
  '||': [1, (a, b) => a || b], '&&': [2, (a, b) => a && b],
  '==': [3, (a, b) => a == b], '!=': [3, (a, b) => a != b], // eslint-disable-line eqeqeq
  '<': [4, (a, b) => a < b], '<=': [4, (a, b) => a <= b], '>': [4, (a, b) => a > b], '>=': [4, (a, b) => a >= b],
  '+': [5, (a, b) => a + b], '-': [5, (a, b) => a - b],
  '*': [6, (a, b) => a * b], '/': [6, (a, b) => (b === 0 ? 0 : a / b)], '%': [6, (a, b) => (b === 0 ? 0 : a % b)],
};

function tokenize(src) {
  const out = [];
  const re = /\s*(?:(\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|"([^"]*)"|'([^']*)'|(\|\||&&|==|!=|<=|>=|[-+*/%<>()!,?:]))/y;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    const start = re.lastIndex;
    if (/^\s*$/.test(src.slice(start))) break;
    m = re.exec(src);
    if (!m) throw new Error(`Unexpected "${src.slice(start).trim()[0]}"`);
    if (m[1] !== undefined) out.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] !== undefined) out.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined || m[4] !== undefined) out.push({ t: 'str', v: m[3] ?? m[4] });
    else out.push({ t: 'op', v: m[5] });
  }
  return out;
}

// Compile to a tree once; evaluate many times.
export function compile(src) {
  const toks = tokenize(String(src ?? ''));
  let i = 0;
  const peek = () => toks[i];
  const take = (v) => {
    const t = toks[i];
    if (!t || (v && t.v !== v)) throw new Error(v ? `Expected "${v}"` : 'Unexpected end of formula');
    i++;
    return t;
  };
  function primary() {
    const t = take();
    if (t.t === 'num' || t.t === 'str') return { k: 'lit', v: t.v };
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { k: 'lit', v: t.v === 'true' };
      if (peek()?.v === '(') {
        take('(');
        const args = [];
        if (peek()?.v !== ')') {
          do { args.push(ternary()); } while (peek()?.v === ',' && take(','));
        }
        take(')');
        return { k: 'call', name: t.v, args };
      }
      return { k: 'var', name: t.v };
    }
    if (t.v === '(') { const e = ternary(); take(')'); return e; }
    if (t.v === '-') return { k: 'neg', e: unary() };
    if (t.v === '!') return { k: 'not', e: unary() };
    throw new Error(`Unexpected "${t.v}"`);
  }
  function unary() { return primary(); }
  function binary(minPrec) {
    let left = unary();
    for (;;) {
      const t = peek();
      const op = t?.t === 'op' && OPS[t.v];
      if (!op || op[0] < minPrec) return left;
      i++;
      const right = binary(op[0] + 1);
      left = { k: 'bin', op: t.v, l: left, r: right };
    }
  }
  function ternary() {
    const cond = binary(1);
    if (peek()?.v === '?') {
      take('?');
      const a = ternary();
      take(':');
      const b = ternary();
      return { k: 'if', c: cond, a, b };
    }
    return cond;
  }
  if (!toks.length) throw new Error('Empty formula');
  const tree = ternary();
  if (i < toks.length) throw new Error(`Unexpected "${toks[i].v}"`);
  return tree;
}

export const BUILTINS = {
  max: Math.max, min: Math.min, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
};

export function evaluate(tree, scope) {
  switch (tree.k) {
    case 'lit': return tree.v;
    case 'var':
      if (!(tree.name in scope)) throw new Error(`Unknown name "${tree.name}"`);
      return typeof scope[tree.name] === 'function' ? scope[tree.name]() : scope[tree.name];
    case 'call': {
      const fn = scope[tree.name] ?? BUILTINS[tree.name];
      if (typeof fn !== 'function') throw new Error(`Unknown function "${tree.name}"`);
      return fn(...tree.args.map((a) => evaluate(a, scope)));
    }
    case 'neg': return -evaluate(tree.e, scope);
    case 'not': return !evaluate(tree.e, scope);
    case 'if': return evaluate(tree.c, scope) ? evaluate(tree.a, scope) : evaluate(tree.b, scope);
    case 'bin': {
      if (tree.op === '&&') return evaluate(tree.l, scope) && evaluate(tree.r, scope);
      if (tree.op === '||') return evaluate(tree.l, scope) || evaluate(tree.r, scope);
      return OPS[tree.op][1](evaluate(tree.l, scope), evaluate(tree.r, scope));
    }
    default: throw new Error('Bad formula');
  }
}

const cache = new Map();
export function run(src, scope) {
  let tree = cache.get(src);
  if (!tree) { tree = compile(src); cache.set(src, tree); }
  return evaluate(tree, scope);
}

// Returns an error message, or '' when the formula parses.
export function check(src) {
  try { compile(src); return ''; } catch (e) { return e.message; }
}
