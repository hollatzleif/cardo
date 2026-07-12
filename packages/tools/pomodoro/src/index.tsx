import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  DEFAULT_SETTINGS,
  STATE_DOC_ID,
  durationFor,
  formatTime,
  initialState,
  nextPhase,
  remainingNow,
} from './logic';
import type { Phase, PomodoroSettings, PomodoroState } from './logic';

const PHASE_KEY: Record<Phase, string> = {
  work: 'tool.pomodoro.phase.work',
  'short-break': 'tool.pomodoro.phase.shortBreak',
  'long-break': 'tool.pomodoro.phase.longBreak',
};

const FINISHED_BODY_KEY: Record<Phase, string> = {
  work: 'tool.pomodoro.notify.workDone',
  'short-break': 'tool.pomodoro.notify.shortBreakDone',
  'long-break': 'tool.pomodoro.notify.longBreakDone',
};

/** Short two-note completion chime via Web Audio – no assets shipped. */
function playChime(): void {
  if (typeof AudioContext === 'undefined') return;
  try {
    const ac = new AudioContext();
    const gain = ac.createGain();
    gain.connect(ac.destination);
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ac.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.85);
    [660, 880].forEach((freq, i) => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ac.currentTime + i * 0.18);
      osc.connect(gain);
      osc.start(ac.currentTime + i * 0.18);
      osc.stop(ac.currentTime + i * 0.18 + 0.4);
    });
    setTimeout(() => {
      void ac.close();
    }, 1000);
  } catch {
    // Audio device unavailable – the notification still fires.
  }
}

/** Fully customizable Pomodoro timer: work / short break / long break cycles. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string => ctx?.i18n.t(key, vars) ?? key;

  /* ── Settings ── */

  async function loadSettings(): Promise<PomodoroSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [workMinutes, shortBreakMinutes, longBreakMinutes, cyclesUntilLongBreak, soundEnabled] =
      await Promise.all([
        c.settings.get<number>('workMinutes'),
        c.settings.get<number>('shortBreakMinutes'),
        c.settings.get<number>('longBreakMinutes'),
        c.settings.get<number>('cyclesUntilLongBreak'),
        c.settings.get<boolean>('soundEnabled'),
      ]);
    return {
      workMinutes: workMinutes ?? DEFAULT_SETTINGS.workMinutes,
      shortBreakMinutes: shortBreakMinutes ?? DEFAULT_SETTINGS.shortBreakMinutes,
      longBreakMinutes: longBreakMinutes ?? DEFAULT_SETTINGS.longBreakMinutes,
      cyclesUntilLongBreak: cyclesUntilLongBreak ?? DEFAULT_SETTINGS.cyclesUntilLongBreak,
      soundEnabled: soundEnabled ?? DEFAULT_SETTINGS.soundEnabled,
    };
  }

  async function updateSetting(
    key: keyof PomodoroSettings,
    value: number | boolean,
  ): Promise<void> {
    const before = await loadSettings();
    await ctx?.settings.set(key, value);
    const after = { ...before, [key]: value } as PomodoroSettings;
    // If the timer sits untouched at the full old duration, adopt the new one.
    const state = await readState();
    if (!state.running && state.remainingSeconds === durationFor(state.phase, before)) {
      await writeState({ ...state, remainingSeconds: durationFor(state.phase, after) });
    }
  }

  /* ── State ── */

  async function readState(): Promise<PomodoroState> {
    const doc = await ctx?.storage.get<PomodoroState>(STATE_DOC_ID);
    return doc ?? initialState(await loadSettings());
  }

  async function writeState(state: PomodoroState): Promise<void> {
    await ctx?.storage.set<PomodoroState>(STATE_DOC_ID, state);
  }

  async function startTimer(): Promise<void> {
    const state = await readState();
    if (state.running) return;
    const remaining = Math.max(1, state.remainingSeconds);
    await writeState({
      ...state,
      running: true,
      remainingSeconds: remaining,
      endsAt: new Date(Date.now() + remaining * 1000).toISOString(),
    });
    // Every actual "phase is now running" transition goes through here
    // (start button, restart after auto-advance, skip + start) – announce
    // it for coupled tools. Phase names keep the logic.ts convention.
    ctx?.events.emit('pomodoro:phase-started', {
      phase: state.phase,
      at: new Date().toISOString(),
    });
  }

  async function pauseTimer(): Promise<void> {
    const state = await readState();
    if (!state.running) return;
    await writeState({
      ...state,
      running: false,
      remainingSeconds: remainingNow(state, Date.now()),
      endsAt: null,
    });
  }

  async function resetTimer(): Promise<void> {
    await writeState(initialState(await loadSettings()));
  }

  async function skipPhase(): Promise<void> {
    const state = await readState();
    await writeState(nextPhase(state, await loadSettings()));
  }

  /** A phase ran out: notify, chime, advance – but PAUSED. */
  async function finishPhase(): Promise<void> {
    const state = await readState();
    if (!state.running) return; // already handled elsewhere
    const settings = await loadSettings();
    await writeState(nextPhase(state, settings));
    ctx?.events.emit('pomodoro:finished', { phase: state.phase, at: new Date().toISOString() });
    await ctx?.notifications.notify({
      titleKey: 'tool.pomodoro.notify.title',
      bodyKey: FINISHED_BODY_KEY[state.phase],
    });
    if (settings.soundEnabled) playChime();
  }

  /* ── Widget ── */

  function SettingRow(props: {
    labelKey: string;
    value: number;
    onChange: (v: number) => void;
  }) {
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
        <input
          className="c-input"
          type="number"
          min={1}
          max={999}
          value={props.value}
          style={{ width: '72px', textAlign: 'right' }}
          onChange={(e) => {
            const v = Math.round(Number(e.target.value));
            if (Number.isFinite(v) && v >= 1 && v <= 999) props.onChange(v);
          }}
        />
      </label>
    );
  }

  function PomodoroWidget(_props: WidgetProps) {
    const [state, setState] = useState<PomodoroState | null>(null);
    const [settings, setSettings] = useState<PomodoroSettings>({ ...DEFAULT_SETTINGS });
    const [showSettings, setShowSettings] = useState(false);
    const [, setTick] = useState(0);
    const finishing = useRef(false);

    const refresh = useCallback(() => {
      void readState().then(setState);
      void loadSettings().then(setSettings);
    }, []);

    useEffect(() => {
      refresh();
      const unsubStorage = ctx?.storage.subscribe(() => refresh());
      const unsubSettings = ctx?.settings.subscribe(() => refresh());
      return () => {
        unsubStorage?.();
        unsubSettings?.();
      };
    }, [refresh]);

    // Tick while running; fire phase completion exactly once per run-out.
    useEffect(() => {
      if (!state?.running) return;
      const timer = setInterval(() => {
        setTick((n) => n + 1);
        if (remainingNow(state, Date.now()) <= 0 && !finishing.current) {
          finishing.current = true;
          void finishPhase().finally(() => {
            finishing.current = false;
          });
        }
      }, 250);
      return () => clearInterval(timer);
    }, [state]);

    if (!state) {
      return <div className="c-muted" style={{ padding: 'var(--space-3)' }} />;
    }

    const remaining = remainingNow(state, Date.now());
    const cycleSpan = Math.max(1, settings.cyclesUntilLongBreak);
    const doneInSet =
      state.phase === 'long-break' ? cycleSpan : state.completedCycles % cycleSpan;

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
          className="c-muted"
          style={{ fontSize: '0.8em', textTransform: 'uppercase', letterSpacing: '0.08em' }}
        >
          {t(PHASE_KEY[state.phase])}
        </div>
        <div style={{ fontSize: '2.8em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
          {formatTime(remaining)}
        </div>
        <div
          aria-label={t('tool.pomodoro.cycles', { done: doneInSet, total: cycleSpan })}
          title={t('tool.pomodoro.cycles', { done: doneInSet, total: cycleSpan })}
          style={{ display: 'flex', gap: 'var(--space-1)', fontSize: '0.75em' }}
        >
          {Array.from({ length: cycleSpan }, (_, i) => (
            <span key={i} style={{ color: i < doneInSet ? 'var(--accent)' : 'var(--text-muted)' }}>
              {i < doneInSet ? '●' : '○'}
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
          <button
            className="c-btn c-btn--primary"
            onClick={() => void (state.running ? pauseTimer() : startTimer())}
          >
            {state.running ? t('tool.pomodoro.pause') : t('tool.pomodoro.start')}
          </button>
          <button className="c-btn c-btn--ghost" onClick={() => void resetTimer()}>
            {t('tool.pomodoro.reset')}
          </button>
          <button
            className="c-btn c-btn--ghost"
            title={t('tool.pomodoro.skip')}
            aria-label={t('tool.pomodoro.skip')}
            onClick={() => void skipPhase()}
          >
            {'»'}
          </button>
          <button
            className="c-btn c-btn--ghost"
            title={t('tool.pomodoro.settings.toggle')}
            aria-label={t('tool.pomodoro.settings.toggle')}
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
            <SettingRow
              labelKey="tool.pomodoro.settings.workMinutes"
              value={settings.workMinutes}
              onChange={(v) => void updateSetting('workMinutes', v)}
            />
            <SettingRow
              labelKey="tool.pomodoro.settings.shortBreakMinutes"
              value={settings.shortBreakMinutes}
              onChange={(v) => void updateSetting('shortBreakMinutes', v)}
            />
            <SettingRow
              labelKey="tool.pomodoro.settings.longBreakMinutes"
              value={settings.longBreakMinutes}
              onChange={(v) => void updateSetting('longBreakMinutes', v)}
            />
            <SettingRow
              labelKey="tool.pomodoro.settings.cyclesUntilLongBreak"
              value={settings.cyclesUntilLongBreak}
              onChange={(v) => void updateSetting('cyclesUntilLongBreak', v)}
            />
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                fontSize: '0.85em',
              }}
            >
              <input
                type="checkbox"
                checked={settings.soundEnabled}
                onChange={(e) => void updateSetting('soundEnabled', e.target.checked)}
              />
              <span className="c-muted">{t('tool.pomodoro.settings.sound')}</span>
            </label>
          </div>
        )}
      </div>
    );
  }

  /* ── Tool export ── */

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
      context.commands.register({
        id: 'pomodoro.start',
        titleKey: 'tool.pomodoro.command.start',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          await startTimer();
          return { ok: true, data: await readState() };
        },
      });
      context.commands.register({
        id: 'pomodoro.pause',
        titleKey: 'tool.pomodoro.command.pause',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          await pauseTimer();
          return { ok: true, data: await readState() };
        },
      });
      context.commands.register({
        id: 'pomodoro.reset',
        titleKey: 'tool.pomodoro.command.reset',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          await resetTimer();
          return { ok: true, data: await readState() };
        },
      });
      context.commands.register({
        id: 'pomodoro.skip',
        titleKey: 'tool.pomodoro.command.skip',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          await skipPhase();
          return { ok: true, data: await readState() };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: PomodoroWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'state-persists': {
          const probe: PomodoroState = {
            ...initialState({ ...DEFAULT_SETTINGS }),
            phase: 'short-break',
            remainingSeconds: 123,
            completedCycles: 2,
          };
          await testCtx.storage.set<PomodoroState>(STATE_DOC_ID, probe);
          const roundtrip = await testCtx.storage.get<PomodoroState>(STATE_DOC_ID);
          await testCtx.storage.delete(STATE_DOC_ID);
          return roundtrip &&
            roundtrip.phase === 'short-break' &&
            roundtrip.remainingSeconds === 123 &&
            roundtrip.completedCycles === 2 &&
            roundtrip.id === STATE_DOC_ID
            ? { status: 'pass' }
            : { status: 'fail', detail: `unexpected roundtrip: ${JSON.stringify(roundtrip)}` };
        }
        case 'phase-advance': {
          const s = { ...DEFAULT_SETTINGS };
          const afterFirstWork = nextPhase(initialState(s), s);
          if (afterFirstWork.phase !== 'short-break' || afterFirstWork.completedCycles !== 1) {
            return {
              status: 'fail',
              detail: `work should advance to short-break, got ${afterFirstWork.phase}`,
            };
          }
          if (afterFirstWork.running) {
            return { status: 'fail', detail: 'next phase must start paused' };
          }
          const fourthWork = { ...initialState(s), completedCycles: s.cyclesUntilLongBreak - 1 };
          const afterFourthWork = nextPhase(fourthWork, s);
          if (afterFourthWork.phase !== 'long-break') {
            return {
              status: 'fail',
              detail: `cycle ${s.cyclesUntilLongBreak} should advance to long-break, got ${afterFourthWork.phase}`,
            };
          }
          const backToWork = nextPhase(afterFourthWork, s);
          return backToWork.phase === 'work' &&
            backToWork.remainingSeconds === durationFor('work', s)
            ? { status: 'pass' }
            : { status: 'fail', detail: `break should advance to work, got ${backToWork.phase}` };
        }
        case 'settings-roundtrip': {
          await testCtx.settings.set('workMinutes', 42);
          const value = await testCtx.settings.get<number>('workMinutes');
          return value === 42
            ? { status: 'pass' }
            : { status: 'fail', detail: `expected 42, got ${JSON.stringify(value)}` };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
