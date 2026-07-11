import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, CommandResult, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  dayDocId,
  elapsedSeconds,
  formatDuration,
  localDateKey,
  type DayDoc,
} from './workclock';

/* Typed cross-tool events (declaration merging, see plugin-api CardoEvents). */
declare module '@cardo/plugin-api' {
  interface CardoEvents {
    'workclock:started': { date: string };
    'workclock:session-ended': { date: string; seconds: number };
  }
}

const WEEK_DAYS = 7;
const DAY_MS = 86_400_000;

/** Workclock – tracks productive time per day. Fully local, one doc per day. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  /** Module-level translator – widget and commands share the host i18n. */
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Core actions ─────────────────────────────────────────────────────
   * All take the context as a parameter so self-tests can run the exact
   * same code paths against the scratch database (testCtx).            */

  async function readDay(c: ToolContext, dateKey: string): Promise<DayDoc | null> {
    return c.storage.get<DayDoc>(dayDocId(dateKey));
  }

  /** The currently running day doc, if any (query returns bodies without ids – the id is stored inside the doc). */
  async function findRunning(c: ToolContext): Promise<DayDoc | null> {
    const docs = await c.storage.query<DayDoc>({
      orderBy: 'date',
      direction: 'desc',
      limit: 31,
    });
    return (
      docs.find((d) => typeof d.runningSince === 'string' && d.runningSince.length > 0) ?? null
    );
  }

  async function start(c: ToolContext, now = new Date()): Promise<CommandResult> {
    if (await findRunning(c)) {
      return { ok: true, messageKey: 'tool.workclock.msg.alreadyRunning' };
    }
    const dateKey = localDateKey(now);
    const existing = await readDay(c, dateKey);
    const doc: DayDoc = {
      id: dayDocId(dateKey),
      date: dateKey,
      seconds: existing?.seconds ?? 0,
      runningSince: now.toISOString(), // persisted → a running clock survives restarts
    };
    await c.storage.set(doc.id, doc);
    c.events.emit('workclock:started', { date: dateKey });
    return { ok: true, data: { date: dateKey } };
  }

  async function stop(c: ToolContext, now = new Date()): Promise<CommandResult> {
    const running = await findRunning(c);
    if (!running || typeof running.runningSince !== 'string') {
      return { ok: true, messageKey: 'tool.workclock.msg.notRunning' };
    }
    const sessionSeconds = elapsedSeconds(running.runningSince, now);
    // Midnight edge: if the session crossed midnight (runningSince day ≠ today),
    // the WHOLE elapsed time is credited to the day the session STARTED
    // (running.date). Deliberately simple – no splitting across days.
    const updated: DayDoc = {
      ...running,
      seconds: running.seconds + sessionSeconds,
      runningSince: null,
    };
    await c.storage.set(updated.id, updated);
    c.events.emit('workclock:session-ended', { date: running.date, seconds: sessionSeconds });
    return { ok: true, data: { date: running.date, seconds: sessionSeconds } };
  }

  async function toggle(c: ToolContext): Promise<CommandResult> {
    return (await findRunning(c)) ? stop(c) : start(c);
  }

  /* ── Widget ──────────────────────────────────────────────────────────── */

  function WorkclockWidget(_props: WidgetProps) {
    const [docs, setDocs] = useState<DayDoc[] | null>(null);
    const [nowMs, setNowMs] = useState(() => Date.now());

    const reload = useCallback(() => {
      const since = localDateKey(new Date(Date.now() - (WEEK_DAYS - 1) * DAY_MS));
      ctx?.storage
        .query<DayDoc>({
          where: [{ field: 'date', op: '>=', value: since }],
          orderBy: 'date',
          direction: 'desc',
          limit: WEEK_DAYS,
        })
        .then((result) => {
          setDocs(result);
          setNowMs(Date.now());
        });
    }, []);

    useEffect(() => {
      reload();
      const unsub = ctx?.storage.subscribe(() => reload());
      return () => unsub?.();
    }, [reload]);

    const runningDoc =
      docs?.find((d) => typeof d.runningSince === 'string' && d.runningSince.length > 0) ?? null;
    const isRunning = runningDoc !== null;

    // Tick once per second – but only while the clock is running.
    useEffect(() => {
      if (!isRunning) return;
      const id = window.setInterval(() => setNowMs(Date.now()), 1000);
      return () => window.clearInterval(id);
    }, [isRunning]);

    const todayKey = localDateKey(new Date(nowMs));
    const liveSeconds =
      runningDoc && typeof runningDoc.runningSince === 'string'
        ? elapsedSeconds(runningDoc.runningSince, new Date(nowMs))
        : 0;
    // Running total for today = completed seconds + live session time.
    // (An overnight session shows here too, but is credited to its start day on stop.)
    const todaySeconds = (docs?.find((d) => d.date === todayKey)?.seconds ?? 0) + liveSeconds;
    const weekSeconds = (docs ?? []).reduce((sum, d) => sum + d.seconds, 0) + liveSeconds;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-3)',
          padding: 'var(--space-3)',
        }}
      >
        <div
          style={{
            fontSize: '2.4em',
            fontVariantNumeric: 'tabular-nums',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {docs === null ? '…' : formatDuration(todaySeconds)}
        </div>
        <div
          style={{
            fontSize: '0.85em',
            color: isRunning ? 'var(--success)' : 'var(--text-muted)',
          }}
        >
          {isRunning ? t('tool.workclock.state.running') : t('tool.workclock.state.paused')}
        </div>
        <button
          className={isRunning ? 'c-btn' : 'c-btn c-btn--primary'}
          disabled={docs === null}
          onClick={async () => {
            if (!ctx) return;
            if (isRunning) await stop(ctx);
            else await start(ctx);
          }}
        >
          {isRunning ? t('tool.workclock.action.stop') : t('tool.workclock.action.start')}
        </button>
        <div className="c-muted" style={{ fontSize: '0.8em' }}>
          {t('tool.workclock.week', { duration: formatDuration(weekSeconds) })}
        </div>
      </div>
    );
  }

  /* ── Tool object ─────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
      context.commands.register({
        id: 'workclock.start',
        titleKey: 'tool.workclock.command.start',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          return ctx ? start(ctx) : { ok: false };
        },
      });
      context.commands.register({
        id: 'workclock.stop',
        titleKey: 'tool.workclock.command.stop',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          return ctx ? stop(ctx) : { ok: false };
        },
      });
      context.commands.register({
        id: 'workclock.toggle',
        titleKey: 'tool.workclock.command.toggle',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          return ctx ? toggle(ctx) : { ok: false };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: WorkclockWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'day-roundtrip': {
          const probe: DayDoc = {
            id: dayDocId('2000-01-01'),
            date: '2000-01-01',
            seconds: 123,
            runningSince: null,
          };
          await testCtx.storage.set(probe.id, probe);
          const roundtrip = await testCtx.storage.get<DayDoc>(probe.id);
          await testCtx.storage.delete(probe.id);
          const gone = await testCtx.storage.get<DayDoc>(probe.id);
          if (roundtrip?.date !== probe.date || roundtrip.seconds !== probe.seconds) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
          }
          if (gone !== null) {
            return { status: 'fail', detail: 'day doc still present after delete' };
          }
          return { status: 'pass' };
        }
        case 'start-stop': {
          // A previous command self-test may have left the scratch clock running.
          await stop(testCtx);
          const now = new Date();
          const dateKey = localDateKey(now);
          const startRes = await start(testCtx, now);
          const afterStart = await readDay(testCtx, dateKey);
          if (!startRes.ok || typeof afterStart?.runningSince !== 'string') {
            return { status: 'fail', detail: 'start did not persist runningSince' };
          }
          const stopRes = await stop(testCtx);
          const afterStop = await readDay(testCtx, dateKey);
          if (!stopRes.ok || !afterStop) {
            return { status: 'fail', detail: 'stop failed or day doc missing' };
          }
          if (afterStop.runningSince != null) {
            return { status: 'fail', detail: 'runningSince not cleared after stop' };
          }
          if (typeof afterStop.seconds !== 'number' || afterStop.seconds < afterStart.seconds) {
            return { status: 'fail', detail: `unexpected seconds: ${afterStop.seconds}` };
          }
          return { status: 'pass', detail: `accumulated ${afterStop.seconds}s` };
        }
        case 'format': {
          const checks: Array<[number, string]> = [
            [0, '00:00'],
            [59, '00:59'],
            [61, '01:01'],
            [3599, '59:59'],
            [3600, '1:00:00'],
            [45296, '12:34:56'],
          ];
          for (const [input, expected] of checks) {
            const actual = formatDuration(input);
            if (actual !== expected) {
              return {
                status: 'fail',
                detail: `formatDuration(${input}) = "${actual}", expected "${expected}"`,
              };
            }
          }
          const key = localDateKey(new Date(2026, 6, 11, 12, 0, 0));
          if (key !== '2026-07-11') {
            return { status: 'fail', detail: `localDateKey returned "${key}"` };
          }
          return { status: 'pass' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
