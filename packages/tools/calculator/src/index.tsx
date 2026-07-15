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
  buildCalcContext,
  calcParamsSchema,
  DEFAULT_HISTORY_CAP,
  evaluate,
  formatDisplay,
  formatNumber,
  FUNCTION_NAMES,
  HISTORY_DOC_ID,
  pushHistory,
  type AngleMode,
  type EvalError,
  type HistoryDoc,
  type HistoryEntry,
} from './logic';

type CalculatorSettings = {
  /** Default angle mode for trig (the scientific variant can toggle it live). */
  angleMode: AngleMode;
  /** Thousands separator in the result display (Intl-based). */
  thousands: boolean;
  /** How many history entries are kept. */
  historyLength: number;
};

const DEFAULT_SETTINGS: CalculatorSettings = {
  angleMode: 'deg',
  thousands: false,
  historyLength: DEFAULT_HISTORY_CAP,
};

const ERROR_KEYS: Record<EvalError, string> = {
  syntax: 'tool.calculator.error.syntax',
  'division-by-zero': 'tool.calculator.error.divisionByZero',
  'unknown-token': 'tool.calculator.error.unknownToken',
  math: 'tool.calculator.error.math',
};

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function getHistoryIn(storage: ToolStorage): Promise<HistoryEntry[]> {
  const doc = await storage.get<HistoryDoc>(HISTORY_DOC_ID);
  return doc?.entries ?? [];
}

/** Evaluates and – on success – records the calculation in the history doc. */
async function calcIn(
  storage: ToolStorage,
  expression: string,
  angleMode: AngleMode,
  cap: number,
): Promise<{ result: ReturnType<typeof evaluate>; entry: HistoryEntry | null }> {
  const result = evaluate(expression, { angleMode });
  if (!result.ok) return { result, entry: null };
  const entry: HistoryEntry = { expr: expression.trim(), result: formatNumber(result.value) };
  const entries = await getHistoryIn(storage);
  await storage.set<HistoryDoc>(HISTORY_DOC_ID, { entries: pushHistory(entries, entry, cap) });
  return { result, entry };
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<CalculatorSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [angleMode, thousands, historyLength] = await Promise.all([
      c.settings.get<AngleMode>('angleMode'),
      c.settings.get<boolean>('thousands'),
      c.settings.get<number>('historyLength'),
    ]);
    return {
      angleMode: angleMode === 'rad' || angleMode === 'deg' ? angleMode : DEFAULT_SETTINGS.angleMode,
      thousands: thousands ?? DEFAULT_SETTINGS.thousands,
      historyLength: historyLength ?? DEFAULT_SETTINGS.historyLength,
    };
  }

  function SettingRow(props: { labelKey: string; children: ReactNode }) {
    return (
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 'var(--space-2)',
        }}
      >
        <span className="c-muted" style={{ fontSize: '0.85em' }}>
          {t(props.labelKey)}
        </span>
        {props.children}
      </label>
    );
  }

  function CalculatorWidget(props: WidgetProps) {
    const [input, setInput] = useState('');
    const [history, setHistory] = useState<HistoryEntry[]>([]);
    const [settings, setSettings] = useState<CalculatorSettings>({ ...DEFAULT_SETTINGS });
    const [angleMode, setAngleMode] = useState<AngleMode | null>(null);
    const [showSettings, setShowSettings] = useState(false);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [entries, loaded] = await Promise.all([getHistoryIn(c.storage), loadSettings()]);
      setHistory(entries);
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

    const lang = ctx?.i18n.language ?? 'en';
    const mode: AngleMode = angleMode ?? settings.angleMode;
    const trimmed = input.trim();
    const live = trimmed ? evaluate(trimmed, { angleMode: mode }) : null;
    const display = (value: number) =>
      formatDisplay(value, { locale: lang, grouping: settings.thousands });

    async function commit() {
      const c = ctx;
      if (!c || !trimmed) return;
      const { result } = await calcIn(c.storage, trimmed, mode, settings.historyLength);
      // Chain calculations: the (plain, re-parseable) result becomes the input.
      if (result.ok) setInput(formatNumber(result.value));
    }

    const append = (text: string) => setInput((prev) => prev + text);

    const inputRow = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        <input
          className="c-input"
          value={input}
          placeholder={t('tool.calculator.widget.placeholder')}
          aria-label={t('tool.calculator.widget.inputLabel')}
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          style={{ flex: 1, minWidth: 0, fontVariantNumeric: 'tabular-nums' }}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') setInput('');
          }}
        />
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.calculator.widget.settingsToggle')}
          title={t('tool.calculator.widget.settingsToggle')}
          aria-expanded={showSettings}
          style={{ flexShrink: 0 }}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
    );

    const resultLine = (
      <div
        aria-live="polite"
        style={{
          minHeight: '1.6em',
          textAlign: 'right',
          fontSize: '1.25em',
          fontVariantNumeric: 'tabular-nums',
          flexShrink: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {live === null ? (
          <span className="c-muted">0</span>
        ) : live.ok ? (
          <span>= {display(live.value)}</span>
        ) : (
          <span className="c-muted" style={{ fontSize: '0.75em' }}>
            {t(ERROR_KEYS[live.error])}
          </span>
        )}
      </div>
    );

    const settingsPanel = showSettings ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          flexShrink: 0,
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 'var(--space-2)',
        }}
      >
        <SettingRow labelKey="tool.calculator.settings.angleMode">
          <select
            className="c-input"
            value={settings.angleMode}
            style={{ width: 'auto' }}
            onChange={(e) => {
              const next = e.target.value === 'rad' ? 'rad' : 'deg';
              setAngleMode(null);
              void ctx?.settings.set('angleMode', next);
            }}
          >
            <option value="deg">{t('tool.calculator.widget.deg')}</option>
            <option value="rad">{t('tool.calculator.widget.rad')}</option>
          </select>
        </SettingRow>
        <SettingRow labelKey="tool.calculator.settings.thousands">
          <input
            type="checkbox"
            checked={settings.thousands}
            style={{ accentColor: 'var(--accent)' }}
            onChange={(e) => void ctx?.settings.set('thousands', e.target.checked)}
          />
        </SettingRow>
        <SettingRow labelKey="tool.calculator.settings.historyLength">
          <input
            className="c-input"
            type="number"
            min={1}
            max={200}
            value={settings.historyLength}
            style={{ width: 72, textAlign: 'right' }}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v >= 1 && v <= 200) {
                void ctx?.settings.set('historyLength', v);
              }
            }}
          />
        </SettingRow>
      </div>
    ) : null;

    const padButton = (label: string, insert: string | (() => void), primary = false) => (
      <button
        key={label}
        className={primary ? 'c-btn c-btn--primary' : 'c-btn c-btn--ghost'}
        style={{ padding: 'var(--space-1)', fontVariantNumeric: 'tabular-nums', minWidth: 0 }}
        onClick={() => {
          if (typeof insert === 'function') insert();
          else append(insert);
        }}
      >
        {label}
      </button>
    );

    const basicPad = (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 'var(--space-1)',
          flexShrink: 0,
        }}
      >
        {padButton('C', () => setInput(''))}
        {padButton('(', '(')}
        {padButton(')', ')')}
        {padButton('÷', '/')}
        {padButton('7', '7')}
        {padButton('8', '8')}
        {padButton('9', '9')}
        {padButton('×', '*')}
        {padButton('4', '4')}
        {padButton('5', '5')}
        {padButton('6', '6')}
        {padButton('−', '-')}
        {padButton('1', '1')}
        {padButton('2', '2')}
        {padButton('3', '3')}
        {padButton('+', '+')}
        {padButton('0', '0')}
        {padButton('.', '.')}
        {padButton('⌫', () => setInput((prev) => prev.slice(0, -1)))}
        {padButton('=', () => void commit(), true)}
      </div>
    );

    const scientificPad = (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 'var(--space-1)',
          flexShrink: 0,
        }}
      >
        <button
          className="c-btn c-btn--ghost"
          aria-pressed={mode === 'deg'}
          title={t('tool.calculator.widget.angleToggle')}
          style={{ padding: 'var(--space-1)', color: 'var(--accent)', minWidth: 0 }}
          onClick={() => setAngleMode(mode === 'deg' ? 'rad' : 'deg')}
        >
          {mode === 'deg' ? t('tool.calculator.widget.deg') : t('tool.calculator.widget.rad')}
        </button>
        {padButton('π', 'pi')}
        {padButton('e', 'e')}
        {padButton('^', '^')}
        {FUNCTION_NAMES.map((name) => padButton(name, `${name}(`))}
        {padButton('%', '%')}
      </div>
    );

    const historyList = (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-1)',
        }}
      >
        {history.length === 0 ? (
          <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-2)', fontSize: 12 }}>
            {t('tool.calculator.widget.emptyHistory')}
          </div>
        ) : (
          history.map((entry, i) => (
            <button
              key={`${entry.expr}:${i}`}
              className="c-btn c-btn--ghost"
              title={t('tool.calculator.widget.reuse')}
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 'var(--space-2)',
                padding: '0 var(--space-1)',
                fontVariantNumeric: 'tabular-nums',
                fontSize: 12,
                minWidth: 0,
              }}
              onClick={() => setInput(entry.expr)}
            >
              <span
                className="c-muted"
                style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              >
                {entry.expr}
              </span>
              <span style={{ flexShrink: 0 }}>= {entry.result}</span>
            </button>
          ))
        )}
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
        }}
      >
        {inputRow}
        {resultLine}
        {settingsPanel}
        {props.variant === 'scientific' ? scientificPad : null}
        {props.variant !== 'compact' ? basicPad : null}
        {historyList}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'calculator.calc',
        titleKey: 'tool.calculator.command.calc',
        descriptionKey: 'tool.calculator.command.calcDesc',
        icon: '=',
        assistant: true,
        params: calcParamsSchema,
        selfTestParams: { expression: '2+3*4' },
        async run({ expression }): Promise<CommandResult> {
          const [angleMode, historyLength] = await Promise.all([
            context.settings.get<AngleMode>('angleMode'),
            context.settings.get<number>('historyLength'),
          ]);
          const { result, entry } = await calcIn(
            context.storage,
            expression,
            angleMode === 'rad' ? 'rad' : 'deg',
            historyLength ?? DEFAULT_HISTORY_CAP,
          );
          if (!result.ok) {
            return { ok: false, messageKey: ERROR_KEYS[result.error] };
          }
          return {
            ok: true,
            data: {
              text: `${entry?.expr ?? expression} = ${entry?.result ?? formatNumber(result.value)}`,
              value: result.value,
            },
            messageKey: 'tool.calculator.msg.calculated',
          };
        },
      });

      context.commands.register({
        id: 'calculator.context',
        titleKey: 'tool.calculator.command.context',
        descriptionKey: 'tool.calculator.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const entries = await getHistoryIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildCalcContext(entries, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: CalculatorWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'parser': {
          const good: Array<[string, number]> = [
            ['1+1', 2],
            ['2+3*4', 14],
            ['(2+3)*4', 20],
            ['2^3^2', 512],
            ['-3^2', -9],
            ['(-3)^2', 9],
            ['2^-3', 0.125],
            ['10-4-3', 3],
            ['20/4/5', 1],
            ['7%3', 1],
            ['sqrt(16)', 4],
            ['abs(-7)', 7],
            ['round(2.5)', 3],
            ['floor(2.9)', 2],
            ['ceil(2.1)', 3],
            ['log(1000)', 3],
            ['((1+2)*(3+4))', 21],
            ['.5+.5', 1],
          ];
          for (const [expr, expected] of good) {
            const result = evaluate(expr, { angleMode: 'rad' });
            if (!result.ok || Math.abs(result.value - expected) > 1e-9) {
              return {
                status: 'fail',
                detail: `"${expr}" → ${JSON.stringify(result)}, expected ${expected}`,
              };
            }
          }
          const deg = evaluate('sin(90)', { angleMode: 'deg' });
          const rad = evaluate('sin(pi/2)', { angleMode: 'rad' });
          if (!deg.ok || Math.abs(deg.value - 1) > 1e-9 || !rad.ok || Math.abs(rad.value - 1) > 1e-9) {
            return { status: 'fail', detail: 'trig angle modes broken' };
          }
          const bad: Array<[string, string]> = [
            ['2++', 'syntax'],
            ['(', 'syntax'],
            ['2 3', 'syntax'],
            ['1/0', 'division-by-zero'],
            ['foo(3)', 'unknown-token'],
            ['sqrt(-1)', 'math'],
          ];
          for (const [expr, expectedError] of bad) {
            const result = evaluate(expr);
            if (result.ok || result.error !== expectedError) {
              return {
                status: 'fail',
                detail: `"${expr}" → ${JSON.stringify(result)}, expected error "${expectedError}"`,
              };
            }
          }
          return { status: 'pass', detail: `${good.length + bad.length + 2} parser checks ok` };
        }
        case 'calc-command': {
          const before = await testCtx.storage.get<HistoryDoc>(HISTORY_DOC_ID);
          const { result, entry } = await calcIn(testCtx.storage, '6*7', 'deg', 50);
          const doc = await testCtx.storage.get<HistoryDoc>(HISTORY_DOC_ID);
          // Restore whatever the scratch DB held before the probe.
          if (before) await testCtx.storage.set<HistoryDoc>(HISTORY_DOC_ID, before);
          else await testCtx.storage.delete(HISTORY_DOC_ID);
          if (!result.ok || result.value !== 42 || entry?.result !== '42') {
            return { status: 'fail', detail: `6*7 → ${JSON.stringify(result)}` };
          }
          if (doc?.entries[0]?.expr !== '6*7' || doc.entries[0].result !== '42') {
            return { status: 'fail', detail: `history head wrong: ${JSON.stringify(doc?.entries[0])}` };
          }
          return { status: 'pass', detail: '6*7 = 42 calculated and recorded' };
        }
        case 'history-crud': {
          const before = await testCtx.storage.get<HistoryDoc>(HISTORY_DOC_ID);
          let entries: HistoryDoc['entries'] = [];
          for (let i = 0; i < 55; i++) {
            entries = pushHistory(entries, { expr: `${i}+0`, result: String(i) }, 50);
          }
          await testCtx.storage.set<HistoryDoc>(HISTORY_DOC_ID, { entries });
          const back = await testCtx.storage.get<HistoryDoc>(HISTORY_DOC_ID);
          if (before) await testCtx.storage.set<HistoryDoc>(HISTORY_DOC_ID, before);
          else await testCtx.storage.delete(HISTORY_DOC_ID);
          if (!back || back.entries.length !== 50) {
            return { status: 'fail', detail: `expected 50 capped entries, got ${back?.entries.length}` };
          }
          if (back.entries[0]?.result !== '54') {
            return { status: 'fail', detail: `newest entry wrong: ${JSON.stringify(back.entries[0])}` };
          }
          return { status: 'pass', detail: 'history doc roundtrip with 50-entry cap ok' };
        }
        case 'render':
          return typeof CalculatorWidget === 'function' && CalculatorWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
