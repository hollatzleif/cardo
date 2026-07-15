import { describe, expect, it } from 'vitest';
import {
  adherence,
  buildMedicationContext,
  doseKey,
  intakeKey,
  isDoseTaken,
  isValidTime,
  localDateKey,
  nextOccurrence,
  parseTimes,
  type IntakeDoc,
  type MedDoc,
} from './logic';

function med(partial: Partial<MedDoc>): MedDoc {
  return {
    id: 'med:test',
    type: 'med',
    name: 'Ibuprofen',
    dose: '400 mg',
    times: ['08:00', '20:00'],
    createdAt: '2026-01-01T08:00:00.000Z',
    ...partial,
  };
}

function intake(date: string, taken: Record<string, boolean>): IntakeDoc {
  return { id: intakeKey(date), type: 'intake', date, taken };
}

describe('isValidTime / parseTimes', () => {
  it('accepts HH:MM and rejects everything else', () => {
    expect(isValidTime('00:00')).toBe(true);
    expect(isValidTime('23:59')).toBe(true);
    expect(isValidTime('24:00')).toBe(false);
    expect(isValidTime('8:00')).toBe(false);
    expect(isValidTime('08:60')).toBe(false);
    expect(isValidTime('')).toBe(false);
  });

  it('parses a comma-separated list, sorted and deduped', () => {
    expect(parseTimes('20:00, 08:00,20:00')).toEqual(['08:00', '20:00']);
    expect(parseTimes(' 12:30 ')).toEqual(['12:30']);
  });

  it('rejects lists containing any invalid entry, and empty input', () => {
    expect(parseTimes('08:00, 25:00')).toBeNull();
    expect(parseTimes('')).toBeNull();
    expect(parseTimes(' , ')).toBeNull();
  });
});

describe('doseKey / isDoseTaken', () => {
  it('builds the "<medId>@<HH:MM>" key', () => {
    expect(doseKey('med:a', '08:00')).toBe('med:a@08:00');
  });

  it('reads the taken flag, defaulting to false', () => {
    const i = intake('2026-07-13', { 'med:a@08:00': true });
    expect(isDoseTaken(i, 'med:a', '08:00')).toBe(true);
    expect(isDoseTaken(i, 'med:a', '20:00')).toBe(false);
    expect(isDoseTaken(null, 'med:a', '08:00')).toBe(false);
    expect(isDoseTaken(undefined, 'med:a', '08:00')).toBe(false);
  });
});

describe('nextOccurrence', () => {
  it('picks the earliest time still ahead today', () => {
    const next = nextOccurrence(['08:00', '20:00'], new Date(2026, 6, 13, 9, 30, 0));
    expect(next?.getHours()).toBe(20);
    expect(next?.getDate()).toBe(13);
  });

  it('rolls to the FIRST time tomorrow when all times have passed', () => {
    const next = nextOccurrence(['08:00', '20:00'], new Date(2026, 6, 13, 21, 0, 0));
    expect(next?.getHours()).toBe(8);
    expect(next?.getDate()).toBe(14);
  });

  it('is exclusive at the exact minute (a dose "now" schedules the next one)', () => {
    const next = nextOccurrence(['08:00'], new Date(2026, 6, 13, 8, 0, 0, 0));
    expect(next?.getDate()).toBe(14);
  });

  it('handles the midnight rollover across month and year ends', () => {
    const monthEnd = nextOccurrence(['06:00'], new Date(2026, 6, 31, 23, 59, 0));
    expect(monthEnd && localDateKey(monthEnd)).toBe('2026-08-01');
    const yearEnd = nextOccurrence(['06:00'], new Date(2026, 11, 31, 23, 59, 0));
    expect(yearEnd && localDateKey(yearEnd)).toBe('2027-01-01');
  });

  it('a time just after midnight is found "today" shortly after midnight', () => {
    const next = nextOccurrence(['00:30'], new Date(2026, 6, 13, 0, 5, 0));
    expect(next?.getDate()).toBe(13);
    expect(next?.getHours()).toBe(0);
    expect(next?.getMinutes()).toBe(30);
  });

  it('returns null for empty or fully invalid times', () => {
    expect(nextOccurrence([], new Date())).toBeNull();
    expect(nextOccurrence(['nope'], new Date())).toBeNull();
  });

  it('ignores invalid entries but uses the valid ones', () => {
    const next = nextOccurrence(['bad', '10:00'], new Date(2026, 6, 13, 9, 0, 0));
    expect(next?.getHours()).toBe(10);
  });
});

describe('adherence', () => {
  const m = med({ id: 'med:a', times: ['08:00', '20:00'], createdAt: '2026-07-01T00:00:00' });

  it('is 100% when every expected dose is taken', () => {
    const intakes = [
      intake('2026-07-12', { 'med:a@08:00': true, 'med:a@20:00': true }),
      intake('2026-07-13', { 'med:a@08:00': true, 'med:a@20:00': true }),
    ];
    expect(adherence(intakes, [m], 2, '2026-07-13')).toBe(100);
  });

  it('counts partial days correctly (3 of 4 doses = 75%)', () => {
    const intakes = [
      intake('2026-07-12', { 'med:a@08:00': true, 'med:a@20:00': true }),
      intake('2026-07-13', { 'med:a@08:00': true }),
    ];
    expect(adherence(intakes, [m], 2, '2026-07-13')).toBe(75);
  });

  it('missing intake docs count as 0 taken for that day', () => {
    const intakes = [intake('2026-07-13', { 'med:a@08:00': true, 'med:a@20:00': true })];
    expect(adherence(intakes, [m], 2, '2026-07-13')).toBe(50);
  });

  it('excludes days before the med existed (no punishment for new meds)', () => {
    const fresh = med({ id: 'med:b', times: ['08:00'], createdAt: '2026-07-13T09:00:00' });
    const intakes = [intake('2026-07-13', { 'med:b@08:00': true })];
    // 7-day window, but only 1 day has an expected dose → 1/1 = 100%.
    expect(adherence(intakes, [fresh], 7, '2026-07-13')).toBe(100);
  });

  it('returns null when nothing was expected (no meds / no times)', () => {
    expect(adherence([], [], 7, '2026-07-13')).toBeNull();
    expect(adherence([], [med({ times: [], createdAt: '2026-01-01T00:00:00' })], 7, '2026-07-13')).toBeNull();
  });

  it('ignores meds with an invalid createdAt instead of throwing', () => {
    const broken = med({ id: 'med:x', createdAt: 'not-a-date' });
    expect(adherence([], [broken], 7, '2026-07-13')).toBeNull();
  });

  it('spans month boundaries in the day window', () => {
    const early = med({ id: 'med:a', times: ['08:00'], createdAt: '2026-06-01T00:00:00' });
    const intakes = [
      intake('2026-06-30', { 'med:a@08:00': true }),
      intake('2026-07-01', { 'med:a@08:00': true }),
    ];
    expect(adherence(intakes, [early], 2, '2026-07-01')).toBe(100);
  });
});

describe('buildMedicationContext', () => {
  const meds = [
    med({ id: 'med:a', name: 'Ibuprofen', dose: '400 mg', times: ['08:00', '20:00'] }),
    med({ id: 'med:b', name: 'Vitamin D', dose: '1 Tablette', times: ['12:00'] }),
  ];

  it('lists remaining doses sorted by time, with names and doses', () => {
    const text = buildMedicationContext(meds, { taken: { 'med:a@08:00': true } }, 'en');
    expect(text).toContain('1/3 taken');
    expect(text).toContain('12:00 Vitamin D (1 Tablette), 20:00 Ibuprofen (400 mg)');
  });

  it('reports when everything is taken', () => {
    const taken = { 'med:a@08:00': true, 'med:a@20:00': true, 'med:b@12:00': true };
    expect(buildMedicationContext(meds, { taken }, 'en')).toBe('All 3 doses for today are taken.');
    expect(buildMedicationContext(meds, { taken }, 'de')).toBe(
      'Alle 3 Dosen für heute sind genommen.',
    );
  });

  it('reports the empty state in both languages', () => {
    expect(buildMedicationContext([], null, 'en')).toBe('No medications set up.');
    expect(buildMedicationContext([], null, 'de')).toBe('Keine Medikamente angelegt.');
  });

  it('handles a missing intake doc (nothing taken yet)', () => {
    const text = buildMedicationContext(meds, null, 'de');
    expect(text).toContain('0/3 genommen');
  });
});
