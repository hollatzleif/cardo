import { useCallback, useEffect, useState } from 'react';
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
  KG_PER_LB,
  buildWorkoutContext,
  formatWeight,
  isValidDate,
  localDayKey,
  logSessionParamsSchema,
  makeSession,
  personalRecords,
  sessionVolume,
  sessionsThisWeek,
  volumeByWeekday,
  weeklyVolume,
  type Exercise,
  type SessionDoc,
  type WeightUnit,
} from './logic';

/**
 * Workout log – sessions with sets/reps/weight in `session:<id>` docs
 * (weights are ALWAYS stored in kg; lb is a pure display unit). Fully local.
 */

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function querySessionsIn(storage: ToolStorage): Promise<SessionDoc[]> {
  const sessions = await storage.query<SessionDoc>({
    where: [{ field: 'type', op: '=', value: 'session' }],
  });
  return [...sessions].sort(
    (a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt),
  );
}

async function logSessionIn(
  storage: ToolStorage,
  kind: string,
  date: string,
): Promise<SessionDoc> {
  const session = makeSession(kind, date);
  await storage.set(session.id, session);
  return session;
}

/** Append one exercise to an existing session; null when the session is gone. */
async function addExerciseIn(
  storage: ToolStorage,
  sessionId: string,
  exercise: Exercise,
): Promise<SessionDoc | null> {
  const session = await storage.get<SessionDoc>(sessionId);
  if (!session) return null;
  const updated: SessionDoc = { ...session, exercises: [...session.exercises, exercise] };
  await storage.set(sessionId, updated);
  return updated;
}

async function removeExerciseIn(
  storage: ToolStorage,
  sessionId: string,
  index: number,
): Promise<SessionDoc | null> {
  const session = await storage.get<SessionDoc>(sessionId);
  if (!session) return null;
  const updated: SessionDoc = {
    ...session,
    exercises: session.exercises.filter((_, i) => i !== index),
  };
  await storage.set(sessionId, updated);
  return updated;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadUnit(): Promise<WeightUnit> {
    const unit = await ctx?.settings.get<WeightUnit>('unit');
    return unit === 'lb' ? 'lb' : 'kg';
  }

  /** Shared state loader: all variants need sessions + unit, live-updated. */
  function useWorkoutData() {
    const [sessions, setSessions] = useState<SessionDoc[]>([]);
    const [unit, setUnit] = useState<WeightUnit>('kg');

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, loadedUnit] = await Promise.all([querySessionsIn(c.storage), loadUnit()]);
      setSessions(list);
      setUnit(loadedUnit);
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

    return { sessions, unit };
  }

  /* ── Add-exercise form (inside an expanded session) ────────────────── */

  function ExerciseForm({ sessionId, unit }: { sessionId: string; unit: WeightUnit }) {
    const [name, setName] = useState('');
    const [sets, setSets] = useState('3');
    const [reps, setReps] = useState('10');
    const [weight, setWeight] = useState('');

    async function addExercise() {
      const c = ctx;
      const setsN = Math.round(Number(sets));
      const repsN = Math.round(Number(reps));
      if (!c || !name.trim() || !(setsN >= 1) || !(repsN >= 1)) return;
      const exercise: Exercise = { name: name.trim(), sets: setsN, reps: repsN };
      if (weight.trim() !== '') {
        const w = Number(weight.replace(',', '.'));
        if (!Number.isFinite(w) || w < 0) return;
        // Stored ALWAYS in kg – an lb display unit converts on entry.
        if (w > 0) exercise.weightKg = unit === 'kg' ? w : Math.round(w * KG_PER_LB * 100) / 100;
      }
      await addExerciseIn(c.storage, sessionId, exercise);
      setName('');
      setWeight('');
    }

    const num = (
      value: string,
      set: (v: string) => void,
      labelKey: string,
      width: number,
    ) => (
      <input
        className="c-input"
        type="number"
        min={1}
        value={value}
        aria-label={t(labelKey)}
        title={t(labelKey)}
        style={{ width, textAlign: 'right' }}
        onChange={(e) => set(e.target.value)}
      />
    );

    return (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        <input
          className="c-input"
          value={name}
          placeholder={t('tool.workout.log.exercisePlaceholder')}
          aria-label={t('tool.workout.log.exercisePlaceholder')}
          style={{ flex: 1, minWidth: 80 }}
          onChange={(e) => setName(e.target.value)}
        />
        {num(sets, setSets, 'tool.workout.log.sets', 52)}
        {num(reps, setReps, 'tool.workout.log.reps', 52)}
        <input
          className="c-input"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={weight}
          placeholder={unit}
          aria-label={t('tool.workout.log.weight', { unit })}
          title={t('tool.workout.log.weight', { unit })}
          style={{ width: 64, textAlign: 'right' }}
          onChange={(e) => setWeight(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addExercise();
          }}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.workout.log.addExercise')}
          title={t('tool.workout.log.addExercise')}
          style={{ flexShrink: 0 }}
          onClick={() => void addExercise()}
        >
          +
        </button>
      </div>
    );
  }

  /* ── Log variant ───────────────────────────────────────────────────── */

  function LogView({ sessions, unit }: { sessions: SessionDoc[]; unit: WeightUnit }) {
    const [kind, setKind] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);

    async function addSession() {
      const c = ctx;
      if (!c || !kind.trim()) return;
      const session = await logSessionIn(c.storage, kind, localDayKey());
      setKind('');
      setExpanded(session.id);
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
          <input
            className="c-input"
            value={kind}
            placeholder={t('tool.workout.log.kindPlaceholder')}
            aria-label={t('tool.workout.log.kindPlaceholder')}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => setKind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addSession();
            }}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.workout.log.addSession')}
            title={t('tool.workout.log.addSession')}
            style={{ flexShrink: 0 }}
            onClick={() => void addSession()}
          >
            +
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {sessions.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.workout.widget.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {sessions.map((session) => {
                const open = expanded === session.id;
                return (
                  <div key={session.id}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <button
                        className="c-btn c-btn--ghost"
                        aria-expanded={open}
                        aria-label={t('tool.workout.log.toggleSession', { kind: session.kind })}
                        style={{
                          flex: 1,
                          minWidth: 0,
                          display: 'flex',
                          gap: 'var(--space-2)',
                          justifyContent: 'flex-start',
                          padding: '0 var(--space-1)',
                        }}
                        onClick={() => setExpanded(open ? null : session.id)}
                      >
                        <span className="c-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                          {session.date}
                        </span>
                        <span
                          style={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {session.kind}
                        </span>
                        <span
                          className="c-muted"
                          style={{ marginLeft: 'auto', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}
                        >
                          {t('tool.workout.log.exerciseCount', { count: session.exercises.length })}
                        </span>
                      </button>
                      <button
                        className="c-btn c-btn--ghost"
                        aria-label={t('tool.workout.log.deleteSession', { kind: session.kind })}
                        title={t('tool.workout.log.deleteSession', { kind: session.kind })}
                        style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
                        onClick={() => void ctx?.storage.delete(session.id)}
                      >
                        ×
                      </button>
                    </div>
                    {open ? (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 'var(--space-1)',
                          padding: 'var(--space-1) 0 var(--space-2) var(--space-3)',
                          borderLeft: '2px solid var(--border-subtle)',
                          margin: 'var(--space-1) 0 var(--space-1) var(--space-1)',
                        }}
                      >
                        {session.exercises.map((ex, i) => (
                          <div
                            key={`${session.id}:${i}`}
                            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', fontSize: 13 }}
                          >
                            <span
                              style={{
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ex.name}
                            </span>
                            <span
                              className="c-muted"
                              style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                            >
                              {ex.sets} × {ex.reps}
                              {ex.weightKg !== undefined && ex.weightKg > 0
                                ? ` @ ${formatWeight(ex.weightKg, unit)}`
                                : ''}
                            </span>
                            <button
                              className="c-btn c-btn--ghost"
                              aria-label={t('tool.workout.log.deleteExercise', { name: ex.name })}
                              title={t('tool.workout.log.deleteExercise', { name: ex.name })}
                              style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
                              onClick={() => {
                                const c = ctx;
                                if (c) void removeExerciseIn(c.storage, session.id, i);
                              }}
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <ExerciseForm sessionId={session.id} unit={unit} />
                        <span className="c-muted" style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                          {t('tool.workout.log.sessionVolume', {
                            volume: Math.round(sessionVolume(session)),
                          })}
                        </span>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Weekly variant ────────────────────────────────────────────────── */

  function WeeklyView({ sessions }: { sessions: SessionDoc[] }) {
    const lang = ctx?.i18n.language ?? 'en';
    const today = localDayKey();
    const buckets = volumeByWeekday(sessions, today);
    const total = Math.round(weeklyVolume(sessions, today));
    const count = sessionsThisWeek(sessions, today).length;
    const max = Math.max(1, ...buckets);
    const barW = 100 / 7;
    // 2026-01-05 is a Monday – base for localized weekday initials.
    const dayLabel = (i: number) =>
      new Date(Date.UTC(2026, 0, 5 + i)).toLocaleDateString(lang, {
        weekday: 'narrow',
        timeZone: 'UTC',
      });

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-1)' }}>
        <div className="c-muted" style={{ fontSize: 12, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
          {t('tool.workout.weekly.title', { count, volume: total })}
        </div>
        <svg
          viewBox="0 0 100 40"
          preserveAspectRatio="none"
          role="img"
          aria-label={t('tool.workout.weekly.title', { count, volume: total })}
          style={{ flex: 1, minHeight: 0, width: '100%' }}
        >
          {buckets.map((volume, i) => {
            if (volume === 0) return null;
            const h = (volume / max) * 38;
            return (
              <rect
                key={i}
                x={i * barW + barW * 0.15}
                y={40 - h}
                width={barW * 0.7}
                height={h}
                rx={0.8}
                fill="var(--accent)"
              >
                <title>{`${dayLabel(i)}: ${Math.round(volume)}`}</title>
              </rect>
            );
          })}
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
          {buckets.map((_, i) => (
            <span key={i}>{dayLabel(i)}</span>
          ))}
        </div>
      </div>
    );
  }

  /* ── Records variant ───────────────────────────────────────────────── */

  function RecordsView({ sessions, unit }: { sessions: SessionDoc[]; unit: WeightUnit }) {
    const records = personalRecords(sessions);
    if (records.length === 0) {
      return (
        <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
          {t('tool.workout.records.empty')}
        </div>
      );
    }
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', height: '100%', overflowY: 'auto' }}>
        {records.map((r) => (
          <div key={r.name.toLowerCase()} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span aria-hidden="true" style={{ flexShrink: 0 }}>
              🏆
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
              {r.name}
            </span>
            <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--accent)', flexShrink: 0 }}>
              {formatWeight(r.weightKg, unit)}
            </span>
            <span className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {r.date}
            </span>
          </div>
        ))}
      </div>
    );
  }

  function WorkoutWidget(props: WidgetProps) {
    const { sessions, unit } = useWorkoutData();
    const [showSettings, setShowSettings] = useState(false);

    let body;
    switch (props.variant) {
      case 'weekly':
        body = <WeeklyView sessions={sessions} />;
        break;
      case 'records':
        body = <RecordsView sessions={sessions} unit={unit} />;
        break;
      case 'log':
      default:
        body = <LogView sessions={sessions} unit={unit} />;
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
            aria-label={t('tool.workout.widget.settingsToggle')}
            title={t('tool.workout.widget.settingsToggle')}
            aria-expanded={showSettings}
            style={{ position: 'absolute', bottom: 0, right: 0, padding: '0 var(--space-1)' }}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        </div>
        {showSettings ? (
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 'var(--space-2)',
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: 'var(--space-2)',
              flexShrink: 0,
            }}
          >
            <span className="c-muted" style={{ fontSize: '0.85em' }}>
              {t('tool.workout.settings.unit')}
            </span>
            <select
              className="c-input"
              value={unit}
              style={{ width: 'auto' }}
              onChange={(e) => void ctx?.settings.set('unit', e.target.value)}
            >
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </label>
        ) : null}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'workout.log',
        titleKey: 'tool.workout.command.log',
        descriptionKey: 'tool.workout.command.logDesc',
        icon: '🏋️',
        params: logSessionParamsSchema,
        selfTestParams: { kind: 'Cardo self-test', date: '2099-01-01' },
        async run(params): Promise<CommandResult> {
          if (!params.kind.trim()) {
            return { ok: false, messageKey: 'tool.workout.msg.invalidKind' };
          }
          const date = params.date ?? localDayKey();
          if (!isValidDate(date)) {
            return { ok: false, messageKey: 'tool.workout.msg.invalidDate' };
          }
          const session = await logSessionIn(context.storage, params.kind, date);
          return {
            ok: true,
            data: { sessionId: session.id, date: session.date },
            messageKey: 'tool.workout.msg.logged',
          };
        },
      });

      context.commands.register({
        id: 'workout.context',
        titleKey: 'tool.workout.command.context',
        descriptionKey: 'tool.workout.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [sessions, unit] = await Promise.all([
            querySessionsIn(context.storage),
            loadUnit(),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildWorkoutContext(
                sessions,
                context.i18n.language,
                localDayKey(),
                unit,
              ),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: WorkoutWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const session = await logSessionIn(testCtx.storage, 'selftest push', '2026-02-03');
          try {
            const afterCreate = await testCtx.storage.get<SessionDoc>(session.id);
            const withExercise = await addExerciseIn(testCtx.storage, session.id, {
              name: 'Bench',
              sets: 3,
              reps: 8,
              weightKg: 60,
            });
            const reloaded = await testCtx.storage.get<SessionDoc>(session.id);
            if (
              !afterCreate ||
              afterCreate.kind !== 'selftest push' ||
              afterCreate.exercises.length !== 0 ||
              !withExercise ||
              reloaded?.exercises.length !== 1 ||
              reloaded.exercises[0]?.weightKg !== 60
            ) {
              return { status: 'fail', detail: `bad roundtrip: ${JSON.stringify(reloaded)}` };
            }
            await testCtx.storage.delete(session.id);
            const gone = await testCtx.storage.get<SessionDoc>(session.id);
            if (gone !== null) {
              return { status: 'fail', detail: 'session still present after delete' };
            }
            // Graceful not-found: appending to a deleted session must not throw.
            const orphan = await addExerciseIn(testCtx.storage, session.id, {
              name: 'X',
              sets: 1,
              reps: 1,
            });
            if (orphan !== null) {
              return { status: 'fail', detail: 'addExercise resurrected a deleted session' };
            }
            return { status: 'pass', detail: 'create → add exercise → delete roundtrip ok' };
          } finally {
            await testCtx.storage.delete(session.id);
          }
        }
        case 'volume-math': {
          // 2026-02-03 is a Tuesday; its ISO week is 2026-02-02 … 2026-02-08.
          const inWeek = await logSessionIn(testCtx.storage, 'selftest volume', '2026-02-03');
          const outOfWeek = await logSessionIn(testCtx.storage, 'selftest volume', '2026-02-01');
          try {
            await addExerciseIn(testCtx.storage, inWeek.id, {
              name: 'Squat',
              sets: 3,
              reps: 5,
              weightKg: 100,
            }); // 1500
            await addExerciseIn(testCtx.storage, inWeek.id, { name: 'Pull-up', sets: 4, reps: 10 }); // 40
            await addExerciseIn(testCtx.storage, outOfWeek.id, {
              name: 'Squat',
              sets: 1,
              reps: 1,
              weightKg: 999,
            });
            const all = await querySessionsIn(testCtx.storage);
            const mine = all.filter((s) => s.kind === 'selftest volume');
            const week = weeklyVolume(mine, '2026-02-03');
            const stored = mine.find((s) => s.id === inWeek.id);
            const single = stored ? sessionVolume(stored) : -1;
            if (single !== 1540 || week !== 1540) {
              return {
                status: 'fail',
                detail: `expected session 1540 / week 1540, got ${single} / ${week}`,
              };
            }
            return { status: 'pass', detail: 'volume 1540 (incl. bodyweight), week window ok' };
          } finally {
            await testCtx.storage.delete(inWeek.id);
            await testCtx.storage.delete(outOfWeek.id);
          }
        }
        case 'render':
          return typeof WorkoutWidget === 'function' && WorkoutWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
