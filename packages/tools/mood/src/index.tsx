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
  MOODS,
  averageMood,
  buildMoodContext,
  localDayKey,
  logMoodParamsSchema,
  makeDayDoc,
  monthMatrix,
  moodEmoji,
  moodSeries,
  moodToken,
  streak,
  type MoodDayDoc,
  type ScaleStyle,
  type WeekStart,
} from './logic';

/**
 * Mood journal – one mood (1-5) plus an optional one-line note per LOCAL
 * day, stored in `day:<yyyy-mm-dd>` docs. Fully local.
 */

type MoodSettings = {
  weekStart: WeekStart;
  scaleStyle: ScaleStyle;
};

const DEFAULT_SETTINGS: MoodSettings = { weekStart: 'mon', scaleStyle: 'emoji' };

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryEntriesIn(storage: ToolStorage): Promise<MoodDayDoc[]> {
  const entries = await storage.query<MoodDayDoc>({
    where: [{ field: 'type', op: '=', value: 'day' }],
  });
  return [...entries].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Upsert the entry of one day. An omitted note keeps the existing one
 * (mood-only re-log must not wipe the journal line); an empty note clears it.
 */
async function logMoodIn(
  storage: ToolStorage,
  date: string,
  mood: number,
  note?: string,
): Promise<MoodDayDoc> {
  const existing = await storage.get<MoodDayDoc>(`day:${date}`);
  const effectiveNote = note === undefined ? existing?.note : note;
  const doc = makeDayDoc(date, mood, effectiveNote);
  await storage.set(doc.id, doc);
  return doc;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<MoodSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [weekStart, scaleStyle] = await Promise.all([
      c.settings.get<WeekStart>('weekStart'),
      c.settings.get<ScaleStyle>('scaleStyle'),
    ]);
    return {
      weekStart: weekStart === 'sun' ? 'sun' : DEFAULT_SETTINGS.weekStart,
      scaleStyle: scaleStyle === 'numbers' ? 'numbers' : DEFAULT_SETTINGS.scaleStyle,
    };
  }

  /** Shared state loader: all variants need entries + settings, live-updated. */
  function useMoodData() {
    const [entries, setEntries] = useState<MoodDayDoc[]>([]);
    const [settings, setSettings] = useState<MoodSettings>({ ...DEFAULT_SETTINGS });

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, loaded] = await Promise.all([queryEntriesIn(c.storage), loadSettings()]);
      setEntries(list);
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

    return { entries, settings };
  }

  function moodLabel(mood: number, style: ScaleStyle): string {
    return style === 'numbers' ? String(mood) : moodEmoji(mood);
  }

  /* ── Settings panel (gear) ─────────────────────────────────────────── */

  function SettingsPanel({ settings }: { settings: MoodSettings }) {
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
          'tool.mood.settings.weekStart',
          <select
            className="c-input"
            value={settings.weekStart}
            style={{ width: 'auto' }}
            onChange={(e) => void ctx?.settings.set('weekStart', e.target.value)}
          >
            <option value="mon">{t('tool.mood.settings.weekStartMon')}</option>
            <option value="sun">{t('tool.mood.settings.weekStartSun')}</option>
          </select>,
        )}
        {row(
          'tool.mood.settings.scaleStyle',
          <select
            className="c-input"
            value={settings.scaleStyle}
            style={{ width: 'auto' }}
            onChange={(e) => void ctx?.settings.set('scaleStyle', e.target.value)}
          >
            <option value="emoji">{t('tool.mood.settings.scaleEmoji')}</option>
            <option value="numbers">{t('tool.mood.settings.scaleNumbers')}</option>
          </select>,
        )}
      </div>
    );
  }

  /* ── Today variant ─────────────────────────────────────────────────── */

  function TodayView({ entries, settings }: { entries: MoodDayDoc[]; settings: MoodSettings }) {
    const today = localDayKey();
    const todayEntry = entries.find((e) => e.date === today);
    const [note, setNote] = useState('');
    const [noteDirty, setNoteDirty] = useState(false);

    // Show the stored note until the user starts typing their own.
    const shownNote = noteDirty ? note : (todayEntry?.note ?? '');

    async function pickMood(mood: number) {
      const c = ctx;
      if (!c) return;
      await logMoodIn(c.storage, today, mood, noteDirty ? note : undefined);
      setNoteDirty(false);
    }

    async function saveNote() {
      const c = ctx;
      if (!c || !noteDirty) return;
      await logMoodIn(c.storage, today, todayEntry?.mood ?? 3, note);
      setNoteDirty(false);
    }

    const s = streak(entries, today);

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-3)',
        }}
      >
        <div className="c-muted" style={{ fontSize: '0.85em' }}>
          {t('tool.mood.today.question')}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', justifyContent: 'center' }}>
          {MOODS.map((mood) => {
            const selected = todayEntry?.mood === mood;
            return (
              <button
                key={mood}
                className="c-btn c-btn--ghost"
                aria-label={t('tool.mood.today.moodLabel', { mood })}
                aria-pressed={selected}
                title={t('tool.mood.today.moodLabel', { mood })}
                style={{
                  fontSize: settings.scaleStyle === 'emoji' ? '1.5em' : '1.1em',
                  padding: 'var(--space-1) var(--space-2)',
                  fontVariantNumeric: 'tabular-nums',
                  border: selected ? '2px solid var(--accent)' : '2px solid transparent',
                  borderRadius: 'var(--radius-md, 8px)',
                }}
                onClick={() => void pickMood(mood)}
              >
                {moodLabel(mood, settings.scaleStyle)}
              </button>
            );
          })}
        </div>
        <input
          className="c-input"
          value={shownNote}
          placeholder={t('tool.mood.today.notePlaceholder')}
          aria-label={t('tool.mood.today.notePlaceholder')}
          maxLength={200}
          style={{ width: '100%', maxWidth: 280 }}
          onChange={(e) => {
            setNote(e.target.value);
            setNoteDirty(true);
          }}
          onBlur={() => void saveNote()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void saveNote();
          }}
        />
        {s > 0 ? (
          <div className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
            {t('tool.mood.today.streak', { count: s })}
          </div>
        ) : null}
      </div>
    );
  }

  /* ── Calendar variant ──────────────────────────────────────────────── */

  function CalendarView({ entries, settings }: { entries: MoodDayDoc[]; settings: MoodSettings }) {
    const lang = ctx?.i18n.language ?? 'en';
    const today = localDayKey();
    const now = new Date();
    const weeks = monthMatrix(now.getFullYear(), now.getMonth() + 1, settings.weekStart);
    const byDate = new Map(entries.map((e) => [e.date, e]));

    // Localized weekday headers: 2026-01-05 is a Monday, 2026-01-04 a Sunday.
    const headerBase = settings.weekStart === 'mon' ? 5 : 4;
    const headers = Array.from({ length: 7 }, (_, i) =>
      new Date(Date.UTC(2026, 0, headerBase + i)).toLocaleDateString(lang, {
        weekday: 'narrow',
        timeZone: 'UTC',
      }),
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-1)' }}>
        <span style={{ fontWeight: 600, flexShrink: 0 }}>
          {now.toLocaleDateString(lang, { month: 'long', year: 'numeric' })}
        </span>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(7, 1fr)',
            gap: 2,
            flex: 1,
            minHeight: 0,
            gridAutoRows: '1fr',
          }}
        >
          {headers.map((h, i) => (
            <div
              key={`h${i}`}
              className="c-muted"
              style={{ fontSize: 10, textAlign: 'center', alignSelf: 'end' }}
            >
              {h}
            </div>
          ))}
          {weeks.flat().map((date, i) => {
            if (!date) return <div key={`p${i}`} />;
            const dayEntry = byDate.get(date);
            const isToday = date === today;
            return (
              <div
                key={date}
                title={
                  dayEntry
                    ? `${date}: ${dayEntry.mood}/5${dayEntry.note ? ` – ${dayEntry.note}` : ''}`
                    : date
                }
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 10,
                  fontVariantNumeric: 'tabular-nums',
                  borderRadius: 4,
                  minHeight: 0,
                  border: isToday ? '1px solid var(--accent)' : '1px solid transparent',
                  background: dayEntry
                    ? `color-mix(in srgb, ${moodToken(dayEntry.mood)} 45%, var(--bg-widget))`
                    : 'var(--bg-widget-hover)',
                  color: dayEntry ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {Number(date.slice(8, 10))}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  /* ── Trend variant ─────────────────────────────────────────────────── */

  function TrendView({ entries }: { entries: MoodDayDoc[] }) {
    const today = localDayKey();
    const series = moodSeries(entries, 14, today);
    const logged = series.filter((s) => s.mood !== null);
    const avg = averageMood(entries, 14, today);
    const barW = 100 / series.length;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div className="c-muted" style={{ fontSize: 12, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {avg === null
            ? t('tool.mood.trend.empty')
            : t('tool.mood.trend.average', { avg: avg.toFixed(1) })}
        </div>
        {logged.length === 0 ? (
          <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            {t('tool.mood.widget.empty')}
          </div>
        ) : (
          <svg
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            role="img"
            aria-label={t('tool.mood.trend.chartLabel')}
            style={{ flex: 1, minHeight: 0, width: '100%' }}
          >
            {series.map((s, i) => {
              if (s.mood === null) return null;
              const h = (s.mood / 5) * 36;
              return (
                <rect
                  key={s.date}
                  x={i * barW + barW * 0.15}
                  y={40 - h}
                  width={barW * 0.7}
                  height={h}
                  rx={0.8}
                  fill={moodToken(s.mood)}
                >
                  <title>{`${s.date}: ${s.mood}/5`}</title>
                </rect>
              );
            })}
          </svg>
        )}
        <div
          className="c-muted"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          <span>{series[0]?.date ?? ''}</span>
          <span>{series[series.length - 1]?.date ?? ''}</span>
        </div>
      </div>
    );
  }

  function MoodWidget(props: WidgetProps) {
    const { entries, settings } = useMoodData();
    const [showSettings, setShowSettings] = useState(false);

    let body;
    switch (props.variant) {
      case 'calendar':
        body = <CalendarView entries={entries} settings={settings} />;
        break;
      case 'trend':
        body = <TrendView entries={entries} />;
        break;
      case 'today':
      default:
        body = <TodayView entries={entries} settings={settings} />;
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
            aria-label={t('tool.mood.widget.settingsToggle')}
            title={t('tool.mood.widget.settingsToggle')}
            aria-expanded={showSettings}
            style={{ position: 'absolute', top: 0, right: 0, padding: '0 var(--space-1)' }}
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
        id: 'mood.log',
        titleKey: 'tool.mood.command.log',
        descriptionKey: 'tool.mood.command.logDesc',
        icon: '🙂',
        params: logMoodParamsSchema,
        selfTestParams: { mood: 4, note: 'Cardo self-test' },
        async run(params): Promise<CommandResult> {
          const doc = await logMoodIn(context.storage, localDayKey(), params.mood, params.note);
          return {
            ok: true,
            data: { date: doc.date, mood: doc.mood },
            messageKey: 'tool.mood.msg.logged',
          };
        },
      });

      context.commands.register({
        id: 'mood.context',
        titleKey: 'tool.mood.command.context',
        descriptionKey: 'tool.mood.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const entries = await queryEntriesIn(context.storage);
          return {
            ok: true,
            data: {
              contextText: buildMoodContext(entries, context.i18n.language, localDayKey()),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: MoodWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const date = '2026-02-03';
          try {
            const first = await logMoodIn(testCtx.storage, date, 3, 'first note');
            const afterFirst = await testCtx.storage.get<MoodDayDoc>(first.id);
            if (afterFirst?.mood !== 3 || afterFirst.note !== 'first note') {
              return { status: 'fail', detail: `bad first write: ${JSON.stringify(afterFirst)}` };
            }
            // Upsert of the same day: mood changes, an omitted note survives.
            await logMoodIn(testCtx.storage, date, 5);
            const afterUpsert = await testCtx.storage.get<MoodDayDoc>(first.id);
            if (afterUpsert?.mood !== 5 || afterUpsert.note !== 'first note') {
              return { status: 'fail', detail: `bad upsert: ${JSON.stringify(afterUpsert)}` };
            }
            const all = await testCtx.storage.query<MoodDayDoc>({
              where: [{ field: 'date', op: '=', value: date }],
            });
            if (all.length !== 1) {
              return { status: 'fail', detail: `expected 1 doc for ${date}, got ${all.length}` };
            }
            return { status: 'pass', detail: 'log → reload → same-day upsert ok' };
          } finally {
            await testCtx.storage.delete(`day:${date}`);
          }
        }
        case 'streak-math': {
          const entries = [
            makeDayDoc('2026-07-13', 2),
            makeDayDoc('2026-07-14', 4),
            makeDayDoc('2026-07-15', 5),
          ];
          const checks: Array<[number, number]> = [
            [streak(entries, '2026-07-15'), 3],
            [streak(entries, '2026-07-16'), 3], // today unlogged → ends yesterday
            [streak(entries, '2026-07-18'), 0],
            [streak([], '2026-07-15'), 0],
          ];
          for (const [got, expected] of checks) {
            if (got !== expected) {
              return { status: 'fail', detail: `streak: expected ${expected}, got ${got}` };
            }
          }
          const avg = averageMood(entries, 7, '2026-07-15');
          if (avg === null || Math.abs(avg - 11 / 3) > 1e-9) {
            return { status: 'fail', detail: `averageMood: expected 3.67, got ${avg}` };
          }
          return { status: 'pass', detail: 'streak and average verified' };
        }
        case 'render':
          return typeof MoodWidget === 'function' && MoodWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
