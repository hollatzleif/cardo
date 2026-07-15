import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { playTonePattern } from '@cardo/ui';
import manifest from '../manifest.json';
import {
  buildBreathingContext,
  localDateKey,
  phaseAt,
  phaseLabelKey,
  phaseTargetScale,
  phaseTone,
  sessionPlan,
  type PatternId,
} from './logic';

/**
 * Breathing – guided box / 4-7-8 breathing. The only persistent data is the
 * settings, a `session` doc while an exercise runs (written by the widget OR
 * by the assistant via `breathing.start` – the widget reacts through
 * storage.subscribe) and a per-day `stats:<date>` completion counter.
 */

const SESSION_DOC_ID = 'session';

type SessionDoc = {
  id: string;
  type: 'session';
  pattern: PatternId;
  cycles: number;
  /** ISO timestamp of the session start. */
  startedAt: string;
};

type StatsDoc = {
  id: string;
  type: 'stats';
  date: string;
  completed: number;
};

type BreathingSettings = {
  pattern: PatternId;
  cycles: number;
  sound: boolean;
};

const DEFAULT_SETTINGS: BreathingSettings = { pattern: 'box', cycles: 4, sound: false };

function statsKey(date: string): string {
  return `stats:${date}`;
}

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function startSessionIn(
  storage: ToolStorage,
  pattern: PatternId,
  cycles: number,
  now: Date = new Date(),
): Promise<SessionDoc> {
  const session: SessionDoc = {
    id: SESSION_DOC_ID,
    type: 'session',
    pattern,
    cycles: Math.max(1, Math.min(99, Math.floor(cycles))),
    startedAt: now.toISOString(),
  };
  await storage.set<SessionDoc>(SESSION_DOC_ID, session);
  return session;
}

async function bumpStatsIn(storage: ToolStorage, date: string): Promise<StatsDoc> {
  const existing = await storage.get<StatsDoc>(statsKey(date));
  const next: StatsDoc = {
    id: statsKey(date),
    type: 'stats',
    date,
    completed: (existing?.completed ?? 0) + 1,
  };
  await storage.set<StatsDoc>(next.id, next);
  return next;
}

/** matchMedia guard – reduced-motion users get the static text pacer. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<BreathingSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [pattern, cycles, sound] = await Promise.all([
      c.settings.get<PatternId>('pattern'),
      c.settings.get<number>('cycles'),
      c.settings.get<boolean>('sound'),
    ]);
    return {
      pattern: pattern === '478' ? '478' : pattern === 'box' ? 'box' : DEFAULT_SETTINGS.pattern,
      cycles: cycles ?? DEFAULT_SETTINGS.cycles,
      sound: sound ?? DEFAULT_SETTINGS.sound,
    };
  }

  function BreathingWidget(props: WidgetProps) {
    const [session, setSession] = useState<SessionDoc | null>(null);
    const [settings, setSettings] = useState<BreathingSettings>({ ...DEFAULT_SETTINGS });
    const [completedToday, setCompletedToday] = useState(0);
    const [showSettings, setShowSettings] = useState(false);
    const [nowMs, setNowMs] = useState(() => Date.now());
    const lastPhaseIndex = useRef(-1);
    const completing = useRef(false);
    const reducedMotion = prefersReducedMotion();

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [sess, stats, loaded] = await Promise.all([
        c.storage.get<SessionDoc>(SESSION_DOC_ID),
        c.storage.get<StatsDoc>(statsKey(localDateKey(new Date()))),
        loadSettings(),
      ]);
      setSession(sess);
      setCompletedToday(stats?.completed ?? 0);
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

    // Drive the timeline while a session runs.
    useEffect(() => {
      if (!session) {
        lastPhaseIndex.current = -1;
        completing.current = false;
        return;
      }
      const timer = window.setInterval(() => setNowMs(Date.now()), 100);
      return () => window.clearInterval(timer);
    }, [session]);

    const startTime = session ? Date.parse(session.startedAt) : Number.NaN;
    const elapsedMs = Number.isFinite(startTime) ? Math.max(0, nowMs - startTime) : 0;
    const plan = session ? sessionPlan(session.pattern, session.cycles) : null;
    const active = plan ? phaseAt(plan, elapsedMs) : null;

    // Sound cue on phase change (setting + manifest "audio" permission gated).
    useEffect(() => {
      if (!active) return;
      if (active.index === lastPhaseIndex.current) return;
      lastPhaseIndex.current = active.index;
      if (!settings.sound) return;
      const tone = phaseTone(active.phase.key);
      if (tone) void playTonePattern([tone]);
    }, [active, settings.sound]);

    // Session finished → count it once and remove the session doc.
    useEffect(() => {
      if (!session || !plan) return;
      if (elapsedMs < plan.totalMs && plan.totalMs > 0) return;
      if (completing.current) return;
      completing.current = true;
      void (async () => {
        const c = ctx;
        if (!c) return;
        const still = await c.storage.get<SessionDoc>(SESSION_DOC_ID);
        if (still && still.startedAt === session.startedAt) {
          await c.storage.delete(SESSION_DOC_ID);
          await bumpStatsIn(c.storage, localDateKey(new Date()));
        }
      })();
    }, [session, plan, elapsedMs]);

    const start = async () => {
      const c = ctx;
      if (!c) return;
      completing.current = false;
      await startSessionIn(c.storage, settings.pattern, settings.cycles);
    };

    const stop = async () => {
      await ctx?.storage.delete(SESSION_DOC_ID);
    };

    /* ── Running view ────────────────────────────────────────────── */

    let body: ReactNode;
    if (session && active) {
      const label = t(phaseLabelKey(active.phase.key));
      const scale = phaseTargetScale(active.phase.key);
      const countdown = (
        <div
          aria-live="polite"
          style={{ textAlign: 'center', display: 'flex', flexDirection: 'column' }}
        >
          <span style={{ fontSize: '1.1em', fontWeight: 600 }}>{label}</span>
          <span
            style={{ fontSize: '2em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}
          >
            {active.remainingSeconds}
          </span>
          <span className="c-muted" style={{ fontSize: '0.75em' }}>
            {t('tool.breathing.widget.cycleOf', {
              cycle: active.phase.cycle,
              cycles: session.cycles,
            })}
          </span>
        </div>
      );

      let pacer: ReactNode = null;
      if (!reducedMotion && props.variant !== 'minimal') {
        pacer =
          props.variant === 'bar' ? (
            <div
              aria-hidden
              style={{
                width: '100%',
                height: '10px',
                borderRadius: '999px',
                background: 'var(--border-subtle)',
                overflow: 'hidden',
                flexShrink: 0,
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: '999px',
                  background: 'var(--accent)',
                  width: `${scale * 100}%`,
                  transition: `width ${active.phase.seconds}s linear`,
                }}
              />
            </div>
          ) : (
            <svg viewBox="0 0 100 100" aria-hidden style={{ width: '100%', maxWidth: 120 }}>
              <circle cx="50" cy="50" r="48" fill="none" stroke="var(--border-subtle)" />
              <circle
                cx="50"
                cy="50"
                r="48"
                fill="var(--accent)"
                opacity="0.85"
                style={{
                  transformOrigin: '50px 50px',
                  transform: `scale(${scale})`,
                  transition: `transform ${active.phase.seconds}s ease-in-out`,
                }}
              />
            </svg>
          );
      }

      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            overflow: 'hidden',
          }}
        >
          {pacer}
          {countdown}
          <button className="c-btn c-btn--ghost" onClick={() => void stop()}>
            {t('tool.breathing.widget.stop')}
          </button>
        </div>
      );
    } else {
      /* ── Idle view ───────────────────────────────────────────── */
      body = (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-2)',
            overflow: 'auto',
          }}
        >
          <button
            className="c-btn c-btn--primary"
            style={{ fontSize: '1.1em', padding: 'var(--space-2) var(--space-4)' }}
            onClick={() => void start()}
          >
            {t('tool.breathing.widget.start')}
          </button>
          <span className="c-muted" style={{ fontSize: '0.8em' }}>
            {t(`tool.breathing.pattern.${settings.pattern}`)} ·{' '}
            {t('tool.breathing.widget.cycles', { cycles: settings.cycles })}
          </span>
          {completedToday > 0 ? (
            <span style={{ color: 'var(--success)', fontSize: '0.8em' }}>
              {t('tool.breathing.widget.completedToday', { count: completedToday })}
            </span>
          ) : null}
          {showSettings ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                width: '100%',
                maxWidth: '240px',
                borderTop: '1px solid var(--border-subtle)',
                paddingTop: 'var(--space-2)',
              }}
            >
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-2)',
                }}
              >
                <span className="c-muted" style={{ fontSize: '0.85em' }}>
                  {t('tool.breathing.settings.pattern')}
                </span>
                <select
                  className="c-input"
                  value={settings.pattern}
                  style={{ width: 'auto' }}
                  onChange={(e) =>
                    void ctx?.settings.set('pattern', e.target.value === '478' ? '478' : 'box')
                  }
                >
                  <option value="box">{t('tool.breathing.pattern.box')}</option>
                  <option value="478">{t('tool.breathing.pattern.478')}</option>
                </select>
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: 'var(--space-2)',
                }}
              >
                <span className="c-muted" style={{ fontSize: '0.85em' }}>
                  {t('tool.breathing.settings.cycles')}
                </span>
                <input
                  className="c-input"
                  type="number"
                  min={1}
                  max={99}
                  value={settings.cycles}
                  style={{ width: '64px', textAlign: 'right' }}
                  onChange={(e) => {
                    const v = Math.round(Number(e.target.value));
                    if (Number.isFinite(v) && v >= 1 && v <= 99) {
                      void ctx?.settings.set('cycles', v);
                    }
                  }}
                />
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <input
                  type="checkbox"
                  checked={settings.sound}
                  style={{ accentColor: 'var(--accent)' }}
                  onChange={(e) => void ctx?.settings.set('sound', e.target.checked)}
                />
                <span className="c-muted" style={{ fontSize: '0.85em' }}>
                  {t('tool.breathing.settings.sound')}
                </span>
              </label>
            </div>
          ) : null}
        </div>
      );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-1)',
          padding: 'var(--space-3)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.breathing.widget.settingsToggle')}
            title={t('tool.breathing.widget.settingsToggle')}
            aria-expanded={showSettings}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        </div>
        {body}
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'breathing.start',
        titleKey: 'tool.breathing.command.start',
        descriptionKey: 'tool.breathing.command.startDesc',
        icon: '🫁',
        assistant: true,
        params: z.object({
          pattern: z.enum(['box', '478']).optional(),
          cycles: z.number().int().min(1).max(99).optional(),
        }),
        selfTestParams: { pattern: 'box', cycles: 1 },
        async run(params): Promise<CommandResult> {
          const settings = await loadSettings();
          const session = await startSessionIn(
            context.storage,
            params.pattern ?? settings.pattern,
            params.cycles ?? settings.cycles,
          );
          return { ok: true, data: session, messageKey: 'tool.breathing.msg.started' };
        },
      });

      context.commands.register({
        id: 'breathing.context',
        titleKey: 'tool.breathing.command.context',
        descriptionKey: 'tool.breathing.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [session, stats] = await Promise.all([
            context.storage.get<SessionDoc>(SESSION_DOC_ID),
            context.storage.get<StatsDoc>(statsKey(localDateKey(new Date()))),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildBreathingContext(
                session,
                stats?.completed ?? 0,
                context.i18n.language,
              ),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: BreathingWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'phase-math': {
          const box = sessionPlan('box', 2);
          if (box.phases.length !== 8 || box.totalMs !== 32_000) {
            return {
              status: 'fail',
              detail: `box × 2 should be 8 phases / 32 s, got ${box.phases.length} / ${box.totalMs}`,
            };
          }
          const relax = sessionPlan('478', 1);
          if (relax.phases.length !== 3 || relax.totalMs !== 19_000) {
            return {
              status: 'fail',
              detail: `4-7-8 should be 3 phases / 19 s, got ${relax.phases.length} / ${relax.totalMs}`,
            };
          }
          if (phaseAt(box, 0)?.phase.key !== 'inhale') {
            return { status: 'fail', detail: 'elapsed 0 must be the first inhale' };
          }
          if (phaseAt(box, 4000)?.phase.key !== 'hold1' || phaseAt(box, 3999)?.phase.key !== 'inhale') {
            return { status: 'fail', detail: 'phase boundary at 4000 ms is not exact' };
          }
          if (phaseAt(box, 32_000) !== null) {
            return { status: 'fail', detail: 'session end must yield null' };
          }
          return { status: 'pass', detail: 'sequence, plan sums and boundaries ok' };
        }
        case 'start-command': {
          // The shared helper the breathing.start command uses, run against
          // the scratch storage.
          const before = await testCtx.storage.get<SessionDoc>(SESSION_DOC_ID);
          const session = await startSessionIn(testCtx.storage, '478', 2);
          const stored = await testCtx.storage.get<SessionDoc>(SESSION_DOC_ID);
          // Clean up / restore whatever was there before.
          if (before) {
            await testCtx.storage.set<SessionDoc>(SESSION_DOC_ID, before);
          } else {
            await testCtx.storage.delete(SESSION_DOC_ID);
          }
          if (stored?.pattern !== '478' || stored.cycles !== 2 || stored.type !== 'session') {
            return { status: 'fail', detail: `session doc mismatch: ${JSON.stringify(stored)}` };
          }
          if (Number.isNaN(Date.parse(session.startedAt))) {
            return { status: 'fail', detail: `startedAt is not a timestamp: ${session.startedAt}` };
          }
          return { status: 'pass', detail: 'start writes a readable session doc' };
        }
        case 'render':
          return typeof BreathingWidget === 'function' && BreathingWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
