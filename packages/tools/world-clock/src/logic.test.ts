import { describe, expect, it } from 'vitest';
import {
  COMMON_TIMEZONES,
  MAX_ZONES,
  STATE_DOC_ID,
  addZone,
  addZoneParamsSchema,
  analogAngles,
  buildWorldClockContext,
  defaultLabel,
  isValidTimeZone,
  offsetLabel,
  removeZone,
  zoneTime,
  type WorldClockState,
  type ZoneEntry,
} from './logic';

const emptyState = (): WorldClockState => ({ id: STATE_DOC_ID, zones: [] });

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimeZone('Europe/Berlin')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejects garbage without throwing', () => {
    expect(isValidTimeZone('Not/AZone')).toBe(false);
    expect(isValidTimeZone('Europe/Atlantis')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('every curated suggestion is valid (and there are ≥ 30)', () => {
    expect(COMMON_TIMEZONES.length).toBeGreaterThanOrEqual(30);
    for (const tz of COMMON_TIMEZONES) {
      expect(isValidTimeZone(tz), tz).toBe(true);
    }
  });
});

describe('zoneTime (DST-safe via Intl, never manual offsets)', () => {
  // Winter instant: Berlin is CET (UTC+1), New York EST (UTC-5).
  const winter = new Date('2026-01-15T12:00:00Z');
  // Summer instant: Berlin is CEST (UTC+2), New York EDT (UTC-4).
  const summer = new Date('2026-07-15T12:00:00Z');

  it('known zones differ as expected (winter)', () => {
    expect(zoneTime(winter, 'Europe/Berlin')).toMatchObject({ hh: '13', mm: '00', hour: 13 });
    expect(zoneTime(winter, 'America/New_York')).toMatchObject({ hh: '07', mm: '00', hour: 7 });
    expect(zoneTime(winter, 'UTC')).toMatchObject({ hh: '12', mm: '00' });
  });

  it('follows DST transitions (summer)', () => {
    expect(zoneTime(summer, 'Europe/Berlin')?.hh).toBe('14');
    expect(zoneTime(summer, 'America/New_York')?.hh).toBe('08');
  });

  it('marks day and night across the 06:00 / 20:00 boundaries', () => {
    // Berlin in winter = UTC+1.
    expect(zoneTime(new Date('2026-01-15T04:59:00Z'), 'Europe/Berlin')?.isDay).toBe(false); // 05:59
    expect(zoneTime(new Date('2026-01-15T05:00:00Z'), 'Europe/Berlin')?.isDay).toBe(true); // 06:00
    expect(zoneTime(new Date('2026-01-15T18:59:00Z'), 'Europe/Berlin')?.isDay).toBe(true); // 19:59
    expect(zoneTime(new Date('2026-01-15T19:00:00Z'), 'Europe/Berlin')?.isDay).toBe(false); // 20:00
  });

  it('reports a localized weekday', () => {
    const en = zoneTime(winter, 'Europe/Berlin', 'en');
    const de = zoneTime(winter, 'Europe/Berlin', 'de');
    expect(en?.weekday).toBe('Thu');
    expect(de?.weekday.startsWith('Do')).toBe(true);
  });

  it('midnight is 00, not 24 (h23)', () => {
    expect(zoneTime(new Date('2026-01-15T23:00:00Z'), 'Europe/Berlin')?.hh).toBe('00');
  });

  it('rejects invalid zones with null', () => {
    expect(zoneTime(winter, 'Not/AZone')).toBeNull();
    expect(zoneTime(winter, '')).toBeNull();
  });
});

describe('offsetLabel', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');

  it('is DST-aware', () => {
    expect(offsetLabel(winter, 'Europe/Berlin')).toBe('+01:00');
    expect(offsetLabel(summer, 'Europe/Berlin')).toBe('+02:00');
    expect(offsetLabel(winter, 'America/New_York')).toBe('-05:00');
    expect(offsetLabel(summer, 'America/New_York')).toBe('-04:00');
  });

  it('handles UTC and half-hour zones', () => {
    expect(offsetLabel(winter, 'UTC')).toBe('+00:00');
    expect(offsetLabel(winter, 'Asia/Kolkata')).toBe('+05:30');
  });

  it('returns an empty string for invalid zones', () => {
    expect(offsetLabel(winter, 'Not/AZone')).toBe('');
  });
});

describe('addZone / removeZone', () => {
  it('adds a valid zone with a default label', () => {
    const next = addZone(emptyState(), 'America/New_York');
    expect(next).not.toBeNull();
    expect(next?.zones).toHaveLength(1);
    expect(next?.zones[0]?.tz).toBe('America/New_York');
    expect(next?.zones[0]?.label).toBe('New York');
    expect(next?.zones[0]?.id.startsWith('zone:')).toBe(true);
  });

  it('prefers a trimmed custom label', () => {
    const next = addZone(emptyState(), 'Europe/Berlin', '  Home  ');
    expect(next?.zones[0]?.label).toBe('Home');
  });

  it('a whitespace label falls back to the default', () => {
    const next = addZone(emptyState(), 'Europe/Berlin', '   ');
    expect(next?.zones[0]?.label).toBe('Berlin');
  });

  it('rejects invalid zones', () => {
    expect(addZone(emptyState(), 'Not/AZone')).toBeNull();
  });

  it('enforces the maximum of 8 zones', () => {
    let state = emptyState();
    for (let i = 0; i < MAX_ZONES; i += 1) {
      const next = addZone(state, 'UTC', `Zone ${i}`);
      expect(next).not.toBeNull();
      if (next) state = next;
    }
    expect(state.zones).toHaveLength(MAX_ZONES);
    expect(addZone(state, 'UTC', 'One too many')).toBeNull();
  });

  it('removeZone drops exactly the matching entry', () => {
    const a = addZone(emptyState(), 'UTC', 'A');
    const b = a ? addZone(a, 'Europe/Berlin', 'B') : null;
    expect(b?.zones).toHaveLength(2);
    const firstId = b?.zones[0]?.id ?? '';
    const after = removeZone(b ?? emptyState(), firstId);
    expect(after.zones).toHaveLength(1);
    expect(after.zones[0]?.label).toBe('B');
    // Unknown ids are a no-op.
    expect(removeZone(after, 'zone:nope').zones).toHaveLength(1);
  });
});

describe('defaultLabel', () => {
  it('uses the last path segment with spaces', () => {
    expect(defaultLabel('America/New_York')).toBe('New York');
    expect(defaultLabel('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(defaultLabel('UTC')).toBe('UTC');
  });
});

describe('analogAngles', () => {
  it('maps wall-clock time to hand angles', () => {
    expect(analogAngles(3, 0)).toEqual({ hour: 90, minute: 0 });
    expect(analogAngles(15, 0)).toEqual({ hour: 90, minute: 0 }); // 12h face
    expect(analogAngles(6, 30)).toEqual({ hour: 195, minute: 180 });
    expect(analogAngles(0, 0)).toEqual({ hour: 0, minute: 0 });
  });
});

describe('addZoneParamsSchema', () => {
  it('requires a tz and allows an optional label', () => {
    expect(addZoneParamsSchema.safeParse({ tz: 'Europe/Berlin' }).success).toBe(true);
    expect(addZoneParamsSchema.safeParse({ tz: 'Europe/Berlin', label: 'Home' }).success).toBe(true);
    expect(addZoneParamsSchema.safeParse({ tz: '' }).success).toBe(false);
    expect(addZoneParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe('buildWorldClockContext', () => {
  const now = new Date('2026-01-15T12:00:00Z');
  const zones: ZoneEntry[] = [
    { id: 'zone:1', tz: 'Europe/Berlin', label: 'Berlin' },
    { id: 'zone:2', tz: 'America/New_York', label: 'NYC' },
  ];

  it('reports the empty state in both languages', () => {
    expect(buildWorldClockContext([], now, 'en')).toBe('No time zones in the world clock.');
    expect(buildWorldClockContext([], now, 'de')).toBe('Keine Zeitzonen in der Weltzeituhr.');
  });

  it('lists every zone with local time and offset', () => {
    const text = buildWorldClockContext(zones, now, 'en');
    expect(text).toContain('World clock:');
    expect(text).toContain('Berlin: 13:00 (UTC+01:00)');
    expect(text).toContain('NYC: 07:00 (UTC-05:00)');
  });

  it('marks broken zones instead of crashing', () => {
    const text = buildWorldClockContext(
      [{ id: 'zone:x', tz: 'Not/AZone', label: 'Broken' }],
      now,
      'en',
    );
    expect(text).toContain('Broken: ?');
  });
});
