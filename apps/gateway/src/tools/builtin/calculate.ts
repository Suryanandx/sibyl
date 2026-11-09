/**
 * `calculate`: a safe arithmetic evaluator. A tiny tokenizer + Pratt parser —
 * no eval, no Function, no property access; only numbers, operators, a fixed
 * set of functions and constants.
 */
import type { ToolDefinition } from "@open-gpt-live/core";

type Token =
  | { kind: "num"; value: number; pos: number }
  | { kind: "ident"; value: string; pos: number }
  | { kind: "op"; value: string; pos: number }
  | { kind: "eof"; pos: number };

export class CalcError extends Error {}

const MAX_LENGTH = 1_000;
const MAX_DEPTH = 100;

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  π: Math.PI,
  e: Math.E,
  tau: 2 * Math.PI,
  phi: (1 + Math.sqrt(5)) / 2,
  inf: Infinity,
  infinity: Infinity
};

type Fn = { min: number; max: number; apply: (...args: number[]) => number };
const fn = (min: number, max: number, apply: (...args: number[]) => number): Fn => ({ min, max, apply });

const FUNCTIONS: Record<string, Fn> = {
  sqrt: fn(1, 1, Math.sqrt),
  cbrt: fn(1, 1, Math.cbrt),
  abs: fn(1, 1, Math.abs),
  floor: fn(1, 1, Math.floor),
  ceil: fn(1, 1, Math.ceil),
  trunc: fn(1, 1, Math.trunc),
  sign: fn(1, 1, Math.sign),
  round: fn(1, 2, (x, digits = 0) => {
    const factor = 10 ** Math.trunc(digits);
    return Math.round(x * factor) / factor;
  }),
  sin: fn(1, 1, Math.sin),
  cos: fn(1, 1, Math.cos),
  tan: fn(1, 1, Math.tan),
  asin: fn(1, 1, Math.asin),
  acos: fn(1, 1, Math.acos),
  atan: fn(1, 1, Math.atan),
  atan2: fn(2, 2, Math.atan2),
  sinh: fn(1, 1, Math.sinh),
  cosh: fn(1, 1, Math.cosh),
  tanh: fn(1, 1, Math.tanh),
  deg: fn(1, 1, (x) => (x * 180) / Math.PI),
  rad: fn(1, 1, (x) => (x * Math.PI) / 180),
  ln: fn(1, 1, Math.log),
  log: fn(1, 2, (x, base) => (base === undefined ? Math.log10(x) : Math.log(x) / Math.log(base))),
  log10: fn(1, 1, Math.log10),
  log2: fn(1, 1, Math.log2),
  exp: fn(1, 1, Math.exp),
  pow: fn(2, 2, Math.pow),
  min: fn(1, 100, Math.min),
  max: fn(1, 100, Math.max),
  hypot: fn(1, 100, Math.hypot),
  mod: fn(2, 2, (a, b) => a % b),
  factorial: fn(1, 1, factorial),
  avg: fn(1, 100, (...xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length),
  mean: fn(1, 100, (...xs) => xs.reduce((sum, x) => sum + x, 0) / xs.length),
  sum: fn(1, 100, (...xs) => xs.reduce((sum, x) => sum + x, 0))
};

function factorial(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new CalcError("factorial needs a non-negative integer");
  if (n > 170) return Infinity;
  let result = 1;
  for (let i = 2; i <= n; i += 1) result *= i;
  return result;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const numberMatch = /^(?:\d[\d_]*(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(i));
    if (numberMatch) {
      const raw = numberMatch[0].replace(/_/g, "");
      tokens.push({ kind: "num", value: Number(raw), pos: i });
      i += numberMatch[0].length;
      continue;
    }
    const identMatch = /^[a-zA-Zπ][a-zA-Z0-9_]*/.exec(source.slice(i));
    if (identMatch) {
      tokens.push({ kind: "ident", value: identMatch[0].toLowerCase(), pos: i });
      i += identMatch[0].length;
      continue;
    }
    if (source.startsWith("**", i)) {
      tokens.push({ kind: "op", value: "^", pos: i });
      i += 2;
      continue;
    }
    const normalized: Record<string, string> = {
      "×": "*", "·": "*", "∙": "*", "÷": "/", "−": "-", "–": "-", "√": "√"
    };
    const op = normalized[ch] ?? ch;
    if ("+-*/^%(),!√".includes(op)) {
      tokens.push({ kind: "op", value: op, pos: i });
      i += 1;
      continue;
    }
    throw new CalcError(`unexpected character "${ch}" at position ${i + 1}`);
  }
  tokens.push({ kind: "eof", pos: source.length });
  return tokens;
}

/** Evaluate an arithmetic expression. Throws CalcError on bad input. */
export function evaluateExpression(source: string): number {
  if (source.length > MAX_LENGTH) throw new CalcError(`expression is longer than ${MAX_LENGTH} characters`);
  const tokens = tokenize(source);
  let index = 0;
  let depth = 0;

  const peek = (offset = 0): Token => tokens[Math.min(index + offset, tokens.length - 1)]!;
  const next = (): Token => tokens[index++]!;
  const isOp = (token: Token, value: string): boolean => token.kind === "op" && token.value === value;
  const expectOp = (value: string): void => {
    const token = next();
    if (!isOp(token, value)) throw new CalcError(`expected "${value}" at position ${token.pos + 1}`);
  };
  /** Can this token start an operand? (Used for implicit multiplication and `%`.) */
  const startsOperand = (token: Token): boolean =>
    token.kind === "num" || token.kind === "ident" || isOp(token, "(") || isOp(token, "√");

  const binding: Record<string, number> = { "+": 10, "-": 10, "*": 20, "/": 20, "%": 20, mod: 20, "^": 40 };

  function parse(minBp: number): number {
    depth += 1;
    if (depth > MAX_DEPTH) throw new CalcError("expression is nested too deeply");
    let left = parsePrefix();
    for (;;) {
      const token = peek();
      let op: string | undefined;
      if (token.kind === "op" && Object.hasOwn(binding, token.value)) op = token.value;
      else if (token.kind === "ident" && token.value === "mod") op = "mod";
      else if (startsOperand(token)) op = "implicit";
      if (!op) break;

      // `x%` followed by no operand is "percent" (15% = 0.15); `a % b` is remainder.
      if (op === "%" && !startsOperand(peek(1))) {
        next();
        left = left / 100;
        continue;
      }
      const bp = op === "implicit" ? binding["*"]! : binding[op]!;
      if (bp < minBp) break;
      if (op !== "implicit") next();
      // ^ is right-associative; everything else is left-associative.
      const right = parse(op === "^" ? bp : bp + 1);
      left = applyBinary(op === "implicit" ? "*" : op, left, right);
    }
    depth -= 1;
    return left;
  }

  function parsePrefix(): number {
    const token = next();
    if (isOp(token, "-")) return -parse(30);
    if (isOp(token, "+")) return parse(30);
    if (isOp(token, "√")) return Math.sqrt(parse(50));
    let value: number;
    if (token.kind === "num") {
      value = token.value;
    } else if (isOp(token, "(")) {
      value = parse(0);
      expectOp(")");
    } else if (token.kind === "ident") {
      const name = token.value;
      if (isOp(peek(), "(") && Object.hasOwn(FUNCTIONS, name)) {
        next();
        const args: number[] = [];
        if (!isOp(peek(), ")")) {
          args.push(parse(0));
          while (isOp(peek(), ",")) {
            next();
            args.push(parse(0));
          }
        }
        expectOp(")");
        const spec = FUNCTIONS[name]!;
        if (args.length < spec.min || args.length > spec.max) {
          throw new CalcError(
            `${name}() takes ${spec.min === spec.max ? spec.min : `${spec.min}–${spec.max}`} argument(s), got ${args.length}`
          );
        }
        value = spec.apply(...args);
      } else if (Object.hasOwn(CONSTANTS, name)) {
        value = CONSTANTS[name]!;
      } else if (Object.hasOwn(FUNCTIONS, name)) {
        throw new CalcError(`${name} needs parentheses, e.g. ${name}(2)`);
      } else {
        throw new CalcError(`unknown name "${name}"`);
      }
    } else if (token.kind === "eof") {
      throw new CalcError("expression ended unexpectedly");
    } else {
      throw new CalcError(`unexpected "${token.value}" at position ${token.pos + 1}`);
    }
    // Postfix factorial binds tighter than anything else.
    while (isOp(peek(), "!")) {
      next();
      value = factorial(value);
    }
    return value;
  }

  const result = parse(0);
  const rest = peek();
  if (rest.kind !== "eof") {
    throw new CalcError(`unexpected "${rest.kind === "num" ? rest.value : (rest as { value: string }).value}" at position ${rest.pos + 1}`);
  }
  return result;
}

function applyBinary(op: string, a: number, b: number): number {
  switch (op) {
    case "+": return a + b;
    case "-": return a - b;
    case "*": return a * b;
    case "/":
      if (b === 0) throw new CalcError("division by zero");
      return a / b;
    case "%":
    case "mod":
      if (b === 0) throw new CalcError("division by zero");
      return a % b;
    case "^": return a ** b;
    default: throw new CalcError(`unknown operator ${op}`);
  }
}

/** Format without float noise (0.1 + 0.2 → 0.3) but keep big/small numbers readable. */
export function formatNumber(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
  if (Object.is(value, -0) || value === 0) return "0";
  const rounded = Number(value.toPrecision(12));
  const abs = Math.abs(rounded);
  if (abs >= 1e21 || abs < 1e-9) return rounded.toExponential().replace(/\.?0+e/, "e");
  return String(rounded);
}

export const calculateTool: ToolDefinition<{ expression: string }, { expression: string; result: number }> = {
  name: "calculate",
  title: "Calculate",
  description:
    "Evaluate an arithmetic expression exactly instead of doing math in your head. Supports + - * / ^ (or ×, ÷, **), " +
    "parentheses, unary minus, factorial (5!), percent (15% = 0.15, so `200 * 15%` = 30), remainder (`a % b` or `a mod b`), " +
    "implicit multiplication (2pi), constants pi, e, tau, phi, and functions sqrt, cbrt, abs, round(x, digits), floor, ceil, " +
    "trunc, sin/cos/tan/asin/acos/atan/atan2 (radians; deg()/rad() convert), sinh/cosh/tanh, ln, log(x) (base 10) or log(x, base), " +
    "log2, exp, pow, min, max, sum, avg, hypot, factorial. Numbers only — no units or currencies.",
  inputSchema: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The expression, e.g. \"(1250 * 1.07^5) - 300\" or \"sqrt(2) * sin(rad(30))\"."
      }
    },
    required: ["expression"],
    additionalProperties: false
  },
  effect: "read",
  source: "builtin",
  async run(input) {
    const expression = typeof input?.expression === "string" ? input.expression.trim() : "";
    if (!expression) return { content: "Calculation failed: no expression given.", isError: true };
    try {
      const result = evaluateExpression(expression);
      if (Number.isNaN(result)) {
        return { content: `Calculation failed: ${expression} is not a real number (NaN).`, isError: true };
      }
      const formatted = formatNumber(result);
      return { content: `${expression} = ${formatted}`, data: { expression, result } };
    } catch (error) {
      const message = error instanceof CalcError ? error.message : String(error);
      return { content: `Calculation failed: ${message}.`, isError: true };
    }
  }
};
