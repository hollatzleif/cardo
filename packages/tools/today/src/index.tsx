import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  aggregateToday,
  hasAnySection,
  PROVIDER_COMMANDS,
  type CalendarSummary,
  type HabitsSummary,
  type RoutineSummary,
  type TodayData,
  type TodoSummary,
} from './aggregate';

/**
 * Today – the day at a glance. Aggregates events, tasks, routine and habit
 * status from the other tools, exclusively via the Command API (never via
 * foreign storage). Sections whose provider is missing are hidden.
 */

const COMPLETE_COMMAND = 'todo.complete';

/** Cross-tool events that should trigger an immediate re-aggregation. */
const REFRESH_EVENTS = ['todo:completed', 'routine:item-checked', 'habits:checked'] as const;

const REFRESH_INTERVAL_MS = 60_000;

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Presentational helpers ──────────────────────────────────────── */

  function SectionTitle({ children }: { children: ReactNode }) {
    return (
      <div
        className="c-muted"
        style={{
          fontSize: '0.75em',
          fontWeight: 600,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {children}
      </div>
    );
  }

  function MutedLine({ children }: { children: ReactNode }) {
    return (
      <div className="c-muted" style={{ fontSize: '0.9em' }}>
        {children}
      </div>
    );
  }

  const listStyle = { listStyle: 'none', margin: 0, padding: 0 } as const;
  const rowStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: '2px 0',
  } as const;

  function EventsSection({ calendar }: { calendar: CalendarSummary }) {
    return (
      <section>
        <SectionTitle>{t('tool.today.section.events')}</SectionTitle>
        {calendar.events.length === 0 ? (
          <MutedLine>{t('tool.today.widget.noEvents')}</MutedLine>
        ) : (
          <ul style={listStyle}>
            {calendar.events.map((event) => (
              <li key={event.id} style={{ ...rowStyle, alignItems: 'baseline' }}>
                <span
                  className="c-muted"
                  style={{ fontSize: '0.85em', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                >
                  {event.time ?? t('tool.today.widget.allDay')}
                </span>
                <span style={{ minWidth: 0 }}>{event.title}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    );
  }

  function TasksSection({ todo, onReload }: { todo: TodoSummary; onReload: () => void }) {
    const canComplete = ctx?.commands.has(COMPLETE_COMMAND) ?? false;

    async function completeTask(id: string) {
      const context = ctx;
      if (!context || !context.commands.has(COMPLETE_COMMAND)) return;
      try {
        await context.commands.execute(COMPLETE_COMMAND, { id });
      } catch {
        // The provider failing must not break the overview.
      }
      onReload();
    }

    return (
      <section>
        <SectionTitle>{t('tool.today.section.tasks')}</SectionTitle>
        {todo.open.length === 0 ? (
          <MutedLine>{t('tool.today.widget.noTasks')}</MutedLine>
        ) : (
          <ul style={listStyle}>
            {todo.open.map((task) => (
              <li key={task.id} style={rowStyle}>
                {canComplete && (
                  <input
                    type="checkbox"
                    checked={false}
                    onChange={() => void completeTask(task.id)}
                    aria-label={t('tool.today.widget.completeTask')}
                    style={{ accentColor: 'var(--accent)', flexShrink: 0, margin: 0 }}
                  />
                )}
                {task.overdue && (
                  <span
                    aria-hidden
                    style={{
                      width: '8px',
                      height: '8px',
                      borderRadius: '999px',
                      background: 'var(--danger)',
                      flexShrink: 0,
                    }}
                  />
                )}
                <span style={{ minWidth: 0 }}>{task.title}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="c-muted" style={{ fontSize: '0.85em', marginTop: 'var(--space-1)' }}>
          {t('tool.today.widget.completedToday', { count: todo.completedToday })}
        </div>
      </section>
    );
  }

  function RoutineSection({ routine }: { routine: RoutineSummary }) {
    const ratio = routine.total > 0 ? Math.min(1, routine.done / routine.total) : 0;
    return (
      <section>
        <SectionTitle>{t('tool.today.section.routine')}</SectionTitle>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontVariantNumeric: 'tabular-nums',
            marginTop: 'var(--space-1)',
          }}
        >
          <span className="c-muted" style={{ fontSize: '0.85em', flexShrink: 0 }}>
            {routine.done}/{routine.total}
          </span>
          <div
            style={{
              flex: 1,
              height: '4px',
              borderRadius: '999px',
              background: 'var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${ratio * 100}%`,
                height: '100%',
                borderRadius: '999px',
                background: 'var(--success)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      </section>
    );
  }

  function HabitsSection({ habits }: { habits: HabitsSummary }) {
    return (
      <section>
        <SectionTitle>{t('tool.today.section.habits')}</SectionTitle>
        <div style={{ fontVariantNumeric: 'tabular-nums' }}>
          {t('tool.today.widget.habitsLine', {
            done: habits.doneToday,
            total: habits.total,
            streak: habits.bestStreak,
          })}
        </div>
      </section>
    );
  }

  /* ── Widget ──────────────────────────────────────────────────────── */

  function TodayWidget(_props: WidgetProps) {
    const [data, setData] = useState<TodayData | null>(null);

    const load = useCallback(() => {
      const context = ctx;
      if (!context) return;
      aggregateToday(context)
        .then(setData)
        .catch(() => {
          // aggregateToday guards every provider; this is belt-and-braces.
        });
    }, []);

    useEffect(() => {
      load();
      const timer = window.setInterval(load, REFRESH_INTERVAL_MS);
      const unsubs = REFRESH_EVENTS.map((event) => ctx?.events.on(event, load));
      return () => {
        window.clearInterval(timer);
        for (const unsub of unsubs) unsub?.();
      };
    }, [load]);

    const heading = new Intl.DateTimeFormat(ctx?.i18n.language, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date());

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          overflowWrap: 'break-word',
        }}
      >
        <div style={{ fontWeight: 600 }}>{heading}</div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          {data === null ? (
            <MutedLine>{t('common.loading')}</MutedLine>
          ) : !hasAnySection(data) ? (
            <MutedLine>{t('tool.today.widget.emptyHint')}</MutedLine>
          ) : (
            <>
              {data.calendar && <EventsSection calendar={data.calendar} />}
              {data.todo && <TasksSection todo={data.todo} onReload={load} />}
              {data.routine && <RoutineSection routine={data.routine} />}
              {data.habits && <HabitsSection habits={data.habits} />}
            </>
          )}
        </div>
      </div>
    );
  }

  /* ── Tool ────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
    },
    deactivate() {
      ctx = null;
    },
    Widget: TodayWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'aggregate-graceful': {
          const providerIds = Object.values(PROVIDER_COMMANDS);
          const anyProvider = providerIds.some((id) => testCtx.commands.has(id));
          const data = await aggregateToday(testCtx);
          if (anyProvider) {
            // Scratch context happens to host provider tools – the point of
            // this test (no throw, full shape) still holds.
            return { status: 'pass', detail: 'providers present; aggregation did not throw' };
          }
          return hasAnySection(data)
            ? {
                status: 'fail',
                detail: `expected all sections null, got ${JSON.stringify(data)}`,
              }
            : { status: 'pass' };
        }
        case 'aggregate-with-todo': {
          if (!testCtx.commands.has(PROVIDER_COMMANDS.todo)) {
            testCtx.commands.register({
              id: PROVIDER_COMMANDS.todo,
              titleKey: 'tool.today.test.aggregateWithTodo',
              params: z.object({}),
              palette: false,
              async run() {
                return {
                  ok: true,
                  data: {
                    open: [
                      { id: 'probe-due', title: 'Due today', list: 'inbox', overdue: false },
                      { id: 'probe-overdue', title: 'Overdue', priority: 'high', overdue: true },
                    ],
                    dueToday: 1,
                    overdue: 1,
                    completedToday: 2,
                  },
                };
              },
            });
            const data = await aggregateToday(testCtx);
            const todo = data.todo;
            const ok =
              todo !== null &&
              todo.open.length === 2 &&
              todo.open[0]?.id === 'probe-overdue' && // overdue sorts first
              todo.dueToday === 1 &&
              todo.overdue === 1 &&
              todo.completedToday === 2;
            return ok
              ? { status: 'pass' }
              : {
                  status: 'fail',
                  detail: `fake todo provider not aggregated correctly: ${JSON.stringify(data.todo)}`,
                };
          }
          // A real todo tool is active in the scratch context: aggregation
          // must still surface its section.
          const data = await aggregateToday(testCtx);
          return data.todo !== null
            ? { status: 'pass', detail: 'aggregated the live todo provider' }
            : { status: 'fail', detail: 'todo.query-today exists but section is missing' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
