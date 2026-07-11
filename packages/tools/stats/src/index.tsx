import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  WINDOWS,
  applyEvent,
  dayDocId,
  emptyDay,
  formatHours,
  localDateKey,
  rangeKeys,
  sumDays,
} from './stats';
import type { DayDoc, StatsEvent, WindowKind } from './stats';

/* Typed cross-tool events (declaration merging, see plugin-api CardoEvents).
 * 'workclock:session-ended' is re-declared with the exact shape workclock
 * declares – identical declarations merge cleanly. */
declare module '@cardo/plugin-api' {
  interface CardoEvents {
    'todo:completed': { id: string; title: string; completedAt: string };
    'workclock:session-ended': { date: string; seconds: number };
    'pomodoro:finished': { phase: string; at: string };
  }
}

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** One labeled summary number. Accent comes in as a chart token reference. */
function Metric({ value, label, color }: { value: string; label: string; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div
        style={{ fontSize: '1.7em', fontWeight: 600, fontVariantNumeric: 'tabular-nums', color }}
      >
        {value}
      </div>
      <div className="c-muted" style={{ fontSize: '12px' }}>
        {label}
      </div>
    </div>
  );
}

/**
 * Statistics v1 – aggregates what OTHER tools report via events (tools never
 * read foreign storage) into its own namespace: one doc per day.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  let unsubscribers: Array<() => void> = [];

  /** Module-level translator – widget and commands share the host i18n. */
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Aggregation ──────────────────────────────────────────────────────── */

  /**
   * Folds one incoming event into the day aggregate it belongs to.
   * `dateKey` lets emitters that know their day (workclock) pin the doc;
   * everything else lands on the local today.
   */
  async function record(c: ToolContext, event: StatsEvent, dateKey?: string): Promise<void> {
    const key = dateKey && DATE_KEY_RE.test(dateKey) ? dateKey : localDateKey(new Date());
    const id = dayDocId(key);
    const existing = await c.storage.get<DayDoc>(id);
    await c.storage.set(id, applyEvent(existing ?? emptyDay(key), event));
  }

  /** The day docs covered by a window, oldest first, gaps filled with zeros. */
  async function readRange(c: ToolContext, win: WindowKind, now: Date): Promise<DayDoc[]> {
    const keys = rangeKeys(win, now);
    const docs = await Promise.all(keys.map((k) => c.storage.get<DayDoc>(dayDocId(k))));
    return keys.map((k, i) => docs[i] ?? emptyDay(k));
  }

  /* ── Widget ───────────────────────────────────────────────────────────── */

  function StatsWidget(_props: WidgetProps) {
    const [win, setWin] = useState<WindowKind>('day');
    const [days, setDays] = useState<DayDoc[] | null>(null);

    useEffect(() => {
      let mounted = true;
      const load = () => {
        const c = ctx;
        if (!c) return;
        void readRange(c, win, new Date()).then((docs) => {
          if (mounted) setDays(docs);
        });
      };
      load();
      const unsub = ctx?.storage.subscribe(load);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [win]);

    const totals = useMemo(() => (days ? sumDays(days) : null), [days]);
    const maxTasks = useMemo(
      () => Math.max(1, ...(days ?? []).map((d) => d.tasksCompleted)),
      [days],
    );
    const isEmpty =
      totals !== null &&
      totals.tasksCompleted === 0 &&
      totals.workSeconds === 0 &&
      totals.pomodoros === 0;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-3)',
          padding: 'var(--space-3)',
        }}
      >
        <div
          role="group"
          aria-label={t('tool.stats.window.label')}
          style={{ display: 'flex', gap: 'var(--space-1)' }}
        >
          {WINDOWS.map((w) => (
            <button
              key={w}
              className={w === win ? 'c-btn c-btn--primary' : 'c-btn c-btn--ghost'}
              aria-pressed={w === win}
              onClick={() => setWin(w)}
              style={{ fontSize: '12px', padding: 'var(--space-1) var(--space-3)' }}
            >
              {t(`tool.stats.window.${w}`)}
            </button>
          ))}
        </div>

        {totals === null ? (
          <div className="c-muted">…</div>
        ) : isEmpty ? (
          <div
            className="c-muted"
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: 'var(--space-4)',
            }}
          >
            {t('tool.stats.empty')}
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 'var(--space-5)', flexWrap: 'wrap' }}>
              <Metric
                value={String(totals.tasksCompleted)}
                label={t('tool.stats.metric.tasks')}
                color="var(--chart-1)"
              />
              <Metric
                value={formatHours(totals.workSeconds)}
                label={t('tool.stats.metric.work')}
                color="var(--chart-2)"
              />
              <Metric
                value={String(totals.pomodoros)}
                label={t('tool.stats.metric.pomodoros')}
                color="var(--chart-3)"
              />
            </div>
            {win !== 'day' && days !== null && (
              /* Inline bar chart: pure CSS flex columns, no chart library. */
              <div
                role="group"
                aria-label={t('tool.stats.chart.title')}
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  alignItems: 'flex-end',
                  gap: '2px',
                  borderBottom: '1px solid var(--border-subtle)',
                }}
              >
                {days.map((d) => {
                  const barLabel = t('tool.stats.chart.bar', {
                    date: d.date,
                    count: d.tasksCompleted,
                  });
                  return (
                    <div
                      key={d.date}
                      role="img"
                      aria-label={barLabel}
                      title={barLabel}
                      style={{
                        flex: 1,
                        height: '100%',
                        display: 'flex',
                        alignItems: 'flex-end',
                      }}
                    >
                      <div
                        style={{
                          width: '100%',
                          height: `${(d.tasksCompleted / maxTasks) * 100}%`,
                          minHeight: d.tasksCompleted > 0 ? '2px' : '0',
                          background: 'var(--chart-1)',
                          borderRadius: '2px 2px 0 0',
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  /* ── Tool ─────────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context) {
      ctx = context;

      /* Listen to what other tools report. v1 limitation (by design): events
       * are only counted while Cardo runs with stats active – acceptable,
       * since all tools run in the same app instance and emit live. */
      unsubscribers.push(
        context.events.on('todo:completed', () => {
          void record(context, { type: 'todo:completed' });
        }),
        context.events.on('workclock:session-ended', (p) => {
          void record(context, { type: 'workclock:session-ended', seconds: p.seconds }, p.date);
        }),
        context.events.on('pomodoro:finished', (p) => {
          void record(context, { type: 'pomodoro:finished', phase: p.phase });
        }),
      );

      context.commands.register({
        id: 'stats.summary',
        titleKey: 'tool.stats.command.summary',
        params: z.object({ window: z.enum(['day', 'week', 'month']).default('day') }),
        selfTestParams: { window: 'day' },
        async run({ window: win }) {
          const days = await readRange(context, win ?? 'day', new Date());
          return { ok: true, data: sumDays(days) };
        },
      });
    },

    deactivate() {
      for (const unsub of unsubscribers) unsub();
      unsubscribers = [];
      ctx = null;
    },

    Widget: StatsWidget,

    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'aggregate-roundtrip': {
          const key = '2026-01-15';
          const probe: DayDoc = {
            id: dayDocId(key),
            date: key,
            tasksCompleted: 3,
            workSeconds: 4500,
            pomodoros: 2,
          };
          await testCtx.storage.set(probe.id, probe);
          const roundtrip = await testCtx.storage.get<DayDoc>(probe.id);
          await testCtx.storage.delete(probe.id);
          return roundtrip !== null &&
            roundtrip.date === key &&
            roundtrip.tasksCompleted === 3 &&
            roundtrip.workSeconds === 4500 &&
            roundtrip.pomodoros === 2
            ? { status: 'pass' }
            : { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
        }
        case 'event-count': {
          let doc = emptyDay('2026-01-15');
          doc = applyEvent(doc, { type: 'todo:completed' });
          doc = applyEvent(doc, { type: 'workclock:session-ended', seconds: 90 });
          doc = applyEvent(doc, { type: 'pomodoro:finished', phase: 'work' });
          doc = applyEvent(doc, { type: 'pomodoro:finished', phase: 'short-break' });
          return doc.tasksCompleted === 1 && doc.workSeconds === 90 && doc.pomodoros === 1
            ? { status: 'pass' }
            : {
                status: 'fail',
                detail: `expected {1, 90, 1}, got {${doc.tasksCompleted}, ${doc.workSeconds}, ${doc.pomodoros}}`,
              };
        }
        case 'range-keys': {
          const now = new Date(2026, 0, 15, 12, 0, 0);
          const day = rangeKeys('day', now);
          const week = rangeKeys('week', now);
          const month = rangeKeys('month', now);
          const ok =
            day.length === 1 &&
            day[0] === '2026-01-15' &&
            week.length === 7 &&
            week[0] === '2026-01-09' &&
            week[6] === '2026-01-15' &&
            month.length === 30 &&
            month[0] === '2025-12-17' &&
            month[29] === '2026-01-15' &&
            new Set(month).size === 30;
          return ok
            ? { status: 'pass' }
            : {
                status: 'fail',
                detail: `unexpected ranges: day=${JSON.stringify(day)}, week=${JSON.stringify(week)}, month(first/last)=${month[0]}/${month[29]}`,
              };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
