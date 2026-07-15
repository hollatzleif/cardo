import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  DEFAULT_GOAL_HOURS,
  MAX_GOAL_HOURS,
  MIN_GOAL_HOURS,
  averageMinutes,
  buildSleepContext,
  consistencyStdev,
  durationMinutes,
  formatClock,
  formatHm,
  goalStreak,
  isValidDate,
  isValidTime,
  lastNights,
  localDayKey,
  logNightParamsSchema,
  makeNight,
  weekSeries,
  type NightDoc,
  type TimeFormat,
} from './logic';

/**
 * Sleep log – bed/wake times per night, keyed by the WAKE-UP day
 * (`night:<yyyy-mm-dd>`, LOCAL date). Fully local.
 */

type SleepSettings = {
  goalHours: number;
  timeFormat: TimeFormat;
};

const DEFAULT_SETTINGS: SleepSettings = { goalHours: DEFAULT_GOAL_HOURS, timeFormat: '24' };

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryNightsIn(storage: ToolStorage): Promise<NightDoc[]> {
  return storage.query<NightDoc>({ where: [{ field: 'type', op: '=', value: 'night' }] });
}

/** Upsert the night of one wake-up day. */
async function logNightIn(
  storage: ToolStorage,
  date: string,
  bed: string,
  wake: string,
): Promise<NightDoc> {
  const doc = makeNight(date, bed, wake);
  await storage.set(doc.id, doc);
  return doc;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<SleepSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [goalHours, timeFormat] = await Promise.all([
      c.settings.get<number>('goalHours'),
      c.settings.get<TimeFormat>('timeFormat'),
    ]);
    const goal =
      typeof goalHours === 'number' && goalHours >= MIN_GOAL_HOURS && goalHours <= MAX_GOAL_HOURS
        ? goalHours
        : DEFAULT_SETTINGS.goalHours;
    return { goalHours: goal, timeFormat: timeFormat === '12' ? '12' : '24' };
  }

  /** Shared state loader: all variants need nights + settings, live-updated. */
  function useSleepData() {
    const [nights, setNights] = useState<NightDoc[]>([]);
    const [settings, setSettings] = useState<SleepSettings>({ ...DEFAULT_SETTINGS });

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, loaded] = await Promise.all([queryNightsIn(c.storage), loadSettings()]);
      setNights(list);
      setSettings(loaded);
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsubStorage = ctx?.storage.subscribe(safeReload);
      const unsubSettings = ctx?.settings.subscribe(safeReload);
      return () => {
        mounted = false;
        unsubStorage?.();
        unsubSettings?.();
      };
    }, [reload]);

    return { nights, settings };
  }

  /* ── Settings panel (gear) ─────────────────────────────────────────── */

  function SettingsPanel({ settings }: { settings: SleepSettings }) {
    const row = (labelKey: string, children: ReactNode) => (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span className="c-muted" style={{ fontSize: '0.85em' }}>
          {t(labelKey)}
        </span>
        {children}
      </label>
    );
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 'var(--space-2)',
          flexShrink: 0,
        }}
      >
        {row(
          'tool.sleep-log.settings.goalHours',
          <input
            className="c-input"
            type="number"
            min={MIN_GOAL_HOURS}
            max={MAX_GOAL_HOURS}
            step={0.5}
            value={settings.goalHours}
            style={{ width: 72, textAlign: 'right' }}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v) && v >= MIN_GOAL_HOURS && v <= MAX_GOAL_HOURS) {
                void ctx?.settings.set('goalHours', v);
              }
            }}
          />,
        )}
        {row(
          'tool.sleep-log.settings.timeFormat',
          <select
            className="c-input"
            value={settings.timeFormat}
            style={{ width: 'auto' }}
            onChange={(e) => void ctx?.settings.set('timeFormat', e.target.value)}
          >
            <option value="24">{t('tool.sleep-log.settings.format24')}</option>
            <option value="12">{t('tool.sleep-log.settings.format12')}</option>
          </select>,
        )}
      </div>
    );
  }

  /* ── Log variant: form + recent nights ─────────────────────────────── */

  function LogView({ nights, settings }: { nights: NightDoc[]; settings: SleepSettings }) {
    const [bed, setBed] = useState('23:00');
    const [wake, setWake] = useState('07:00');
    const [date, setDate] = useState(() => localDayKey());

    async function logNight() {
      const c = ctx;
      if (!c || !isValidTime(bed) || !isValidTime(wake) || !isValidDate(date)) return;
      await logNightIn(c.storage, date, bed, wake);
    }

    const recent = lastNights(nights, 14);
    const goalMinutes = settings.goalHours * 60;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
          <input
            className="c-input"
            type="date"
            value={date}
            aria-label={t('tool.sleep-log.log.dateLabel')}
            title={t('tool.sleep-log.log.dateLabel')}
            style={{ width: 'auto' }}
            onChange={(e) => setDate(e.target.value)}
          />
          <input
            className="c-input"
            type="time"
            value={bed}
            aria-label={t('tool.sleep-log.log.bedLabel')}
            title={t('tool.sleep-log.log.bedLabel')}
            style={{ width: 'auto' }}
            onChange={(e) => setBed(e.target.value)}
          />
          <input
            className="c-input"
            type="time"
            value={wake}
            aria-label={t('tool.sleep-log.log.wakeLabel')}
            title={t('tool.sleep-log.log.wakeLabel')}
            style={{ width: 'auto' }}
            onChange={(e) => setWake(e.target.value)}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.sleep-log.log.add')}
            title={t('tool.sleep-log.log.add')}
            style={{ flexShrink: 0 }}
            onClick={() => void logNight()}
          >
            +
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {recent.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.sleep-log.widget.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {recent.map((n) => {
                const minutes = durationMinutes(n.bed, n.wake);
                return (
                  <div
                    key={n.id}
                    style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                  >
                    <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                      {n.date}
                    </span>
                    <span
                      className="c-muted"
                      style={{ flex: 1, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                    >
                      {formatClock(n.bed, settings.timeFormat)} –{' '}
                      {formatClock(n.wake, settings.timeFormat)}
                    </span>
                    <span
                      style={{
                        fontSize: 12,
                        fontVariantNumeric: 'tabular-nums',
                        color: minutes < goalMinutes ? 'var(--warning)' : 'var(--success)',
                        flexShrink: 0,
                      }}
                    >
                      {formatHm(minutes)}
                    </span>
                    <button
                      className="c-btn c-btn--ghost"
                      aria-label={t('tool.sleep-log.log.delete', { date: n.date })}
                      title={t('tool.sleep-log.log.delete', { date: n.date })}
                      style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
                      onClick={() => void ctx?.storage.delete(n.id)}
                    >
                      ×
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Weekly-bar variant ────────────────────────────────────────────── */

  function WeeklyBarView({ nights, settings }: { nights: NightDoc[]; settings: SleepSettings }) {
    const lang = ctx?.i18n.language ?? 'en';
    const series = weekSeries(nights, localDayKey());
    const goalMinutes = settings.goalHours * 60;
    const max = Math.max(goalMinutes, ...series.map((s) => s.minutes ?? 0)) * 1.1;
    const barW = 100 / series.length;
    const goalY = 40 - (goalMinutes / max) * 40;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-1)' }}>
        <div className="c-muted" style={{ fontSize: 12, flexShrink: 0 }}>
          {t('tool.sleep-log.weekly.title', { goal: settings.goalHours })}
        </div>
        <svg
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          role="img"
          aria-label={t('tool.sleep-log.weekly.title', { goal: settings.goalHours })}
          style={{ flex: 1, minHeight: 0, width: '100%' }}
        >
          {series.map((s, i) => {
            if (s.minutes === null) return null;
            const h = (s.minutes / max) * 40;
            return (
              <rect
                key={s.date}
                x={i * barW + barW * 0.15}
                y={40 - h}
                width={barW * 0.7}
                height={h}
                rx={0.8}
                fill={s.minutes < goalMinutes ? 'var(--warning)' : 'var(--info)'}
              >
                <title>{`${s.date}: ${formatHm(s.minutes)}`}</title>
              </rect>
            );
          })}
          <line
            x1={0}
            y1={goalY}
            x2={100}
            y2={goalY}
            stroke="var(--text-muted)"
            strokeWidth={0.5}
            strokeDasharray="2 1.5"
          />
        </svg>
        <div
          className="c-muted"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            fontSize: 10,
            textAlign: 'center',
            flexShrink: 0,
          }}
        >
          {series.map((s) => (
            <span key={s.date}>
              {new Date(`${s.date}T00:00:00Z`).toLocaleDateString(lang, {
                weekday: 'narrow',
                timeZone: 'UTC',
              })}
            </span>
          ))}
        </div>
      </div>
    );
  }

  /* ── Summary variant ───────────────────────────────────────────────── */

  function SummaryView({ nights, settings }: { nights: NightDoc[]; settings: SleepSettings }) {
    const today = localDayKey();
    const week = weekSeries(nights, today)
      .map((s) => s.minutes)
      .filter((m): m is number => m !== null);
    const goalMinutes = settings.goalHours * 60;
    const streak = goalStreak(nights, goalMinutes, today);

    if (nights.length === 0) {
      return (
        <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
          {t('tool.sleep-log.widget.empty')}
        </div>
      );
    }

    const stat = (value: string, labelKey: string, color?: string) => (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
        <span
          style={{
            fontSize: '1.4em',
            fontVariantNumeric: 'tabular-nums',
            ...(color ? { color } : {}),
          }}
        >
          {value}
        </span>
        <span className="c-muted" style={{ fontSize: 11, textAlign: 'center' }}>
          {t(labelKey)}
        </span>
      </div>
    );

    return (
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-evenly',
          height: '100%',
          gap: 'var(--space-2)',
        }}
      >
        {stat(
          week.length > 0 ? formatHm(averageMinutes(week)) : '–',
          'tool.sleep-log.summary.average',
        )}
        {stat(
          week.length > 0 ? `± ${formatHm(consistencyStdev(week))}` : '–',
          'tool.sleep-log.summary.consistency',
        )}
        {stat(
          String(streak),
          'tool.sleep-log.summary.goalStreak',
          streak > 0 ? 'var(--success)' : undefined,
        )}
      </div>
    );
  }

  function SleepLogWidget(props: WidgetProps) {
    const { nights, settings } = useSleepData();
    const [showSettings, setShowSettings] = useState(false);

    let body;
    switch (props.variant) {
      case 'weekly-bar':
        body = <WeeklyBarView nights={nights} settings={settings} />;
        break;
      case 'summary':
        body = <SummaryView nights={nights} settings={settings} />;
        break;
      case 'log':
      default:
        body = <LogView nights={nights} settings={settings} />;
        break;
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          padding: 'var(--space-3)',
          gap: 'var(--space-2)',
        }}
      >
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          {body}
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.sleep-log.widget.settingsToggle')}
            title={t('tool.sleep-log.widget.settingsToggle')}
            aria-expanded={showSettings}
            style={{ position: 'absolute', bottom: 0, right: 0, padding: '0 var(--space-1)' }}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        </div>
        {showSettings ? <SettingsPanel settings={settings} /> : null}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'sleep-log.log',
        titleKey: 'tool.sleep-log.command.log',
        descriptionKey: 'tool.sleep-log.command.logDesc',
        icon: '🌙',
        params: logNightParamsSchema,
        selfTestParams: { bed: '23:30', wake: '07:15', date: '2099-01-01' },
        async run(params): Promise<CommandResult> {
          if (!isValidTime(params.bed) || !isValidTime(params.wake)) {
            return { ok: false, messageKey: 'tool.sleep-log.msg.invalidTime' };
          }
          const date = params.date ?? localDayKey();
          if (!isValidDate(date)) {
            return { ok: false, messageKey: 'tool.sleep-log.msg.invalidDate' };
          }
          const doc = await logNightIn(context.storage, date, params.bed, params.wake);
          return {
            ok: true,
            data: { date: doc.date, minutes: durationMinutes(doc.bed, doc.wake) },
            messageKey: 'tool.sleep-log.msg.logged',
          };
        },
      });

      context.commands.register({
        id: 'sleep-log.context',
        titleKey: 'tool.sleep-log.command.context',
        descriptionKey: 'tool.sleep-log.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [nights, settings] = await Promise.all([
            queryNightsIn(context.storage),
            loadSettings(),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildSleepContext(
                nights,
                context.i18n.language,
                localDayKey(),
                settings.goalHours,
              ),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: SleepLogWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'midnight-math': {
          // Both midnight cases through a real storage roundtrip.
          const cases: Array<[string, string, string, number]> = [
            ['2026-02-03', '23:30', '07:15', 465], // crosses midnight
            ['2026-02-04', '01:00', '08:00', 420], // bed after midnight
            ['2026-02-05', '22:00', '22:00', 0], // defined edge: bed == wake
          ];
          try {
            for (const [date, bed, wake, expected] of cases) {
              await logNightIn(testCtx.storage, date, bed, wake);
              const stored = await testCtx.storage.get<NightDoc>(`night:${date}`);
              const minutes = stored ? durationMinutes(stored.bed, stored.wake) : -1;
              if (minutes !== expected) {
                return {
                  status: 'fail',
                  detail: `${bed}→${wake}: expected ${expected} min, got ${minutes}`,
                };
              }
            }
            return { status: 'pass', detail: '465 / 420 / 0 minute cases verified via storage' };
          } finally {
            for (const [date] of cases) await testCtx.storage.delete(`night:${date}`);
          }
        }
        case 'crud': {
          const date = '2026-02-10';
          try {
            await logNightIn(testCtx.storage, date, '23:00', '07:00');
            const first = await testCtx.storage.get<NightDoc>(`night:${date}`);
            // Upsert: logging the same wake-up day again replaces the night.
            await logNightIn(testCtx.storage, date, '00:30', '08:00');
            const second = await testCtx.storage.get<NightDoc>(`night:${date}`);
            if (first?.bed !== '23:00' || second?.bed !== '00:30' || second.wake !== '08:00') {
              return {
                status: 'fail',
                detail: `bad roundtrip: ${JSON.stringify(first)} → ${JSON.stringify(second)}`,
              };
            }
            await testCtx.storage.delete(`night:${date}`);
            const gone = await testCtx.storage.get<NightDoc>(`night:${date}`);
            if (gone !== null) return { status: 'fail', detail: 'night still present after delete' };
            return { status: 'pass', detail: 'log → upsert → delete roundtrip ok' };
          } finally {
            await testCtx.storage.delete(`night:${date}`);
          }
        }
        case 'render':
          return typeof SleepLogWidget === 'function' && SleepLogWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
