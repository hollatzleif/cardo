import { describe, expect, it } from 'vitest';
import { analogAngles, timeToWords } from './logic';

function at(h: number, m: number): Date {
  const d = new Date(2026, 0, 1, h, m, 0);
  return d;
}

describe('timeToWords – German (halb = next hour)', () => {
  it('renders exact, past, half and to phrases', () => {
    expect(timeToWords(at(9, 0), 'de')).toBe('Neun Uhr');
    expect(timeToWords(at(9, 15), 'de')).toBe('viertel nach neun');
    expect(timeToWords(at(9, 30), 'de')).toBe('halb zehn');
    expect(timeToWords(at(9, 45), 'de')).toBe('viertel vor zehn');
    expect(timeToWords(at(9, 25), 'de')).toBe('fünf vor halb zehn');
  });
  it('rounds to the nearest 5 minutes', () => {
    expect(timeToWords(at(9, 2), 'de')).toBe('Neun Uhr');
    expect(timeToWords(at(9, 13), 'de')).toBe('viertel nach neun');
  });
  it('wraps 12 correctly (11:30 → halb zwölf)', () => {
    expect(timeToWords(at(11, 30), 'de')).toBe('halb zwölf');
  });
});

describe('timeToWords – English (half past = current hour)', () => {
  it('renders exact, past, half and to phrases', () => {
    expect(timeToWords(at(9, 0), 'en')).toBe("Nine o'clock");
    expect(timeToWords(at(9, 15), 'en')).toBe('quarter past nine');
    expect(timeToWords(at(9, 30), 'en')).toBe('half past nine');
    expect(timeToWords(at(9, 45), 'en')).toBe('quarter to ten');
  });
});

describe('analogAngles', () => {
  it('maps 3:00 to a 90° hour hand and 0° minute hand', () => {
    const a = analogAngles(at(3, 0));
    expect(a.hour).toBe(90);
    expect(a.minute).toBe(0);
  });
  it('advances the hour hand within the hour (9:30 → 285°)', () => {
    expect(analogAngles(at(9, 30)).hour).toBe(285);
  });
});
