import { useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  SettingsApi,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  CATEGORIES,
  buildConverterContext,
  convert,
  convertParamsSchema,
  formatResult,
  inferCategory,
  resolveUnit,
  unitsOf,
  type Category,
  type ConvertParams,
} from './logic';

const DEFAULT_DECIMALS = 2;

function clampDecimals(value: number | null | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_DECIMALS;
  return Math.min(6, Math.max(0, Math.trunc(value)));
}

function asCategory(value: string | null | undefined): Category | null {
  return value && (CATEGORIES as string[]).includes(value) ? (value as Category) : null;
}

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  const unitLabel = (unit: string) => t(`tool.unit-converter.unit.${unit}`);

  /**
   * Shared core of the unit-converter.convert command, parameterized over the
   * settings backend so the self-test can run it against the scratch context.
   * Persists the last-used pair (the widget and the context command read it).
   */
  async function runConvertWith(settings: SettingsApi, params: ConvertParams): Promise<CommandResult> {
    const category = inferCategory(params.from, params.to);
    const result = convert(params.value, params.from, params.to);
    if (category === null || result === null) {
      return { ok: false, messageKey: 'tool.unit-converter.msg.unknownUnit' };
    }
    const from = resolveUnit(params.from)?.unit ?? params.from;
    const to = resolveUnit(params.to)?.unit ?? params.to;
    const decimals = clampDecimals(await settings.get<number>('decimals'));
    const language = ctx?.i18n.language ?? 'en';
    const text = `${formatResult(params.value, decimals, language)} ${unitLabel(from)} = ${formatResult(result, decimals, language)} ${unitLabel(to)}`;
    await Promise.all([
      settings.set('lastFrom', from),
      settings.set('lastTo', to),
      settings.set('lastCategory', category),
    ]);
    return {
      ok: true,
      data: { value: params.value, from, to, category, result, text },
      messageKey: 'tool.unit-converter.msg.converted',
    };
  }

  function ConverterWidget(props: WidgetProps) {
    const [category, setCategory] = useState<Category>('length');
    const [from, setFrom] = useState('m');
    const [to, setTo] = useState('km');
    const [value, setValue] = useState('1');
    const [decimals, setDecimals] = useState(DEFAULT_DECIMALS);
    const [defaultCategory, setDefaultCategory] = useState<Category>('length');
    const [showSettings, setShowSettings] = useState(false);

    // Initial load only – live typing must never be clobbered by subscriptions.
    useEffect(() => {
      let mounted = true;
      void (async () => {
        const c = ctx;
        if (!c) return;
        const [dec, defCat, lastFrom, lastTo, lastCat] = await Promise.all([
          c.settings.get<number>('decimals'),
          c.settings.get<string>('defaultCategory'),
          c.settings.get<string>('lastFrom'),
          c.settings.get<string>('lastTo'),
          c.settings.get<string>('lastCategory'),
        ]);
        if (!mounted) return;
        const fallback = asCategory(defCat) ?? 'length';
        const cat = asCategory(lastCat) ?? fallback;
        const units = unitsOf(cat);
        setDecimals(clampDecimals(dec));
        setDefaultCategory(fallback);
        setCategory(cat);
        setFrom(lastFrom && units.includes(lastFrom) ? lastFrom : (units[0] ?? 'm'));
        setTo(lastTo && units.includes(lastTo) ? lastTo : (units[1] ?? units[0] ?? 'm'));
      })();
      return () => {
        mounted = false;
      };
    }, []);

    const lang = ctx?.i18n.language ?? 'en';

    function persistPair(nextFrom: string, nextTo: string, nextCategory: Category) {
      const c = ctx;
      if (!c) return;
      void c.settings.set('lastFrom', nextFrom);
      void c.settings.set('lastTo', nextTo);
      void c.settings.set('lastCategory', nextCategory);
    }

    function pickCategory(next: Category) {
      const units = unitsOf(next);
      const nextFrom = units[0] ?? '';
      const nextTo = units[1] ?? nextFrom;
      setCategory(next);
      setFrom(nextFrom);
      setTo(nextTo);
      persistPair(nextFrom, nextTo, next);
    }

    function swap() {
      setFrom(to);
      setTo(from);
      persistPair(to, from, category);
    }

    const parsed = Number(value.replace(',', '.'));
    const result = value.trim() === '' ? null : convert(parsed, from, to, category);
    const resultText = result === null ? '—' : formatResult(result, decimals, lang);

    const unitSelect = (
      current: string,
      onChange: (unit: string) => void,
      labelKey: string,
    ) => (
      <select
        className="c-input"
        value={current}
        aria-label={t(labelKey)}
        title={t(labelKey)}
        style={{ width: 'auto', flexShrink: 0 }}
        onChange={(e) => onChange(e.target.value)}
      >
        {unitsOf(category).map((unit) => (
          <option key={unit} value={unit}>
            {unitLabel(unit)}
          </option>
        ))}
      </select>
    );

    const valueInput = (
      <input
        className="c-input"
        type="number"
        step="any"
        inputMode="decimal"
        value={value}
        aria-label={t('tool.unit-converter.widget.valueLabel')}
        title={t('tool.unit-converter.widget.valueLabel')}
        style={{ flex: 1, minWidth: 64, textAlign: 'right' }}
        onChange={(e) => setValue(e.target.value)}
      />
    );

    const gearButton = (
      <button
        className="c-btn c-btn--ghost"
        aria-label={t('tool.unit-converter.widget.settingsToggle')}
        title={t('tool.unit-converter.widget.settingsToggle')}
        aria-expanded={showSettings}
        style={{ flexShrink: 0 }}
        onClick={() => setShowSettings((s) => !s)}
      >
        ⚙
      </button>
    );

    const settingsPanel = showSettings ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 'var(--space-2)',
          flexShrink: 0,
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
            {t('tool.unit-converter.settings.decimals')}
          </span>
          <input
            className="c-input"
            type="number"
            min={0}
            max={6}
            value={decimals}
            style={{ width: 64, textAlign: 'right' }}
            onChange={(e) => {
              const next = clampDecimals(Number(e.target.value));
              setDecimals(next);
              void ctx?.settings.set('decimals', next);
            }}
          />
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
            {t('tool.unit-converter.settings.defaultCategory')}
          </span>
          <select
            className="c-input"
            value={defaultCategory}
            style={{ width: 'auto' }}
            onChange={(e) => {
              const next = asCategory(e.target.value) ?? 'length';
              setDefaultCategory(next);
              void ctx?.settings.set('defaultCategory', next);
            }}
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t(`tool.unit-converter.category.${cat}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
    ) : null;

    if (props.variant === 'compact') {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            height: '100%',
            gap: 'var(--space-2)',
            padding: 'var(--space-3)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
            {valueInput}
            {unitSelect(from, (u) => {
              setFrom(u);
              persistPair(u, to, category);
            }, 'tool.unit-converter.widget.fromLabel')}
            <span className="c-muted" aria-hidden style={{ flexShrink: 0 }}>
              →
            </span>
            {unitSelect(to, (u) => {
              setTo(u);
              persistPair(from, u, category);
            }, 'tool.unit-converter.widget.toLabel')}
            {gearButton}
          </div>
          <div
            style={{
              fontSize: '1.5em',
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'center',
              color: result === null ? 'var(--text-muted)' : 'var(--accent)',
            }}
          >
            {resultText}
            {result !== null ? (
              <span className="c-muted" style={{ fontSize: '0.6em' }}>
                {' '}
                {unitLabel(to)}
              </span>
            ) : null}
          </div>
          {settingsPanel}
        </div>
      );
    }

    const categoryPicker =
      props.variant === 'category-tabs' ? (
        <div
          role="tablist"
          style={{
            display: 'flex',
            gap: 'var(--space-1)',
            overflowX: 'auto',
            flexShrink: 0,
            alignItems: 'center',
          }}
        >
          {CATEGORIES.map((cat) => {
            const active = cat === category;
            return (
              <button
                key={cat}
                role="tab"
                aria-selected={active}
                className="c-btn c-btn--ghost"
                style={{
                  padding: 'var(--space-1) var(--space-2)',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  fontSize: 12,
                  ...(active
                    ? { background: 'var(--bg-widget-hover)', boxShadow: 'inset 0 -2px 0 0 var(--accent)' }
                    : { color: 'var(--text-muted)' }),
                }}
                onClick={() => pickCategory(cat)}
              >
                {t(`tool.unit-converter.category.${cat}`)}
              </button>
            );
          })}
          <span style={{ marginLeft: 'auto', flexShrink: 0 }}>{gearButton}</span>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center', flexShrink: 0 }}>
          <select
            className="c-input"
            value={category}
            aria-label={t('tool.unit-converter.widget.categoryLabel')}
            title={t('tool.unit-converter.widget.categoryLabel')}
            style={{ flex: 1 }}
            onChange={(e) => pickCategory(asCategory(e.target.value) ?? 'length')}
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {t(`tool.unit-converter.category.${cat}`)}
              </option>
            ))}
          </select>
          {gearButton}
        </div>
      );

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          height: '100%',
          gap: 'var(--space-2)',
          padding: 'var(--space-3)',
          overflowY: 'auto',
        }}
      >
        {categoryPicker}
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          {valueInput}
          {unitSelect(from, (u) => {
            setFrom(u);
            persistPair(u, to, category);
          }, 'tool.unit-converter.widget.fromLabel')}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', flexShrink: 0 }}>
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.unit-converter.widget.swap')}
            title={t('tool.unit-converter.widget.swap')}
            onClick={swap}
          >
            ⇅
          </button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
          <div
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: '1.4em',
              fontVariantNumeric: 'tabular-nums',
              textAlign: 'right',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: result === null ? 'var(--text-muted)' : 'var(--accent)',
            }}
          >
            {resultText}
          </div>
          {unitSelect(to, (u) => {
            setTo(u);
            persistPair(from, u, category);
          }, 'tool.unit-converter.widget.toLabel')}
        </div>
        {settingsPanel}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      // Palette AND assistant visible: the assistant answers "how much is
      // 5 km in miles?" by executing this and reading data.text.
      context.commands.register({
        id: 'unit-converter.convert',
        titleKey: 'tool.unit-converter.command.convert',
        descriptionKey: 'tool.unit-converter.command.convertDesc',
        icon: '⇄',
        params: convertParamsSchema,
        selfTestParams: { value: 1, from: 'km', to: 'm' },
        async run(params): Promise<CommandResult> {
          return runConvertWith(context.settings, params);
        },
      });

      context.commands.register({
        id: 'unit-converter.context',
        titleKey: 'tool.unit-converter.command.context',
        descriptionKey: 'tool.unit-converter.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const [lastFrom, lastTo] = await Promise.all([
            context.settings.get<string>('lastFrom'),
            context.settings.get<string>('lastTo'),
          ]);
          const last = lastFrom && lastTo ? { from: lastFrom, to: lastTo } : null;
          return {
            ok: true,
            data: { contextText: buildConverterContext(last, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: ConverterWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'conversions': {
          const checks: Array<[number, string, string, number]> = [
            [0, 'c', 'f', 32],
            [100, 'c', 'f', 212],
            [-40, 'c', 'f', -40],
            [0, 'c', 'k', 273.15],
            [212, 'f', 'k', 373.15],
            [273.15, 'k', 'c', 0],
            [1, 'km', 'm', 1000],
            [1, 'mi', 'km', 1.609344],
            [1, 'kg', 'lb', 1 / 0.45359237],
            [1, 'KB', 'B', 1000],
            [1, 'KiB', 'B', 1024],
            [1, 'GiB', 'MiB', 1024],
            [36, 'km/h', 'm/s', 10],
            [1, 'gal', 'l', 3.785411784],
            [1, 'ha', 'm2', 10000],
          ];
          for (const [value, from, to, expected] of checks) {
            const got = convert(value, from, to);
            if (got === null || Math.abs(got - expected) > 1e-9) {
              return {
                status: 'fail',
                detail: `convert(${value}, ${from}, ${to}) = ${got}, expected ${expected}`,
              };
            }
          }
          if (convert(1, 'km', 'kg') !== null || convert(1, 'bogus', 'm') !== null) {
            return { status: 'fail', detail: 'mismatched/unknown units must convert to null' };
          }
          return { status: 'pass', detail: `${checks.length} known-value conversions ok` };
        }
        case 'convert-command': {
          const result = await runConvertWith(testCtx.settings, { value: 5, from: 'km', to: 'mi' });
          if (!result.ok) return { status: 'fail', detail: 'convert command rejected 5 km → mi' };
          const data = result.data as { result: number; from: string; to: string; text: string };
          if (Math.abs(data.result - 5000 / 1609.344) > 1e-9) {
            return { status: 'fail', detail: `5 km → mi returned ${data.result}` };
          }
          if (typeof data.text !== 'string' || data.text.length === 0) {
            return { status: 'fail', detail: 'convert command returned no formatted text' };
          }
          const [lastFrom, lastTo] = await Promise.all([
            testCtx.settings.get<string>('lastFrom'),
            testCtx.settings.get<string>('lastTo'),
          ]);
          if (lastFrom !== 'km' || lastTo !== 'mi') {
            return {
              status: 'fail',
              detail: `last pair not persisted (got ${lastFrom} → ${lastTo})`,
            };
          }
          return { status: 'pass', detail: `data.text = "${data.text}"` };
        }
        case 'render':
          return typeof ConverterWidget === 'function' && ConverterWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
