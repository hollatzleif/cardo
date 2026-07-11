import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { nextOccurrence } from './alarm';

type AlarmDoc = {
  /** Stored inside the doc – query() returns bodies without ids. */
  id: string;
  /** Wall-clock time "HH:MM" (local). */
  time: string;
  message: string;
  enabled: boolean;
  /** Scheduler handle of the pending ring, if armed. */
  scheduleId?: string;
  createdAt: string;
};

function makeId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `alarm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Short Web Audio chime. Silent no-op where Web Audio is unavailable. */
function playChime(): void {
  if (typeof AudioContext === 'undefined') return;
  try {
    const audio = new AudioContext();
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audio.currentTime);
    osc.frequency.setValueAtTime(660, audio.currentTime + 0.35);
    osc.frequency.setValueAtTime(880, audio.currentTime + 0.7);
    gain.gain.setValueAtTime(0.001, audio.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.3, audio.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 1.4);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start();
    osc.stop(audio.currentTime + 1.5);
    osc.onended = () => void audio.close();
  } catch {
    /* audio output unavailable – the notification alone still fires */
  }
}

/** Alarm clock – notifications + chime at a wall-clock time, fully local. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function listAlarms(): Promise<AlarmDoc[]> {
    return (await ctx?.storage.query<AlarmDoc>({ orderBy: 'time', direction: 'asc' })) ?? [];
  }

  /** Schedule the next ring and persist the schedule handle. */
  async function armAlarm(c: ToolContext, alarm: AlarmDoc): Promise<AlarmDoc> {
    let scheduleId: string | undefined;
    try {
      scheduleId = await c.scheduler.scheduleAt(
        nextOccurrence(alarm.time, new Date()),
        'alarm.ring',
        { id: alarm.id },
      );
    } catch {
      scheduleId = undefined; // scheduler unavailable – alarm stays stored, re-armed on next activate
    }
    const armed: AlarmDoc = { ...alarm, enabled: true, scheduleId };
    await c.storage.set<AlarmDoc>(alarm.id, armed);
    return armed;
  }

  async function cancelSchedule(c: ToolContext, alarm: AlarmDoc): Promise<void> {
    if (!alarm.scheduleId) return;
    try {
      await c.scheduler.cancel(alarm.scheduleId);
    } catch {
      /* schedule already gone (in-memory scheduler after restart) */
    }
  }

  async function createAlarm(time: string, message: string): Promise<AlarmDoc | null> {
    const c = ctx;
    if (!c) return null;
    const alarm: AlarmDoc = {
      id: makeId(),
      time,
      message,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    return armAlarm(c, alarm);
  }

  async function toggleAlarm(alarm: AlarmDoc): Promise<void> {
    const c = ctx;
    if (!c) return;
    if (alarm.enabled) {
      await cancelSchedule(c, alarm);
      await c.storage.set<AlarmDoc>(alarm.id, { ...alarm, enabled: false, scheduleId: undefined });
    } else {
      await armAlarm(c, alarm);
    }
  }

  async function removeAlarm(alarm: AlarmDoc): Promise<void> {
    const c = ctx;
    if (!c) return;
    await cancelSchedule(c, alarm);
    await c.storage.delete(alarm.id);
  }

  function AlarmWidget(_props: WidgetProps) {
    const [alarms, setAlarms] = useState<AlarmDoc[] | null>(null);
    const [time, setTime] = useState('07:00');
    const [message, setMessage] = useState('');

    useEffect(() => {
      let mounted = true;
      const load = () => {
        void listAlarms().then((list) => {
          if (mounted) setAlarms(list);
        });
      };
      load();
      const unsub = ctx?.storage.subscribe(load);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);

    const add = async () => {
      if (!time) return;
      await createAlarm(time, message.trim() || t('tool.alarm.defaultMessage'));
      setMessage('');
    };

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-2)',
        }}
      >
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          {alarms === null ? (
            <div className="c-muted">…</div>
          ) : alarms.length === 0 ? (
            <div className="c-muted">{t('tool.alarm.empty')}</div>
          ) : (
            alarms.map((alarm) => (
              <div
                key={alarm.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
              >
                <input
                  type="checkbox"
                  checked={alarm.enabled}
                  onChange={() => void toggleAlarm(alarm)}
                  aria-label={t('tool.alarm.toggle')}
                  title={t('tool.alarm.toggle')}
                  style={{ accentColor: 'var(--accent)' }}
                />
                <span
                  style={{
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 600,
                    color: alarm.enabled ? 'var(--text-primary)' : 'var(--text-muted)',
                  }}
                >
                  {alarm.time}
                </span>
                <span
                  className={alarm.enabled ? undefined : 'c-muted'}
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {alarm.message}
                </span>
                <button
                  className="c-btn c-btn--ghost"
                  style={{ color: 'var(--danger)', padding: 'var(--space-1) var(--space-2)' }}
                  onClick={() => void removeAlarm(alarm)}
                  aria-label={t('tool.alarm.delete')}
                  title={t('tool.alarm.delete')}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          <input
            type="time"
            className="c-input"
            style={{ width: 'auto', flexShrink: 0 }}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label={t('tool.alarm.name')}
          />
          <input
            className="c-input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder={t('tool.alarm.messagePlaceholder')}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
          <button className="c-btn c-btn--primary" onClick={() => void add()}>
            {t('tool.alarm.add')}
          </button>
        </div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;

      context.commands.register({
        id: 'alarm.set',
        titleKey: 'tool.alarm.command.set',
        params: z.object({
          time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
          message: z.string().min(1),
        }),
        selfTestParams: { time: '07:00', message: 'probe' },
        async run({ time, message }) {
          const alarm = await createAlarm(time, message);
          return alarm
            ? { ok: true, messageKey: 'tool.alarm.msg.created', data: alarm.id }
            : { ok: false, messageKey: 'tool.alarm.msg.failed' };
        },
      });

      context.commands.register({
        id: 'alarm.ring',
        titleKey: 'tool.alarm.command.ring',
        palette: false,
        params: z.object({ id: z.string().min(1) }),
        selfTestParams: { id: 'nonexistent' },
        async run({ id }) {
          try {
            const c = ctx;
            if (!c) return { ok: false, messageKey: 'tool.alarm.msg.notFound' };
            const alarm = await c.storage.get<AlarmDoc>(id);
            // Deleted/disabled before it rang – a normal outcome, not a
            // command failure (diagnose executes this with a probe id).
            if (!alarm || !alarm.enabled) {
              return { ok: true, messageKey: 'tool.alarm.msg.notFound' };
            }
            await c.notifications.notify({
              titleKey: 'tool.alarm.notification.title',
              bodyKey: 'tool.alarm.notification.body',
              vars: { message: alarm.message, time: alarm.time },
            });
            playChime();
            // Still enabled → re-arm for the next day.
            await armAlarm(c, alarm);
            return { ok: true, messageKey: 'tool.alarm.msg.rang' };
          } catch {
            return { ok: false, messageKey: 'tool.alarm.msg.failed' };
          }
        },
      });

      // The scheduler is an in-memory MVP: re-arm every enabled alarm on activate.
      void (async () => {
        const alarms = await context.storage.query<AlarmDoc>();
        for (const alarm of alarms) {
          if (!alarm.enabled) continue;
          await cancelSchedule(context, alarm);
          await armAlarm(context, alarm);
        }
      })().catch(() => {
        /* storage not ready – widget load will surface the state */
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: AlarmWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'storage-roundtrip': {
          const probe: AlarmDoc = {
            id: 'selftest-alarm',
            time: '07:00',
            message: 'probe',
            enabled: true,
            createdAt: new Date().toISOString(),
          };
          await testCtx.storage.set<AlarmDoc>(probe.id, probe);
          const roundtrip = await testCtx.storage.get<AlarmDoc>(probe.id);
          await testCtx.storage.delete(probe.id);
          const afterDelete = await testCtx.storage.get<AlarmDoc>(probe.id);
          if (roundtrip?.time !== '07:00' || roundtrip.message !== 'probe') {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
          }
          if (afterDelete !== null) {
            return { status: 'fail', detail: 'doc still present after delete' };
          }
          return { status: 'pass' };
        }
        case 'next-occurrence': {
          const before = nextOccurrence('07:00', new Date(2026, 0, 15, 6, 30, 0));
          if (before.getDate() !== 15 || before.getHours() !== 7 || before.getMinutes() !== 0) {
            return { status: 'fail', detail: `expected today 07:00, got ${before.toISOString()}` };
          }
          const after = nextOccurrence('07:00', new Date(2026, 0, 15, 8, 0, 0));
          if (after.getDate() !== 16 || after.getHours() !== 7) {
            return { status: 'fail', detail: `expected tomorrow 07:00, got ${after.toISOString()}` };
          }
          return { status: 'pass' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
