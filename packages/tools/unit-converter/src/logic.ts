/**
 * Pure conversion logic for the unit-converter tool.
 * Linear categories convert through a base unit ({unit: factorToBase});
 * temperature converts through offset functions (Celsius as pivot).
 * Unknown units return null – this module never throws.
 */

import { z } from 'zod';

export type Category = 'length' | 'weight' | 'temperature' | 'data' | 'speed' | 'volume' | 'area';

export const CATEGORIES: Category[] = [
  'length',
  'weight',
  'temperature',
  'data',
  'speed',
  'volume',
  'area',
];

/** Params of the unit-converter.convert command. */
export const convertParamsSchema = z.object({
  value: z.number(),
  from: z.string().min(1),
  to: z.string().min(1),
});
export type ConvertParams = z.infer<typeof convertParamsSchema>;

type LinearCategory = Exclude<Category, 'temperature'>;

/**
 * Factor-to-base tables. Base units: m, kg, byte, m/s, l, m².
 * The data category deliberately carries BOTH decimal (KB = 1000 B) and
 * binary (KiB = 1024 B) units – they are different things.
 */
const TABLES: Record<LinearCategory, Record<string, number>> = {
  length: {
    mm: 0.001,
    cm: 0.01,
    m: 1,
    km: 1000,
    in: 0.0254,
    ft: 0.3048,
    yd: 0.9144,
    mi: 1609.344,
  },
  weight: {
    mg: 0.000001,
    g: 0.001,
    kg: 1,
    t: 1000,
    oz: 0.028349523125,
    lb: 0.45359237,
  },
  data: {
    B: 1,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    KiB: 1024,
    MiB: 1024 ** 2,
    GiB: 1024 ** 3,
    TiB: 1024 ** 4,
  },
  speed: {
    'm/s': 1,
    'km/h': 1 / 3.6,
    mph: 0.44704,
    kn: 1852 / 3600,
    'ft/s': 0.3048,
  },
  volume: {
    ml: 0.001,
    cl: 0.01,
    l: 1,
    m3: 1000,
    tsp: 0.00492892159375,
    tbsp: 0.01478676478125,
    floz: 0.0295735295625,
    cup: 0.2365882365,
    pt: 0.473176473,
    qt: 0.946352946,
    gal: 3.785411784,
  },
  area: {
    cm2: 0.0001,
    m2: 1,
    ha: 10000,
    km2: 1e6,
    in2: 0.00064516,
    ft2: 0.09290304,
    acre: 4046.8564224,
    mi2: 2589988.110336,
  },
};

const TEMPERATURE_UNITS = ['c', 'f', 'k'] as const;
export type TemperatureUnit = (typeof TEMPERATURE_UNITS)[number];

function toCelsius(value: number, unit: TemperatureUnit): number {
  switch (unit) {
    case 'c':
      return value;
    case 'f':
      return ((value - 32) * 5) / 9;
    case 'k':
      return value - 273.15;
  }
}

function fromCelsius(value: number, unit: TemperatureUnit): number {
  switch (unit) {
    case 'c':
      return value;
    case 'f':
      return (value * 9) / 5 + 32;
    case 'k':
      return value + 273.15;
  }
}

/** Ordered unit ids of a category (select options, conversions, i18n labels). */
export function unitsOf(category: Category): string[] {
  if (category === 'temperature') return [...TEMPERATURE_UNITS];
  return Object.keys(TABLES[category]);
}

/* Exact-id lookup plus a case-insensitive fallback (built once). */
const EXACT = new Map<string, Category>();
const LOWER = new Map<string, { unit: string; category: Category } | null>();
for (const category of CATEGORIES) {
  for (const unit of unitsOf(category)) {
    EXACT.set(unit, category);
    const lower = unit.toLowerCase();
    // Ambiguous lowercase forms resolve to null → rejected on lookup.
    LOWER.set(lower, LOWER.has(lower) && LOWER.get(lower)?.unit !== unit ? null : { unit, category });
  }
}

/**
 * Resolves a raw unit string ("km", "Mb", "°C") to its canonical id and
 * category. Case-insensitive fallback; a leading degree sign is ignored.
 * Unknown units resolve to null – never an exception.
 */
export function resolveUnit(raw: string): { unit: string; category: Category } | null {
  const trimmed = raw.trim().replace(/^°/, '');
  if (!trimmed) return null;
  const exact = EXACT.get(trimmed);
  if (exact) return { unit: trimmed, category: exact };
  return LOWER.get(trimmed.toLowerCase()) ?? null;
}

/** Category shared by both units, or null when unknown/mismatched. */
export function inferCategory(from: string, to: string): Category | null {
  const f = resolveUnit(from);
  const g = resolveUnit(to);
  if (!f || !g || f.category !== g.category) return null;
  return f.category;
}

/**
 * Converts `value` from one unit to another. When `category` is given, both
 * units must belong to it. Returns null for unknown units, category
 * mismatches or non-finite values – it never throws.
 */
export function convert(value: number, from: string, to: string, category?: Category): number | null {
  if (!Number.isFinite(value)) return null;
  const f = resolveUnit(from);
  const g = resolveUnit(to);
  if (!f || !g || f.category !== g.category) return null;
  if (category && f.category !== category) return null;
  if (f.category === 'temperature') {
    return fromCelsius(toCelsius(value, f.unit as TemperatureUnit), g.unit as TemperatureUnit);
  }
  const table = TABLES[f.category as LinearCategory];
  const factorFrom = table[f.unit];
  const factorTo = table[g.unit];
  if (factorFrom === undefined || factorTo === undefined || factorTo === 0) return null;
  return (value * factorFrom) / factorTo;
}

/**
 * Display formatting: rounds to `decimals` fraction digits (clamped to 0..6)
 * and formats with the UI language's number conventions.
 */
export function formatResult(value: number, decimals: number, language = 'en'): string {
  const d = Math.min(6, Math.max(0, Math.trunc(Number.isFinite(decimals) ? decimals : 2)));
  return new Intl.NumberFormat(language, { maximumFractionDigits: d }).format(value);
}

export type LastPair = { from: string; to: string } | null;

/** Assistant "current state" line: which pair was converted last, if any. */
export function buildConverterContext(last: LastPair, language: string): string {
  const de = language === 'de';
  if (!last) {
    return de
      ? 'Einheiten-Umrechner bereit; noch nichts umgerechnet.'
      : 'Unit converter ready; nothing converted yet.';
  }
  return de
    ? `Einheiten-Umrechner bereit. Zuletzt umgerechnet: ${last.from} → ${last.to}.`
    : `Unit converter ready. Last conversion: ${last.from} → ${last.to}.`;
}
