/**
 * Minimal iCalendar (RFC 5545) reader for subscribed calendars – enough for
 * Google Calendar's "secret address in iCal format": VEVENTs with DTSTART/
 * DTEND/DURATION in UTC, with TZID or as all-day dates, RRULE recurrence
 * (DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL, BYDAY,
 * BYMONTHDAY, BYMONTH), EXDATE, and RECURRENCE-ID overrides/cancellations.
 *
 * Pure: no host access, unit-tested. Output is in the DEVICE's local wall
 * time, the same "YYYY-MM-DD" + "HH:MM" model the calendar widget stores.
 */

/* ── Time values ──────────────────────────────────────────────────────── */

export type IcsTime =
  | { kind: 'date'; y: number; m: number; d: number }
  | { kind: 'utc'; ms: number }
  /** Wall time in an IANA zone; `tz` undefined = floating (device local). */
  | {
      kind: 'wall';
      tz?: string;
      y: number;
      m: number;
      d: number;
      h: number;
      mi: number;
      s: number;
    };

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}

export interface IcsEvent {
  uid: string;
  summary: string;
  start: IcsTime;
  /** Duration in ms (from DTEND or DURATION); undefined = none given. */
  durationMs?: number;
  rrule?: Record<string, string>;
  exdates: IcsTime[];
  recurrenceId?: IcsTime;
  cancelled: boolean;
}

/** One concrete appointment, in device-local wall time. */
export interface Occurrence {
  /** Stable per occurrence: UID for single events, UID + original start for repeats. */
  key: string;
  uid: string;
  title: string;
  date: string;
  time?: string;
  durationMinutes?: number;
  recurring: boolean;
}

/* ── Parsing ──────────────────────────────────────────────────────────── */

function unfold(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r\n|\n|\r/)) {
    if ((raw.startsWith(' ') || raw.startsWith('\t')) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else if (raw !== '') {
      out.push(raw);
    }
  }
  return out;
}

function parseProp(line: string): Prop | null {
  // The value starts at the first ':' outside double quotes.
  let inQuotes = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === ':' && !inQuotes) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = (parts.shift() ?? '').toUpperCase();
  const params: Record<string, string> = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name, params, value };
}

export function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, c: string) => (c === 'n' || c === 'N' ? '\n' : c));
}

export function parseIcsTime(value: string, params: Record<string, string>): IcsTime | null {
  const v = value.trim();
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (date || params['VALUE'] === 'DATE') {
    const m = date ?? /^(\d{4})(\d{2})(\d{2})/.exec(v);
    if (!m) return null;
    return { kind: 'date', y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  }
  const dt = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!dt) return null;
  const [y, mo, d, h, mi, s] = dt.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (dt[7] === 'Z') return { kind: 'utc', ms: Date.UTC(y, mo - 1, d, h, mi, s) };
  return { kind: 'wall', tz: params['TZID'], y, m: mo, d, h, mi, s };
}

/** ISO 8601 duration (P1D, PT1H30M, P1W) in ms; null if unparseable. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(
    value.trim(),
  );
  if (!m) return null;
  const [, sign, w, d, h, mi, s] = m;
  const ms =
    ((Number(w ?? 0) * 7 + Number(d ?? 0)) * 86_400 +
      Number(h ?? 0) * 3600 +
      Number(mi ?? 0) * 60 +
      Number(s ?? 0)) *
    1000;
  return sign === '-' ? -ms : ms;
}

export function parseIcs(text: string): IcsEvent[] {
  const events: IcsEvent[] = [];
  let current: Prop[] | null = null;
  let depth = 0; // nested components inside a VEVENT (VALARM)
  for (const line of unfold(text)) {
    const prop = parseProp(line);
    if (!prop) continue;
    if (prop.name === 'BEGIN') {
      if (prop.value.toUpperCase() === 'VEVENT' && current === null) current = [];
      else if (current !== null) depth++;
      continue;
    }
    if (prop.name === 'END') {
      if (current !== null && depth > 0) {
        depth--;
      } else if (current !== null && prop.value.toUpperCase() === 'VEVENT') {
        const ev = buildEvent(current);
        if (ev) events.push(ev);
        current = null;
      }
      continue;
    }
    if (current !== null && depth === 0) current.push(prop);
  }
  return events;
}

function buildEvent(props: Prop[]): IcsEvent | null {
  const get = (name: string) => props.find((p) => p.name === name);
  const uid = get('UID')?.value.trim();
  const dtstart = get('DTSTART');
  if (!uid || !dtstart) return null;
  const start = parseIcsTime(dtstart.value, dtstart.params);
  if (!start) return null;
  let durationMs: number | undefined;
  const dtend = get('DTEND');
  const end = dtend ? parseIcsTime(dtend.value, dtend.params) : null;
  if (end) {
    const diff = instantMs(end) - instantMs(start);
    if (diff > 0) durationMs = diff;
  } else {
    const dur = get('DURATION');
    const ms = dur ? parseDuration(dur.value) : null;
    if (ms !== null && ms > 0) durationMs = ms;
  }
  const rruleProp = get('RRULE');
  const rrule = rruleProp ? parseRrule(rruleProp.value) : undefined;
  const exdates: IcsTime[] = [];
  for (const p of props.filter((q) => q.name === 'EXDATE')) {
    for (const part of p.value.split(',')) {
      const t = parseIcsTime(part, p.params);
      if (t) exdates.push(t);
    }
  }
  const rid = get('RECURRENCE-ID');
  return {
    uid,
    summary: unescapeText(get('SUMMARY')?.value ?? ''),
    start,
    durationMs,
    rrule,
    exdates,
    recurrenceId: rid ? (parseIcsTime(rid.value, rid.params) ?? undefined) : undefined,
    cancelled: (get('STATUS')?.value ?? '').toUpperCase() === 'CANCELLED',
  };
}

function parseRrule(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).toUpperCase();
  }
  return out;
}

/* ── Time zones ───────────────────────────────────────────────────────── */

const zoneFormatters = new Map<string, Intl.DateTimeFormat | null>();

function zoneFormatter(tz: string): Intl.DateTimeFormat | null {
  if (!zoneFormatters.has(tz)) {
    try {
      zoneFormatters.set(
        tz,
        new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        }),
      );
    } catch {
      zoneFormatters.set(tz, null); // unknown zone (e.g. Windows names): treat as floating
    }
  }
  return zoneFormatters.get(tz) ?? null;
}

/** Offset (zone wall time − UTC) in ms at the given instant. */
function zoneOffset(fmt: Intl.DateTimeFormat, ms: number): number {
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return asUtc - (ms - (ms % 1000));
}

/** Instant (UTC ms) of a wall time in `tz`; DST gaps resolve forward like most calendars. */
export function wallToUtc(
  tz: string | undefined,
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  s = 0,
): number {
  const fmt = tz ? zoneFormatter(tz) : null;
  if (!fmt) return new Date(y, m - 1, d, h, mi, s).getTime(); // floating = device local
  const naive = Date.UTC(y, m - 1, d, h, mi, s);
  let guess = naive - zoneOffset(fmt, naive);
  guess = naive - zoneOffset(fmt, guess);
  return guess;
}

function instantMs(t: IcsTime): number {
  if (t.kind === 'utc') return t.ms;
  if (t.kind === 'date') return new Date(t.y, t.m - 1, t.d).getTime();
  return wallToUtc(t.tz, t.y, t.m, t.d, t.h, t.mi, t.s);
}

const pad = (n: number) => String(n).padStart(2, '0');

function localDateTime(ms: number): { date: string; time: string } {
  const d = new Date(ms);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
  };
}

/* ── Recurrence ───────────────────────────────────────────────────────── */

const DAY_MS = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Day number since epoch for a calendar date (timezone-free arithmetic). */
const dayNum = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
function fromDayNum(n: number): { y: number; m: number; d: number; wd: number } {
  const dt = new Date(n * DAY_MS);
  return {
    y: dt.getUTCFullYear(),
    m: dt.getUTCMonth() + 1,
    d: dt.getUTCDate(),
    wd: dt.getUTCDay(),
  };
}
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

interface ByDay {
  wd: number;
  /** 0 = every such weekday; ±n = the n-th (from the end if negative) in the month/year. */
  nth: number;
}

function parseByDay(value: string | undefined): ByDay[] {
  if (!value) return [];
  const out: ByDay[] = [];
  for (const part of value.split(',')) {
    const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(part.trim());
    if (m) out.push({ wd: WEEKDAYS.indexOf(m[2]!), nth: m[1] ? Number(m[1]) : 0 });
  }
  return out;
}

const numList = (value: string | undefined) =>
  value
    ? value
        .split(',')
        .map(Number)
        .filter((n) => Number.isFinite(n) && n !== 0)
    : [];

/** n-th weekday of a month (negative counts from the end); null if it does not exist. */
function nthWeekdayOfMonth(y: number, m: number, wd: number, nth: number): number | null {
  const len = daysInMonth(y, m);
  if (nth > 0) {
    const first = fromDayNum(dayNum(y, m, 1)).wd;
    const day = 1 + ((wd - first + 7) % 7) + (nth - 1) * 7;
    return day <= len ? day : null;
  }
  const last = fromDayNum(dayNum(y, m, len)).wd;
  const day = len - ((last - wd + 7) % 7) + (nth + 1) * 7;
  return day >= 1 ? day : null;
}

function matchesMonthDay(y: number, m: number, d: number, list: number[]): boolean {
  const len = daysInMonth(y, m);
  return list.some((n) => (n > 0 ? n === d : len + n + 1 === d));
}

function matchesByDayInMonth(y: number, m: number, d: number, wd: number, byDay: ByDay[]): boolean {
  return byDay.some(
    (b) => b.wd === wd && (b.nth === 0 || nthWeekdayOfMonth(y, m, b.wd, b.nth) === d),
  );
}

/**
 * Calendar dates (as day numbers) on which the rule fires, from the start
 * date up to `untilDay`, honouring COUNT. `startDay` always counts as the
 * first occurrence (RFC 5545: DTSTART is the first instance).
 */
export function expandDays(
  rule: Record<string, string>,
  start: { y: number; m: number; d: number },
  untilDay: number,
  untilInstant?: (day: number) => boolean,
): number[] {
  const freq = rule['FREQ'];
  const interval = Math.max(1, Number(rule['INTERVAL'] ?? 1) || 1);
  const count = rule['COUNT'] ? Number(rule['COUNT']) : Infinity;
  const byDay = parseByDay(rule['BYDAY']);
  const byMonthDay = numList(rule['BYMONTHDAY']);
  const byMonth = numList(rule['BYMONTH']);
  const wkst = Math.max(0, WEEKDAYS.indexOf(rule['WKST'] ?? 'MO'));
  const startDay = dayNum(start.y, start.m, start.d);
  const startInfo = fromDayNum(startDay);
  const startWeekStart = startDay - ((startInfo.wd - wkst + 7) % 7);

  const matches = (day: number): boolean => {
    const { y, m, d, wd } = fromDayNum(day);
    if (byMonth.length && !byMonth.includes(m)) return false;
    switch (freq) {
      case 'DAILY':
        if ((day - startDay) % interval !== 0) return false;
        if (byDay.length && !byDay.some((b) => b.wd === wd)) return false;
        if (byMonthDay.length && !matchesMonthDay(y, m, d, byMonthDay)) return false;
        return true;
      case 'WEEKLY': {
        const weekStart = day - ((wd - wkst + 7) % 7);
        if (Math.round((weekStart - startWeekStart) / 7) % interval !== 0) return false;
        const days = byDay.length ? byDay.map((b) => b.wd) : [startInfo.wd];
        return days.includes(wd);
      }
      case 'MONTHLY': {
        const monthDiff = (y - startInfo.y) * 12 + (m - startInfo.m);
        if (monthDiff % interval !== 0) return false;
        if (byMonthDay.length) return matchesMonthDay(y, m, d, byMonthDay);
        if (byDay.length) return matchesByDayInMonth(y, m, d, wd, byDay);
        return d === startInfo.d;
      }
      case 'YEARLY': {
        if ((y - startInfo.y) % interval !== 0) return false;
        const months = byMonth.length ? byMonth : [startInfo.m];
        if (!months.includes(m)) return false;
        if (byMonthDay.length) return matchesMonthDay(y, m, d, byMonthDay);
        if (byDay.length) return matchesByDayInMonth(y, m, d, wd, byDay);
        return d === startInfo.d;
      }
      default:
        return false;
    }
  };

  const out: number[] = [];
  let produced = 0;
  // Safety bound: never walk more than ~120 years.
  const hardStop = Math.min(untilDay, startDay + 366 * 120);
  for (let day = startDay; day <= hardStop && produced < count; day++) {
    if (day !== startDay && !matches(day)) continue;
    if (untilInstant && !untilInstant(day)) break;
    out.push(day);
    produced++;
  }
  return out;
}

/* ── Occurrences in a window ──────────────────────────────────────────── */

export interface Window {
  fromMs: number;
  toMs: number;
}

function occurrenceOf(
  ev: IcsEvent,
  startTime: IcsTime,
  key: string,
  recurring: boolean,
): Occurrence {
  const minutes = ev.durationMs !== undefined ? Math.round(ev.durationMs / 60_000) : undefined;
  if (startTime.kind === 'date') {
    return {
      key,
      uid: ev.uid,
      title: ev.summary,
      date: `${startTime.y}-${pad(startTime.m)}-${pad(startTime.d)}`,
      recurring,
    };
  }
  const { date, time } = localDateTime(instantMs(startTime));
  return {
    key,
    uid: ev.uid,
    title: ev.summary,
    date,
    time,
    ...(minutes !== undefined && minutes > 0 ? { durationMinutes: minutes } : {}),
    recurring,
  };
}

function withDay(t: IcsTime, day: number): IcsTime {
  const { y, m, d } = fromDayNum(day);
  if (t.kind === 'date') return { kind: 'date', y, m, d };
  if (t.kind === 'wall') return { ...t, y, m, d };
  // UTC start: repeat at the same UTC time of day.
  const tod = ((t.ms % DAY_MS) + DAY_MS) % DAY_MS;
  return { kind: 'utc', ms: day * DAY_MS + tod };
}

/** Calendar day (y/m/d) the event's own clock shows at its start. */
function ownDate(t: IcsTime): { y: number; m: number; d: number } {
  if (t.kind === 'utc') {
    const dt = new Date(t.ms);
    return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
  }
  return { y: t.y, m: t.m, d: t.d };
}

/** Every occurrence starting inside the window, in device-local wall time. */
export function occurrencesIn(events: IcsEvent[], win: Window): Occurrence[] {
  const masters = events.filter((e) => !e.recurrenceId);
  const overrides = events.filter((e) => e.recurrenceId);
  const overrideFor = (uid: string, ms: number) =>
    overrides.find((o) => o.uid === uid && instantMs(o.recurrenceId!) === ms);
  const out: Occurrence[] = [];
  const inWindow = (ms: number) => ms >= win.fromMs && ms < win.toMs;

  for (const ev of masters) {
    if (ev.cancelled) continue;
    if (!ev.rrule) {
      if (inWindow(instantMs(ev.start))) out.push(occurrenceOf(ev, ev.start, ev.uid, false));
      continue;
    }
    const until = ev.rrule['UNTIL'] ? parseIcsTime(ev.rrule['UNTIL'], {}) : null;
    const lastDay = Math.floor(win.toMs / DAY_MS) + 2;
    const days = expandDays(ev.rrule, ownDate(ev.start), lastDay, (day) => {
      if (!until) return true;
      // A date-only UNTIL includes that whole day; otherwise compare instants.
      if (until.kind === 'date') return day <= dayNum(until.y, until.m, until.d);
      return instantMs(withDay(ev.start, day)) <= instantMs(until);
    });
    const excluded = new Set(ev.exdates.map(instantMs));
    for (const day of days) {
      const t = withDay(ev.start, day);
      const ms = instantMs(t);
      if (excluded.has(ms)) continue;
      const key = `${ev.uid}@${ms}`;
      const override = overrideFor(ev.uid, ms);
      if (override) continue; // emitted below from the override itself
      if (inWindow(ms)) out.push(occurrenceOf(ev, t, key, true));
    }
  }
  for (const o of overrides) {
    if (o.cancelled) continue;
    const ms = instantMs(o.start);
    if (inWindow(ms))
      out.push(occurrenceOf(o, o.start, `${o.uid}@${instantMs(o.recurrenceId!)}`, true));
  }
  return out.sort((a, b) => (a.date + (a.time ?? '')).localeCompare(b.date + (b.time ?? '')));
}

/* ── ⏰ rule ───────────────────────────────────────────────────────────── */

const ALARM_PREFIX = /^\s*⏰️?\s*/;

/** Appointments whose title starts with ⏰ also become a to-do. */
export function isAlarmTitle(title: string): boolean {
  return ALARM_PREFIX.test(title);
}

/** The to-do title: the appointment title without the leading ⏰. */
export function stripAlarm(title: string): string {
  return title.replace(ALARM_PREFIX, '').trim() || title.trim();
}

/** Short stable hash (FNV-1a, 52 bits as base36) for doc ids. */
export function stableHash(text: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 6).toString(36);
}

/** Only Google's secret iCal addresses are accepted (fixed host, https, .ics). */
export function isGoogleIcsUrl(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return (
      u.protocol === 'https:' &&
      u.hostname === 'calendar.google.com' &&
      u.port === '' &&
      u.username === '' &&
      u.pathname.startsWith('/calendar/ical/') &&
      u.pathname.endsWith('.ics')
    );
  } catch {
    return false;
  }
}
