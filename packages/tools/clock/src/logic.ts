/** Clock display helpers, kept pure so the word-clock logic is unit-testable. */

export type ClockLang = 'de' | 'en';

const HOURS_DE = [
  'zwölf', 'eins', 'zwei', 'drei', 'vier', 'fünf',
  'sechs', 'sieben', 'acht', 'neun', 'zehn', 'elf',
];
const HOURS_EN = [
  'twelve', 'one', 'two', 'three', 'four', 'five',
  'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
];

function hourWord(h24: number, lang: ClockLang): string {
  const i = h24 % 12;
  return (lang === 'de' ? HOURS_DE : HOURS_EN)[i] ?? '';
}

/**
 * Renders a time as a spoken phrase, rounded to the nearest 5 minutes
 * (word-clock style). German uses the "halb {next}" convention (9:30 → "halb
 * zehn"); English uses the "half past {current}" convention.
 */
export function timeToWords(date: Date, lang: ClockLang): string {
  const h = date.getHours();
  const roundedTotal = Math.round((h * 60 + date.getMinutes()) / 5) * 5;
  const hh = Math.floor((roundedTotal % 1440) / 60);
  const mm = roundedTotal % 60;
  const cur = hourWord(hh, lang);
  const next = hourWord(hh + 1, lang);

  if (lang === 'de') {
    switch (mm) {
      case 0: return `${cap(cur)} Uhr`;
      case 5: return `fünf nach ${cur}`;
      case 10: return `zehn nach ${cur}`;
      case 15: return `viertel nach ${cur}`;
      case 20: return `zwanzig nach ${cur}`;
      case 25: return `fünf vor halb ${next}`;
      case 30: return `halb ${next}`;
      case 35: return `fünf nach halb ${next}`;
      case 40: return `zwanzig vor ${next}`;
      case 45: return `viertel vor ${next}`;
      case 50: return `zehn vor ${next}`;
      case 55: return `fünf vor ${next}`;
      default: return `${cap(cur)} Uhr`;
    }
  }
  switch (mm) {
    case 0: return `${cap(cur)} o'clock`;
    case 5: return `five past ${cur}`;
    case 10: return `ten past ${cur}`;
    case 15: return `quarter past ${cur}`;
    case 20: return `twenty past ${cur}`;
    case 25: return `twenty-five past ${cur}`;
    case 30: return `half past ${cur}`;
    case 35: return `twenty-five to ${next}`;
    case 40: return `twenty to ${next}`;
    case 45: return `quarter to ${next}`;
    case 50: return `ten to ${next}`;
    case 55: return `five to ${next}`;
    default: return `${cap(cur)} o'clock`;
  }
}

function cap(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** Hand angles (degrees, 0 = 12 o'clock, clockwise) for an analog face. */
export function analogAngles(date: Date): { hour: number; minute: number; second: number } {
  const s = date.getSeconds();
  const m = date.getMinutes();
  const h = date.getHours() % 12;
  return {
    second: s * 6,
    minute: m * 6 + s * 0.1,
    hour: h * 30 + m * 0.5,
  };
}
