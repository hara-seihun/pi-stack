/**
 * The gate expression language, kept deliberately tiny: comparisons of
 * `taskId.demand` against number literals, combined with `and`/`or` and
 * parentheses. Gates reference demand values only -- never other gates -- so
 * cycles are impossible by construction.
 */

export type GateAst =
  | { readonly kind: "cmp"; readonly ref: string; readonly op: Op; readonly value: number }
  | { readonly kind: "and" | "or"; readonly left: GateAst; readonly right: GateAst };

type Op = "==" | "!=" | "<" | "<=" | ">" | ">=";

const TOKEN =
  /\s*(?:(\()|(\))|(and\b)|(or\b)|(==|!=|<=|>=|<|>)|([A-Za-z0-9_-]+)\.demand\b|(-?\d+(?:\.\d+)?))/y;

interface Token {
  kind: "lparen" | "rparen" | "and" | "or" | "op" | "ref" | "number";
  text: string;
}

function tokenize(source: string): Token[] {
  const out: Token[] = [];
  let pos = 0;
  while (pos < source.length) {
    TOKEN.lastIndex = pos;
    const m = TOKEN.exec(source);
    if (!m) {
      if (source.slice(pos).trim() === "") break;
      throw new Error(`gate syntax error at "${source.slice(pos).trim()}"`);
    }
    pos = TOKEN.lastIndex;
    if (m[1]) out.push({ kind: "lparen", text: m[1] });
    else if (m[2]) out.push({ kind: "rparen", text: m[2] });
    else if (m[3]) out.push({ kind: "and", text: m[3] });
    else if (m[4]) out.push({ kind: "or", text: m[4] });
    else if (m[5]) out.push({ kind: "op", text: m[5] });
    else if (m[6]) out.push({ kind: "ref", text: m[6] });
    else if (m[7]) out.push({ kind: "number", text: m[7] });
  }
  return out;
}

export function parseGate(source: string): GateAst {
  const tokens = tokenize(source);
  let i = 0;
  const peek = () => tokens[i];
  const take = (kind: Token["kind"]): Token => {
    const t = tokens[i];
    if (!t || t.kind !== kind) {
      throw new Error(`gate syntax error: expected ${kind}, got "${t?.text ?? "end"}" in "${source}"`);
    }
    i++;
    return t;
  };
  const parseAtom = (): GateAst => {
    if (peek()?.kind === "lparen") {
      take("lparen");
      const inner = parseOr();
      take("rparen");
      return inner;
    }
    const ref = take("ref").text;
    const op = take("op").text as Op;
    const value = Number(take("number").text);
    return { kind: "cmp", ref, op, value };
  };
  const parseAnd = (): GateAst => {
    let left = parseAtom();
    while (peek()?.kind === "and") {
      take("and");
      left = { kind: "and", left, right: parseAtom() };
    }
    return left;
  };
  const parseOr = (): GateAst => {
    let left = parseAnd();
    while (peek()?.kind === "or") {
      take("or");
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  };
  const ast = parseOr();
  if (i !== tokens.length) {
    throw new Error(`gate syntax error: trailing "${tokens[i].text}" in "${source}"`);
  }
  return ast;
}

export function gateRefs(ast: GateAst): string[] {
  if (ast.kind === "cmp") return [ast.ref];
  return [...new Set([...gateRefs(ast.left), ...gateRefs(ast.right)])];
}

/**
 * Evaluates a gate against known demand values. `undefined` means the gate
 * cannot be evaluated (a referenced demand is unknown); callers must treat
 * that as closed -- fail-safe, never fail-open.
 */
export function evalGate(
  ast: GateAst,
  demand: (taskId: string) => number | undefined,
): boolean | undefined {
  if (ast.kind === "cmp") {
    const v = demand(ast.ref);
    if (v === undefined) return undefined;
    switch (ast.op) {
      case "==": return v === ast.value;
      case "!=": return v !== ast.value;
      case "<": return v < ast.value;
      case "<=": return v <= ast.value;
      case ">": return v > ast.value;
      case ">=": return v >= ast.value;
    }
  }
  const l = evalGate(ast.left, demand);
  const r = evalGate(ast.right, demand);
  if (ast.kind === "and") {
    if (l === false || r === false) return false;
    if (l === undefined || r === undefined) return undefined;
    return true;
  }
  if (l === true || r === true) return true;
  if (l === undefined || r === undefined) return undefined;
  return false;
}
