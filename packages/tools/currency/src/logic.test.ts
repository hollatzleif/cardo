import { describe, expect, it } from 'vitest';
import {
  CURRENCIES,
  DEFAULT_PAIRS,
  REFRESH_INTERVAL_MS,
  STALE_AFTER_MS,
  buildCurrencyContext,
  buildUrl,
  convert,
  formatAmount,
  isStale,
  normalizeCode,
  parsePair,
  parseRatesResponse,
  rateAgeLabel,
  shouldFetch,
  type LastPairDoc,
  type RatesDoc,
} from './logic';

const DOC: RatesDoc = {
  type: 'rates',
  base: 'EUR',
  fetchedAtMs: 1_700_000_000_000,
  rates: { EUR: 1, USD: 1.08, GBP: 0.85, JPY: 160 },
};

describe('convert', () => {
  it('converts via the base cross-rate', () => {
    // 100 USD → EUR → GBP: 100 / 1.08 * 0.85
    expect(convert(100, 'USD', 'GBP', DOC)).toBeCloseTo((100 / 1.08) * 0.85, 10);
  });

  it('converts from the base itself', () => {
    expect(convert(50, 'EUR', 'USD', DOC)).toBeCloseTo(54, 10);
  });

  it('same-currency conversion is the identity', () => {
    expect(convert(123.45, 'USD', 'USD', DOC)).toBeCloseTo(123.45, 10);
    expect(convert(0, 'JPY', 'JPY', DOC)).toBe(0);
  });

  it('is case/whitespace tolerant on codes', () => {
    expect(convert(1, ' usd ', 'eur', DOC)).toBeCloseTo(1 / 1.08, 10);
  });

  it('returns null for unknown codes', () => {
    expect(convert(1, 'XXX', 'EUR', DOC)).toBeNull();
    expect(convert(1, 'EUR', 'XXX', DOC)).toBeNull();
    expect(convert(1, 'not-a-code', 'EUR', DOC)).toBeNull();
  });

  it('returns null without a rates doc or with a bad amount', () => {
    expect(convert(1, 'EUR', 'USD', null)).toBeNull();
    expect(convert(Number.NaN, 'EUR', 'USD', DOC)).toBeNull();
  });
});

describe('parseRatesResponse', () => {
  const valid = {
    result: 'success',
    base_code: 'EUR',
    rates: { EUR: 1, USD: 1.08, GBP: 0.85 },
  };

  it('accepts the real API shape', () => {
    const parsed = parseRatesResponse(valid);
    expect(parsed).not.toBeNull();
    expect(parsed?.base).toBe('EUR');
    expect(parsed?.rates.USD).toBe(1.08);
  });

  it('skips non-numeric / non-positive rate entries', () => {
    const parsed = parseRatesResponse({
      ...valid,
      rates: { EUR: 1, USD: 1.08, BAD: 'x', NEG: -1, NAN: Number.NaN },
    });
    expect(parsed?.rates).toEqual({ EUR: 1, USD: 1.08 });
  });

  it('rejects garbage payloads', () => {
    expect(parseRatesResponse(null)).toBeNull();
    expect(parseRatesResponse('rates')).toBeNull();
    expect(parseRatesResponse({})).toBeNull();
    expect(parseRatesResponse({ result: 'error' })).toBeNull();
    expect(parseRatesResponse({ result: 'success', base_code: 'EUR' })).toBeNull();
    expect(parseRatesResponse({ result: 'success', base_code: 'EUR', rates: null })).toBeNull();
    // Base missing from its own table → not a usable rate table.
    expect(
      parseRatesResponse({ result: 'success', base_code: 'EUR', rates: { USD: 1.08, GBP: 0.85 } }),
    ).toBeNull();
    // A single entry is not a table either.
    expect(parseRatesResponse({ result: 'success', base_code: 'EUR', rates: { EUR: 1 } })).toBeNull();
  });
});

describe('freshness', () => {
  const now = 1_700_000_000_000;

  it('isStale flips just past 26 h', () => {
    expect(isStale(now - STALE_AFTER_MS, now)).toBe(false);
    expect(isStale(now - STALE_AFTER_MS - 1, now)).toBe(true);
    expect(isStale(now, now)).toBe(false);
  });

  it('shouldFetch: no doc, or a day-old doc', () => {
    expect(shouldFetch(null, now)).toBe(true);
    expect(shouldFetch({ ...DOC, fetchedAtMs: now - REFRESH_INTERVAL_MS }, now)).toBe(true);
    expect(shouldFetch({ ...DOC, fetchedAtMs: now - REFRESH_INTERVAL_MS + 1 }, now)).toBe(false);
    expect(shouldFetch({ ...DOC, fetchedAtMs: now }, now)).toBe(false);
  });
});

describe('rateAgeLabel', () => {
  const now = 1_700_000_000_000;
  const h = 60 * 60 * 1000;

  it('bucket: under one hour', () => {
    expect(rateAgeLabel(now - 5 * 60 * 1000, now, 'en')).toBe('less than 1 h ago');
    expect(rateAgeLabel(now - 5 * 60 * 1000, now, 'de')).toBe('vor weniger als 1 Std.');
    // Clock skew (fetched "in the future") clamps to the freshest bucket.
    expect(rateAgeLabel(now + h, now, 'en')).toBe('less than 1 h ago');
  });

  it('bucket: whole hours', () => {
    expect(rateAgeLabel(now - 3 * h - 1000, now, 'en')).toBe('3 h ago');
    expect(rateAgeLabel(now - 3 * h - 1000, now, 'de')).toBe('vor 3 Std.');
    expect(rateAgeLabel(now - 23 * h, now, 'en')).toBe('23 h ago');
  });

  it('bucket: whole days, singular and plural', () => {
    expect(rateAgeLabel(now - 24 * h, now, 'en')).toBe('1 day ago');
    expect(rateAgeLabel(now - 24 * h, now, 'de')).toBe('vor 1 Tag');
    expect(rateAgeLabel(now - 72 * h, now, 'en')).toBe('3 days ago');
    expect(rateAgeLabel(now - 72 * h, now, 'de')).toBe('vor 3 Tagen');
  });

  it('accepts locale-style language tags', () => {
    expect(rateAgeLabel(now - 2 * h, now, 'de-DE')).toBe('vor 2 Std.');
  });
});

describe('codes, pairs, URL', () => {
  it('buildUrl embeds the base', () => {
    expect(buildUrl('EUR')).toBe('https://open.er-api.com/v6/latest/EUR');
  });

  it('normalizeCode uppercases and validates', () => {
    expect(normalizeCode(' usd ')).toBe('USD');
    expect(normalizeCode('EURO')).toBeNull();
    expect(normalizeCode('e1')).toBeNull();
    expect(normalizeCode('')).toBeNull();
  });

  it('parsePair splits and validates', () => {
    expect(parsePair('EUR/USD')).toEqual({ from: 'EUR', to: 'USD' });
    expect(parsePair('eur/usd')).toEqual({ from: 'EUR', to: 'USD' });
    expect(parsePair('EURUSD')).toBeNull();
    expect(parsePair('EUR/USD/GBP')).toBeNull();
    expect(parsePair('EUR/')).toBeNull();
  });

  it('CURRENCIES is a sane, unique 3-letter list incl. the default pairs', () => {
    expect(CURRENCIES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(CURRENCIES).size).toBe(CURRENCIES.length);
    for (const code of CURRENCIES) expect(code).toMatch(/^[A-Z]{3}$/);
    for (const pair of DEFAULT_PAIRS) {
      const parsed = parsePair(pair);
      expect(parsed).not.toBeNull();
      expect(CURRENCIES).toContain(parsed!.from);
      expect(CURRENCIES).toContain(parsed!.to);
    }
  });
});

describe('formatAmount', () => {
  it('applies the decimals setting', () => {
    expect(formatAmount(1.23456, 2, 'en')).toBe('1.23');
    expect(formatAmount(1.5, 0, 'en')).toBe('2');
    expect(formatAmount(1.23456, 4, 'en')).toBe('1.2346');
  });
});

describe('buildCurrencyContext', () => {
  const now = DOC.fetchedAtMs + 3 * 60 * 60 * 1000;
  const lastPair: LastPairDoc = {
    type: 'last-pair',
    from: 'EUR',
    to: 'USD',
    amount: 100,
    result: 108,
  };

  it('explains the empty state', () => {
    expect(buildCurrencyContext(null, null, 'en', now)).toContain('No exchange rates');
    expect(buildCurrencyContext(null, null, 'de', now)).toContain('keine Wechselkurse');
  });

  it('summarizes table, age and last pair', () => {
    const text = buildCurrencyContext(DOC, lastPair, 'en', now);
    expect(text).toContain('EUR');
    expect(text).toContain('3 h ago');
    expect(text).toContain('100.00 EUR = 108.00 USD');
  });

  it('German variant', () => {
    const text = buildCurrencyContext(DOC, lastPair, 'de', now);
    expect(text).toContain('vor 3 Std.');
    expect(text).toContain('Letzte Umrechnung');
  });

  it('works without a last pair', () => {
    const text = buildCurrencyContext(DOC, null, 'en', now);
    expect(text).toContain('4 currencies');
    expect(text).not.toContain('Last conversion');
  });
});
