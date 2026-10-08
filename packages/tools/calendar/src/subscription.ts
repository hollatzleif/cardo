/**
 * Google Calendar subscription (one-way, Google → Cardo) and the ⏰ rule.
 *
 * - Appointments from the secret iCal address are mirrored as read-only
 *   event docs `event:gcal-<hash>` (source: 'google'). Docs are only
 *   rewritten when something changed, so an unchanged calendar costs no sync
 *   traffic.
 * - Appointments whose title starts with ⏰ become to-dos (via the todo
 *   tool's commands, with a stable id per appointment, so several desktops
 *   importing at once never create duplicates). Moved appointments move the
 *   to-do's due date; deleted appointments delete the to-do while it is still
 *   open. A to-do the user deleted by hand is never recreated.
 *
 * Fetching needs the desktop host (ctx.calendarFeed); the phone receives the
 * mirrored docs through sync.
 */
import type { CommandResult, ToolStorage } from '@cardo/plugin-api';
import {
  isAlarmTitle,
  isGoogleIcsUrl,
  occurrencesIn,
  parseIcs,
  stableHash,
  stripAlarm,
  type Occurrence,
} from './ics';

export const FEED_DOC = 'feed';
export const ALARMS_DOC = 'gcal-alarms';
export const GOOGLE_EVENT_PREFIX = 'event:gcal-';

/** Mirror window: two months back, a good year ahead. */
const BACK_MS = 60 * 86_400_000;
const AHEAD_MS = 400 * 86_400_000;
/** Repeating ⏰ appointments only become to-dos when they are this close. */
const RECURRING_ALARM_AHEAD_DAYS = 14;

export type FeedDoc = {
  url: string;
  /** ⏰ appointments become to-dos (default on). */
  alarmTodos?: boolean;
  lastSyncMs?: number;
  lastError?: string;
  lastCount?: number;
};

export type GoogleEventDoc = {
  id: string;
  title: string;
  date: string;
  time?: string;
  durationMinutes?: number;
  createdAt: string;
  source: 'google';
  sourceKey: string;
};

type AlarmEntry = {
  todoId: string;
  date: string;
  title: string;
};

type AlarmsDoc = {
  entries: Record<string, AlarmEntry>;
};

export interface FeedDeps {
  storage: ToolStorage;
  fetchIcs?: (url: string) => Promise<string>;
  execute(id: string, params: unknown): Promise<CommandResult>;
  hasCommand(id: string): boolean;
  now(): number;
}

export type FeedOutcome =
  | { kind: 'not-configured' }
  | { kind: 'no-host' }
  | { kind: 'ok'; events: number; todosCreated: number; todosUpdated: number; todosRemoved: number }
  | { kind: 'error'; message: string };

const pad = (n: number) => String(n).padStart(2, '0');
function localDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export const googleEventId = (key: string) => `${GOOGLE_EVENT_PREFIX}${stableHash(key)}`;
export const alarmTodoId = (key: string) => `task:gcal-${stableHash(key)}`;

export function isGoogleEvent(doc: unknown): doc is GoogleEventDoc {
  return !!doc && typeof doc === 'object' && (doc as { source?: unknown }).source === 'google';
}

function sameEvent(a: GoogleEventDoc, b: GoogleEventDoc): boolean {
  return (
    a.title === b.title &&
    a.date === b.date &&
    a.time === b.time &&
    a.durationMinutes === b.durationMinutes &&
    a.sourceKey === b.sourceKey
  );
}

/** Which occurrences become to-dos today. */
export function alarmCandidates(occurrences: Occurrence[], nowMs: number): Occurrence[] {
  const today = localDate(nowMs);
  const recurringLimit = localDate(nowMs + RECURRING_ALARM_AHEAD_DAYS * 86_400_000);
  return occurrences.filter(
    (o) => isAlarmTitle(o.title) && o.date >= today && (!o.recurring || o.date <= recurringLimit),
  );
}

export async function syncGoogleFeed(deps: FeedDeps): Promise<FeedOutcome> {
  const { storage } = deps;
  const feed = await storage.get<FeedDoc>(FEED_DOC);
  if (!feed?.url || !isGoogleIcsUrl(feed.url)) return { kind: 'not-configured' };
  if (!deps.fetchIcs) return { kind: 'no-host' };

  const now = deps.now();
  let occurrences: Occurrence[];
  try {
    const text = await deps.fetchIcs(feed.url);
    occurrences = occurrencesIn(parseIcs(text), { fromMs: now - BACK_MS, toMs: now + AHEAD_MS });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await storage.set<FeedDoc>(FEED_DOC, { ...feed, lastError: message });
    return { kind: 'error', message };
  }

  /* ── Mirror the appointments ── */
  const existing = (await storage.query<Record<string, unknown>>()).filter(isGoogleEvent);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const keep = new Set<string>();
  const createdAt = new Date(now).toISOString();
  for (const o of occurrences) {
    const id = googleEventId(o.key);
    keep.add(id);
    const doc: GoogleEventDoc = {
      id,
      title: o.title,
      date: o.date,
      ...(o.time ? { time: o.time } : {}),
      ...(o.durationMinutes ? { durationMinutes: o.durationMinutes } : {}),
      createdAt: byId.get(id)?.createdAt ?? createdAt,
      source: 'google',
      sourceKey: o.key,
    };
    const old = byId.get(id);
    if (!old || !sameEvent(old, doc)) await storage.set<GoogleEventDoc>(id, doc);
  }
  for (const old of existing) {
    if (!keep.has(old.id)) await storage.delete(old.id);
  }

  /* ── ⏰ appointments → to-dos ── */
  let todosCreated = 0;
  let todosUpdated = 0;
  let todosRemoved = 0;
  if (feed.alarmTodos !== false && deps.hasCommand('todo.create')) {
    const alarms = (await storage.get<AlarmsDoc>(ALARMS_DOC)) ?? { entries: {} };
    const entries = { ...alarms.entries };
    const candidates = alarmCandidates(occurrences, now);
    const current = new Set(candidates.map((o) => o.key));
    const stillInFeed = new Set(occurrences.filter((o) => isAlarmTitle(o.title)).map((o) => o.key));

    for (const o of candidates) {
      const title = stripAlarm(o.title);
      const entry = entries[o.key];
      if (!entry) {
        const todoId = alarmTodoId(o.key);
        const result = await deps.execute('todo.create', { id: todoId, title, due: o.date });
        if (result.ok) {
          entries[o.key] = { todoId, date: o.date, title };
          todosCreated++;
        }
      } else if (entry.date !== o.date || entry.title !== title) {
        const result = await deps.execute('todo.update', { id: entry.todoId, title, due: o.date });
        if (result.ok) {
          entries[o.key] = { ...entry, date: o.date, title };
          todosUpdated++;
        }
      }
    }
    const windowStart = localDate(now - BACK_MS);
    for (const [key, entry] of Object.entries(entries)) {
      if (current.has(key) || stillInFeed.has(key)) continue;
      // Gone from Google (or ⏰ removed from the title): remove the open
      // to-do. Entries that simply aged out of the window are forgotten
      // without touching the to-do.
      if (entry.date >= windowStart) {
        const result = await deps.execute('todo.delete', { id: entry.todoId, onlyIfOpen: true });
        if (result.ok) todosRemoved++;
      }
      delete entries[key];
    }
    if (JSON.stringify(entries) !== JSON.stringify(alarms.entries)) {
      await storage.set<AlarmsDoc>(ALARMS_DOC, { entries });
    }
  }

  const next: FeedDoc = { ...feed, lastSyncMs: now, lastCount: occurrences.length };
  delete next.lastError;
  await storage.set<FeedDoc>(FEED_DOC, next);
  return { kind: 'ok', events: occurrences.length, todosCreated, todosUpdated, todosRemoved };
}

/** Unsubscribe: forget the address and the mirrored appointments (to-dos stay). */
export async function removeGoogleFeed(storage: ToolStorage): Promise<void> {
  const docs = (await storage.query<Record<string, unknown>>()).filter(isGoogleEvent);
  for (const doc of docs) await storage.delete(doc.id);
  await storage.delete(FEED_DOC);
  await storage.delete(ALARMS_DOC);
}
