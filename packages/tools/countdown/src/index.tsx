import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { daysUntil } from './countdown';

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

  function CountdownWidget(_props: WidgetProps) {
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
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
