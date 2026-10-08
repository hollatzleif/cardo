import { describe, expect, it } from 'vitest';
import {
  expandDays,
  isAlarmTitle,
  isGoogleIcsUrl,
  occurrencesIn,
  parseDuration,
  parseIcs,
  stableHash,
  stripAlarm,
  unescapeText,
  wallToUtc,
} from './ics';

const cal = (...events: string[]) =>
  ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const vevent = (lines: string[]) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'].join('\r\n');

// Wide window around 2026 so local-time conversions never fall outside.
const WIN = { fromMs: Date.UTC(2025, 0, 1), toMs: Date.UTC(2028, 0, 1) };

/** Expected local date/time for an instant, computed the same way the app does. */
function local(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}`,
  };
}

describe('iCalendar parsing', () => {
  it('unfolds lines, unescapes text and reads TZID times', () => {
    const events = parseIcs(
      cal(
        vevent([
          'UID:abc@google.com',
          'DTSTART;TZID=Europe/Berlin:20261008T090000',
          'DTEND;TZID=Europe/Berlin:20261008T103000',
          'SUMMARY:Seminar\\, Teil 1\\; mit',
          ' Pause',
          'BEGIN:VALARM',
          'TRIGGER:-PT10M',
          'END:VALARM',
        ]),
      ),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.summary).toBe('Seminar, Teil 1; mitPause');
    expect(events[0]!.durationMs).toBe(90 * 60_000);
    const [occ] = occurrencesIn(events, WIN);
    // 09:00 Berlin (CEST, UTC+2) = 07:00 UTC.
    expect({ date: occ!.date, time: occ!.time }).toEqual(local(Date.UTC(2026, 9, 8, 7, 0)));
    expect(occ!.durationMinutes).toBe(90);
    expect(occ!.recurring).toBe(false);
  });

  it('handles UTC times and all-day dates', () => {
    const occ = occurrencesIn(
      parseIcs(
        cal(
          vevent(['UID:u1', 'DTSTART:20261008T120000Z', 'SUMMARY:UTC']),
          vevent([
            'UID:u2',
            'DTSTART;VALUE=DATE:20261224',
            'DTEND;VALUE=DATE:20261225',
            'SUMMARY:Heiligabend',
          ]),
        ),
      ),
      WIN,
    );
    expect(occ.find((o) => o.uid === 'u1')).toMatchObject(local(Date.UTC(2026, 9, 8, 12, 0)));
    const allDay = occ.find((o) => o.uid === 'u2')!;
    expect(allDay.date).toBe('2026-12-24');
    expect(allDay.time).toBeUndefined();
  });

  it('keeps wall time across the DST switch for weekly series', () => {
    const occ = occurrencesIn(
      parseIcs(
        cal(
          vevent([
            'UID:weekly',
            'DTSTART;TZID=Europe/Berlin:20261019T090000',
            'RRULE:FREQ=WEEKLY;COUNT=3',
            'SUMMARY:Jour fixe',
          ]),
        ),
      ),
      WIN,
    );
    expect(occ.map((o) => o.key.split('@')[0])).toEqual(['weekly', 'weekly', 'weekly']);
    // Oct 19 + 26 (DST ends Oct 25) + Nov 2: always 09:00 in Berlin.
    expect(occ.map((o) => o.date + ' ' + o.time)).toEqual(
      [Date.UTC(2026, 9, 19, 7), Date.UTC(2026, 9, 26, 8), Date.UTC(2026, 10, 2, 8)].map((ms) => {
        const l = local(ms);
        return l.date + ' ' + l.time;
      }),
    );
  });

  it('applies EXDATE, overrides and cancellations', () => {
    const occ = occurrencesIn(
      parseIcs(
        cal(
          vevent([
            'UID:s',
            'DTSTART;TZID=Europe/Berlin:20261005T180000',
            'RRULE:FREQ=DAILY;COUNT=5',
            'EXDATE;TZID=Europe/Berlin:20261006T180000',
            'SUMMARY:Laufen',
          ]),
          // Oct 7 moved to 20:00 with a new title
          vevent([
            'UID:s',
            'RECURRENCE-ID;TZID=Europe/Berlin:20261007T180000',
            'DTSTART;TZID=Europe/Berlin:20261007T200000',
            'SUMMARY:Laufen (später)',
          ]),
          // Oct 8 cancelled
          vevent([
            'UID:s',
            'RECURRENCE-ID;TZID=Europe/Berlin:20261008T180000',
            'DTSTART;TZID=Europe/Berlin:20261008T180000',
            'STATUS:CANCELLED',
            'SUMMARY:Laufen',
          ]),
        ),
      ),
      WIN,
    );
    expect(occ.map((o) => o.title)).toEqual(['Laufen', 'Laufen (später)', 'Laufen']);
    expect(occ[1]!.time).toBe(local(Date.UTC(2026, 9, 7, 18)).time);
    // The moved occurrence keeps the key of its original slot.
    expect(occ[1]!.key).toBe(`s@${Date.UTC(2026, 9, 7, 16)}`);
  });

  it('stops at UNTIL and ignores cancelled masters', () => {
    const occ = occurrencesIn(
      parseIcs(
        cal(
          vevent([
            'UID:u',
            'DTSTART;VALUE=DATE:20261001',
            'RRULE:FREQ=DAILY;UNTIL=20261003',
            'SUMMARY:x',
          ]),
          vevent(['UID:c', 'DTSTART;VALUE=DATE:20261001', 'STATUS:CANCELLED', 'SUMMARY:weg']),
        ),
      ),
      WIN,
    );
    expect(occ.map((o) => o.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03']);
  });

  it('only returns occurrences inside the window', () => {
    const occ = occurrencesIn(
      parseIcs(
        cal(
          vevent([
            'UID:bday',
            'DTSTART;VALUE=DATE:19800315',
            'RRULE:FREQ=YEARLY',
            'SUMMARY:Geburtstag',
          ]),
        ),
      ),
      { fromMs: Date.UTC(2026, 0, 1), toMs: Date.UTC(2027, 0, 1) },
    );
    expect(occ.map((o) => o.date)).toEqual(['2026-03-15']);
  });
});

describe('recurrence rules', () => {
  const days = (rule: Record<string, string>, y: number, m: number, d: number, n = 400) =>
    expandDays(rule, { y, m, d }, Math.floor(Date.UTC(y, m - 1, d) / 86_400_000) + n).map((day) =>
      new Date(day * 86_400_000).toISOString().slice(0, 10),
    );

  it('weekly with BYDAY and INTERVAL', () => {
    expect(
      days({ FREQ: 'WEEKLY', INTERVAL: '2', BYDAY: 'MO,TH', COUNT: '4' }, 2026, 10, 5),
    ).toEqual(['2026-10-05', '2026-10-08', '2026-10-19', '2026-10-22']);
  });

  it('monthly on the last Friday and on the 31st (skipping short months)', () => {
    expect(days({ FREQ: 'MONTHLY', BYDAY: '-1FR', COUNT: '3' }, 2026, 10, 30)).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
    ]);
    expect(days({ FREQ: 'MONTHLY', COUNT: '3' }, 2026, 10, 31)).toEqual([
      '2026-10-31',
      '2026-12-31',
      '2027-01-31',
    ]);
  });

  it('monthly on the second Tuesday', () => {
    expect(days({ FREQ: 'MONTHLY', BYDAY: '2TU', COUNT: '2' }, 2026, 10, 13)).toEqual([
      '2026-10-13',
      '2026-11-10',
    ]);
  });

  it('yearly on Feb 29 only in leap years', () => {
    expect(days({ FREQ: 'YEARLY', COUNT: '2' }, 2024, 2, 29, 366 * 9)).toEqual([
      '2024-02-29',
      '2028-02-29',
    ]);
  });
});

describe('helpers', () => {
  it('parses durations', () => {
    expect(parseDuration('PT1H30M')).toBe(90 * 60_000);
    expect(parseDuration('P1D')).toBe(86_400_000);
    expect(parseDuration('P1W')).toBe(7 * 86_400_000);
    expect(parseDuration('nonsense')).toBeNull();
  });

  it('unescapes text', () => {
    expect(unescapeText('a\\nb\\,c\\\\d')).toBe('a\nb,c\\d');
  });

  it('converts zoned wall time to UTC, also for the DST gap', () => {
    expect(wallToUtc('Europe/Berlin', 2026, 1, 15, 12, 0)).toBe(Date.UTC(2026, 0, 15, 11, 0));
    expect(wallToUtc('Europe/Berlin', 2026, 7, 15, 12, 0)).toBe(Date.UTC(2026, 6, 15, 10, 0));
    expect(wallToUtc('America/New_York', 2026, 7, 15, 12, 0)).toBe(Date.UTC(2026, 6, 15, 16, 0));
  });

  it('recognises the ⏰ rule', () => {
    expect(isAlarmTitle('⏰ Steuer abgeben')).toBe(true);
    expect(isAlarmTitle('⏰️Steuer')).toBe(true);
    expect(isAlarmTitle('Steuer ⏰')).toBe(false);
    expect(stripAlarm('⏰️  Steuer abgeben')).toBe('Steuer abgeben');
    expect(stripAlarm('⏰')).toBe('⏰');
  });

  it('accepts only Google secret iCal addresses', () => {
    expect(
      isGoogleIcsUrl(
        'https://calendar.google.com/calendar/ical/heike%40gmail.com/private-abc123/basic.ics',
      ),
    ).toBe(true);
    expect(isGoogleIcsUrl('http://calendar.google.com/calendar/ical/x/basic.ics')).toBe(false);
    expect(isGoogleIcsUrl('https://evil.example/calendar/ical/x/basic.ics')).toBe(false);
    expect(isGoogleIcsUrl('https://calendar.google.com/calendar/embed?src=x')).toBe(false);
  });

  it('stable hash is deterministic and id-safe', () => {
    expect(stableHash('a@1')).toBe(stableHash('a@1'));
    expect(stableHash('a@1')).not.toBe(stableHash('a@2'));
    expect(stableHash('x')).toMatch(/^[0-9a-z]+$/);
  });
});
