import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  addMonths,
  dateKey,
  monthGrid,
  reminderFireTime,
  weekdayLabels,
} from './calendar';

const DEFAULT_REMINDER_MINUTES = 10;

type EventDoc = {
  /** Full doc id "event:<uuid>" – stored inside the doc, query() returns bodies without ids. */
  id: string;
  title: string;
  /** Local calendar date "YYYY-MM-DD". */
  date: string;
  /** Optional wall-clock time "HH:MM" (local). */
  time?: string;
  durationMinutes?: number;
  note?: string;
  /** Minutes before start to remind (only meaningful with `time`). */
  reminderMinutes?: number;
  /** Scheduler handle of the pending reminder, if armed. */
  scheduleId?: string;
  createdAt: string;
};

function makeId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Sort a day's events: all-day first, then by time. */
function byTime(a: EventDoc, b: EventDoc): number {
  return (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title);
}

/** Calendar – own appointments with local reminders. Fully offline. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function listEvents(): Promise<EventDoc[]> {
    return (await ctx?.storage.query<EventDoc>({ orderBy: 'date', direction: 'asc' })) ?? [];
  }

  /**
   * Arm the reminder for an event with date + time whose fire time is still
   * ahead, persist the schedule handle. Persists the doc in every case.
   */
  async function armReminder(c: ToolContext, event: EventDoc): Promise<EventDoc> {
    const next: EventDoc = { ...event, scheduleId: undefined };
    if (event.time) {
      const minutes = event.reminderMinutes ?? DEFAULT_REMINDER_MINUTES;
      const when = reminderFireTime(event.date, event.time, minutes);
      next.reminderMinutes = minutes;
      if (when.getTime() > Date.now()) {
        try {
          next.scheduleId = await c.scheduler.scheduleAt(when, 'calendar.remind', {
            id: event.id,
          });
        } catch {
          next.scheduleId = undefined; // scheduler unavailable – re-armed on next activate
        }
      }
    }
    await c.storage.set<EventDoc>(next.id, next);
    return next;
  }

  async function cancelReminder(c: ToolContext, event: EventDoc): Promise<void> {
    if (!event.scheduleId) return;
    try {
      await c.scheduler.cancel(event.scheduleId);
    } catch {
      /* schedule already gone (in-memory scheduler after restart) */
    }
  }

  async function createEvent(title: string, date: string, time?: string): Promise<EventDoc | null> {
    const c = ctx;
    if (!c) return null;
    const event: EventDoc = {
      id: `event:${makeId()}`,
      title,
      date,
      time: time || undefined,
      reminderMinutes: time ? DEFAULT_REMINDER_MINUTES : undefined,
      createdAt: new Date().toISOString(),
    };
    return armReminder(c, event);
  }

  async function removeEvent(event: EventDoc): Promise<void> {
    const c = ctx;
    if (!c) return;
    await cancelReminder(c, event);
    await c.storage.delete(event.id);
  }

  function CalendarWidget(_props: WidgetProps) {
    const locale = ctx?.i18n.language ?? 'en';
    const todayKey = dateKey(new Date());
    const [events, setEvents] = useState<EventDoc[] | null>(null);
    const [view, setView] = useState(() => {
      const now = new Date();
      return { year: now.getFullYear(), month: now.getMonth() };
    });
    const [selected, setSelected] = useState(todayKey);
    const [title, setTitle] = useState('');
    const [time, setTime] = useState('');

    useEffect(() => {
      let mounted = true;
      const load = () => {
        void listEvents().then((list) => {
          if (mounted) setEvents(list);
        });
      };
      load();
      const unsub = ctx?.storage.subscribe(load);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);

    const grid = useMemo(() => monthGrid(view.year, view.month, 1), [view]);
    const headers = useMemo(() => weekdayLabels(locale, 1), [locale]);
    const monthLabel = useMemo(
      () =>
        new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric' }).format(
          new Date(view.year, view.month, 1),
        ),
      [locale, view],
    );
    const selectedLabel = useMemo(() => {
      const [y, m, d] = selected.split('-').map(Number);
      return new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
      }).format(new Date(y ?? 0, (m ?? 1) - 1, d ?? 1));
    }, [locale, selected]);

    const byDate = useMemo(() => {
      const map = new Map<string, EventDoc[]>();
      for (const event of events ?? []) {
        const list = map.get(event.date) ?? [];
        list.push(event);
        map.set(event.date, list);
      }
      for (const list of map.values()) list.sort(byTime);
      return map;
    }, [events]);

    const dayEvents = byDate.get(selected) ?? [];

    const shiftMonth = (delta: number) => setView((v) => addMonths(v.year, v.month, delta));
    const goToday = () => {
      const now = new Date();
      setView({ year: now.getFullYear(), month: now.getMonth() });
      setSelected(dateKey(now));
    };
    const pickDay = (day: Date) => {
      setSelected(dateKey(day));
      if (day.getMonth() !== view.month || day.getFullYear() !== view.year) {
        setView({ year: day.getFullYear(), month: day.getMonth() });
      }
    };

    const add = async () => {
      const trimmed = title.trim();
      if (!trimmed) return;
      await createEvent(trimmed, selected, time || undefined);
      setTitle('');
      setTime('');
    };

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-2)',
        }}
      >
        {/* Month navigation */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span style={{ flex: 1, fontWeight: 600 }}>{monthLabel}</span>
          <button
            className="c-btn c-btn--ghost"
            style={{ padding: 'var(--space-1) var(--space-2)' }}
            onClick={() => shiftMonth(-1)}
            aria-label={t('tool.calendar.prevMonth')}
            title={t('tool.calendar.prevMonth')}
          >
            ‹
          </button>
          <button
            className="c-btn c-btn--ghost"
            style={{ padding: 'var(--space-1) var(--space-2)' }}
            onClick={goToday}
          >
            {t('tool.calendar.today')}
          </button>
          <button
            className="c-btn c-btn--ghost"
            style={{ padding: 'var(--space-1) var(--space-2)' }}
            onClick={() => shiftMonth(1)}
            aria-label={t('tool.calendar.nextMonth')}
            title={t('tool.calendar.nextMonth')}
          >
            ›
          </button>
        </div>

        {/* Weekday header + month grid */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 'var(--space-1)',
          }}
        >
          {headers.map((label) => (
            <div
              key={label}
              className="c-muted"
              style={{ textAlign: 'center', fontSize: '0.75em' }}
            >
              {label}
            </div>
          ))}
          {grid.flat().map((day) => {
            const key = dateKey(day);
            const inMonth = day.getMonth() === view.month;
            const isToday = key === todayKey;
            const isSelected = key === selected;
            const hasEvents = byDate.has(key);
            return (
              <button
                key={key}
                onClick={() => pickDay(day)}
                aria-label={key}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 1,
                  padding: 'var(--space-1)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  cursor: 'pointer',
                  fontVariantNumeric: 'tabular-nums',
                  background: isSelected ? 'var(--bg-widget-hover)' : 'transparent',
                  color: inMonth ? 'var(--text-primary)' : 'var(--text-muted)',
                  boxShadow: isToday ? 'inset 0 0 0 1.5px var(--accent)' : 'none',
                  fontWeight: isToday ? 700 : 400,
                }}
              >
                <span>{day.getDate()}</span>
                <span
                  style={{
                    width: 4,
                    height: 4,
                    borderRadius: '50%',
                    background: hasEvents ? 'var(--accent)' : 'transparent',
                  }}
                />
              </button>
            );
          })}
        </div>

        {/* Day panel */}
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 'var(--space-2)',
          }}
        >
          <div className="c-muted" style={{ fontSize: '0.85em' }}>
            {selectedLabel}
          </div>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            {events === null ? (
              <div className="c-muted">…</div>
            ) : dayEvents.length === 0 ? (
              <div className="c-muted">{t('tool.calendar.empty')}</div>
            ) : (
              dayEvents.map((event) => (
                <div
                  key={event.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                >
                  <span
                    className={event.time ? undefined : 'c-muted'}
                    style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                  >
                    {event.time ?? t('tool.calendar.allDay')}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {event.title}
                  </span>
                  <button
                    className="c-btn c-btn--ghost"
                    style={{ color: 'var(--danger)', padding: 'var(--space-1) var(--space-2)' }}
                    onClick={() => void removeEvent(event)}
                    aria-label={t('tool.calendar.delete')}
                    title={t('tool.calendar.delete')}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <input
              className="c-input"
              style={{ flex: 1, minWidth: 0 }}
              placeholder={t('tool.calendar.titlePlaceholder')}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void add();
              }}
            />
            <input
              type="time"
              className="c-input"
              style={{ width: 'auto', flexShrink: 0 }}
              value={time}
              onChange={(e) => setTime(e.target.value)}
              aria-label={t('tool.calendar.time')}
              title={t('tool.calendar.time')}
            />
            <button className="c-btn c-btn--primary" onClick={() => void add()}>
              {t('tool.calendar.add')}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;

      context.commands.register({
        id: 'calendar.create',
        titleKey: 'tool.calendar.command.create',
        params: z.object({
          title: z.string().min(1),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          time: z
            .string()
            .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
            .optional(),
        }),
        selfTestParams: { title: 'probe', date: '2030-01-01', time: '12:00' },
        async run({ title, date, time }) {
          const event = await createEvent(title, date, time);
          return event
            ? { ok: true, messageKey: 'tool.calendar.msg.created', data: event.id }
            : { ok: false, messageKey: 'tool.calendar.msg.failed' };
        },
      });

      context.commands.register({
        id: 'calendar.remind',
        titleKey: 'tool.calendar.command.remind',
        palette: false,
        params: z.object({ id: z.string().min(1) }),
        selfTestParams: { id: 'nonexistent' },
        async run({ id }) {
          try {
            const c = ctx;
            if (!c) return { ok: false, messageKey: 'tool.calendar.msg.notFound' };
            const event = await c.storage.get<EventDoc>(id);
            // A vanished event is a normal outcome (deleted before the
            // reminder fired), not a command failure – ok:true keeps the
            // diagnose command check honest.
            if (!event) return { ok: true, messageKey: 'tool.calendar.msg.notFound' };
            await c.notifications.notify({
              titleKey: 'tool.calendar.notification.title',
              bodyKey: 'tool.calendar.notification.body',
              vars: { title: event.title, time: event.time ?? '' },
            });
            return { ok: true };
          } catch {
            return { ok: false, messageKey: 'tool.calendar.msg.failed' };
          }
        },
      });

      // The scheduler is an in-memory MVP: re-arm every future reminder on activate.
      void (async () => {
        const events = await context.storage.query<EventDoc>();
        for (const event of events) {
          if (!event.time) continue;
          await cancelReminder(context, event);
          await armReminder(context, event);
        }
      })().catch(() => {
        /* storage not ready – widget load will surface the state */
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: CalendarWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'event-roundtrip': {
          const probe: EventDoc = {
            id: 'event:selftest',
            title: 'probe',
            date: '2030-01-01',
            time: '12:00',
            reminderMinutes: 10,
            createdAt: new Date().toISOString(),
          };
          await testCtx.storage.set<EventDoc>(probe.id, probe);
          const roundtrip = await testCtx.storage.get<EventDoc>(probe.id);
          await testCtx.storage.delete(probe.id);
          const afterDelete = await testCtx.storage.get<EventDoc>(probe.id);
          if (
            roundtrip?.title !== 'probe' ||
            roundtrip.date !== '2030-01-01' ||
            roundtrip.time !== '12:00'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
          }
          if (afterDelete !== null) {
            return { status: 'fail', detail: 'doc still present after delete' };
          }
          return { status: 'pass' };
        }
        case 'month-grid': {
          // 2026-02-01 is a Sunday → Monday-based grid starts on 2026-01-26.
          const grid = monthGrid(2026, 1, 1);
          if (grid.length !== 6 || grid.some((week) => week.length !== 7)) {
            return { status: 'fail', detail: 'grid is not 6×7' };
          }
          const first = grid[0]?.[0];
          if (!first || dateKey(first) !== '2026-01-26' || first.getDay() !== 1) {
            return {
              status: 'fail',
              detail: `expected first cell 2026-01-26 (Monday), got ${first ? dateKey(first) : 'empty grid'}`,
            };
          }
          return { status: 'pass' };
        }
        case 'reminder-time': {
          const fire = reminderFireTime('2030-01-01', '12:00', 10);
          if (dateKey(fire) !== '2030-01-01' || fire.getHours() !== 11 || fire.getMinutes() !== 50) {
            return {
              status: 'fail',
              detail: `expected 2030-01-01 11:50 local, got ${fire.toString()}`,
            };
          }
          return { status: 'pass' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
