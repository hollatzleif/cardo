/**
 * Pure time-zone logic for the world-clock tool.
 * DST-SAFE BY DESIGN: every wall-clock value comes out of Intl with an
 * explicit `timeZone` – there is no manual offset arithmetic anywhere.
 */

import { z } from 'zod';

export type ZoneEntry = {
  /** Stable entry id ("zone:<random>"). */
  id: string;
  /** IANA time zone, e.g. "Europe/Berlin". */
  tz: string;
  /** Display label, defaults to the city part of the tz id. */
  label: string;
};

/** Singleton storage doc `state` holding the configured zones (max 8). */
export type WorldClockState = { id: string; zones: ZoneEntry[] };

export const STATE_DOC_ID = 'state';
export const MAX_ZONES = 8;

/** Params of the world-clock.add-zone command. */
export const addZoneParamsSchema = z.object({
  tz: z.string().min(1),
  label: z.string().min(1).optional(),
});
export type AddZoneParams = z.infer<typeof addZoneParamsSchema>;

/** Curated datalist suggestions for the zone picker (~30 common zones). */
export const COMMON_TIMEZONES: readonly string[] = [
  'UTC',
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'Europe/Madrid',
  'Europe/Rome',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Amsterdam',
  'Europe/Stockholm',
  'Europe/Lisbon',
  'Europe/Athens',
  'Europe/Istanbul',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Mexico_City',
  'America/Sao_Paulo',
  'America/Argentina/Buenos_Aires',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Singapore',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Bangkok',
  'Australia/Sydney',
  'Pacific/Auckland',
  'Africa/Cairo',
  'Africa/Johannesburg',
];

export function makeZoneId(): string {
  return `zone:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** "America/New_York" → "New York" (last path segment, underscores → spaces). */
export function defaultLabel(tz: string): string {
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

/** True when the runtime's Intl accepts `tz` as a time zone. Never throws. */
export function isValidTimeZone(tz: string): boolean {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export type ZoneTime = {
  /** Two-digit wall-clock hour ("07"). */
  hh: string;
  /** Two-digit minute ("05"). */
  mm: string;
  hour: number;
  minute: number;
  /** Localized short weekday name in that zone ("Wed"/"Mi"). */
  weekday: string;
  /** Daytime = 06:00–19:59 local wall-clock. */
  isDay: boolean;
};

/**
 * Wall-clock time of `now` in `tz`, via Intl.formatToParts with guarded part
 * lookups. Numeric parts always use en-US digits (h23), only the weekday
 * label follows `locale`. Null for invalid zones – never an exception.
 */
export function zoneTime(now: Date, tz: string, locale = 'en'): ZoneTime | null {
  if (!isValidTimeZone(tz)) return null;
  try {
    const numeric = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes): string =>
      numeric.find((p) => p.type === type)?.value ?? '';
    const hh = part('hour');
    const mm = part('minute');
    const hour = Number.parseInt(hh, 10);
    const minute = Number.parseInt(mm, 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    const weekday =
      new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'short' })
        .formatToParts(now)
        .find((p) => p.type === 'weekday')?.value ?? '';
    return { hh, mm, hour, minute, weekday, isDay: hour >= 6 && hour < 20 };
  } catch {
    return null;
  }
}

/**
 * "+02:00"-style UTC offset of `tz` at the instant `now` (DST included),
 * read from Intl's longOffset name with a shortOffset fallback. Empty string
 * when the runtime cannot provide an offset – never an exception.
 */
export function offsetLabel(now: Date, tz: string): string {
  if (!isValidTimeZone(tz)) return '';
  const read = (name: 'longOffset' | 'shortOffset'): string | null => {
    try {
      return (
        new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: name })
          .formatToParts(now)
          .find((p) => p.type === 'timeZoneName')?.value ?? null
      );
    } catch {
      return null;
    }
  };
  const raw = read('longOffset') ?? read('shortOffset');
  if (!raw) return '';
  if (raw === 'GMT' || raw === 'UTC') return '+00:00';
  const match = /^(?:GMT|UTC)([+-])(\d{1,2})(?::(\d{2}))?$/.exec(raw);
  if (!match) return raw;
  const sign = match[1] ?? '+';
  const hours = (match[2] ?? '0').padStart(2, '0');
  const minutes = match[3] ?? '00';
  return `${sign}${hours}:${minutes}`;
}

/**
 * Returns a new state with the zone appended, or null when the tz is invalid
 * or the list is full (MAX_ZONES). An empty/whitespace label falls back to
 * the tz's city name.
 */
export function addZone(state: WorldClockState, tz: string, label?: string): WorldClockState | null {
  if (!isValidTimeZone(tz)) return null;
  if (state.zones.length >= MAX_ZONES) return null;
  const zone: ZoneEntry = {
    id: makeZoneId(),
    tz,
    label: (label ?? '').trim() || defaultLabel(tz),
  };
  return { ...state, zones: [...state.zones, zone] };
}

export function removeZone(state: WorldClockState, id: string): WorldClockState {
  return { ...state, zones: state.zones.filter((zone) => zone.id !== id) };
}

/** Assistant "current state" line: every zone with its local time and offset. */
export function buildWorldClockContext(zones: ZoneEntry[], now: Date, language: string): string {
  const de = language === 'de';
  if (zones.length === 0) {
    return de ? 'Keine Zeitzonen in der Weltzeituhr.' : 'No time zones in the world clock.';
  }
  const items = zones.map((zone) => {
    const time = zoneTime(now, zone.tz, language);
    if (!time) return `${zone.label}: ?`;
    const offset = offsetLabel(now, zone.tz);
    return `${zone.label}: ${time.hh}:${time.mm}${offset ? ` (UTC${offset})` : ''}`;
  });
  return `${de ? 'Weltzeituhr' : 'World clock'}: ${items.join(', ')}.`;
}

/** Hand angles (degrees, 0 = 12 o'clock, clockwise) for the small analog faces. */
export function analogAngles(hour: number, minute: number): { hour: number; minute: number } {
  return {
    hour: (((hour % 12) + 12) % 12) * 30 + minute * 0.5,
    minute: minute * 6,
  };
}
