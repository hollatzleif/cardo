import { useCallback, useEffect, useMemo, useState } from 'react';
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
  addGoalParamsSchema,
  buildSavingsContext,
  contributeParamsSchema,
  formatMoney,
  isValidDeadline,
  makeGoal,
  neededPerDay,
  onTrack,
  progressOf,
  todayIso,
  type GoalDoc,
} from './logic';

/** Currency is a pure DISPLAY setting – no FX math anywhere. */
const DEFAULT_CURRENCY = '€';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryGoalsIn(storage: ToolStorage): Promise<GoalDoc[]> {
  const goals = await storage.query<GoalDoc>({
    where: [{ field: 'type', op: '=', value: 'goal' }],
  });
  return [...goals].sort((a, b) =>
    a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
  );
}

async function addGoalIn(
  storage: ToolStorage,
  input: { name: string; target: number; deadline?: string },
): Promise<GoalDoc> {
  const goal = makeGoal(input);
  await storage.set(goal.id, goal);
  return goal;
}

/** Add `amount` to a goal's saved total (clamped at 0). Null when the goal is gone. */
async function contributeIn(
  storage: ToolStorage,
  id: string,
  amount: number,
): Promise<GoalDoc | null> {
  const goal = await storage.get<GoalDoc>(id);
  if (!goal) return null;
  const next: GoalDoc = { ...goal, saved: Math.max(0, goal.saved + amount) };
  await storage.set(id, next);
  return next;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /** SVG jar whose fill level follows the saving progress. */
  function JarSvg(props: { progress: number; label: string; animate: boolean }) {
    const innerH = 44;
    const bottom = 71;
    const fillH = innerH * props.progress;
    return (
      <svg
        viewBox="0 0 60 80"
        role="img"
        aria-label={props.label}
        style={{ width: 56, height: 74, flexShrink: 0 }}
      >
        <rect
          x={15}
          y={bottom - fillH}
          width={30}
          height={fillH}
          rx={3}
          fill="var(--accent)"
          opacity={0.75}
          style={props.animate ? { transition: 'y 0.4s ease, height 0.4s ease' } : undefined}
        />
        <rect
          x={17}
          y={8}
          width={26}
          height={7}
          rx={2}
          fill="none"
          stroke="var(--text-muted)"
          strokeWidth={2}
        />
        <path
          d="M19 15 v5 q-7 4 -7 11 v33 q0 9 9 9 h18 q9 0 9 -9 v-33 q0 -7 -7 -11 v-5"
          fill="none"
          stroke="var(--text-muted)"
          strokeWidth={2}
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  function SavingsWidget(props: WidgetProps) {
    const [goals, setGoals] = useState<GoalDoc[]>([]);
    const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
    const [name, setName] = useState('');
    const [target, setTarget] = useState('');
    const [deadline, setDeadline] = useState('');
    const [amounts, setAmounts] = useState<Record<string, string>>({});
    const [showSettings, setShowSettings] = useState(false);

    // Spec: honor prefers-reduced-motion – no fill transition then.
    const animate = useMemo(
      () =>
        typeof window === 'undefined' ||
        !window.matchMedia ||
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      [],
    );

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [gs, cur] = await Promise.all([
        queryGoalsIn(c.storage),
        c.settings.get<string>('currency'),
      ]);
      setGoals(gs);
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

    async function addGoal() {
      const c = ctx;
      const parsedTarget = Number(target.replace(',', '.'));
      if (!c || !name.trim() || !Number.isFinite(parsedTarget) || parsedTarget <= 0) return;
      if (deadline && !isValidDeadline(deadline)) return;
      const input: { name: string; target: number; deadline?: string } = {
        name,
        target: parsedTarget,
      };
      if (deadline) input.deadline = deadline;
      await addGoalIn(c.storage, input);
      setName('');
      setTarget('');
      setDeadline('');
    }

    async function contribute(goal: GoalDoc) {
      const c = ctx;
      const amount = Number((amounts[goal.id] ?? '').replace(',', '.'));
      if (!c || !Number.isFinite(amount) || amount <= 0) return;
      await contributeIn(c.storage, goal.id, amount);
      setAmounts((prev) => ({ ...prev, [goal.id]: '' }));
    }

    async function removeGoal(goal: GoalDoc) {
      await ctx?.storage.delete(goal.id);
    }

    const money = (value: number) => formatMoney(value, lang, currency);

    /** Deadline / rate / reached line shared by all variants. */
    const goalMeta = (goal: GoalDoc) => {
      const progress = progressOf(goal);
      if (progress >= 1) {
        return (
          <span style={{ color: 'var(--success)', fontSize: 12 }}>
            {t('tool.savings-jar.widget.reached')}
          </span>
        );
      }
      if (!goal.deadline) return null;
      const rate = neededPerDay(goal, today);
      const track = onTrack(goal, today);
      return (
        <span className="c-muted" style={{ fontSize: 12 }}>
          {t('tool.savings-jar.widget.deadline', { date: goal.deadline })}
          {rate > 0 ? ` · ${t('tool.savings-jar.widget.perDay', { amount: money(rate) })}` : ''}
          {' · '}
          <span style={{ color: track ? 'var(--success)' : 'var(--warning)' }}>
            {t(track ? 'tool.savings-jar.widget.onTrack' : 'tool.savings-jar.widget.behind')}
          </span>
        </span>
      );
    };

    const contributeControls = (goal: GoalDoc) => (
      <span style={{ display: 'inline-flex', gap: 'var(--space-1)', alignItems: 'center' }}>
        <input
          className="c-input"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={amounts[goal.id] ?? ''}
          aria-label={t('tool.savings-jar.widget.amountLabel')}
          title={t('tool.savings-jar.widget.amountLabel')}
          style={{ width: 64, textAlign: 'right' }}
          onChange={(e) => setAmounts((prev) => ({ ...prev, [goal.id]: e.target.value }))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void contribute(goal);
          }}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.savings-jar.widget.contribute', { name: goal.name })}
          title={t('tool.savings-jar.widget.contribute', { name: goal.name })}
          style={{ padding: 'var(--space-1) var(--space-2)', flexShrink: 0 }}
          onClick={() => void contribute(goal)}
        >
          +
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.savings-jar.widget.deleteGoal', { name: goal.name })}
          title={t('tool.savings-jar.widget.deleteGoal', { name: goal.name })}
          style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)', flexShrink: 0 }}
          onClick={() => void removeGoal(goal)}
        >
          ×
        </button>
      </span>
    );

    const progressLabel = (goal: GoalDoc) =>
      t('tool.savings-jar.widget.progressLabel', {
        name: goal.name,
        saved: money(goal.saved),
        target: money(goal.target),
      });

    const renderJar = (goal: GoalDoc) => (
      <div
        key={goal.id}
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'var(--space-1)',
          padding: 'var(--space-2)',
          minWidth: 120,
          textAlign: 'center',
        }}
      >
        <JarSvg progress={progressOf(goal)} label={progressLabel(goal)} animate={animate} />
        <span
          style={{
            fontWeight: 600,
            maxWidth: 140,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {goal.name}
        </span>
        <span className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          {money(goal.saved)} / {money(goal.target)}
        </span>
        {goalMeta(goal)}
        {contributeControls(goal)}
      </div>
    );

    const renderBarRow = (goal: GoalDoc) => {
      const progress = progressOf(goal);
      return (
        <div key={goal.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span
              style={{
                fontWeight: 600,
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {goal.name}
            </span>
            <span className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {money(goal.saved)} / {money(goal.target)}
            </span>
            {contributeControls(goal)}
          </div>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={progressLabel(goal)}
            style={{
              height: 6,
              borderRadius: 999,
              background: 'var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: '100%',
                borderRadius: 999,
                background: 'var(--accent)',
                transition: animate ? 'width 0.4s ease' : undefined,
              }}
            />
          </div>
          {goalMeta(goal)}
        </div>
      );
    };

    const renderCard = (goal: GoalDoc) => {
      const progress = progressOf(goal);
      return (
        <div
          key={goal.id}
          className="c-card"
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-1)',
            padding: 'var(--space-2)',
            border: '1px solid var(--border-subtle)',
            borderRadius: 'var(--radius-sm)',
            minWidth: 0,
          }}
        >
          <span
            style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          >
            {goal.name}
          </span>
          <span style={{ fontSize: '1.4em', fontVariantNumeric: 'tabular-nums' }}>
            {money(goal.saved)}
          </span>
          <span className="c-muted" style={{ fontSize: 12 }}>
            / {money(goal.target)} ({Math.round(progress * 100)} %)
          </span>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            aria-label={progressLabel(goal)}
            style={{ height: 4, borderRadius: 999, background: 'var(--border-subtle)', overflow: 'hidden' }}
          >
            <div
              style={{
                width: `${progress * 100}%`,
                height: '100%',
                background: 'var(--accent)',
                transition: animate ? 'width 0.4s ease' : undefined,
              }}
            />
          </div>
          {goalMeta(goal)}
          {contributeControls(goal)}
        </div>
      );
    };

    const goalArea =
      goals.length === 0 ? (
        <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
          {t('tool.savings-jar.widget.empty')}
        </div>
      ) : props.variant === 'bar' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {goals.map(renderBarRow)}
        </div>
      ) : props.variant === 'cards' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
            gap: 'var(--space-2)',
          }}
        >
          {goals.map(renderCard)}
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: 'var(--space-2)',
          }}
        >
          {goals.map(renderJar)}
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
        {/* Add goal */}
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
          <input
            className="c-input"
            value={name}
            placeholder={t('tool.savings-jar.widget.namePlaceholder')}
            aria-label={t('tool.savings-jar.widget.namePlaceholder')}
            style={{ flex: 2, minWidth: 90 }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addGoal();
            }}
          />
          <input
            className="c-input"
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={target}
            placeholder={t('tool.savings-jar.widget.targetPlaceholder')}
            aria-label={t('tool.savings-jar.widget.targetPlaceholder')}
            style={{ width: 84, textAlign: 'right' }}
            onChange={(e) => setTarget(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addGoal();
            }}
          />
          <input
            className="c-input"
            type="date"
            value={deadline}
            aria-label={t('tool.savings-jar.widget.deadlineLabel')}
            title={t('tool.savings-jar.widget.deadlineLabel')}
            style={{ width: 'auto' }}
            onChange={(e) => setDeadline(e.target.value)}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.savings-jar.widget.addGoal')}
            title={t('tool.savings-jar.widget.addGoal')}
            style={{ flexShrink: 0 }}
            onClick={() => void addGoal()}
          >
            +
          </button>
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.savings-jar.widget.settingsToggle')}
            title={t('tool.savings-jar.widget.settingsToggle')}
            aria-expanded={showSettings}
            style={{ flexShrink: 0 }}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        </div>

        {showSettings && (
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
              {t('tool.savings-jar.settings.currency')}
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
        )}

        {/* Goals */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{goalArea}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'savings-jar.add-goal',
        titleKey: 'tool.savings-jar.command.addGoal',
        descriptionKey: 'tool.savings-jar.command.addGoalDesc',
        icon: 'plus',
        params: addGoalParamsSchema,
        selfTestParams: { name: 'Cardo self-test goal', target: 100 },
        async run(params): Promise<CommandResult> {
          if (params.deadline && !isValidDeadline(params.deadline)) {
            return { ok: false, messageKey: 'tool.savings-jar.msg.invalidDeadline' };
          }
          const goal = await addGoalIn(context.storage, params);
          return { ok: true, data: goal, messageKey: 'tool.savings-jar.msg.goalAdded' };
        },
      });

      // NOTE on selfTestParams: diagnostics executes the command against a
      // scratch database where this probe id never exists. run() treats
      // "not found" as a graceful no-op (ok:true + friendly toast), so the
      // command stays verifiable and real callers never crash on stale ids.
      context.commands.register({
        id: 'savings-jar.contribute',
        titleKey: 'tool.savings-jar.command.contribute',
        descriptionKey: 'tool.savings-jar.command.contributeDesc',
        icon: 'plus',
        palette: false,
        assistant: true,
        params: contributeParamsSchema,
        selfTestParams: { id: 'goal:selftest-nonexistent', amount: 1 },
        async run({ id, amount }): Promise<CommandResult> {
          const goal = await contributeIn(context.storage, id, amount);
          if (!goal) return { ok: true, messageKey: 'tool.savings-jar.msg.notFound' };
          return { ok: true, data: goal, messageKey: 'tool.savings-jar.msg.contributed' };
        },
      });

      context.commands.register({
        id: 'savings-jar.context',
        titleKey: 'tool.savings-jar.command.context',
        descriptionKey: 'tool.savings-jar.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const goals = await queryGoalsIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildSavingsContext(goals, context.i18n.language, todayIso()) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: SavingsWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const goal = await addGoalIn(testCtx.storage, {
            name: 'selftest goal',
            target: 250,
            deadline: '2099-12-31',
          });
          const back = await testCtx.storage.get<GoalDoc>(goal.id);
          await testCtx.storage.delete(goal.id);
          const gone = await testCtx.storage.get<GoalDoc>(goal.id);
          if (!back || back.name !== 'selftest goal' || back.target !== 250 || back.saved !== 0) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (back.deadline !== '2099-12-31') {
            return { status: 'fail', detail: `deadline lost in roundtrip: ${JSON.stringify(back)}` };
          }
          if (gone !== null) {
            return { status: 'fail', detail: 'goal still present after delete' };
          }
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'contribute-command': {
          const goal = await addGoalIn(testCtx.storage, { name: 'selftest contribute', target: 100 });
          const once = await contributeIn(testCtx.storage, goal.id, 25);
          const twice = await contributeIn(testCtx.storage, goal.id, 30.5);
          const back = await testCtx.storage.get<GoalDoc>(goal.id);
          await testCtx.storage.delete(goal.id);
          if (once?.saved !== 25 || twice?.saved !== 55.5 || back?.saved !== 55.5) {
            return {
              status: 'fail',
              detail: `expected saved 25 → 55.5, got ${once?.saved} → ${back?.saved}`,
            };
          }
          const missing = await contributeIn(testCtx.storage, 'goal:selftest-nonexistent', 1);
          if (missing !== null) {
            return { status: 'fail', detail: 'contributing to a missing goal must return null' };
          }
          return { status: 'pass', detail: 'contributions accumulate on the stored goal' };
        }
        case 'render':
          return typeof SavingsWidget === 'function' && SavingsWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
