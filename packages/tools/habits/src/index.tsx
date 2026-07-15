import { Fragment, useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, CommandResult, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  currentStreak,
  currentWeekDays,
  dateFromKey,
  heatLevel,
  heatmapDays,
  localDateKey,
  longestStreak,
  type DayDoc,
  type HabitDoc,
} from './habits';

/**
 * Habits – a habit tracker with per-habit streaks and a 26-week heatmap.
 * Habits live in `habit:<id>` docs; the completions of one calendar day live
 * in a single `day:<YYYY-MM-DD>` doc (LOCAL date key), so history accumulates
 * naturally and "today" rolls over at local midnight without any migration.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Storage helpers ─────────────────────────────────────────────── */

  async function listHabits(): Promise<HabitDoc[]> {
    if (!ctx) return [];
    // query() returns doc bodies without ids; habit and day docs share the
    // namespace – tell them apart by shape.
    const docs = await ctx.storage.query<Record<string, unknown>>();
    return docs
      .filter(
        (d): d is HabitDoc =>
          typeof d.id === 'string' &&
          typeof d.title === 'string' &&
          typeof d.order === 'number' &&
          typeof d.createdAt === 'string',
      )
      .sort((a, b) => a.order - b.order);
  }

  async function listDays(): Promise<DayDoc[]> {
    if (!ctx) return [];
    const docs = await ctx.storage.query<Record<string, unknown>>();
    return docs.filter(
      (d): d is DayDoc =>
        typeof d.id === 'string' && typeof d.date === 'string' && Array.isArray(d.done),
    );
  }

  async function getDay(date: string): Promise<DayDoc> {
    const doc = await ctx?.storage.get<DayDoc>(`day:${date}`);
    return doc ?? { id: date, date, done: [] };
  }

  async function addHabit(title: string): Promise<string | null> {
    const trimmed = title.trim();
    if (!ctx || !trimmed) return null;
    const habits = await listHabits();
    const id = crypto.randomUUID();
    const habit: HabitDoc = {
      id,
      title: trimmed,
      order: habits.reduce((max, h) => Math.max(max, h.order), -1) + 1,
      createdAt: new Date().toISOString(),
    };
    await ctx.storage.set(`habit:${id}`, habit);
    return id;
  }

  async function deleteHabit(habitId: string): Promise<void> {
    await ctx?.storage.delete(`habit:${habitId}`);
  }

  /** Check a habit for today; emits habits events. Graceful on unknown ids. */
  async function checkHabit(habitId: string): Promise<CommandResult> {
    if (!ctx) return { ok: false, messageKey: 'tool.habits.msg.notFound' };
    const habit = await ctx.storage.get<HabitDoc>(`habit:${habitId}`);
    // Unknown/deleted habit is a normal outcome, not a command failure
    // (diagnose executes this with a probe id).
    if (!habit) return { ok: true, messageKey: 'tool.habits.msg.notFound' };

    const date = localDateKey(new Date());
    const day = await getDay(date);
    if (!day.done.includes(habitId)) {
      const next: DayDoc = { ...day, done: [...day.done, habitId] };
      await ctx.storage.set(`day:${date}`, next);
      ctx.events.emit('habits:checked', { habitId, date });
      const habits = await listHabits();
      if (habits.length > 0 && habits.every((h) => next.done.includes(h.id))) {
        ctx.events.emit('habits:day-completed', { date });
      }
    }
    return { ok: true, data: { habitId, date } };
  }

  async function uncheckHabit(habitId: string): Promise<void> {
    if (!ctx) return;
    const date = localDateKey(new Date());
    const day = await getDay(date);
    if (day.done.includes(habitId)) {
      await ctx.storage.set<DayDoc>(`day:${date}`, {
        ...day,
        done: day.done.filter((id) => id !== habitId),
      });
    }
  }

  /** Dates on which the given habit was checked. */
  function doneDatesOf(habitId: string, days: DayDoc[]): string[] {
    return days.filter((d) => d.done.includes(habitId)).map((d) => d.date);
  }

  /* ── Widget ──────────────────────────────────────────────────────── */

  function HabitsWidget(props: WidgetProps) {
    const [habits, setHabits] = useState<HabitDoc[] | null>(null);
    const [days, setDays] = useState<DayDoc[]>([]);
    const [dateKey, setDateKey] = useState(() => localDateKey(new Date()));
    const [draft, setDraft] = useState('');

    // Roll over to the new day at local midnight without a restart.
    useEffect(() => {
      const timer = window.setInterval(() => {
        const key = localDateKey(new Date());
        setDateKey((prev) => (prev === key ? prev : key));
      }, 30_000);
      return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
      let mounted = true;
      const load = () =>
        Promise.all([listHabits(), listDays()]).then(([nextHabits, nextDays]) => {
          if (mounted) {
            setHabits(nextHabits);
            setDays(nextDays);
          }
        });
      void load();
      const unsub = ctx?.storage.subscribe(() => void load());
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [dateKey]);

    const total = habits?.length ?? 0;
    const habitIds = new Set((habits ?? []).map((h) => h.id));
    const doneToday = new Set(days.find((d) => d.date === dateKey)?.done ?? []);
    const doneTodayCount = (habits ?? []).filter((h) => doneToday.has(h.id)).length;
    const allDone = total > 0 && doneTodayCount === total;

    // Per-day completion count for the heatmap (only habits that still exist).
    const doneCountByDate = new Map<string, number>();
    for (const day of days) {
      doneCountByDate.set(day.date, day.done.filter((id) => habitIds.has(id)).length);
    }

    async function submitDraft() {
      const title = draft.trim();
      if (!title) return;
      setDraft('');
      await addHabit(title);
    }

    /* ── Variant "week-grid": habits × Mo–So matrix of the current week ── */
    if (props.variant === 'week-grid') {
      const weekKeys = currentWeekDays(dateKey);
      const doneByDate = new Map(days.map((d) => [d.date, new Set(d.done)]));
      const lang = ctx?.i18n.language ?? 'en';
      const weekdayFmt = new Intl.DateTimeFormat(lang, { weekday: 'narrow' });

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            gap: 'var(--space-2)',
            padding: 'var(--space-3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
            <span style={{ fontWeight: 600 }}>{t('tool.habits.widget.heading')}</span>
            <span
              className="c-muted"
              style={{ fontSize: '0.85em', fontVariantNumeric: 'tabular-nums' }}
            >
              {doneTodayCount}/{total}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {habits !== null && total === 0 ? (
              <div className="c-muted" style={{ fontSize: '0.9em' }}>
                {t('tool.habits.widget.empty')}
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) repeat(7, minmax(22px, auto))',
                  alignItems: 'center',
                  columnGap: 'var(--space-1)',
                  rowGap: '2px',
                }}
              >
                <span aria-hidden />
                {weekKeys.map((key) => (
                  <span
                    key={key}
                    className="c-muted"
                    style={{
                      fontSize: '0.75em',
                      textAlign: 'center',
                      fontWeight: key === dateKey ? 700 : 400,
                    }}
                    title={key}
                  >
                    {weekdayFmt.format(dateFromKey(key))}
                  </span>
                ))}
                {(habits ?? []).map((habit) => (
                  <Fragment key={habit.id}>
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontSize: '0.9em',
                      }}
                      title={habit.title}
                    >
                      {habit.title}
                    </span>
                    {weekKeys.map((key) => {
                      const checked = doneByDate.get(key)?.has(habit.id) ?? false;
                      if (key === dateKey) {
                        return (
                          <span key={`${habit.id}:${key}`} style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              checked={checked}
                              aria-label={t('tool.habits.widget.check', { title: habit.title })}
                              onChange={() =>
                                void (checked ? uncheckHabit(habit.id) : checkHabit(habit.id))
                              }
                              style={{ accentColor: 'var(--success)', margin: 0 }}
                            />
                          </span>
                        );
                      }
                      return (
                        <span
                          key={`${habit.id}:${key}`}
                          aria-hidden
                          className={checked ? undefined : 'c-muted'}
                          style={{
                            textAlign: 'center',
                            fontSize: '0.85em',
                            color: checked ? 'var(--success)' : undefined,
                            opacity: checked ? 1 : 0.6,
                          }}
                          title={`${habit.title} · ${key}`}
                        >
                          {checked ? '✓' : '·'}
                        </span>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }

    /* ── Variant "streaks": habits ranked by current streak, number big ── */
    if (props.variant === 'streaks') {
      const ranked = [...(habits ?? [])]
        .map((habit) => ({ habit, streak: currentStreak(doneDatesOf(habit.id, days), dateKey) }))
        .sort((a, b) => b.streak - a.streak || a.habit.order - b.habit.order);

      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            height: '100%',
            gap: 'var(--space-2)',
            padding: 'var(--space-3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
            <span style={{ fontWeight: 600 }}>{t('tool.habits.widget.heading')}</span>
            <span
              className="c-muted"
              style={{ fontSize: '0.85em', fontVariantNumeric: 'tabular-nums' }}
            >
              {doneTodayCount}/{total}
            </span>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {habits !== null && total === 0 && (
              <div className="c-muted" style={{ fontSize: '0.9em' }}>
                {t('tool.habits.widget.empty')}
              </div>
            )}
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {ranked.map(({ habit, streak }) => (
                <li
                  key={habit.id}
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-1) 0',
                  }}
                >
                  <span
                    className={streak === 0 ? 'c-muted' : undefined}
                    title={t('tool.habits.widget.streak', { days: streak })}
                    style={{
                      fontSize: '1.6em',
                      fontWeight: 700,
                      lineHeight: 1,
                      fontVariantNumeric: 'tabular-nums',
                      minWidth: '2ch',
                      textAlign: 'right',
                      flexShrink: 0,
                      color: streak > 0 ? 'var(--accent)' : undefined,
                    }}
                  >
                    {streak}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {streak >= 3 ? '🔥 ' : ''}
                    {habit.title}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      );
    }

    /* ── Variant "list" (default): the classic checklist + heatmap ── */
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
          <span style={{ fontWeight: 600 }}>{t('tool.habits.widget.heading')}</span>
          <span
            className="c-muted"
            style={{ fontSize: '0.85em', fontVariantNumeric: 'tabular-nums' }}
          >
            {doneTodayCount}/{total}
          </span>
        </div>

        {allDone && (
          <div style={{ color: 'var(--success)', fontSize: '0.9em' }}>
            {t('tool.habits.widget.allDone')}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {habits !== null && total === 0 && (
            <div className="c-muted" style={{ fontSize: '0.9em' }}>
              {t('tool.habits.widget.empty')}
            </div>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(habits ?? []).map((habit) => {
              const isChecked = doneToday.has(habit.id);
              const streak = currentStreak(doneDatesOf(habit.id, days), dateKey);
              return (
                <li
                  key={habit.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-1) 0',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      flex: 1,
                      minWidth: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      aria-label={t('tool.habits.widget.check', { title: habit.title })}
                      onChange={() =>
                        void (isChecked ? uncheckHabit(habit.id) : checkHabit(habit.id))
                      }
                      style={{ accentColor: 'var(--success)', flexShrink: 0 }}
                    />
                    <span
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {habit.title}
                    </span>
                  </label>
                  <span
                    className={streak === 0 ? 'c-muted' : undefined}
                    title={t('tool.habits.widget.streak', { days: streak })}
                    style={{
                      fontSize: '0.85em',
                      fontVariantNumeric: 'tabular-nums',
                      flexShrink: 0,
                    }}
                  >
                    {streak >= 3 ? `🔥 ${streak}` : streak}
                  </span>
                  <button
                    className="c-btn c-btn--ghost"
                    aria-label={t('tool.habits.widget.remove')}
                    title={t('tool.habits.widget.remove')}
                    onClick={() => void deleteHabit(habit.id)}
                    style={{ padding: '0 var(--space-2)', fontSize: '0.85em' }}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <div style={{ flexShrink: 0 }}>
          <div className="c-muted" style={{ fontSize: '0.75em', marginBottom: 'var(--space-1)' }}>
            {t('tool.habits.widget.heatmapLabel')}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateRows: 'repeat(7, 10px)',
                gridAutoFlow: 'column',
                gridAutoColumns: '10px',
                gap: '2px',
                width: 'max-content',
              }}
            >
              {heatmapDays(dateKey).map((key) => {
                const n = doneCountByDate.get(key) ?? 0;
                const level = heatLevel(total > 0 ? n / total : 0);
                return (
                  <div
                    key={key}
                    title={`${key}: ${n}/${total}`}
                    style={{
                      width: '10px',
                      height: '10px',
                      borderRadius: '2px',
                      background: level === 0 ? 'var(--border-subtle)' : 'var(--chart-3)',
                      opacity: level === 0 ? 0.45 : level * 0.25,
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitDraft();
          }}
          style={{ display: 'flex', gap: 'var(--space-2)' }}
        >
          <input
            className="c-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('tool.habits.widget.addPlaceholder')}
          />
          <button type="submit" className="c-btn c-btn--primary" disabled={!draft.trim()}>
            {t('tool.habits.widget.add')}
          </button>
        </form>
      </div>
    );
  }

  /* ── Tool ────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;

      context.commands.register({
        id: 'habits.add',
        titleKey: 'tool.habits.command.add',
        params: z.object({ title: z.string().min(1) }),
        selfTestParams: { title: 'probe' },
        async run({ title }) {
          const id = await addHabit(title);
          return id
            ? { ok: true, messageKey: 'tool.habits.msg.added', data: { id } }
            : { ok: false, messageKey: 'tool.habits.msg.failed' };
        },
      });

      context.commands.register({
        id: 'habits.check',
        titleKey: 'tool.habits.command.check',
        params: z.object({ habitId: z.string().min(1) }),
        // Nonexistent id on purpose: must resolve gracefully, never throw.
        selfTestParams: { habitId: 'selftest-nonexistent-habit' },
        async run({ habitId }) {
          return checkHabit(habitId);
        },
      });

      context.commands.register({
        id: 'habits.query-status',
        titleKey: 'tool.habits.command.queryStatus',
        params: z.object({}),
        palette: false,
        selfTestParams: {},
        async run() {
          const [habits, days] = await Promise.all([listHabits(), listDays()]);
          const today = localDateKey(new Date());
          const doneToday = new Set(days.find((d) => d.date === today)?.done ?? []);
          const bestStreak = habits.reduce(
            (best, h) => Math.max(best, longestStreak(doneDatesOf(h.id, days))),
            0,
          );
          return {
            ok: true,
            data: {
              total: habits.length,
              doneToday: habits.filter((h) => doneToday.has(h.id)).length,
              bestStreak,
            },
          };
        },
      });

      // Global search: find habits by title, picking one checks it for today.
      context.search.register(async (query) => {
        const q = query.trim().toLowerCase();
        if (!q) return [];
        const [habits, days] = await Promise.all([listHabits(), listDays()]);
        const today = localDateKey(new Date());
        return habits
          .filter((h) => h.title.toLowerCase().includes(q))
          .slice(0, 5)
          .map((h) => ({
            title: h.title,
            subtitle: t('tool.habits.search.streak', {
              days: currentStreak(doneDatesOf(h.id, days), today),
            }),
            icon: '🔥',
            action: async () => {
              await checkHabit(h.id);
            },
          }));
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: HabitsWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'habit-roundtrip': {
          const probe: HabitDoc = {
            id: 'selftest-habit',
            title: 'probe',
            order: 0,
            createdAt: new Date().toISOString(),
          };
          await testCtx.storage.set('habit:selftest-habit', probe);
          const roundtrip = await testCtx.storage.get<HabitDoc>('habit:selftest-habit');
          await testCtx.storage.delete('habit:selftest-habit');
          const gone = await testCtx.storage.get<HabitDoc>('habit:selftest-habit');
          if (roundtrip?.id !== 'selftest-habit' || roundtrip.title !== 'probe') {
            return { status: 'fail', detail: `bad roundtrip: ${JSON.stringify(roundtrip)}` };
          }
          return gone === null
            ? { status: 'pass' }
            : { status: 'fail', detail: 'habit still present after delete' };
        }
        case 'streak-calc': {
          const today = '2026-03-10';
          // Today checked, two days before too, then a gap → streak 3.
          const withToday = currentStreak(['2026-03-05', '2026-03-08', '2026-03-09', today], today);
          // Today not (yet) checked → streak counted up to yesterday.
          const upToYesterday = currentStreak(['2026-03-08', '2026-03-09'], today);
          // Gap right before yesterday → streak 0.
          const gapped = currentStreak(['2026-03-06', '2026-03-07'], today);
          const longest = longestStreak(['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-09', today]);
          if (withToday !== 3) return { status: 'fail', detail: `withToday: ${withToday} ≠ 3` };
          if (upToYesterday !== 2)
            return { status: 'fail', detail: `upToYesterday: ${upToYesterday} ≠ 2` };
          if (gapped !== 0) return { status: 'fail', detail: `gapped: ${gapped} ≠ 0` };
          if (longest !== 3) return { status: 'fail', detail: `longest: ${longest} ≠ 3` };
          return { status: 'pass' };
        }
        case 'heatmap-range': {
          const today = '2026-07-01'; // a Wednesday
          const days = heatmapDays(today);
          if (days.length !== 182) {
            return { status: 'fail', detail: `expected 182 cells, got ${days.length}` };
          }
          if (days[days.length - 1] !== today || days[0] !== '2026-01-01') {
            return { status: 'fail', detail: `bad range: ${days[0]} … ${days[days.length - 1]}` };
          }
          // 182 = 26 full weeks → the grid starts on the weekday after today's.
          const startWeekday = new Date(2026, 0, 1, 12).getDay();
          const expected = (new Date(2026, 6, 1, 12).getDay() + 1) % 7;
          return startWeekday === expected
            ? { status: 'pass' }
            : { status: 'fail', detail: `start weekday ${startWeekday} ≠ ${expected}` };
        }
        case 'variants': {
          // Uses hooks, so it cannot be invoked outside React here – the
          // host's ping check covers mounting. This verifies the export
          // contract plus the declared variant list.
          const variants = manifest.widgets[0]?.variants ?? [];
          if (variants.length < 2) {
            return { status: 'fail', detail: `expected >= 2 variants, got ${variants.length}` };
          }
          return typeof HabitsWidget === 'function' && HabitsWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget is not a render function' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
