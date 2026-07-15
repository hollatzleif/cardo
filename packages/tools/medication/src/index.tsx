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
  adherence,
  buildMedicationContext,
  doseKey,
  intakeKey,
  isDoseTaken,
  localDateKey,
  nextOccurrence,
  parseTimes,
  type IntakeDoc,
  type MedDoc,
} from './logic';

/**
 * Medication – meds with reminders and a daily tick-off list, fully local.
 * Reminders reuse the persistent scheduler like the alarm tool does:
 * `medication.remind` notifies AND schedules its own next occurrence; the
 * schedule handles live on the med doc and every activate() re-arms meds
 * whose handles are gone from the scheduler (in-memory scheduler restart).
 */

function makeId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? `med:${crypto.randomUUID()}`
    : `med:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryMedsIn(storage: ToolStorage): Promise<MedDoc[]> {
  const meds = await storage.query<MedDoc>({ where: [{ field: 'type', op: '=', value: 'med' }] });
  return [...meds].sort((a, b) => a.name.localeCompare(b.name));
}

async function addMedIn(
  storage: ToolStorage,
  input: { name: string; dose: string; times: string[] },
  now: Date = new Date(),
): Promise<MedDoc> {
  const med: MedDoc = {
    id: makeId(),
    type: 'med',
    name: input.name.trim(),
    dose: input.dose.trim(),
    times: input.times,
    createdAt: now.toISOString(),
  };
  await storage.set<MedDoc>(med.id, med);
  return med;
}

async function getIntakeIn(storage: ToolStorage, date: string): Promise<IntakeDoc> {
  const doc = await storage.get<IntakeDoc>(intakeKey(date));
  return doc ?? { id: intakeKey(date), type: 'intake', date, taken: {} };
}

async function markDoseIn(
  storage: ToolStorage,
  date: string,
  medId: string,
  time: string,
  taken: boolean,
): Promise<IntakeDoc> {
  const intake = await getIntakeIn(storage, date);
  const next: IntakeDoc = { ...intake, taken: { ...intake.taken, [doseKey(medId, time)]: taken } };
  await storage.set<IntakeDoc>(next.id, next);
  return next;
}

async function queryIntakesIn(storage: ToolStorage): Promise<IntakeDoc[]> {
  return storage.query<IntakeDoc>({ where: [{ field: 'type', op: '=', value: 'intake' }] });
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Scheduler reuse (the alarm pattern) ─────────────────────────── */

  /** Schedule the next reminder for this med and persist the handle on the doc. */
  async function armMed(c: ToolContext, med: MedDoc): Promise<MedDoc> {
    const when = nextOccurrence(med.times, new Date());
    let scheduleIds: string[] | undefined;
    if (when) {
      try {
        scheduleIds = [await c.scheduler.scheduleAt(when, 'medication.remind', { medId: med.id })];
      } catch {
        scheduleIds = undefined; // scheduler unavailable – re-armed on next activate
      }
    }
    const armed: MedDoc = { ...med, scheduleIds };
    await c.storage.set<MedDoc>(med.id, armed);
    return armed;
  }

  async function cancelMedSchedules(c: ToolContext, med: MedDoc): Promise<void> {
    for (const scheduleId of med.scheduleIds ?? []) {
      try {
        await c.scheduler.cancel(scheduleId);
      } catch {
        /* schedule already fired or gone – nothing to cancel */
      }
    }
  }

  async function removeMed(med: MedDoc): Promise<void> {
    const c = ctx;
    if (!c) return;
    await cancelMedSchedules(c, med);
    await c.storage.delete(med.id);
  }

  /* ── Widget ──────────────────────────────────────────────────────── */

  function AddForm() {
    const [name, setName] = useState('');
    const [dose, setDose] = useState('');
    const [timesText, setTimesText] = useState('08:00');

    const add = async () => {
      const c = ctx;
      const times = parseTimes(timesText);
      if (!c || !name.trim() || !times) return;
      const med = await addMedIn(c.storage, { name, dose, times });
      await armMed(c, med);
      setName('');
      setDose('');
    };

    return (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          className="c-input"
          value={name}
          placeholder={t('tool.medication.widget.namePlaceholder')}
          aria-label={t('tool.medication.widget.namePlaceholder')}
          style={{ flex: 2, minWidth: 72 }}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <input
          className="c-input"
          value={dose}
          placeholder={t('tool.medication.widget.dosePlaceholder')}
          aria-label={t('tool.medication.widget.dosePlaceholder')}
          style={{ flex: 1, minWidth: 56 }}
          onChange={(e) => setDose(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <input
          className="c-input"
          value={timesText}
          placeholder={t('tool.medication.widget.timesPlaceholder')}
          aria-label={t('tool.medication.widget.timesPlaceholder')}
          title={t('tool.medication.widget.timesHint')}
          style={{ flex: 1, minWidth: 72 }}
          onChange={(e) => setTimesText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.medication.widget.add')}
          title={t('tool.medication.widget.add')}
          style={{ flexShrink: 0 }}
          onClick={() => void add()}
        >
          +
        </button>
      </div>
    );
  }

  function MedicationWidget(props: WidgetProps) {
    const [meds, setMeds] = useState<MedDoc[]>([]);
    const [intakes, setIntakes] = useState<IntakeDoc[]>([]);
    const [rangeDays, setRangeDays] = useState<7 | 30>(7);
    const [today, setToday] = useState(() => localDateKey(new Date()));

    // Roll over to the new day at local midnight without a restart.
    useEffect(() => {
      const timer = window.setInterval(() => {
        const key = localDateKey(new Date());
        setToday((prev) => (prev === key ? prev : key));
      }, 30_000);
      return () => window.clearInterval(timer);
    }, []);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [medList, intakeList] = await Promise.all([
        queryMedsIn(c.storage),
        queryIntakesIn(c.storage),
      ]);
      setMeds(medList);
      setIntakes(intakeList);
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsub = ctx?.storage.subscribe(safeReload);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [reload]);

    const todayIntake = intakes.find((i) => i.date === today) ?? null;

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.medication.widget.empty')}
      </div>
    );

    let body: ReactNode;
    if (props.variant === 'schedule') {
      body =
        meds.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {meds.map((med) => (
              <div
                key={med.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
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
                  {med.name}
                  <span className="c-muted" style={{ fontSize: 12 }}>
                    {' '}
                    · {med.dose}
                  </span>
                </span>
                <span
                  className="c-muted"
                  style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                >
                  {med.times.join(' · ')}
                </span>
                <button
                  className="c-btn c-btn--ghost"
                  aria-label={t('tool.medication.widget.delete', { name: med.name })}
                  title={t('tool.medication.widget.delete', { name: med.name })}
                  style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
                  onClick={() => void removeMed(med)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        );
    } else if (props.variant === 'adherence') {
      const percent = adherence(intakes, meds, rangeDays, today);
      const radius = 44;
      const circumference = 2 * Math.PI * radius;
      const filled = percent === null ? 0 : (percent / 100) * circumference;
      body = (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          <svg
            viewBox="0 0 100 100"
            role="img"
            aria-label={t('tool.medication.widget.adherenceLabel', {
              percent: percent ?? '–',
              days: rangeDays,
            })}
            style={{ width: '100%', maxWidth: 140 }}
          >
            <circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke="var(--border-subtle)"
              strokeWidth="8"
            />
            <circle
              cx="50"
              cy="50"
              r={radius}
              fill="none"
              stroke="var(--success)"
              strokeWidth="8"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circumference - filled}`}
              transform="rotate(-90 50 50)"
            />
            <text
              x="50"
              y="55"
              textAnchor="middle"
              style={{ fill: 'var(--text-primary)', fontSize: 20, fontWeight: 600 }}
            >
              {percent === null ? '–' : `${percent}%`}
            </text>
          </svg>
          <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
            {([7, 30] as const).map((d) => (
              <button
                key={d}
                className={rangeDays === d ? 'c-btn c-btn--primary' : 'c-btn c-btn--ghost'}
                style={{ fontSize: '0.8em' }}
                aria-pressed={rangeDays === d}
                onClick={() => setRangeDays(d)}
              >
                {t('tool.medication.widget.days', { days: d })}
              </button>
            ))}
          </div>
          {percent === null ? (
            <span className="c-muted" style={{ fontSize: '0.8em', textAlign: 'center' }}>
              {t('tool.medication.widget.noData')}
            </span>
          ) : null}
        </div>
      );
    } else {
      // today (default): checklist of today's doses
      const doses = meds
        .flatMap((med) => med.times.map((time) => ({ med, time })))
        .sort((a, b) => a.time.localeCompare(b.time) || a.med.name.localeCompare(b.med.name));
      body =
        doses.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {doses.map(({ med, time }) => {
              const taken = isDoseTaken(todayIntake, med.id, time);
              return (
                <label
                  key={doseKey(med.id, time)}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                >
                  <input
                    type="checkbox"
                    checked={taken}
                    style={{ accentColor: 'var(--success)' }}
                    aria-label={t('tool.medication.widget.markTaken', {
                      name: med.name,
                      time,
                    })}
                    onChange={() => {
                      const c = ctx;
                      if (c) void markDoseIn(c.storage, today, med.id, time, !taken);
                    }}
                  />
                  <span
                    style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                    className={taken ? 'c-muted' : undefined}
                  >
                    {time}
                  </span>
                  <span
                    className={taken ? 'c-muted' : undefined}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      textDecoration: taken ? 'line-through' : 'none',
                    }}
                  >
                    {med.name}
                    <span className="c-muted" style={{ fontSize: 12 }}>
                      {' '}
                      · {med.dose}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        );
    }

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
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
        {props.variant !== 'adherence' ? <AddForm /> : null}
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'medication.add',
        titleKey: 'tool.medication.command.add',
        descriptionKey: 'tool.medication.command.addDesc',
        icon: '💊',
        params: z.object({
          name: z.string().min(1),
          dose: z.string().min(1),
          /** Comma-separated "HH:MM" list, e.g. "08:00, 20:00". */
          times: z.string().min(1),
        }),
        selfTestParams: { name: 'Cardo self-test med', dose: '1 Tablette', times: '08:00, 20:00' },
        async run(params): Promise<CommandResult> {
          const times = parseTimes(params.times);
          if (!times) return { ok: false, messageKey: 'tool.medication.msg.invalidTimes' };
          const med = await addMedIn(context.storage, { ...params, times });
          const armed = await armMed(context, med);
          return { ok: true, data: armed, messageKey: 'tool.medication.msg.added' };
        },
      });

      context.commands.register({
        id: 'medication.taken',
        titleKey: 'tool.medication.command.taken',
        descriptionKey: 'tool.medication.command.takenDesc',
        palette: false,
        assistant: true,
        params: z.object({
          /** Med id or (case-insensitive) name. */
          med: z.string().min(1),
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
        }),
        // Runs against the scratch DB where the med never exists → graceful no-op.
        selfTestParams: { med: 'med:selftest-nonexistent' },
        async run({ med, time }): Promise<CommandResult> {
          const meds = await queryMedsIn(context.storage);
          const target =
            meds.find((m) => m.id === med) ??
            meds.find((m) => m.name.toLocaleLowerCase() === med.trim().toLocaleLowerCase());
          if (!target) return { ok: true, messageKey: 'tool.medication.msg.notFound' };
          const today = localDateKey(new Date());
          const intake = await getIntakeIn(context.storage, today);
          const chosen = time ?? target.times.find((tm) => !isDoseTaken(intake, target.id, tm));
          if (!chosen) return { ok: true, messageKey: 'tool.medication.msg.allTaken' };
          await markDoseIn(context.storage, today, target.id, chosen, true);
          return {
            ok: true,
            data: { medId: target.id, time: chosen },
            messageKey: 'tool.medication.msg.taken',
          };
        },
      });

      context.commands.register({
        id: 'medication.remind',
        titleKey: 'tool.medication.command.remind',
        descriptionKey: 'tool.medication.command.remindDesc',
        palette: false,
        params: z.object({ medId: z.string().min(1) }),
        // Probe id never exists in the scratch DB → graceful no-op.
        selfTestParams: { medId: 'med:selftest-nonexistent' },
        async run({ medId }): Promise<CommandResult> {
          try {
            const med = await context.storage.get<MedDoc>(medId);
            // Deleted before it fired – a normal outcome, not a failure.
            if (!med) return { ok: true, messageKey: 'tool.medication.msg.notFound' };
            await context.notifications.notify({
              titleKey: 'tool.medication.notification.title',
              bodyKey: 'tool.medication.notification.body',
              vars: { name: med.name, dose: med.dose },
            });
            // Self-chain: schedule the next occurrence (like alarm.ring).
            await armMed(context, med);
            return { ok: true, messageKey: 'tool.medication.msg.reminded' };
          } catch {
            return { ok: false, messageKey: 'tool.medication.msg.failed' };
          }
        },
      });

      context.commands.register({
        id: 'medication.context',
        titleKey: 'tool.medication.command.context',
        descriptionKey: 'tool.medication.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const meds = await queryMedsIn(context.storage);
          const todayIntake = await context.storage.get<IntakeDoc>(
            intakeKey(localDateKey(new Date())),
          );
          return {
            ok: true,
            data: {
              contextText: buildMedicationContext(meds, todayIntake, context.i18n.language),
            },
          };
        },
      });

      // Re-arm every med whose schedule handles are gone (the persistent
      // scheduler may have fired them while the app was closed, or an
      // in-memory scheduler lost them on restart).
      void (async () => {
        const [meds, pending] = await Promise.all([
          queryMedsIn(context.storage),
          context.scheduler.list(),
        ]);
        const alive = new Set(pending.map((p) => p.id));
        for (const med of meds) {
          const stillArmed = (med.scheduleIds ?? []).some((id) => alive.has(id));
          if (!stillArmed && med.times.length > 0) await armMed(context, med);
        }
      })().catch(() => {
        /* storage/scheduler not ready – the next remind() run re-arms */
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: MedicationWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const med = await addMedIn(testCtx.storage, {
            name: 'selftest med',
            dose: '400 mg',
            times: ['08:00', '20:00'],
          });
          const back = await testCtx.storage.get<MedDoc>(med.id);
          await testCtx.storage.delete(med.id);
          const gone = await testCtx.storage.get<MedDoc>(med.id);
          if (
            back?.name !== 'selftest med' ||
            back.dose !== '400 mg' ||
            back.times.join(',') !== '08:00,20:00'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'med still present after delete' };
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'next-occurrence': {
          const ahead = nextOccurrence(['08:00', '20:00'], new Date(2026, 0, 15, 9, 30, 0));
          if (!ahead || ahead.getHours() !== 20 || ahead.getDate() !== 15) {
            return { status: 'fail', detail: `expected today 20:00, got ${ahead?.toISOString()}` };
          }
          const tomorrow = nextOccurrence(['08:00', '20:00'], new Date(2026, 0, 15, 21, 0, 0));
          if (!tomorrow || tomorrow.getHours() !== 8 || tomorrow.getDate() !== 16) {
            return {
              status: 'fail',
              detail: `expected tomorrow 08:00, got ${tomorrow?.toISOString()}`,
            };
          }
          const yearEnd = nextOccurrence(['06:00'], new Date(2026, 11, 31, 23, 59, 0));
          if (!yearEnd || localDateKey(yearEnd) !== '2027-01-01') {
            return { status: 'fail', detail: `midnight rollover broken: ${yearEnd?.toISOString()}` };
          }
          if (nextOccurrence([], new Date()) !== null) {
            return { status: 'fail', detail: 'empty times should yield null' };
          }
          return { status: 'pass', detail: 'today / tomorrow / year-end / empty checks ok' };
        }
        case 'adherence-math': {
          // Logic through storage: one med, two days, 3 of 4 doses taken.
          const med = await addMedIn(
            testCtx.storage,
            { name: 'selftest adherence', dose: '1', times: ['08:00', '20:00'] },
            new Date(2026, 0, 10, 8, 0, 0),
          );
          const d1 = '2026-01-14';
          const d2 = '2026-01-15';
          await markDoseIn(testCtx.storage, d1, med.id, '08:00', true);
          await markDoseIn(testCtx.storage, d1, med.id, '20:00', true);
          await markDoseIn(testCtx.storage, d2, med.id, '08:00', true);
          const storedMed = await testCtx.storage.get<MedDoc>(med.id);
          const storedIntakes = (await queryIntakesIn(testCtx.storage)).filter(
            (i) => i.date === d1 || i.date === d2,
          );
          await testCtx.storage.delete(med.id);
          await testCtx.storage.delete(intakeKey(d1));
          await testCtx.storage.delete(intakeKey(d2));
          if (!storedMed) return { status: 'fail', detail: 'med doc missing from scratch storage' };
          const percent = adherence(storedIntakes, [storedMed], 2, d2);
          if (percent !== 75) {
            return { status: 'fail', detail: `expected 75% (3 of 4 doses), got ${percent}` };
          }
          return { status: 'pass', detail: '3 of 4 doses over 2 days = 75%' };
        }
        case 'render':
          return typeof MedicationWidget === 'function' && MedicationWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
