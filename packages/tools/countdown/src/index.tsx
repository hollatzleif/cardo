import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { daysUntil, pickUpcoming, ringProgress } from './countdown';

type CountdownDoc = {
  /** Stored inside the doc – query() returns bodies without ids. */
  id: string;
  title: string;
  /** Target date "YYYY-MM-DD" (local calendar day). */
  targetDate: string;
  createdAt: string;
};

function makeId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `countdown-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Countdown – how many days until your important events. Fully local. */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function formatDate(targetDate: string): string {
    const [year, month, day] = targetDate.split('-').map(Number);
    return new Date(year ?? 0, (month ?? 1) - 1, day ?? 1).toLocaleDateString(ctx?.i18n.language);
  }

  async function listCountdowns(): Promise<CountdownDoc[]> {
    return (
      (await ctx?.storage.query<CountdownDoc>({ orderBy: 'targetDate', direction: 'asc' })) ?? []
    );
  }

  async function createCountdown(title: string, targetDate: string): Promise<CountdownDoc | null> {
    const c = ctx;
    if (!c) return null;
    const doc: CountdownDoc = {
      id: makeId(),
      title,
      targetDate,
      createdAt: new Date().toISOString(),
    };
    await c.storage.set<CountdownDoc>(doc.id, doc);
    return doc;
  }

  /** Day-count label shared by all variants ("today" / "day" / "days"). */
  function daysLabel(days: number): string {
    return days === 0
      ? t('tool.countdown.today')
      : days === 1
        ? t('tool.countdown.day')
        : t('tool.countdown.days');
  }

  /** Variant "big": the next upcoming countdown, number as huge as it gets. */
  function BigView({ countdowns, now }: { countdowns: CountdownDoc[] | null; now: Date }) {
    const next = countdowns ? pickUpcoming(countdowns, now) : null;
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-1)',
          padding: 'var(--space-2)',
          textAlign: 'center',
          overflow: 'hidden',
        }}
      >
        {countdowns === null ? (
          <div className="c-muted">…</div>
        ) : next === null ? (
          <div className="c-muted">
            {countdowns.length === 0 ? t('tool.countdown.empty') : t('tool.countdown.done')}
          </div>
        ) : (
          (() => {
            const days = daysUntil(next.targetDate, now);
            return (
              <>
                <div
                  style={{
                    fontSize: '3.4em',
                    fontWeight: 700,
                    lineHeight: 1,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--accent)',
                  }}
                >
                  {days}
                </div>
                <div className="c-muted">{daysLabel(days)}</div>
                <div
                  style={{
                    maxWidth: '100%',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {next.title}
                </div>
              </>
            );
          })()
        )}
      </div>
    );
  }

  /** Variant "ring": progress ring of the time between creation and target. */
  function RingView({ countdowns, now }: { countdowns: CountdownDoc[] | null; now: Date }) {
    const next = countdowns ? pickUpcoming(countdowns, now) : null;
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (countdowns === null) {
      return (
        <div className="c-muted" style={{ padding: 'var(--space-2)' }}>
          …
        </div>
      );
    }
    if (next === null) {
      return (
        <div
          className="c-muted"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 'var(--space-2)',
            textAlign: 'center',
          }}
        >
          {countdowns.length === 0 ? t('tool.countdown.empty') : t('tool.countdown.done')}
        </div>
      );
    }

    const days = daysUntil(next.targetDate, now);
    // Old docs may lack createdAt – ringProgress falls back to a full ring.
    const progress = ringProgress(next.createdAt, next.targetDate, now);
    const radius = 42;
    const circumference = 2 * Math.PI * radius;

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          gap: 'var(--space-1)',
          padding: 'var(--space-2)',
          overflow: 'hidden',
        }}
      >
        <svg
          viewBox="0 0 100 100"
          role="img"
          aria-label={`${next.title}: ${days} ${daysLabel(days)}`}
          style={{ flex: 1, minHeight: 0, maxWidth: '100%' }}
        >
          <circle
            cx={50}
            cy={50}
            r={radius}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={6}
          />
          <circle
            cx={50}
            cy={50}
            r={radius}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={6}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - progress)}
            transform="rotate(-90 50 50)"
            style={reduceMotion ? undefined : { transition: 'stroke-dashoffset 0.4s ease' }}
          />
          <text
            x={50}
            y={50}
            textAnchor="middle"
            style={{
              fontSize: '26px',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              fill: 'var(--text-primary)',
            }}
          >
            {days}
          </text>
          <text
            x={50}
            y={64}
            textAnchor="middle"
            style={{ fontSize: '9px', fill: 'var(--text-muted)' }}
          >
            {daysLabel(days)}
          </text>
        </svg>
        <div
          style={{
            maxWidth: '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '0.9em',
          }}
        >
          {next.title}
        </div>
      </div>
    );
  }

  function CountdownWidget(props: WidgetProps) {
    const [countdowns, setCountdowns] = useState<CountdownDoc[] | null>(null);
    const [title, setTitle] = useState('');
    const [date, setDate] = useState('');

    useEffect(() => {
      let mounted = true;
      const load = () => {
        void listCountdowns().then((list) => {
          if (mounted) setCountdowns(list);
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
      if (!title.trim() || !date) return;
      await createCountdown(title.trim(), date);
      setTitle('');
      setDate('');
    };

    const now = new Date();

    if (props.variant === 'big') {
      return <BigView countdowns={countdowns} now={now} />;
    }
    if (props.variant === 'ring') {
      return <RingView countdowns={countdowns} now={now} />;
    }

    /* Variant "card" (default): the classic list + add form. */
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
            gap: 'var(--space-3)',
          }}
        >
          {countdowns === null ? (
            <div className="c-muted">…</div>
          ) : countdowns.length === 0 ? (
            <div className="c-muted">{t('tool.countdown.empty')}</div>
          ) : (
            countdowns.map((cd) => {
              const days = daysUntil(cd.targetDate, now);
              const past = days < 0;
              return (
                <div
                  key={cd.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}
                    >
                      {past ? (
                        <span
                          style={{
                            fontSize: '1.6em',
                            fontWeight: 700,
                            color: 'var(--text-muted)',
                          }}
                        >
                          {t('tool.countdown.done')}
                        </span>
                      ) : (
                        <>
                          <span
                            style={{
                              fontSize: '1.6em',
                              fontWeight: 700,
                              fontVariantNumeric: 'tabular-nums',
                              color: 'var(--accent)',
                            }}
                          >
                            {days}
                          </span>
                          <span className="c-muted">
                            {days === 0
                              ? t('tool.countdown.today')
                              : days === 1
                                ? t('tool.countdown.day')
                                : t('tool.countdown.days')}
                          </span>
                        </>
                      )}
                    </div>
                    <div
                      style={{
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        color: past ? 'var(--text-muted)' : 'var(--text-primary)',
                      }}
                    >
                      {cd.title}{' '}
                      <span className="c-muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
                        · {formatDate(cd.targetDate)}
                      </span>
                    </div>
                  </div>
                  <button
                    className="c-btn c-btn--ghost"
                    style={{ color: 'var(--danger)', padding: 'var(--space-1) var(--space-2)' }}
                    onClick={() => void ctx?.storage.delete(cd.id)}
                    aria-label={t('tool.countdown.delete')}
                    title={t('tool.countdown.delete')}
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
          <input
            className="c-input"
            style={{ flex: 1, minWidth: 0 }}
            placeholder={t('tool.countdown.titlePlaceholder')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add();
            }}
          />
          <input
            type="date"
            className="c-input"
            style={{ width: 'auto', flexShrink: 0 }}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            aria-label={t('tool.countdown.name')}
          />
          <button
            className="c-btn c-btn--primary"
            onClick={() => void add()}
            disabled={!title.trim() || !date}
          >
            {t('tool.countdown.add')}
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
        id: 'countdown.create',
        titleKey: 'tool.countdown.command.create',
        params: z.object({
          title: z.string().min(1),
          date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
        selfTestParams: { title: 'probe', date: '2030-01-01' },
        async run({ title, date }) {
          const doc = await createCountdown(title, date);
          return doc
            ? { ok: true, messageKey: 'tool.countdown.msg.created', data: doc.id }
            : { ok: false };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: CountdownWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'storage-roundtrip': {
          const probe: CountdownDoc = {
            id: 'selftest-countdown',
            title: 'probe',
            targetDate: '2030-01-01',
            createdAt: new Date().toISOString(),
          };
          await testCtx.storage.set<CountdownDoc>(probe.id, probe);
          const roundtrip = await testCtx.storage.get<CountdownDoc>(probe.id);
          await testCtx.storage.delete(probe.id);
          const afterDelete = await testCtx.storage.get<CountdownDoc>(probe.id);
          if (roundtrip?.title !== 'probe' || roundtrip.targetDate !== '2030-01-01') {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
          }
          if (afterDelete !== null) {
            return { status: 'fail', detail: 'doc still present after delete' };
          }
          return { status: 'pass' };
        }
        case 'days-calc': {
          const now = new Date(2026, 5, 15, 13, 45, 0);
          const checks: Array<[string, number]> = [
            ['2026-06-15', 0],
            ['2026-06-16', 1],
            ['2026-06-14', -1],
            ['2026-07-15', 30],
          ];
          for (const [target, expected] of checks) {
            const actual = daysUntil(target, now);
            if (actual !== expected) {
              return {
                status: 'fail',
                detail: `daysUntil("${target}") expected ${expected}, got ${actual}`,
              };
            }
          }
          return { status: 'pass' };
        }
        case 'variants': {
          // Uses hooks, so it cannot be invoked outside React here – the
          // host's ping check covers mounting. This verifies the export
          // contract plus the declared variant list.
          const variants = manifest.widgets[0]?.variants ?? [];
          if (variants.length < 2) {
            return { status: 'fail', detail: `expected >= 2 variants, got ${variants.length}` };
          }
          return typeof CountdownWidget === 'function' && CountdownWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget is not a render function' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
