import { describe, expect, it } from 'vitest';
import {
  CATEGORIES,
  buildConverterContext,
  convert,
  convertParamsSchema,
  formatResult,
  inferCategory,
  resolveUnit,
  unitsOf,
  type Category,
} from './logic';

describe('temperature (all six directions, known values)', () => {
  const cases: Array<[number, string, string, number]> = [
    [0, 'c', 'f', 32],
    [100, 'c', 'f', 212],
    [-40, 'c', 'f', -40],
    [-40, 'f', 'c', -40],
    [32, 'f', 'c', 0],
    [212, 'f', 'k', 373.15],
    [0, 'c', 'k', 273.15],
    [273.15, 'k', 'c', 0],
    [273.15, 'k', 'f', 32],
    [0, 'k', 'c', -273.15],
    [100, 'f', 'f', 100],
  ];
  it.each(cases)('%s %s → %s = %s', (value, from, to, expected) => {
    expect(convert(value, from, to)).toBeCloseTo(expected, 9);
  });

  it('accepts °C/°F/K spellings', () => {
    expect(convert(0, '°C', '°F')).toBeCloseTo(32, 9);
    expect(convert(0, 'C', 'K')).toBeCloseTo(273.15, 9);
  });
});

describe('linear categories (known values)', () => {
  const cases: Array<[number, string, string, number]> = [
    [1, 'km', 'm', 1000],
    [1, 'mi', 'km', 1.609344],
    [12, 'in', 'cm', 30.48],
    [3, 'ft', 'yd', 1],
    [1, 'kg', 'lb', 1 / 0.45359237],
    [16, 'oz', 'lb', 1],
    [2, 't', 'kg', 2000],
    [1, 'KB', 'B', 1000],
    [1, 'KiB', 'B', 1024],
    [1, 'MiB', 'B', 1048576],
    [1, 'GiB', 'MiB', 1024],
    [1, 'GB', 'MB', 1000],
    [1, 'TB', 'GB', 1000],
    [36, 'km/h', 'm/s', 10],
    [100, 'km/h', 'mph', 62.13711922373339],
    [1, 'kn', 'km/h', 1.852],
    [1, 'gal', 'l', 3.785411784],
    [1, 'cup', 'ml', 236.5882365],
    [2, 'pt', 'qt', 1],
    [1, 'ha', 'm2', 10000],
    [1, 'acre', 'm2', 4046.8564224],
    [1, 'km2', 'ha', 100],
    [144, 'in2', 'ft2', 1],
  ];
  it.each(cases)('%s %s → %s = %s', (value, from, to, expected) => {
    expect(convert(value, from, to)).toBeCloseTo(expected, 9);
  });

  it('binary and decimal data units stay distinct', () => {
    expect(convert(1, 'KiB', 'KB')).toBeCloseTo(1.024, 12);
    expect(convert(1, 'GiB', 'GB')).toBeCloseTo(1.073741824, 12);
  });
});

describe('rejections (null, never a throw)', () => {
  it('unknown units', () => {
    expect(convert(1, 'parsec', 'm')).toBeNull();
    expect(convert(1, 'm', 'lightyear')).toBeNull();
    expect(convert(1, '', 'm')).toBeNull();
  });

  it('category mismatches', () => {
    expect(convert(1, 'km', 'kg')).toBeNull();
    expect(convert(1, 'c', 'm')).toBeNull();
  });

  it('explicit category must match both units', () => {
    expect(convert(1, 'km', 'm', 'length')).toBe(1000);
    expect(convert(1, 'km', 'm', 'weight')).toBeNull();
  });

  it('non-finite values', () => {
    expect(convert(Number.NaN, 'km', 'm')).toBeNull();
    expect(convert(Number.POSITIVE_INFINITY, 'km', 'm')).toBeNull();
  });
});

describe('resolveUnit / inferCategory', () => {
  it('resolves exact ids to their category', () => {
    expect(resolveUnit('km')).toEqual({ unit: 'km', category: 'length' });
    expect(resolveUnit('KiB')).toEqual({ unit: 'KiB', category: 'data' });
    expect(resolveUnit('m/s')).toEqual({ unit: 'm/s', category: 'speed' });
  });

  it('falls back case-insensitively and strips a degree sign', () => {
    expect(resolveUnit('KM')).toEqual({ unit: 'km', category: 'length' });
    expect(resolveUnit('Mb')).toEqual({ unit: 'MB', category: 'data' });
    expect(resolveUnit('°C')).toEqual({ unit: 'c', category: 'temperature' });
    expect(resolveUnit(' k ')).toEqual({ unit: 'k', category: 'temperature' });
  });

  it('rejects unknown units', () => {
    expect(resolveUnit('bogus')).toBeNull();
    expect(resolveUnit('')).toBeNull();
    expect(resolveUnit('°')).toBeNull();
  });

  it('inferCategory needs two units of the same category', () => {
    expect(inferCategory('km', 'mi')).toBe('length');
    expect(inferCategory('c', 'f')).toBe('temperature');
    expect(inferCategory('km', 'kg')).toBeNull();
    expect(inferCategory('km', 'nope')).toBeNull();
  });
});

describe('unit tables', () => {
  it('exposes all seven categories with at least three units each', () => {
    expect(CATEGORIES).toHaveLength(7);
    for (const category of CATEGORIES) {
      expect(unitsOf(category).length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every declared unit resolves back to its own category', () => {
    for (const category of CATEGORIES) {
      for (const unit of unitsOf(category)) {
        expect(resolveUnit(unit)).toEqual({ unit, category });
      }
    }
  });

  it('identity conversions are exact in every category', () => {
    for (const category of CATEGORIES) {
      for (const unit of unitsOf(category)) {
        expect(convert(7, unit, unit)).toBeCloseTo(7, 12);
      }
    }
  });

  it('temperature units are c/f/k', () => {
    expect(unitsOf('temperature' as Category)).toEqual(['c', 'f', 'k']);
  });
});

describe('formatResult', () => {
  it('rounds to the requested decimals with locale formatting', () => {
    expect(formatResult(1234.5678, 2, 'en')).toBe('1,234.57');
    expect(formatResult(1234.5678, 2, 'de')).toBe('1.234,57');
    expect(formatResult(1.5, 0, 'en')).toBe('2');
    expect(formatResult(3, 4, 'en')).toBe('3');
  });

  it('clamps decimals into 0..6 and survives garbage', () => {
    expect(formatResult(1.23456789, 99, 'en')).toBe('1.234568');
    expect(formatResult(1.987, -3, 'en')).toBe('2');
    expect(formatResult(1.005, Number.NaN, 'en')).toBe(formatResult(1.005, 2, 'en'));
  });
});

describe('convertParamsSchema', () => {
  it('accepts a plain conversion request', () => {
    expect(convertParamsSchema.safeParse({ value: 5, from: 'km', to: 'mi' }).success).toBe(true);
  });

  it('rejects missing/invalid fields', () => {
    expect(convertParamsSchema.safeParse({ value: '5', from: 'km', to: 'mi' }).success).toBe(false);
    expect(convertParamsSchema.safeParse({ value: 5, from: '', to: 'mi' }).success).toBe(false);
    expect(convertParamsSchema.safeParse({ value: 5, from: 'km' }).success).toBe(false);
  });
});

describe('buildConverterContext', () => {
  it('mentions the last pair or the empty state, in both languages', () => {
    expect(buildConverterContext(null, 'en')).toBe('Unit converter ready; nothing converted yet.');
    expect(buildConverterContext(null, 'de')).toBe(
      'Einheiten-Umrechner bereit; noch nichts umgerechnet.',
    );
    expect(buildConverterContext({ from: 'km', to: 'mi' }, 'en')).toContain('km → mi');
    expect(buildConverterContext({ from: 'c', to: 'f' }, 'de')).toContain('Zuletzt umgerechnet: c → f');
  });
});
