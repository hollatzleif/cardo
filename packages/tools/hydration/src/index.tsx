import { useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { isInWindow, localDateKey, type DayDoc, type StateDoc } from './hydration';

/**
 * Hydration – a drink reminder plus daily glass counter, fully local.
 * The count of one day lives in a `day:<YYYY-MM-DD>` doc (LOCAL date), so
 * the counter starts fresh at local midnight without deleting anything.
 * Reminders self-chain: `hydration.remind` notifies (inside the time window,
 * below the goal) and then schedules its own next run via the persistent
 * scheduler – missed reminders fire on launch and re-arm themselves.
 */

const STATE_DOC_ID = 'state';

type HydrationSettings = {
  /** Glasses per day. */
  dailyGoal: number;
  /** Minutes between reminders; 0 disables reminders. */
  remindEveryMinutes: number;
  /** Reminder window start, "HH:MM" local (may cross midnight). */
  remindFrom: string;
  /** Reminder window end, "HH:MM" local. */
  remindUntil: string;
};

const DEFAULT_SETTINGS: HydrationSettings = {
  dailyGoal: 8,
  remindEveryMinutes: 60,
  remindFrom: '09:00',
  remindUntil: '21:00',
};

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Settings ────────────────────────────────────────────────────── */

  async function loadSettings(): Promise<HydrationSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [dailyGoal, remindEveryMinutes, remindFrom, remindUntil] = await Promise.all([
      c.settings.get<number>('dailyGoal'),
      c.settings.get<number>('remindEveryMinutes'),
      c.settings.get<string>('remindFrom'),
      c.settings.get<string>('remindUntil'),
    ]);
    return {
      dailyGoal: dailyGoal ?? DEFAULT_SETTINGS.dailyGoal,
      remindEveryMinutes: remindEveryMinutes ?? DEFAULT_SETTINGS.remindEveryMinutes,
      remindFrom: remindFrom ?? DEFAULT_SETTINGS.remindFrom,
      remindUntil: remindUntil ?? DEFAULT_SETTINGS.remindUntil,
    };
  }

  async function updateSetting(
    key: keyof HydrationSettings,
    value: number | string,
  ): Promise<void> {
    const c = ctx;
    if (!c) return;
    await c.settings.set(key, value);
    // A new cadence takes effect immediately (also arms after 0 → n).
    if (key === 'remindEveryMinutes' && typeof value === 'number') {
      await rearm(c, value);
    }
  }

  /* ── Storage helpers (storage-parametrized for self-tests) ──────────── */

  async function getDayIn(storage: ToolStorage, date: string): Promise<DayDoc> {
    const doc = await storage.get<DayDoc>(`day:${date}`);
    return doc ?? { id: date, date, glasses: 0 };
  }

  /** Add `glasses` (may be negative) to today's count, clamped at 0. */
  async function drinkIn(storage: ToolStorage, glasses: number, now = new Date()): Promise<DayDoc> {
    const date = localDateKey(now);
    const day = await getDayIn(storage, date);
    const next: DayDoc = { ...day, glasses: Math.max(0, day.glasses + glasses) };
    await storage.set<DayDoc>(`day:${date}`, next);
    return next;
  }

  async function getState(storage: ToolStorage): Promise<StateDoc> {
    const doc = await storage.get<StateDoc>(STATE_DOC_ID);
    return doc ?? { id: STATE_DOC_ID };
  }

  /* ── Drinking ────────────────────────────────────────────────────── */

  async function drink(glasses: number): Promise<CommandResult> {
    const c = ctx;
    if (!c) return { ok: false, messageKey: 'tool.hydration.msg.failed' };
    const settings = await loadSettings();
    const day = await drinkIn(c.storage, glasses);
    if (day.glasses >= settings.dailyGoal) {
      const state = await getState(c.storage);
      // Celebrate at most once per (local) day, even across ±1 wobbles.
      if (state.celebratedDate !== day.date) {
        await c.storage.set<StateDoc>(STATE_DOC_ID, { ...state, celebratedDate: day.date });
        c.events.emit('hydration:goal-reached', { date: day.date });
      }
    }
    return { ok: true, data: { date: day.date, glasses: day.glasses } };
  }

  /* ── Reminder chain ──────────────────────────────────────────────── */

  /**
   * Cancel the pending reminder (if any) and – for a positive interval –
   * schedule the next `hydration.remind` run. The schedule handle is
   * persisted in the `state` doc so a restart can clean up after itself.
   */
  async function rearm(c: ToolContext, intervalMinutes: number): Promise<void> {
    const state = await getState(c.storage);
    // Sweep EVERY pending hydration.remind – not just the one whose handle
    // we stored. Orphaned duplicates (from crashes, races or historic bugs)
    // would each self-chain forever and stack identical notifications; the
    // sweep also heals installations that already accumulated them.
    try {
      const pending = await c.scheduler.list();
      await Promise.all(
        pending
          .filter((entry) => entry.commandId === 'hydration.remind')
          .map((entry) => c.scheduler.cancel(entry.id).catch(() => {})),
      );
    } catch {
      /* list unavailable – fall back to the stored handle below */
    }
    if (state.scheduleId) {
      try {
        await c.scheduler.cancel(state.scheduleId);
      } catch {
        /* schedule already fired or gone – nothing to cancel */
      }
    }
    let scheduleId: string | undefined;
    if (intervalMinutes > 0) {
      try {
        scheduleId = await c.scheduler.scheduleAt(
          new Date(Date.now() + intervalMinutes * 60_000),
          'hydration.remind',
          {},
        );
      } catch {
        scheduleId = undefined; // scheduler unavailable – re-armed on next activate
      }
    }
    await c.storage.set<StateDoc>(STATE_DOC_ID, { ...state, scheduleId });
  }

  async function remind(): Promise<CommandResult> {
    const c = ctx;
    if (!c) return { ok: false, messageKey: 'tool.hydration.msg.failed' };
    try {
      const settings = await loadSettings();
      const now = new Date();
      const day = await getDayIn(c.storage, localDateKey(now));
      let notified = false;
      if (
        isInWindow(now, settings.remindFrom, settings.remindUntil) &&
        day.glasses < settings.dailyGoal
      ) {
        await c.notifications.notify({
          titleKey: 'tool.hydration.notification.title',
          bodyKey: 'tool.hydration.notification.body',
          vars: { glasses: day.glasses, goal: settings.dailyGoal },
        });
        notified = true;
      }
      // ALWAYS chain the next run (also outside the window / after the goal),
      // otherwise the reminder loop would die overnight. Interval 0 = off.
      await rearm(c, settings.remindEveryMinutes);
      return { ok: true, data: { notified } };
    } catch {
      return { ok: false, messageKey: 'tool.hydration.msg.failed' };
    }
  }

  /* ── Widget ──────────────────────────────────────────────────────── */

  function SettingRow(props: { labelKey: string; children: ReactNode }) {
    return (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span className="c-muted" style={{ fontSize: '0.85em' }}>
          {t(props.labelKey)}
        </span>
        {props.children}
      </label>
    );
  }

  function HydrationWidget(_props: WidgetProps) {
    const [day, setDay] = useState<DayDoc | null>(null);
    const [settings, setSettings] = useState<HydrationSettings>({ ...DEFAULT_SETTINGS });
    const [showSettings, setShowSettings] = useState(false);
    const [dateKey, setDateKey] = useState(() => localDateKey(new Date()));

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
      const load = () => {
        const c = ctx;
        if (!c) return;
        void getDayIn(c.storage, dateKey).then((next) => {
          if (mounted) setDay(next);
        });
        void loadSettings().then((next) => {
          if (mounted) setSettings(next);
        });
      };
      load();
      const unsubStorage = ctx?.storage.subscribe(() => load());
      const unsubSettings = ctx?.settings.subscribe(() => load());
      return () => {
        mounted = false;
        unsubStorage?.();
        unsubSettings?.();
      };
    }, [dateKey]);

    const glasses = day?.glasses ?? 0;
    const goal = Math.max(1, settings.dailyGoal);
    const reached = glasses >= goal;
    const progress = Math.min(100, (glasses / goal) * 100);

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          overflow: 'auto',
        }}
      >
        <div
          aria-label={t('tool.hydration.widget.progressLabel', { glasses, goal })}
          title={t('tool.hydration.widget.progressLabel', { glasses, goal })}
          style={{ fontSize: '2.2em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}
        >
          {glasses} / {goal} 🥤
        </div>

        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={goal}
          aria-valuenow={Math.min(glasses, goal)}
          style={{
            width: '100%',
            height: '6px',
            borderRadius: '999px',
            background: 'var(--border-subtle)',
            overflow: 'hidden',
            flexShrink: 0,
          }}
        >
          <div
            style={{
              width: `${progress}%`,
              height: '100%',
              borderRadius: '999px',
              background: 'var(--info)',
              transition: 'width 0.2s ease',
            }}
          />
        </div>

        {reached && (
          <div style={{ color: 'var(--success)', fontSize: '0.9em', textAlign: 'center' }}>
            {t('tool.hydration.widget.goalReached')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
          <button
            className="c-btn c-btn--primary"
            style={{ fontSize: '1.3em', padding: 'var(--space-2) var(--space-4)' }}
            aria-label={t('tool.hydration.widget.addGlass')}
            title={t('tool.hydration.widget.addGlass')}
            onClick={() => void drink(1)}
          >
            +1
          </button>
          <button
            className="c-btn c-btn--ghost"
            style={{ fontSize: '0.85em' }}
            aria-label={t('tool.hydration.widget.removeGlass')}
            title={t('tool.hydration.widget.removeGlass')}
            disabled={glasses === 0}
            onClick={() => void drink(-1)}
          >
            −1
          </button>
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.hydration.widget.settingsToggle')}
            title={t('tool.hydration.widget.settingsToggle')}
            aria-expanded={showSettings}
            onClick={() => setShowSettings((s) => !s)}
          >
            {'⚙'}
          </button>
        </div>

        {showSettings && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              width: '100%',
              maxWidth: '260px',
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: 'var(--space-3)',
              marginTop: 'var(--space-2)',
            }}
          >
            <SettingRow labelKey="tool.hydration.settings.dailyGoal">
              <input
                className="c-input"
                type="number"
                min={1}
                max={99}
                value={settings.dailyGoal}
                style={{ width: '72px', textAlign: 'right' }}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value));
                  if (Number.isFinite(v) && v >= 1 && v <= 99) {
                    void updateSetting('dailyGoal', v);
                  }
                }}
              />
            </SettingRow>
            <SettingRow labelKey="tool.hydration.settings.remindEveryMinutes">
              <input
                className="c-input"
                type="number"
                min={0}
                max={1440}
                value={settings.remindEveryMinutes}
                style={{ width: '72px', textAlign: 'right' }}
                onChange={(e) => {
                  const v = Math.round(Number(e.target.value));
                  if (Number.isFinite(v) && v >= 0 && v <= 1440) {
                    void updateSetting('remindEveryMinutes', v);
                  }
                }}
              />
            </SettingRow>
            <div className="c-muted" style={{ fontSize: '0.75em' }}>
              {t('tool.hydration.settings.intervalHint')}
            </div>
            <SettingRow labelKey="tool.hydration.settings.remindFrom">
              <input
                className="c-input"
                type="time"
                value={settings.remindFrom}
                style={{ width: 'auto' }}
                onChange={(e) => {
                  if (e.target.value) void updateSetting('remindFrom', e.target.value);
                }}
              />
            </SettingRow>
            <SettingRow labelKey="tool.hydration.settings.remindUntil">
              <input
                className="c-input"
                type="time"
                value={settings.remindUntil}
                style={{ width: 'auto' }}
                onChange={(e) => {
                  if (e.target.value) void updateSetting('remindUntil', e.target.value);
                }}
              />
            </SettingRow>
          </div>
        )}
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;

      context.commands.register({
        id: 'hydration.drink',
        titleKey: 'tool.hydration.command.drink',
        params: z.object({ glasses: z.number().int().min(1).max(99).optional() }),
        selfTestParams: { glasses: 1 },
        icon: '🥤',
        async run({ glasses }) {
          return drink(glasses ?? 1);
        },
      });

      context.commands.register({
        id: 'hydration.remind',
        titleKey: 'tool.hydration.command.remind',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run() {
          return remind();
        },
      });

      // The persistent scheduler survives restarts and fires missed reminders
      // right after launch – remind() handles the window check either way.
      // Still: drop the stale handle from the last session and arm a fresh
      // chain link so the loop cannot die between sessions.
      void (async () => {
        const settings = await loadSettings();
        await rearm(context, settings.remindEveryMinutes);
      })().catch(() => {
        /* storage/scheduler not ready – next remind() run re-arms */
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: HydrationWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'day-roundtrip': {
          const date = '2026-02-03';
          const probe: DayDoc = { id: date, date, glasses: 3 };
          await testCtx.storage.set<DayDoc>(`day:${date}`, probe);
          const roundtrip = await testCtx.storage.get<DayDoc>(`day:${date}`);
          await testCtx.storage.delete(`day:${date}`);
          const gone = await testCtx.storage.get<DayDoc>(`day:${date}`);
          if (roundtrip?.date !== date || roundtrip.glasses !== 3) {
            return { status: 'fail', detail: `bad roundtrip: ${JSON.stringify(roundtrip)}` };
          }
          return gone === null
            ? { status: 'pass' }
            : { status: 'fail', detail: 'day doc still present after delete' };
        }
        case 'window-logic': {
          const at = (h: number, m: number) => new Date(2026, 0, 15, h, m, 0);
          const checks: Array<[Date, string, string, boolean]> = [
            [at(12, 0), '09:00', '21:00', true],
            [at(9, 0), '09:00', '21:00', true],
            [at(8, 59), '09:00', '21:00', false],
            [at(21, 1), '09:00', '21:00', false],
            // Window crossing midnight: 22:00–06:00.
            [at(23, 30), '22:00', '06:00', true],
            [at(5, 59), '22:00', '06:00', true],
            [at(12, 0), '22:00', '06:00', false],
          ];
          for (const [now, from, until, expected] of checks) {
            if (isInWindow(now, from, until) !== expected) {
              return {
                status: 'fail',
                detail: `isInWindow(${now.getHours()}:${now.getMinutes()}, ${from}, ${until}) should be ${expected}`,
              };
            }
          }
          return { status: 'pass', detail: `${checks.length} window checks ok` };
        }
        case 'drink-command': {
          // Delta-based against the scratch storage: the doc may hold
          // leftovers from command probes.
          const date = localDateKey(new Date());
          const before = await testCtx.storage.get<DayDoc>(`day:${date}`);
          const beforeGlasses = before?.glasses ?? 0;
          const result = await drinkIn(testCtx.storage, 1);
          const after = await testCtx.storage.get<DayDoc>(`day:${date}`);
          // Clean up: restore the previous state.
          if (before) {
            await testCtx.storage.set<DayDoc>(`day:${date}`, before);
          } else {
            await testCtx.storage.delete(`day:${date}`);
          }
          if (result.glasses !== beforeGlasses + 1 || after?.glasses !== beforeGlasses + 1) {
            return {
              status: 'fail',
              detail: `expected ${beforeGlasses + 1} glasses, got ${after?.glasses ?? 'null'}`,
            };
          }
          return { status: 'pass', detail: `count ${beforeGlasses} → ${after.glasses}` };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
