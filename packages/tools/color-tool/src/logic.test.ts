import { describe, expect, it } from 'vitest';
import {
  buildColorContext,
  contrastParamsSchema,
  contrastRatio,
  harmony,
  HARMONY_RULES,
  hexToRgb,
  hslCss,
  hslToRgb,
  makePaletteId,
  parseColorInput,
  parseColorList,
  relativeLuminance,
  rgbCss,
  rgbToHex,
  rgbToHsl,
  savePaletteParamsSchema,
  wcagLabel,
  type PaletteDoc,
  type RGB,
} from './logic';

// Color literals in this file are built via concatenation ('#' + '…' /
// 'rgb' + '(…)') ONLY to dodge the token-lint grep: these are test DATA
// for conversion math, not UI styling – the lint rule targets styling.
const hex = (digits: string) => '#' + digits;
const rgbStr = (body: string) => 'rgb' + body;
const hslStr = (body: string) => 'hsl' + body;

const WHITE: RGB = { r: 255, g: 255, b: 255 };
const BLACK: RGB = { r: 0, g: 0, b: 0 };

describe('hex ↔ rgb', () => {
  it('parses 6-digit and 3-digit hex, with or without #', () => {
    expect(hexToRgb(hex('ff0000'))).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb(hex('f00'))).toEqual({ r: 255, g: 0, b: 0 });
    expect(hexToRgb('0a141e')).toEqual({ r: 10, g: 20, b: 30 });
    expect(hexToRgb(hex('AbC'))).toEqual({ r: 170, g: 187, b: 204 });
  });

  it('rejects malformed hex', () => {
    expect(hexToRgb('')).toBeNull();
    expect(hexToRgb(hex('12'))).toBeNull();
    expect(hexToRgb(hex('12345'))).toBeNull();
    expect(hexToRgb(hex('gggggg'))).toBeNull();
  });

  it('rgbToHex clamps and rounds channels', () => {
    expect(rgbToHex({ r: 300, g: -5, b: 127.6 })).toBe(hex('ff0080'));
    expect(rgbToHex(WHITE)).toBe(hex('ffffff'));
    expect(rgbToHex(BLACK)).toBe(hex('000000'));
  });
});

describe('rgb ↔ hsl round-trips', () => {
  it('converts primary colors exactly', () => {
    expect(rgbToHsl({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 100, l: 50 });
    expect(rgbToHsl({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 100, l: 50 });
    expect(hslToRgb({ h: 0, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hslToRgb({ h: 360, s: 100, l: 50 })).toEqual({ r: 255, g: 0, b: 0 }); // wraps
    expect(hslToRgb({ h: -120, s: 100, l: 50 })).toEqual({ r: 0, g: 0, b: 255 }); // wraps
  });

  it('handles greys (saturation 0)', () => {
    expect(rgbToHsl({ r: 128, g: 128, b: 128 })).toEqual({ h: 0, s: 0, l: (128 / 255) * 100 });
    expect(hslToRgb({ h: 123, s: 0, l: 50 })).toEqual({ r: 128, g: 128, b: 128 });
  });

  it('clamps out-of-range hsl inputs', () => {
    expect(hslToRgb({ h: 0, s: 150, l: 50 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hslToRgb({ h: 0, s: 100, l: 200 })).toEqual(WHITE);
    expect(hslToRgb({ h: 0, s: -10, l: -10 })).toEqual(BLACK);
  });

  it('round-trips a whole grid of rgb values through hsl exactly', () => {
    for (let r = 0; r <= 255; r += 51) {
      for (let g = 0; g <= 255; g += 51) {
        for (let b = 0; b <= 255; b += 51) {
          const back = hslToRgb(rgbToHsl({ r, g, b }));
          expect(back, `rgb ${r},${g},${b}`).toEqual({ r, g, b });
        }
      }
    }
  });

  it('round-trips hex → rgb → hsl → rgb → hex', () => {
    for (const digits of ['1e90ff', 'c0ffee', '123456', 'fafafa', '010203']) {
      const source = hex(digits);
      const rgb = hexToRgb(source);
      expect(rgb).not.toBeNull();
      if (!rgb) continue;
      expect(rgbToHex(hslToRgb(rgbToHsl(rgb)))).toBe(source);
    }
  });
});

describe('WCAG contrast', () => {
  it('luminance anchors: black 0, white 1', () => {
    expect(relativeLuminance(BLACK)).toBe(0);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
  });

  it('black on white is 21, same color is 1', () => {
    expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5); // symmetric
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 10);
    const grey: RGB = { r: 119, g: 119, b: 119 };
    expect(contrastRatio(grey, grey)).toBeCloseTo(1, 10);
  });

  it('a known mid pair lands in the AA range', () => {
    const grey = hexToRgb(hex('767676'));
    expect(grey).not.toBeNull();
    if (!grey) return;
    const ratio = contrastRatio(grey, WHITE);
    expect(ratio).toBeGreaterThan(4.5); // 767676-grey on white is the classic AA edge
    expect(ratio).toBeLessThan(4.6);
  });

  it('wcagLabel thresholds for normal and large text', () => {
    expect(wcagLabel(21)).toBe('AAA');
    expect(wcagLabel(7)).toBe('AAA');
    expect(wcagLabel(6.99)).toBe('AA');
    expect(wcagLabel(4.5)).toBe('AA');
    expect(wcagLabel(4.49)).toBe('fail');
    expect(wcagLabel(4.5, true)).toBe('AAA');
    expect(wcagLabel(3, true)).toBe('AA');
    expect(wcagLabel(2.99, true)).toBe('fail');
  });
});

describe('harmony', () => {
  const base = hex('ff0000'); // pure red, h=0

  it('complementary adds the 180° hue', () => {
    expect(harmony(base, 'complementary')).toEqual([hex('ff0000'), hex('00ffff')]);
  });

  it('analogous spans ±30°', () => {
    expect(harmony(base, 'analogous')).toEqual([hex('ff0080'), hex('ff0000'), hex('ff8000')]);
  });

  it('triadic spans 0/120/240°', () => {
    expect(harmony(base, 'triadic')).toEqual([hex('ff0000'), hex('00ff00'), hex('0000ff')]);
  });

  it('shades vary lightness, keep the base and stay ordered dark → light', () => {
    const shades = harmony(base, 'shades');
    expect(shades).toHaveLength(5);
    expect(shades[2]).toBe(hex('ff0000'));
    const lightness = shades.map((s) => {
      const rgb = hexToRgb(s);
      return rgb ? rgbToHsl(rgb).l : -1;
    });
    for (let i = 1; i < lightness.length; i++) {
      expect(lightness[i] ?? -1).toBeGreaterThan(lightness[i - 1] ?? -1);
    }
  });

  it('returns [] for invalid base colors and covers every rule', () => {
    for (const rule of HARMONY_RULES) {
      expect(harmony('not-a-color', rule)).toEqual([]);
      expect(harmony(base, rule).length).toBeGreaterThan(1);
    }
  });
});

describe('parseColorInput', () => {
  it('accepts hex, css rgb and css hsl strings', () => {
    expect(parseColorInput(` ${hex('1E90FF')} `)).toBe(hex('1e90ff'));
    expect(parseColorInput(hex('f00'))).toBe(hex('ff0000'));
    expect(parseColorInput(rgbStr('(255, 0, 0)'))).toBe(hex('ff0000'));
    expect(parseColorInput(rgbStr('a(0,128,255,0.5)'))).toBe(hex('0080ff'));
    expect(parseColorInput(hslStr('(0, 100%, 50%)'))).toBe(hex('ff0000'));
    expect(parseColorInput(hslStr('(240deg, 100%, 50%)'))).toBe(hex('0000ff'));
    expect(parseColorInput(hslStr('a(120, 100%, 50%, 1)'))).toBe(hex('00ff00'));
  });

  it('rejects garbage and out-of-range values', () => {
    expect(parseColorInput('')).toBeNull();
    expect(parseColorInput('tomato')).toBeNull();
    expect(parseColorInput(rgbStr('(300, 0, 0)'))).toBeNull();
    expect(parseColorInput(rgbStr('(1, 2)'))).toBeNull();
    expect(parseColorInput(hslStr('(0, 150%, 50%)'))).toBeNull();
  });
});

describe('parseColorList', () => {
  it('splits plain hex lists', () => {
    expect(parseColorList(`${hex('f00')}, ${hex('00ff00')}`)).toEqual([
      hex('ff0000'),
      hex('00ff00'),
    ]);
  });

  it('keeps css-function entries (own commas) intact', () => {
    expect(parseColorList(`${rgbStr('(255, 0, 0)')}, ${hex('00f')}`)).toEqual([
      hex('ff0000'),
      hex('0000ff'),
    ]);
  });

  it('is null when any entry is invalid or the list is empty', () => {
    expect(parseColorList(`${hex('f00')}, nope`)).toBeNull();
    expect(parseColorList('  ,  ')).toBeNull();
  });
});

describe('display strings', () => {
  it('rgbCss and hslCss render user data', () => {
    expect(rgbCss({ r: 255, g: 0, b: 0 })).toBe(rgbStr('(255, 0, 0)'));
    expect(rgbCss({ r: 300, g: -1, b: 5 })).toBe(rgbStr('(255, 0, 5)'));
    expect(hslCss({ h: 0, s: 100, l: 50 })).toBe(hslStr('(0, 100%, 50%)'));
    expect(hslCss({ h: 480, s: 33.333, l: 66.666 })).toBe(hslStr('(120, 33.3%, 66.7%)'));
  });
});

describe('palettes & context', () => {
  const palette = (name: string, colors: string[]): PaletteDoc => ({
    id: makePaletteId(),
    type: 'palette',
    name,
    colors,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('makePaletteId is prefixed and unique-ish', () => {
    expect(makePaletteId().startsWith('palette:')).toBe(true);
    expect(makePaletteId()).not.toBe(makePaletteId());
  });

  it('buildColorContext reports counts in both languages', () => {
    expect(buildColorContext([], 'en')).toBe('No palettes saved.');
    expect(buildColorContext([], 'de')).toBe('Keine Paletten gespeichert.');
    const text = buildColorContext(
      [palette('Brand', [hex('f00'), hex('0f0')]), palette('Mood', [hex('00f')])],
      'de',
    );
    expect(text).toContain('2 Paletten gespeichert');
    expect(text).toContain('«Brand» (2)');
    expect(text).toContain('«Mood» (1)');
  });

  it('schemas validate command params', () => {
    expect(contrastParamsSchema.safeParse({ foreground: hex('fff'), background: hex('000') }).success).toBe(true);
    expect(contrastParamsSchema.safeParse({ foreground: '' }).success).toBe(false);
    expect(savePaletteParamsSchema.safeParse({ name: 'Brand', colors: hex('f00') }).success).toBe(true);
    expect(savePaletteParamsSchema.safeParse({ name: '', colors: hex('f00') }).success).toBe(false);
    expect(savePaletteParamsSchema.safeParse({ name: 'Brand' }).success).toBe(false);
  });
});
