/**
 * The guard / assignment expression language (Q4).
 *
 * Deliberately small: numbers, strings, booleans, dotted lookups, arithmetic,
 * comparison, and/or/not, and `in_state(<path>)`. No user functions, no collections
 * (except `for_each`, which is handled by the engine, not here), no arbitrary JS — so a
 * model file someone mailed you is data, not code.
 *
 * Every evaluation records the lookups it made, which is what lets R21 report *why* a
 * guard failed with the values it actually saw, rather than just "false".
 */
import { ExprError, type Json } from "./types.ts";

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "name"; v: string }
  | { t: "op"; v: string }
  | { t: "end" };

const OPS = ["==", "!=", "<=", ">=", "(", ")", ",", "<", ">", "+", "-", "*", "/"];

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      while (j < src.length && /[0-9._]/.test(src[j]!)) j++;
      const raw = src.slice(i, j).replace(/_/g, "");
      const n = Number(raw);
      if (Number.isNaN(n)) throw new ExprError(`not a number: ${raw}`);
      out.push({ t: "num", v: n });
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = src.indexOf(c, i + 1);
      if (end < 0) throw new ExprError(`unterminated string in ${src}`);
      out.push({ t: "str", v: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) j++;
      out.push({ t: "name", v: src.slice(i, j) });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExprError(`unexpected character ${JSON.stringify(c)} in ${src}`);
    out.push({ t: "op", v: op });
    i += op.length;
  }
  out.push({ t: "end" });
  return out;
}

export type Node =
  | { n: "lit"; v: Json }
  | { n: "ref"; path: string }
  | { n: "in_state"; path: string }
  | { n: "un"; op: string; a: Node }
  | { n: "bin"; op: string; a: Node; b: Node };

const BINDING: Record<string, number> = {
  or: 1, and: 2,
  "==": 3, "!=": 3, "<": 3, "<=": 3, ">": 3, ">=": 3,
  "+": 4, "-": 4,
  "*": 5, "/": 5,
};

/**
 * Each expression is parsed once (B-4): a model says the same guards and templates over and over, and a
 * run evaluates them thousands of times. A parsed tree is never changed, so it is shared. An expression
 * that does not parse is not kept: it says why each time it is read.
 */
const parsed = new Map<string, Node>();

export function parse(src: string): Node {
  let tree = parsed.get(src);
  if (tree === undefined) {
    tree = parseText(src);
    parsed.set(src, tree);
  }
  return tree;
}

function parseText(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;

  function primary(): Node {
    const tk = next();
    if (tk.t === "num") return { n: "lit", v: tk.v };
    if (tk.t === "str") return { n: "lit", v: tk.v };
    if (tk.t === "name") {
      if (tk.v === "true") return { n: "lit", v: true };
      if (tk.v === "false") return { n: "lit", v: false };
      if (tk.v === "null") return { n: "lit", v: null };
      if (tk.v === "not") return { n: "un", op: "not", a: unary() };
      if (tk.v === "in_state") {
        // Special form: the argument is a state path, not a variable to look up.
        const open = next();
        if (!(open.t === "op" && open.v === "(")) throw new ExprError("in_state needs (path)");
        const arg = next();
        if (arg.t !== "name" && arg.t !== "str") throw new ExprError("in_state needs a state path");
        const close = next();
        if (!(close.t === "op" && close.v === ")")) throw new ExprError("in_state: missing )");
        return { n: "in_state", path: String(arg.v) };
      }
      return { n: "ref", path: tk.v };
    }
    if (tk.t === "op" && tk.v === "(") {
      const e = expr(0);
      const close = next();
      if (!(close.t === "op" && close.v === ")")) throw new ExprError(`missing ) in ${src}`);
      return e;
    }
    throw new ExprError(`unexpected ${JSON.stringify(tk)} in ${src}`);
  }

  function unary(): Node {
    const tk = peek();
    if (tk.t === "op" && tk.v === "-") { next(); return { n: "un", op: "-", a: unary() }; }
    if (tk.t === "name" && tk.v === "not") { next(); return { n: "un", op: "not", a: unary() }; }
    return primary();
  }

  function expr(min: number): Node {
    let left = unary();
    for (;;) {
      const tk = peek();
      const op = tk.t === "op" ? tk.v : tk.t === "name" && (tk.v === "and" || tk.v === "or") ? tk.v : undefined;
      if (!op) break;
      const bp = BINDING[op];
      if (bp === undefined || bp < min) break;
      next();
      const right = expr(bp + 1);
      left = { n: "bin", op, a: left, b: right };
    }
    return left;
  }

  const out = expr(0);
  if (peek().t !== "end") throw new ExprError(`trailing input in ${src}`);
  return out;
}

/** Every dotted reference an expression reads — used by the accumulator lint. */
export function refsOf(src: string): string[] {
  const out: string[] = [];
  const walk = (n: Node): void => {
    switch (n.n) {
      case "ref": out.push(n.path); return;
      case "un": return walk(n.a);
      case "bin": walk(n.a); return walk(n.b);
      default: return;
    }
  };
  walk(parse(src));
  return out;
}

export interface Scope {
  vars: Record<string, Json>;
  /** Dotted paths of every active state, for in_state(). */
  active: Set<string>;
}

export interface Eval {
  value: Json;
  /** Every lookup made, in order, so a failed guard can be explained. */
  lookups: { path: string; value: Json }[];
}

function lookup(scope: Scope, path: string): Json {
  const parts = path.split(".");
  let cur: Json = scope.vars as Json;
  const walked: string[] = [];
  for (const part of parts) {
    walked.push(part);
    if (cur === null || typeof cur !== "object" || Array.isArray(cur) || !(part in cur)) {
      throw new ExprError(`unknown reference \`${path}\` (no \`${walked.join(".")}\`)`);
    }
    cur = (cur as { [k: string]: Json })[part]!;
  }
  return cur;
}

function truthy(v: Json): boolean {
  if (typeof v === "boolean") return v;
  throw new ExprError(`expected a boolean, got ${JSON.stringify(v)}`);
}

function num(v: Json, op: string): number {
  if (typeof v === "number") return v;
  throw new ExprError(`\`${op}\` needs numbers, got ${JSON.stringify(v)}`);
}

export function evaluate(src: string, scope: Scope): Eval {
  const lookups: { path: string; value: Json }[] = [];
  const walk = (node: Node): Json => {
    switch (node.n) {
      case "lit":
        return node.v;
      case "ref": {
        const v = lookup(scope, node.path);
        lookups.push({ path: node.path, value: v });
        return v;
      }
      case "in_state": {
        const v = scope.active.has(node.path);
        lookups.push({ path: `in_state(${node.path})`, value: v });
        return v;
      }
      case "un":
        if (node.op === "not") return !truthy(walk(node.a));
        return -num(walk(node.a), "-");
      case "bin": {
        if (node.op === "and") return truthy(walk(node.a)) ? truthy(walk(node.b)) : false;
        if (node.op === "or") return truthy(walk(node.a)) ? true : truthy(walk(node.b));
        const a = walk(node.a);
        const b = walk(node.b);
        switch (node.op) {
          case "==": return JSON.stringify(a) === JSON.stringify(b);
          case "!=": return JSON.stringify(a) !== JSON.stringify(b);
          case "<": return num(a, "<") < num(b, "<");
          case "<=": return num(a, "<=") <= num(b, "<=");
          case ">": return num(a, ">") > num(b, ">");
          case ">=": return num(a, ">=") >= num(b, ">=");
          case "+":
            if (typeof a === "string" || typeof b === "string") return String(a) + String(b);
            return num(a, "+") + num(b, "+");
          case "-": return num(a, "-") - num(b, "-");
          case "*": return num(a, "*") * num(b, "*");
          case "/": {
            const d = num(b, "/");
            if (d === 0) throw new ExprError("division by zero");
            return num(a, "/") / d;
          }
        }
        throw new ExprError(`unknown operator ${node.op}`);
      }
    }
  };
  return { value: walk(parse(src)), lookups };
}

/** Renders the lookups a guard made, for the rejection chain (R21). */
export function explain(ev: Eval): string {
  if (ev.lookups.length === 0) return "";
  const seen = new Map<string, Json>();
  for (const l of ev.lookups) seen.set(l.path, l.value);
  return [...seen].map(([p, v]) => `${p}=${JSON.stringify(v)}`).join(", ");
}

/**
 * A template string: literal text with `${expr}` holes. A string that is exactly one hole
 * keeps the expression's native type, so `"${command.items}"` stays an array.
 */
export function template(src: string, scope: Scope): Json {
  const whole = /^\$\{([^}]*)\}$/.exec(src);
  if (whole) return evaluate(whole[1]!, scope).value;
  if (!src.includes("${")) return src;
  return src.replace(/\$\{([^}]*)\}/g, (_m, e: string) => {
    const v = evaluate(e, scope).value;
    return typeof v === "string" ? v : JSON.stringify(v);
  });
}

export function templateObject(
  spec: Record<string, Json>,
  scope: Scope,
): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(spec)) out[k] = templateValue(v, scope);
  return out;
}

/**
 * Holes are filled at every depth: `samples: ["${event.sample}"]` is a one-element list, and a row
 * in a list of rows is filled like a payload. A hole left unfilled because it sat inside a
 * list would reach the receiver as the literal text `${event.sample}` — a silent wrong answer.
 */
function templateValue(v: Json, scope: Scope): Json {
  if (typeof v === "string") return template(v, scope);
  if (Array.isArray(v)) return v.map((x) => templateValue(x, scope));
  if (v !== null && typeof v === "object") return templateObject(v as Record<string, Json>, scope);
  return v;
}
