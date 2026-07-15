import { describe, expect, it } from 'vitest';
import {
  buildCalcContext,
  calcParamsSchema,
  DEFAULT_HISTORY_CAP,
  evaluate,
  formatDisplay,
  formatNumber,
  FUNCTION_NAMES,
  pushHistory,
  type EvalResult,
  type HistoryEntry,
} from './logic';

function value(result: EvalResult): number {
  if (!result.ok) throw new Error(`expected ok, got error "${result.error}"`);
  return result.value;
}

function error(result: EvalResult): string {
  if (result.ok) throw new Error(`expected error, got value ${result.value}`);
  return result.error;
}

describe('evaluate – arithmetic & precedence', () => {
  it('handles a table of well-formed expressions', () => {
    const cases: Array<[string, number]> = [
      ['1+1', 2],
      ['2+3*4', 14], // * before +
      ['(2+3)*4', 20],
      ['10-4-3', 3], // left-assoc
      ['20/4/5', 1], // left-assoc
      ['2^3^2', 512], // ^ right-assoc
      ['(2^3)^2', 64],
      ['-3^2', -9], // unary minus looser than ^
      ['(-3)^2', 9],
      ['2^-3', 0.125], // unary minus after ^
      ['-2*3', -6],
      ['--4', 4],
      ['+5', 5],
      ['7%3', 1],
      ['10 % 4', 2],
      ['((1+2)*(3+4))', 21],
      ['1.5*2', 3],
      ['1,5*2', 3], // comma decimal separator
      ['.5+.5', 1],
      ['3 × 4', 12], // keypad aliases
      ['8 ÷ 2', 4],
      ['5 − 3', 2],
    ];
    for (const [expr, expected] of cases) {
      expect(value(evaluate(expr)), expr).toBeCloseTo(expected, 10);
    }
  });

  it('supports constants', () => {
    expect(value(evaluate('pi'))).toBeCloseTo(Math.PI, 12);
    expect(value(evaluate('2*pi'))).toBeCloseTo(2 * Math.PI, 12);
    expect(value(evaluate('e^2'))).toBeCloseTo(Math.E ** 2, 10);
    expect(value(evaluate('PI'))).toBeCloseTo(Math.PI, 12); // case-insensitive
  });
});

describe('evaluate – functions & angle modes', () => {
  it('evaluates every declared function', () => {
    expect([...FUNCTION_NAMES].sort()).toEqual(
      ['abs', 'ceil', 'cos', 'floor', 'ln', 'log', 'round', 'sin', 'sqrt', 'tan'].sort(),
    );
    expect(value(evaluate('sqrt(16)'))).toBe(4);
    expect(value(evaluate('ln(e)'))).toBeCloseTo(1, 12);
    expect(value(evaluate('log(1000)'))).toBeCloseTo(3, 12);
    expect(value(evaluate('abs(-7)'))).toBe(7);
    expect(value(evaluate('round(2.5)'))).toBe(3);
    expect(value(evaluate('floor(2.9)'))).toBe(2);
    expect(value(evaluate('ceil(2.1)'))).toBe(3);
  });

  it('trig respects deg mode', () => {
    expect(value(evaluate('sin(90)', { angleMode: 'deg' }))).toBeCloseTo(1, 12);
    expect(value(evaluate('cos(180)', { angleMode: 'deg' }))).toBeCloseTo(-1, 12);
    expect(value(evaluate('tan(45)', { angleMode: 'deg' }))).toBeCloseTo(1, 12);
  });

  it('trig defaults to rad mode', () => {
    expect(value(evaluate('sin(pi/2)'))).toBeCloseTo(1, 12);
    expect(value(evaluate('sin(pi/2)', { angleMode: 'rad' }))).toBeCloseTo(1, 12);
    expect(value(evaluate('cos(pi)'))).toBeCloseTo(-1, 12);
    // sin(90) in rad is NOT 1.
    expect(value(evaluate('sin(90)', { angleMode: 'rad' }))).toBeCloseTo(Math.sin(90), 12);
  });

  it('functions nest and combine', () => {
    expect(value(evaluate('sqrt(abs(-16))'))).toBe(4);
    expect(value(evaluate('round(sin(90)*100)', { angleMode: 'deg' }))).toBe(100);
  });
});

describe('evaluate – errors (never throws)', () => {
  it('reports division by zero (also for modulo)', () => {
    expect(error(evaluate('1/0'))).toBe('division-by-zero');
    expect(error(evaluate('5%(3-3)'))).toBe('division-by-zero');
  });

  it('reports malformed input as syntax errors', () => {
    const bad = ['2++', '(', '2 3', '', '   ', ')', '(2+3', '1.2.3', '*3', 'sqrt 4', 'sin()', '2^'];
    for (const expr of bad) {
      expect(error(evaluate(expr)), JSON.stringify(expr)).toBe('syntax');
    }
  });

  it('reports unknown identifiers and characters', () => {
    expect(error(evaluate('foo(3)'))).toBe('unknown-token');
    expect(error(evaluate('x+1'))).toBe('unknown-token');
    expect(error(evaluate('2$3'))).toBe('unknown-token');
  });

  it('reports non-finite math results', () => {
    expect(error(evaluate('sqrt(-1)'))).toBe('math');
    expect(error(evaluate('ln(-5)'))).toBe('math');
    expect(error(evaluate('10^1000'))).toBe('math'); // overflow → Infinity
  });
});

describe('formatNumber', () => {
  it('cleans up float noise (0.1+0.2)', () => {
    expect(formatNumber(value(evaluate('0.1+0.2')))).toBe('0.3');
  });

  it('strips trailing zeros and keeps integers plain', () => {
    expect(formatNumber(4)).toBe('4');
    expect(formatNumber(2.5)).toBe('2.5');
    expect(formatNumber(1.23000000000001, 6)).toBe('1.23');
  });

  it('respects maxDecimals', () => {
    expect(formatNumber(Math.PI, 4)).toBe('3.1416');
    expect(formatNumber(1.006, 2)).toBe('1.01');
    expect(formatNumber(0.7 * 3, 6)).toBe('2.1');
  });
});

describe('formatDisplay', () => {
  it('adds a thousands separator per locale when grouping is on', () => {
    expect(formatDisplay(1234567.5, { locale: 'en', grouping: true })).toBe('1,234,567.5');
    expect(formatDisplay(1234567.5, { locale: 'de', grouping: true })).toBe('1.234.567,5');
  });

  it('omits grouping when off', () => {
    expect(formatDisplay(1234567.5, { locale: 'en', grouping: false })).toBe('1234567.5');
  });

  it('rounds float noise before grouping', () => {
    expect(formatDisplay(0.1 + 0.2, { locale: 'en', grouping: true })).toBe('0.3');
  });
});

describe('pushHistory', () => {
  const entry = (n: number): HistoryEntry => ({ expr: `${n}+0`, result: String(n) });

  it('prepends the newest entry', () => {
    const next = pushHistory([entry(1)], entry(2));
    expect(next.map((e) => e.result)).toEqual(['2', '1']);
  });

  it('caps at the given length (default 50)', () => {
    let entries: HistoryEntry[] = [];
    for (let i = 0; i < 60; i++) entries = pushHistory(entries, entry(i));
    expect(entries).toHaveLength(DEFAULT_HISTORY_CAP);
    expect(entries[0]?.result).toBe('59');
    const small = pushHistory([entry(1), entry(2), entry(3)], entry(4), 2);
    expect(small.map((e) => e.result)).toEqual(['4', '1']);
  });
});

describe('buildCalcContext', () => {
  it('reports the empty state in both languages', () => {
    expect(buildCalcContext([], 'en')).toBe('No calculations yet.');
    expect(buildCalcContext([], 'de')).toBe('Noch keine Berechnungen.');
  });

  it('lists at most the last 3 lines, newest first', () => {
    const entries: HistoryEntry[] = [
      { expr: '4+4', result: '8' },
      { expr: '3+3', result: '6' },
      { expr: '2+2', result: '4' },
      { expr: '1+1', result: '2' },
    ];
    const text = buildCalcContext(entries, 'en');
    expect(text).toContain('4+4 = 8; 3+3 = 6; 2+2 = 4');
    expect(text).not.toContain('1+1');
    expect(buildCalcContext(entries, 'de')).toContain('Letzte Berechnungen:');
  });
});

describe('calcParamsSchema', () => {
  it('requires a non-empty expression', () => {
    expect(calcParamsSchema.safeParse({ expression: '1+1' }).success).toBe(true);
    expect(calcParamsSchema.safeParse({ expression: '' }).success).toBe(false);
    expect(calcParamsSchema.safeParse({}).success).toBe(false);
  });
});
