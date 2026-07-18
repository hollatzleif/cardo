import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  CURRENCIES,
  DEFAULT_BASE,
  DEFAULT_DECIMALS,
  DEFAULT_PAIRS,
  buildCurrencyContext,
  buildUrl,
  convert,
  formatAmount,
  isStale,
  normalizeCode,
  parsePair,
  parseRatesResponse,
  rateAgeLabel,
  shouldFetch,
  type LastPairDoc,
  type RatesDoc,
} from './logic';

/** fetch with hard timeout – bad networks must never hang the widget
 * (same pattern as the host's net.ts; tools cannot import host code). */
function fetchWithTimeout(url: string, timeoutMs = 10_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

type Settings = { base: string; decimals: number; pairs: string[] };

/**
 * Currency – daily-cached exchange rates from open.er-api.com.
 *
 * A "yellow" tool that is honest about its network use: the ONLY thing
 * that ever leaves the device is the base currency code in the URL.
 * Rates are fetched at most once per day per base; all conversions run
 * against the local cache, and the widget always shows how old it is.
 * A failed refresh keeps the cache on screen instead of pretending.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(c: ToolContext): Promise<Settings> {
    const [base, decimals, pairs] = await Promise.all([
      c.settings.get<string>('base'),
      c.settings.get<number>('decimals'),
      c.settings.get<string[]>('pairs'),
    ]);
    return {
      base: (base && normalizeCode(base)) || DEFAULT_BASE,
      decimals: typeof decimals === 'number' && Number.isFinite(decimals) ? decimals : DEFAULT_DECIMALS,
      pairs: Array.isArray(pairs) ? pairs.filter((p) => parsePair(p) !== null) : [...DEFAULT_PAIRS],
    };
  }

  const ratesDocId = (base: string): string => `rates:${base}`;

  type RefreshOutcome = 'ok' | 'fresh' | 'offline';

  /** Fetch today's table for `base` unless the cache is younger than a day. */
  async function refresh(c: ToolContext, base: string, force: boolean): Promise<RefreshOutcome> {
    const cached = await c.storage.get<RatesDoc>(ratesDocId(base));
    if (!force && !shouldFetch(cached, Date.now())) return 'fresh';
    try {
      const res = await fetchWithTimeout(buildUrl(base));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseRatesResponse((await res.json()) as unknown);
      if (!parsed) throw new Error('unexpected payload');
      const doc: RatesDoc = {
        type: 'rates',
        base: parsed.base,
        fetchedAtMs: Date.now(),
        rates: parsed.rates,
      };
      await c.storage.set<RatesDoc>(ratesDocId(base), doc);
      return 'ok';
    } catch {
      // Honesty rule: never fake freshness – keep the cache, report offline.
      return 'offline';
    }
  }

  /** Cache-only conversion shared by the command and the widget. */
  async function convertFromCache(
    c: ToolContext,
    amount: number,
    from: string,
    to: string,
  ): Promise<
    | { state: 'no-rates' }
    | { state: 'unknown-code' }
    | { state: 'ok'; result: number; doc: RatesDoc }
  > {
    const { base } = await loadSettings(c);
    const doc = await c.storage.get<RatesDoc>(ratesDocId(base));
    if (!doc) return { state: 'no-rates' };
    const result = convert(amount, from, to, doc);
    if (result === null) return { state: 'unknown-code' };
    const lastPair: LastPairDoc = {
      type: 'last-pair',
      from: normalizeCode(from) ?? from,
      to: normalizeCode(to) ?? to,
      amount,
      result,
    };
    await c.storage.set<LastPairDoc>('last-pair', lastPair);
    return { state: 'ok', result, doc };
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function CurrencyWidget(props: WidgetProps) {
    const [settings, setSettings] = useState<Settings | null>(null);
    const [doc, setDoc] = useState<RatesDoc | null>(null);
    const [offline, setOffline] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [amount, setAmount] = useState('100');
    const [from, setFrom] = useState('EUR');
    const [to, setTo] = useState('USD');
    const [newPairFrom, setNewPairFrom] = useState('EUR');
    const [newPairTo, setNewPairTo] = useState('USD');
    // Re-render every minute so the age label stays honest.
    const [, setTick] = useState(0);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const s = await loadSettings(c);
      const cached = await c.storage.get<RatesDoc>(ratesDocId(s.base));
      setSettings(s);
      setDoc(cached);
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsubStorage = ctx?.storage.subscribe(safeReload);
      const unsubSettings = ctx?.settings.subscribe(safeReload);
      const ageInterval = window.setInterval(() => {
        if (mounted) setTick((n) => n + 1);
      }, 60 * 1000);
      return () => {
        mounted = false;
        unsubStorage?.();
        unsubSettings?.();
        window.clearInterval(ageInterval);
      };
    }, [reload]);

    // Daily fetch gate: on mount and hourly, fetch only when the cache is
    // missing or a day old (refresh() re-checks the gate itself).
    useEffect(() => {
      let mounted = true;
      const gate = () => {
        const c = ctx;
        if (!c) return;
        void loadSettings(c)
          .then((s) => refresh(c, s.base, false))
          .then((outcome) => {
            if (mounted && outcome !== 'fresh') setOffline(outcome === 'offline');
          });
      };
      gate();
      const interval = window.setInterval(gate, 60 * 60 * 1000);
      return () => {
        mounted = false;
        window.clearInterval(interval);
      };
    }, []);

    const manualRefresh = async () => {
      const c = ctx;
      if (!c || !settings) return;
      setRefreshing(true);
      const outcome = await refresh(c, settings.base, true);
      setOffline(outcome === 'offline');
      setRefreshing(false);
    };

    if (!settings) {
      return (
        <div className="c-muted" style={{ padding: 'var(--space-3)' }}>
          …
        </div>
      );
    }

    const lang = ctx?.i18n.language ?? 'en';
    const now = Date.now();
    const stale = doc ? isStale(doc.fetchedAtMs, now) : false;

    const ageLine = (
      <div
        className="c-muted"
        style={{
          display: 'flex',
          gap: 'var(--space-2)',
          alignItems: 'baseline',
          fontSize: '0.8em',
          flexWrap: 'wrap',
          flexShrink: 0,
        }}
      >
        {doc ? (
          <span style={stale ? { color: 'var(--warning)' } : undefined}>
            {t('tool.currency.updated', { age: rateAgeLabel(doc.fetchedAtMs, now, lang) })}
          </span>
        ) : null}
        {offline && <span style={{ color: 'var(--warning)' }}>{t('tool.currency.offlineHint')}</span>}
      </div>
    );

    const header = (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexShrink: 0 }}>
        <span
          className="c-muted"
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.85em' }}
        >
          {t('tool.currency.baseLabel', { base: settings.base })}
        </span>
        <button
          className="c-btn c-btn--ghost"
          style={{ padding: 'var(--space-1) var(--space-2)' }}
          onClick={() => setShowSettings((s) => !s)}
          aria-expanded={showSettings}
          aria-label={t('tool.currency.settingsToggle')}
          title={t('tool.currency.settingsToggle')}
        >
          ⚙
        </button>
        <button
          className="c-btn c-btn--ghost"
          style={{ padding: 'var(--space-1) var(--space-2)' }}
          onClick={() => void manualRefresh()}
          disabled={refreshing}
          aria-label={t('tool.currency.refresh')}
          title={t('tool.currency.refresh')}
        >
          ↻
        </button>
      </div>
    );

    const currencySelect = (value: string, onChange: (code: string) => void, label: string) => (
      <select
        className="c-input"
        value={value}
        aria-label={label}
        title={label}
        style={{ width: 'auto', flexShrink: 0 }}
        onChange={(e) => onChange(e.target.value)}
      >
        {CURRENCIES.map((code) => (
          <option key={code} value={code}>
            {code}
          </option>
        ))}
      </select>
    );

    const settingsPanel = showSettings ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0 }}>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <span className="c-muted" style={{ fontSize: '0.85em' }}>
            {t('tool.currency.settings.base')}
          </span>
          {currencySelect(
            settings.base,
            (code) => void ctx?.settings.set('base', code),
            t('tool.currency.settings.base'),
          )}
        </label>
        <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--space-2)' }}>
          <span className="c-muted" style={{ fontSize: '0.85em' }}>
            {t('tool.currency.settings.decimals')}
          </span>
          <input
            className="c-input"
            type="number"
            min={0}
            max={8}
            value={settings.decimals}
            style={{ width: 56, textAlign: 'right' }}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) void ctx?.settings.set('decimals', Math.min(8, Math.max(0, Math.trunc(n))));
            }}
          />
        </label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <span className="c-muted" style={{ fontSize: '0.85em' }}>
            {t('tool.currency.settings.pairs')}
          </span>
          {settings.pairs.map((pair) => (
            <div key={pair} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
              <span style={{ flex: 1, fontVariantNumeric: 'tabular-nums' }}>{pair}</span>
              <button
                className="c-btn c-btn--ghost"
                style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)' }}
                aria-label={t('tool.currency.settings.removePair', { pair })}
                title={t('tool.currency.settings.removePair', { pair })}
                onClick={() =>
                  void ctx?.settings.set(
                    'pairs',
                    settings.pairs.filter((p) => p !== pair),
                  )
                }
              >
                ×
              </button>
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            {currencySelect(newPairFrom, setNewPairFrom, t('tool.currency.fromLabel'))}
            <span className="c-muted">/</span>
            {currencySelect(newPairTo, setNewPairTo, t('tool.currency.toLabel'))}
            <button
              className="c-btn c-btn--ghost"
              aria-label={t('tool.currency.settings.addPair')}
              title={t('tool.currency.settings.addPair')}
              onClick={() => {
                const pair = `${newPairFrom}/${newPairTo}`;
                if (!settings.pairs.includes(pair)) {
                  void ctx?.settings.set('pairs', [...settings.pairs, pair]);
                }
              }}
            >
              +
            </button>
          </div>
        </div>
      </div>
    ) : null;

    const pairRate = (pair: string): { pair: string; text: string | null } => {
      const parsed = parsePair(pair);
      const rate = parsed ? convert(1, parsed.from, parsed.to, doc) : null;
      return { pair, text: rate === null ? null : formatAmount(rate, settings.decimals, lang) };
    };

    let body;
    if (props.variant === 'rate-board') {
      body =
        settings.pairs.length === 0 ? (
          <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            {t('tool.currency.noPairs')}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {settings.pairs.map((pair) => {
              const { text } = pairRate(pair);
              return (
                <div key={pair} style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {pair}
                  </span>
                  <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, flexShrink: 0 }}>
                    {text ?? '–'}
                  </span>
                </div>
              );
            })}
          </div>
        );
    } else if (props.variant === 'single-pair') {
      const first = settings.pairs[0];
      const info = first ? pairRate(first) : null;
      body = (
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 'var(--space-1)',
            minHeight: 0,
          }}
        >
          {info ? (
            <>
              <div className="c-muted">{info.pair}</div>
              <div style={{ fontSize: '2.2em', fontWeight: 700, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
                {info.text ?? '–'}
              </div>
            </>
          ) : (
            <div className="c-muted">{t('tool.currency.noPairs')}</div>
          )}
        </div>
      );
    } else {
      /* converter (default) */
      const parsedAmount = Number(amount.replace(',', '.'));
      const result = Number.isFinite(parsedAmount) ? convert(parsedAmount, from, to, doc) : null;
      const unitRate = convert(1, from, to, doc);
      body = (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              className="c-input"
              type="number"
              step="any"
              inputMode="decimal"
              value={amount}
              aria-label={t('tool.currency.amountLabel')}
              title={t('tool.currency.amountLabel')}
              style={{ flex: 1, minWidth: 64, textAlign: 'right' }}
              onChange={(e) => setAmount(e.target.value)}
            />
            {currencySelect(from, setFrom, t('tool.currency.fromLabel'))}
            <button
              className="c-btn c-btn--ghost"
              style={{ padding: 'var(--space-1) var(--space-2)' }}
              onClick={() => {
                setFrom(to);
                setTo(from);
              }}
              aria-label={t('tool.currency.swap')}
              title={t('tool.currency.swap')}
            >
              ⇄
            </button>
            {currencySelect(to, setTo, t('tool.currency.toLabel'))}
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: '1.8em', fontWeight: 700, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' }}>
              {result === null ? '–' : `${formatAmount(result, settings.decimals, lang)} ${to}`}
            </div>
            <div className="c-muted" style={{ fontSize: '0.8em', fontVariantNumeric: 'tabular-nums' }}>
              {unitRate === null
                ? doc
                  ? t('tool.currency.unknownCode')
                  : t('tool.currency.noRates')
                : `1 ${from} = ${formatAmount(unitRate, settings.decimals, lang)} ${to}`}
            </div>
          </div>
        </div>
      );
    }

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          height: '100%',
          padding: 'var(--space-2)',
          overflow: 'hidden',
        }}
      >
        {header}
        {settingsPanel}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
        {ageLine}
      </div>
    );
  }

  /* ── Tool ───────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'currency.convert',
        titleKey: 'tool.currency.command.convert',
        descriptionKey: 'tool.currency.command.convertDesc',
        icon: '💱',
        params: z.object({
          amount: z.number(),
          from: z.string().min(3),
          to: z.string().min(3),
        }),
        selfTestParams: { amount: 100, from: 'EUR', to: 'USD' },
        async run(params): Promise<CommandResult> {
          if (!normalizeCode(params.from) || !normalizeCode(params.to)) {
            return { ok: false, messageKey: 'tool.currency.msg.unknownCode' };
          }
          const outcome = await convertFromCache(context, params.amount, params.from, params.to);
          // No cache yet is a NORMAL state (first run, diagnose scratch DB):
          // report it as ok with a hint instead of failing – conversions
          // simply need one successful currency.refresh first.
          if (outcome.state === 'no-rates') {
            return { ok: true, messageKey: 'tool.currency.msg.noRatesYet', data: { text: t('tool.currency.msg.noRatesYet') } };
          }
          if (outcome.state === 'unknown-code') {
            return { ok: false, messageKey: 'tool.currency.msg.unknownCode' };
          }
          const lang = context.i18n.language;
          const text = `${formatAmount(params.amount, 2, lang)} ${normalizeCode(params.from)} = ${formatAmount(outcome.result, 2, lang)} ${normalizeCode(params.to)}`;
          return {
            ok: true,
            messageKey: 'tool.currency.msg.converted',
            data: { result: outcome.result, text, fetchedAtMs: outcome.doc.fetchedAtMs },
          };
        },
      });

      context.commands.register({
        id: 'currency.refresh',
        titleKey: 'tool.currency.command.refresh',
        descriptionKey: 'tool.currency.command.refreshDesc',
        icon: '↻',
        params: z.object({}),
        // Deliberately NO selfTestParams: the diagnose command probe must
        // never hit the network, and a refresh has no offline no-op path
        // (unlike weather, which short-circuits on the missing place doc).
        selfTestExempt: 'network fetch – no offline no-op path',
        async run(): Promise<CommandResult> {
          const { base } = await loadSettings(context);
          const outcome = await refresh(context, base, true);
          // Offline is a normal condition, not a hard failure (honesty rule:
          // the cache stays untouched and keeps its true age).
          if (outcome === 'offline') return { ok: true, messageKey: 'tool.currency.msg.offline' };
          return { ok: true, messageKey: 'tool.currency.msg.refreshed' };
        },
      });

      context.commands.register({
        id: 'currency.context',
        titleKey: 'tool.currency.command.context',
        descriptionKey: 'tool.currency.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const { base } = await loadSettings(context);
          const [doc, lastPair] = await Promise.all([
            context.storage.get<RatesDoc>(ratesDocId(base)),
            context.storage.get<LastPairDoc>('last-pair'),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildCurrencyContext(doc, lastPair, context.i18n.language, Date.now()),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: CurrencyWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'convert-math': {
          // Seeded table, pure math – NO network anywhere near this.
          const probe: RatesDoc = {
            type: 'rates',
            base: 'EUR',
            fetchedAtMs: Date.now(),
            rates: { EUR: 1, USD: 1.08, GBP: 0.85 },
          };
          await testCtx.storage.set<RatesDoc>('rates:SELFTEST', probe);
          const seeded = await testCtx.storage.get<RatesDoc>('rates:SELFTEST');
          await testCtx.storage.delete('rates:SELFTEST');
          const cross = convert(100, 'USD', 'GBP', seeded);
          const identity = convert(42, 'USD', 'USD', seeded);
          const unknown = convert(1, 'XXX', 'EUR', seeded);
          if (cross === null || Math.abs(cross - (100 / 1.08) * 0.85) > 1e-9) {
            return { status: 'fail', detail: `cross-rate math off: ${cross}` };
          }
          if (identity === null || Math.abs(identity - 42) > 1e-9) {
            return { status: 'fail', detail: `identity conversion off: ${identity}` };
          }
          if (unknown !== null) {
            return { status: 'fail', detail: 'unknown code did not return null' };
          }
          return { status: 'pass', detail: 'cross-rate, identity and unknown-code paths verified' };
        }
        case 'cache-roundtrip': {
          const probe: RatesDoc = {
            type: 'rates',
            base: 'EUR',
            fetchedAtMs: 1_700_000_000_000,
            rates: { EUR: 1, USD: 1.08 },
          };
          await testCtx.storage.set<RatesDoc>('rates:EUR', probe);
          const roundtrip = await testCtx.storage.get<RatesDoc>('rates:EUR');
          await testCtx.storage.delete('rates:EUR');
          const afterDelete = await testCtx.storage.get<RatesDoc>('rates:EUR');
          if (
            roundtrip?.base !== 'EUR' ||
            roundtrip.fetchedAtMs !== probe.fetchedAtMs ||
            roundtrip.rates.USD !== 1.08
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(roundtrip)}` };
          }
          if (afterDelete !== null) {
            return { status: 'fail', detail: 'rates doc still present after delete' };
          }
          return { status: 'pass' };
        }
        case 'render':
          return typeof CurrencyWidget === 'function' && CurrencyWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
