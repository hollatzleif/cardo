/**
 * Pure expression engine for the calculator tool: tokenizer + Pratt parser +
 * evaluator. NO eval(), NO Function() – every character flows through the
 * tokenizer below. evaluate() NEVER throws; every failure is a typed error.
 */

import { z } from 'zod';

export type AngleMode = 'deg' | 'rad';

export type EvalError = 'syntax' | 'division-by-zero' | 'unknown-token' | 'math';

export type EvalResult = { ok: true; value: number } | { ok: false; error: EvalError };

export type HistoryEntry = { expr: string; result: string };

export type HistoryDoc = { entries: HistoryEntry[] };

export const HISTORY_DOC_ID = 'history';
export const DEFAULT_HISTORY_CAP = 50;
export const MAX_DISPLAY_DECIMALS = 12;

export const calcParamsSchema = z.object({ expression: z.string().min(1) });
export type CalcParams = z.infer<typeof calcParamsSchema>;

/* ── Tokenizer ────────────────────────────────────────────────────────── */

type Token =
  | { kind: 'num'; value: number }
  | { kind: 'ident'; name: string }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' | '^' | '%' }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

type TokenizeResult = { ok: true; tokens: Token[] } | { ok: false; error: EvalError };

/** Unicode aliases from calculator keypads. */
const OP_ALIASES: Record<string, '+' | '-' | '*' | '/'> = {
  '×': '*',
  '·': '*',
  '÷': '/',
  '−': '-',
};

function tokenize(expr: string): TokenizeResult {
  const tokens: Token[] = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (ch === undefined) break;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    const aliased = OP_ALIASES[ch];
    if (aliased) {
      tokens.push({ kind: 'op', op: aliased });
      i += 1;
      continue;
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^' || ch === '%') {
      tokens.push({ kind: 'op', op: ch });
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    // Numbers: digits with at most one decimal point ('.' or ',' – keypads
    // in de locales send ','). "1.2.3" is a syntax error, not two numbers.
    if (/[0-9.,]/.test(ch)) {
      let text = '';
      let dots = 0;
      while (i < expr.length) {
        const c = expr[i];
        if (c === undefined || !/[0-9.,]/.test(c)) break;
        if (c === '.' || c === ',') {
          dots += 1;
          text += '.';
        } else {
          text += c;
        }
        i += 1;
      }
      if (dots > 1 || text === '.') return { ok: false, error: 'syntax' };
      const value = Number(text);
      if (!Number.isFinite(value)) return { ok: false, error: 'syntax' };
      tokens.push({ kind: 'num', value });
      continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      let name = '';
      while (i < expr.length) {
        const c = expr[i];
        if (c === undefined || !/[a-zA-Z_]/.test(c)) break;
        name += c;
        i += 1;
      }
      tokens.push({ kind: 'ident', name: name.toLowerCase() });
      continue;
    }
    return { ok: false, error: 'unknown-token' };
  }
  return { ok: true, tokens };
}

/* ── Parser / evaluator (Pratt) ───────────────────────────────────────── */

const CONSTANTS: Record<string, number> = {
  pi: Math.PI,
  e: Math.E,
};

type Fn = (x: number, mode: AngleMode) => number;

const FUNCTIONS: Record<string, Fn> = {
  sin: (x, mode) => Math.sin(mode === 'deg' ? (x * Math.PI) / 180 : x),
  cos: (x, mode) => Math.cos(mode === 'deg' ? (x * Math.PI) / 180 : x),
  tan: (x, mode) => Math.tan(mode === 'deg' ? (x * Math.PI) / 180 : x),
  sqrt: (x) => Math.sqrt(x),
  ln: (x) => Math.log(x),
  log: (x) => Math.log10(x),
  abs: (x) => Math.abs(x),
  round: (x) => Math.round(x),
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
};

/** Exported for the UI (scientific keypad renders one button per function). */
export const FUNCTION_NAMES = Object.keys(FUNCTIONS);

/** Infix binding powers; ^ is right-associative (higher left than right). */
const INFIX_BP: Record<string, [number, number]> = {
  '+': [1, 1.1],
  '-': [1, 1.1],
  '*': [2, 2.1],
  '/': [2, 2.1],
  '%': [2, 2.1],
  '^': [3.5, 3.4],
};

/** Unary minus binds LOOSER than ^ so -3^2 = -(3^2) = -9. */
const UNARY_MINUS_BP = 3;

class ParseFailure {
  constructor(readonly error: EvalError) {}
}

function evaluateTokens(tokens: Token[], mode: AngleMode): EvalResult {
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token | undefined => tokens[pos++];

  function parseExpr(minBp: number): number {
    const token = next();
    if (!token) throw new ParseFailure('syntax');
    let lhs: number;
    if (token.kind === 'num') {
      lhs = token.value;
    } else if (token.kind === 'op' && token.op === '-') {
      lhs = -parseExpr(UNARY_MINUS_BP);
    } else if (token.kind === 'op' && token.op === '+') {
      lhs = parseExpr(UNARY_MINUS_BP);
    } else if (token.kind === 'lparen') {
      lhs = parseExpr(0);
      const close = next();
      if (!close || close.kind !== 'rparen') throw new ParseFailure('syntax');
    } else if (token.kind === 'ident') {
      const constant = CONSTANTS[token.name];
      const fn = FUNCTIONS[token.name];
      if (constant !== undefined) {
        lhs = constant;
      } else if (fn) {
        const open = next();
        if (!open || open.kind !== 'lparen') throw new ParseFailure('syntax');
        const arg = parseExpr(0);
        const close = next();
        if (!close || close.kind !== 'rparen') throw new ParseFailure('syntax');
        lhs = fn(arg, mode);
        if (Number.isNaN(lhs)) throw new ParseFailure('math');
      } else {
        throw new ParseFailure('unknown-token');
      }
    } else {
      throw new ParseFailure('syntax');
    }

    for (;;) {
      const op = peek();
      if (!op || op.kind !== 'op') break;
      const bp = INFIX_BP[op.op];
      if (!bp) break;
      const [leftBp, rightBp] = bp;
      if (leftBp < minBp) break;
      pos += 1;
      const rhs = parseExpr(rightBp);
      switch (op.op) {
        case '+':
          lhs += rhs;
          break;
        case '-':
          lhs -= rhs;
          break;
        case '*':
          lhs *= rhs;
          break;
        case '/':
          if (rhs === 0) throw new ParseFailure('division-by-zero');
          lhs /= rhs;
          break;
        case '%':
          if (rhs === 0) throw new ParseFailure('division-by-zero');
          lhs %= rhs;
          break;
        case '^':
          lhs = Math.pow(lhs, rhs);
          break;
      }
    }
    return lhs;
  }

  try {
    if (tokens.length === 0) return { ok: false, error: 'syntax' };
    const value = parseExpr(0);
    // "2 3" parses 2 and stops – leftover tokens are a syntax error.
    if (pos !== tokens.length) return { ok: false, error: 'syntax' };
    if (Number.isNaN(value)) return { ok: false, error: 'math' };
    if (!Number.isFinite(value)) return { ok: false, error: 'math' };
    return { ok: true, value };
  } catch (failure) {
    if (failure instanceof ParseFailure) return { ok: false, error: failure.error };
    return { ok: false, error: 'syntax' };
  }
}

/** The one public entry point. Never throws. */
export function evaluate(expr: string, opts?: { angleMode?: AngleMode }): EvalResult {
  const tokenized = tokenize(expr);
  if (!tokenized.ok) return { ok: false, error: tokenized.error };
  return evaluateTokens(tokenized.tokens, opts?.angleMode ?? 'rad');
}

/* ── Display formatting ───────────────────────────────────────────────── */

/**
 * Rounds float noise away (0.1+0.2 → "0.3") and strips trailing zeros.
 * Extremes keep JS scientific notation ("1e+21").
 */
export function formatNumber(value: number, maxDecimals = MAX_DISPLAY_DECIMALS): string {
  if (!Number.isFinite(value)) return String(value);
  const decimals = Math.max(0, Math.min(100, Math.floor(maxDecimals)));
  const rounded = Number(value.toFixed(decimals));
  return String(rounded);
}

/** Locale display (thousands separator per gear setting) – Intl-based. */
export function formatDisplay(
  value: number,
  opts: { locale: string; grouping: boolean; maxDecimals?: number },
): string {
  if (!Number.isFinite(value)) return String(value);
  const maxDecimals = opts.maxDecimals ?? MAX_DISPLAY_DECIMALS;
  // Round float noise BEFORE Intl so 0.1+0.2 groups as 0.3, not 0.30000….
  const rounded = Number(value.toFixed(Math.max(0, Math.min(100, maxDecimals))));
  return new Intl.NumberFormat(opts.locale, {
    useGrouping: opts.grouping,
    maximumFractionDigits: Math.min(20, maxDecimals),
  }).format(rounded);
}

/* ── History ──────────────────────────────────────────────────────────── */

/** Newest first, capped. Pure – the storage write happens in index.tsx. */
export function pushHistory(
  entries: HistoryEntry[],
  entry: HistoryEntry,
  cap = DEFAULT_HISTORY_CAP,
): HistoryEntry[] {
  const safeCap = Math.max(1, Math.floor(cap));
  return [entry, ...entries].slice(0, safeCap);
}

/** Assistant context: the last `count` history lines. */
export function buildCalcContext(entries: HistoryEntry[], language: string, count = 3): string {
  const de = language === 'de';
  if (entries.length === 0) return de ? 'Noch keine Berechnungen.' : 'No calculations yet.';
  const lines = entries.slice(0, count).map((entry) => `${entry.expr} = ${entry.result}`);
  const head = de ? 'Letzte Berechnungen:' : 'Recent calculations:';
  return `${head} ${lines.join('; ')}`;
}
