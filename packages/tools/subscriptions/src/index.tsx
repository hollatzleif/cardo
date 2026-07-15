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
  CYCLES,
  addSubParamsSchema,
  advanceDue,
  buildSubsContext,
  daysUntil,
  duesInMonth,
  formatMoney,
  isValidDate,
  makeSub,
  monthlyCost,
  todayIso,
  totalMonthly,
  type Cycle,
  type SubDoc,
} from './logic';

/** Currency is a pure DISPLAY setting – no FX math anywhere. */
const DEFAULT_CURRENCY = '€';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function querySubsIn(storage: ToolStorage): Promise<SubDoc[]> {
  const subs = await storage.query<SubDoc>({ where: [{ field: 'type', op: '=', value: 'sub' }] });
  return [...subs].sort((a, b) =>
    a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : a.name.localeCompare(b.name),
  );
}

async function addSubIn(
  storage: ToolStorage,
  input: { name: string; amount: number; cycle: Cycle; nextDue: string; category?: string },
): Promise<SubDoc> {
  const sub = makeSub(input);
  await storage.set(sub.id, sub);
  return sub;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function SubscriptionsWidget(props: WidgetProps) {
    const [subs, setSubs] = useState<SubDoc[]>([]);
    const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
    const [name, setName] = useState('');
    const [amount, setAmount] = useState('');
    const [cycle, setCycle] = useState<Cycle>('monthly');
    const [nextDue, setNextDue] = useState('');
    const [showSettings, setShowSettings] = useState(false);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, cur] = await Promise.all([
        querySubsIn(c.storage),
        c.settings.get<string>('currency'),
      ]);
      setSubs(list);
      setCurrency(cur ?? DEFAULT_CURRENCY);
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

    const lang = ctx?.i18n.language ?? 'en';
    const today = todayIso();
    const money = (value: number) => formatMoney(value, lang, currency);
    const total = totalMonthly(subs);

    async function addSub() {
      const c = ctx;
      const parsedAmount = Number(amount.replace(',', '.'));
      if (!c || !name.trim() || !Number.isFinite(parsedAmount) || parsedAmount <= 0) return;
      if (!isValidDate(nextDue)) return;
      await addSubIn(c.storage, { name, amount: parsedAmount, cycle, nextDue });
      setName('');
      setAmount('');
      setNextDue('');
    }

    async function markPaid(sub: SubDoc) {
      const c = ctx;
      if (!c) return;
      const advanced = advanceDue(sub, today);
      if (advanced.nextDue !== sub.nextDue) await c.storage.set(sub.id, advanced);
    }

    async function removeSub(sub: SubDoc) {
      await ctx?.storage.delete(sub.id);
    }

    /** Due badge: overdue → danger, due within 7 days → warning, else muted. */
    const dueBadge = (sub: SubDoc) => {
      const days = daysUntil(sub.nextDue, today);
      const color = days < 0 ? 'var(--danger)' : days <= 7 ? 'var(--warning)' : 'var(--text-muted)';
      return (
        <span
          title={t('tool.subscriptions.widget.dueOn', { date: sub.nextDue })}
          style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color, flexShrink: 0 }}
        >
          {sub.nextDue}
        </span>
      );
    };

    const rowActions = (sub: SubDoc) => (
      <span style={{ display: 'inline-flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.subscriptions.widget.markPaid', { name: sub.name })}
          title={t('tool.subscriptions.widget.markPaid', { name: sub.name })}
          style={{ padding: '0 var(--space-1)', color: 'var(--success)' }}
          onClick={() => void markPaid(sub)}
        >
          ✓
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.subscriptions.widget.delete', { name: sub.name })}
          title={t('tool.subscriptions.widget.delete', { name: sub.name })}
          style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)' }}
          onClick={() => void removeSub(sub)}
        >
          ×
        </button>
      </span>
    );

    const renderRow = (sub: SubDoc) => (
      <div key={sub.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {sub.name}
          {sub.category ? (
            <span className="c-muted" style={{ fontSize: 12 }}>
              {' '}
              · {sub.category}
            </span>
          ) : null}
        </span>
        <span
          className="c-muted"
          style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
        >
          {money(sub.amount)} {t(`tool.subscriptions.cycle.${sub.cycle}`)}
        </span>
        {dueBadge(sub)}
        {rowActions(sub)}
      </div>
    );

    const addForm = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          className="c-input"
          value={name}
          placeholder={t('tool.subscriptions.widget.namePlaceholder')}
          aria-label={t('tool.subscriptions.widget.namePlaceholder')}
          style={{ flex: 2, minWidth: 80 }}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addSub();
          }}
        />
        <input
          className="c-input"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={amount}
          placeholder={t('tool.subscriptions.widget.amountLabel')}
          aria-label={t('tool.subscriptions.widget.amountLabel')}
          style={{ width: 76, textAlign: 'right' }}
          onChange={(e) => setAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addSub();
          }}
        />
        <select
          className="c-input"
          value={cycle}
          aria-label={t('tool.subscriptions.widget.cycleLabel')}
          title={t('tool.subscriptions.widget.cycleLabel')}
          style={{ width: 'auto', flexShrink: 0 }}
          onChange={(e) => setCycle(e.target.value as Cycle)}
        >
          {CYCLES.map((c) => (
            <option key={c} value={c}>
              {t(`tool.subscriptions.cycle.${c}`)}
            </option>
          ))}
        </select>
        <input
          className="c-input"
          type="date"
          value={nextDue}
          aria-label={t('tool.subscriptions.widget.nextDueLabel')}
          title={t('tool.subscriptions.widget.nextDueLabel')}
          style={{ width: 'auto' }}
          onChange={(e) => setNextDue(e.target.value)}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.subscriptions.widget.add')}
          title={t('tool.subscriptions.widget.add')}
          style={{ flexShrink: 0 }}
          onClick={() => void addSub()}
        >
          +
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.subscriptions.widget.settingsToggle')}
          title={t('tool.subscriptions.widget.settingsToggle')}
          aria-expanded={showSettings}
          style={{ flexShrink: 0 }}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
    );

    const settingsPanel = showSettings ? (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
          flexShrink: 0,
        }}
      >
        <span className="c-muted" style={{ fontSize: '0.85em' }}>
          {t('tool.subscriptions.settings.currency')}
        </span>
        <input
          className="c-input"
          value={currency}
          maxLength={4}
          style={{ width: 56, textAlign: 'center' }}
          onChange={(e) => {
            setCurrency(e.target.value);
            void ctx?.settings.set('currency', e.target.value);
          }}
        />
      </label>
    ) : null;

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.subscriptions.widget.empty')}
      </div>
    );

    let body;
    if (props.variant === 'total-first') {
      const top3 = [...subs]
        .sort((a, b) => monthlyCost(b.amount, b.cycle) - monthlyCost(a.amount, a.cycle))
        .slice(0, 3);
      body =
        subs.length === 0 ? (
          empty
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
            }}
          >
            <div style={{ fontSize: '2.2em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
              {money(total)}
            </div>
            <div className="c-muted" style={{ fontSize: '0.85em' }}>
              {t('tool.subscriptions.widget.perMonth')}
            </div>
            <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <span className="c-muted" style={{ fontSize: 12 }}>
                {t('tool.subscriptions.widget.top3')}
              </span>
              {top3.map((sub) => (
                <div key={sub.id} style={{ display: 'flex', gap: 'var(--space-2)' }}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {sub.name}
                  </span>
                  <span
                    className="c-muted"
                    style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0, fontSize: 12 }}
                  >
                    {money(monthlyCost(sub.amount, sub.cycle))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        );
    } else if (props.variant === 'calendar') {
      const now = new Date();
      const dues = duesInMonth(subs, now.getFullYear(), now.getMonth() + 1);
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>
            {now.toLocaleDateString(lang, { month: 'long', year: 'numeric' })}
          </span>
          {subs.length === 0 ? (
            empty
          ) : dues.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.subscriptions.widget.noDuesThisMonth')}
            </div>
          ) : (
            dues.map(({ day, sub }) => (
              <div
                key={`${sub.id}:${day}`}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
              >
                <span
                  style={{
                    width: 24,
                    textAlign: 'right',
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--accent)',
                    flexShrink: 0,
                  }}
                >
                  {day}
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
                  {sub.name}
                </span>
                <span
                  className="c-muted"
                  style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                >
                  {money(sub.amount)}
                </span>
              </div>
            ))
          )}
        </div>
      );
    } else {
      body =
        subs.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {subs.map(renderRow)}
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
        {addForm}
        {settingsPanel}
        {props.variant !== 'total-first' && subs.length > 0 ? (
          <div className="c-muted" style={{ fontSize: 12, flexShrink: 0 }}>
            {t('tool.subscriptions.widget.totalMonthly', { total: money(total) })}
          </div>
        ) : null}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'subscriptions.add',
        titleKey: 'tool.subscriptions.command.add',
        descriptionKey: 'tool.subscriptions.command.addDesc',
        icon: 'plus',
        params: addSubParamsSchema,
        selfTestParams: {
          name: 'Cardo self-test sub',
          amount: 9.99,
          cycle: 'monthly',
          nextDue: '2099-01-01',
        },
        async run(params): Promise<CommandResult> {
          if (!isValidDate(params.nextDue)) {
            return { ok: false, messageKey: 'tool.subscriptions.msg.invalidDate' };
          }
          const sub = await addSubIn(context.storage, params);
          return { ok: true, data: sub, messageKey: 'tool.subscriptions.msg.added' };
        },
      });

      context.commands.register({
        id: 'subscriptions.context',
        titleKey: 'tool.subscriptions.command.context',
        descriptionKey: 'tool.subscriptions.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [subs, currency] = await Promise.all([
            querySubsIn(context.storage),
            context.settings.get<string>('currency'),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildSubsContext(
                subs,
                context.i18n.language,
                todayIso(),
                currency ?? DEFAULT_CURRENCY,
              ),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: SubscriptionsWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const sub = await addSubIn(testCtx.storage, {
            name: 'selftest sub',
            amount: 12.5,
            cycle: 'quarterly',
            nextDue: '2099-06-15',
            category: 'selftest',
          });
          const back = await testCtx.storage.get<SubDoc>(sub.id);
          await testCtx.storage.delete(sub.id);
          const gone = await testCtx.storage.get<SubDoc>(sub.id);
          if (
            !back ||
            back.name !== 'selftest sub' ||
            back.amount !== 12.5 ||
            back.cycle !== 'quarterly' ||
            back.nextDue !== '2099-06-15' ||
            back.category !== 'selftest'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'sub still present after delete' };
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'total': {
          // Isolated via a probe category – the scratch DB may hold leftovers
          // from command probes (subscriptions.add selfTestParams).
          const probes = [
            await addSubIn(testCtx.storage, {
              name: 'selftest monthly',
              amount: 5,
              cycle: 'monthly',
              nextDue: '2099-01-05',
              category: 'selftest-total',
            }),
            await addSubIn(testCtx.storage, {
              name: 'selftest yearly',
              amount: 120,
              cycle: 'yearly',
              nextDue: '2099-01-10',
              category: 'selftest-total',
            }),
            await addSubIn(testCtx.storage, {
              name: 'selftest weekly',
              amount: 3,
              cycle: 'weekly',
              nextDue: '2099-01-02',
              category: 'selftest-total',
            }),
          ];
          const stored = await testCtx.storage.query<SubDoc>({
            where: [{ field: 'category', op: '=', value: 'selftest-total' }],
          });
          await Promise.all(probes.map((p) => testCtx.storage.delete(p.id)));
          const total = totalMonthly(stored);
          // 5 + 120/12 + 3×52/12 = 5 + 10 + 13 = 28
          if (stored.length !== 3 || total !== 28) {
            return {
              status: 'fail',
              detail: `expected 3 probes totaling 28/month, got ${stored.length} totaling ${total}`,
            };
          }
          const text = buildSubsContext(stored, 'en', '2098-12-31', '€');
          if (!text.includes('28.00 € per month')) {
            return { status: 'fail', detail: `context misses the total: "${text}"` };
          }
          return { status: 'pass', detail: 'monthly total 28.00 verified via storage roundtrip' };
        }
        case 'render':
          return typeof SubscriptionsWidget === 'function' && SubscriptionsWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
