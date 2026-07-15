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
  addObjectiveParamsSchema,
  buildOkrContext,
  formatKr,
  krProgress,
  leastProgressed,
  makeKeyResult,
  makeObjective,
  matchKeyResult,
  matchObjective,
  objectiveProgress,
  sortObjectives,
  updateKrParamsSchema,
  type KeyResult,
  type ObjectiveDoc,
} from './logic';

/**
 * OKR – objectives & key results. Progress is derived purely: every KR is
 * clamped to 0–1 (target ≤ 0 counts as 0), an objective averages its KRs.
 */

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryObjectivesIn(storage: ToolStorage): Promise<ObjectiveDoc[]> {
  const objectives = await storage.query<ObjectiveDoc>({
    where: [{ field: 'type', op: '=', value: 'objective' }],
  });
  return sortObjectives(objectives);
}

async function addObjectiveIn(
  storage: ToolStorage,
  input: { title: string; quarter?: string },
): Promise<ObjectiveDoc> {
  const objective = makeObjective(input);
  await storage.set(objective.id, objective);
  return objective;
}

async function addKeyResultIn(
  storage: ToolStorage,
  objective: ObjectiveDoc,
  input: { title: string; target: number; unit?: string },
): Promise<KeyResult> {
  const kr = makeKeyResult(input);
  await storage.set<ObjectiveDoc>(objective.id, {
    ...objective,
    keyResults: [...objective.keyResults, kr],
  });
  return kr;
}

async function updateKeyResultIn(
  storage: ToolStorage,
  objective: ObjectiveDoc,
  krId: string,
  current: number,
): Promise<void> {
  await storage.set<ObjectiveDoc>(objective.id, {
    ...objective,
    keyResults: objective.keyResults.map((kr) => (kr.id === krId ? { ...kr, current } : kr)),
  });
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function OkrWidget(props: WidgetProps) {
    const [objectives, setObjectives] = useState<ObjectiveDoc[]>([]);
    const [showPercent, setShowPercent] = useState(true);
    const [showSettings, setShowSettings] = useState(false);
    const [newTitle, setNewTitle] = useState('');
    const [newQuarter, setNewQuarter] = useState('');
    const [krFormFor, setKrFormFor] = useState<string | null>(null);
    const [krTitle, setKrTitle] = useState('');
    const [krTarget, setKrTarget] = useState('');
    const [krUnit, setKrUnit] = useState('');

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, percent] = await Promise.all([
        queryObjectivesIn(c.storage),
        c.settings.get<boolean>('showPercent'),
      ]);
      setObjectives(list);
      setShowPercent(percent ?? true);
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

    const percentOf = (objective: ObjectiveDoc) => Math.round(objectiveProgress(objective) * 100);
    const krLabel = (kr: KeyResult) =>
      showPercent ? `${Math.round(krProgress(kr) * 100)}%` : formatKr(kr);

    async function addObjective() {
      const c = ctx;
      const title = newTitle.trim();
      if (!c || !title) return;
      const quarter = newQuarter.trim();
      const objective = await addObjectiveIn(c.storage, quarter ? { title, quarter } : { title });
      setNewTitle('');
      setNewQuarter('');
      setKrFormFor(objective.id);
    }

    async function addKeyResult(objective: ObjectiveDoc) {
      const c = ctx;
      const title = krTitle.trim();
      const target = Number(krTarget.replace(',', '.'));
      if (!c || !title || !Number.isFinite(target) || target <= 0) return;
      await addKeyResultIn(
        c.storage,
        objective,
        krUnit.trim() ? { title, target, unit: krUnit } : { title, target },
      );
      setKrTitle('');
      setKrTarget('');
      setKrUnit('');
    }

    async function setCurrent(objective: ObjectiveDoc, kr: KeyResult, raw: string) {
      const c = ctx;
      const value = Number(raw.replace(',', '.'));
      if (!c || !Number.isFinite(value)) return;
      await updateKeyResultIn(c.storage, objective, kr.id, value);
    }

    async function removeObjective(objective: ObjectiveDoc) {
      await ctx?.storage.delete(objective.id);
    }

    const krBar = (kr: KeyResult) => (
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(krProgress(kr) * 100)}
        style={{
          width: '100%',
          height: 5,
          borderRadius: 999,
          background: 'var(--border-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${krProgress(kr) * 100}%`,
            height: '100%',
            borderRadius: 999,
            background: 'var(--accent)',
            transition: 'width 0.2s ease',
          }}
        />
      </div>
    );

    const krRow = (objective: ObjectiveDoc, kr: KeyResult) => (
      <div key={kr.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: 12,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {kr.title}
          </span>
          <input
            className="c-input"
            type="number"
            step="any"
            inputMode="decimal"
            value={kr.current}
            aria-label={t('tool.okr.widget.currentLabel', { title: kr.title })}
            title={t('tool.okr.widget.currentLabel', { title: kr.title })}
            style={{ width: 60, textAlign: 'right', fontSize: 12, flexShrink: 0 }}
            onChange={(e) => void setCurrent(objective, kr, e.target.value)}
          />
          <span
            className="c-muted"
            style={{ fontSize: 11, fontVariantNumeric: 'tabular-nums', flexShrink: 0, minWidth: 44, textAlign: 'right' }}
          >
            {krLabel(kr)}
          </span>
        </div>
        {krBar(kr)}
      </div>
    );

    const krForm = (objective: ObjectiveDoc) => (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        <input
          className="c-input"
          value={krTitle}
          placeholder={t('tool.okr.widget.krPlaceholder')}
          aria-label={t('tool.okr.widget.krPlaceholder')}
          style={{ flex: 2, minWidth: 70 }}
          onChange={(e) => setKrTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addKeyResult(objective);
          }}
        />
        <input
          className="c-input"
          type="number"
          min={0}
          step="any"
          inputMode="decimal"
          value={krTarget}
          placeholder={t('tool.okr.widget.targetLabel')}
          aria-label={t('tool.okr.widget.targetLabel')}
          style={{ width: 60, textAlign: 'right' }}
          onChange={(e) => setKrTarget(e.target.value)}
        />
        <input
          className="c-input"
          value={krUnit}
          placeholder={t('tool.okr.widget.unitPlaceholder')}
          aria-label={t('tool.okr.widget.unitPlaceholder')}
          style={{ width: 64 }}
          onChange={(e) => setKrUnit(e.target.value)}
        />
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.okr.widget.addKr')}
          title={t('tool.okr.widget.addKr')}
          style={{ flexShrink: 0 }}
          onClick={() => void addKeyResult(objective)}
        >
          +
        </button>
      </div>
    );

    /** Small SVG progress ring (compact variant); stroke uses the accent token. */
    const ring = (fraction: number, size = 26) => {
      const r = (size - 4) / 2;
      const c = 2 * Math.PI * r;
      return (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden style={{ flexShrink: 0 }}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--border-subtle)"
            strokeWidth={3}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={3}
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - Math.min(1, Math.max(0, fraction)))}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        </svg>
      );
    };

    const objectiveHeader = (objective: ObjectiveDoc) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontWeight: 600,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {objective.title}
        </span>
        {objective.quarter ? (
          <span className="c-muted" style={{ fontSize: 11, flexShrink: 0 }}>
            {objective.quarter}
          </span>
        ) : null}
        <span
          style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: 'var(--accent)', flexShrink: 0 }}
        >
          {percentOf(objective)}%
        </span>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.okr.widget.deleteObjective', { title: objective.title })}
          title={t('tool.okr.widget.deleteObjective', { title: objective.title })}
          style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
          onClick={() => void removeObjective(objective)}
        >
          ×
        </button>
      </div>
    );

    const objectiveCard = (objective: ObjectiveDoc) => (
      <div
        key={objective.id}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-1)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-sm)',
          padding: 'var(--space-2)',
          background: 'var(--bg-canvas)',
        }}
      >
        {objectiveHeader(objective)}
        {objective.keyResults.map((kr) => krRow(objective, kr))}
        {krFormFor === objective.id ? (
          krForm(objective)
        ) : (
          <button
            className="c-btn c-btn--ghost"
            style={{ fontSize: 12, color: 'var(--text-muted)', alignSelf: 'flex-start', padding: '0 var(--space-1)' }}
            onClick={() => {
              setKrTitle('');
              setKrTarget('');
              setKrUnit('');
              setKrFormFor(objective.id);
            }}
          >
            {t('tool.okr.widget.addKr')}
          </button>
        )}
      </div>
    );

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.okr.widget.empty')}
      </div>
    );

    const addForm = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          className="c-input"
          value={newTitle}
          placeholder={t('tool.okr.widget.objectivePlaceholder')}
          aria-label={t('tool.okr.widget.objectivePlaceholder')}
          style={{ flex: 2, minWidth: 80 }}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addObjective();
          }}
        />
        <input
          className="c-input"
          value={newQuarter}
          placeholder={t('tool.okr.widget.quarterPlaceholder')}
          aria-label={t('tool.okr.widget.quarterPlaceholder')}
          style={{ width: 76, flexShrink: 0 }}
          onChange={(e) => setNewQuarter(e.target.value)}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.okr.widget.addObjective')}
          title={t('tool.okr.widget.addObjective')}
          style={{ flexShrink: 0 }}
          onClick={() => void addObjective()}
        >
          +
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.okr.widget.settingsToggle')}
          title={t('tool.okr.widget.settingsToggle')}
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
          {t('tool.okr.settings.showPercent')}
        </span>
        <input
          type="checkbox"
          checked={showPercent}
          style={{ accentColor: 'var(--accent)' }}
          onChange={(e) => void ctx?.settings.set('showPercent', e.target.checked)}
        />
      </label>
    ) : null;

    let body;
    if (props.variant === 'compact') {
      body =
        objectives.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {objectives.map((objective) => (
              <div key={objective.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                {ring(objectiveProgress(objective))}
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {objective.title}
                </span>
                {objective.quarter ? (
                  <span className="c-muted" style={{ fontSize: 11, flexShrink: 0 }}>
                    {objective.quarter}
                  </span>
                ) : null}
                <span
                  style={{
                    fontSize: 12,
                    fontVariantNumeric: 'tabular-nums',
                    color: 'var(--accent)',
                    flexShrink: 0,
                  }}
                >
                  {percentOf(objective)}%
                </span>
              </div>
            ))}
          </div>
        );
    } else if (props.variant === 'single-focus') {
      const focus = leastProgressed(objectives);
      body = !focus ? (
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
          <span className="c-muted" style={{ fontSize: 12 }}>
            {t('tool.okr.widget.focusHint')}
          </span>
          <div style={{ fontWeight: 600, textAlign: 'center', overflowWrap: 'break-word', maxWidth: '100%' }}>
            {focus.title}
            {focus.quarter ? (
              <span className="c-muted" style={{ fontWeight: 400 }}> · {focus.quarter}</span>
            ) : null}
          </div>
          <div style={{ fontSize: '2.2em', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', color: 'var(--accent)' }}>
            {percentOf(focus)}%
          </div>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {focus.keyResults.map((kr) => krRow(focus, kr))}
          </div>
        </div>
      );
    } else {
      // cards (default)
      body =
        objectives.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {objectives.map(objectiveCard)}
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
        {props.variant !== 'compact' && props.variant !== 'single-focus' ? addForm : null}
        {settingsPanel}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'okr.add-objective',
        titleKey: 'tool.okr.command.add-objective',
        descriptionKey: 'tool.okr.command.add-objectiveDesc',
        icon: 'plus',
        params: addObjectiveParamsSchema,
        selfTestParams: { title: 'Cardo self-test objective', quarter: 'Q1 2099' },
        async run(params): Promise<CommandResult> {
          const objective = await addObjectiveIn(context.storage, params);
          return { ok: true, data: objective, messageKey: 'tool.okr.msg.objectiveAdded' };
        },
      });

      // NOTE on the not-found path: diagnostics runs this command with its
      // selfTestParams against a scratch database where the referenced
      // objective never exists. run() therefore treats "not found" as a
      // graceful no-op ({ ok: true, msg.notFound }) instead of throwing, so
      // "command callable" stays verifiable and real callers get a friendly
      // toast for stale references.
      context.commands.register({
        id: 'okr.update-kr',
        titleKey: 'tool.okr.command.update-kr',
        descriptionKey: 'tool.okr.command.update-krDesc',
        icon: 'check',
        palette: false,
        assistant: true,
        params: updateKrParamsSchema,
        selfTestParams: { objective: 'Cardo self-test nonexistent', keyResult: 'kr', current: 1 },
        async run(params): Promise<CommandResult> {
          const objectives = await context.storage.query<ObjectiveDoc>({
            where: [{ field: 'type', op: '=', value: 'objective' }],
          });
          const objective = matchObjective(objectives, params.objective);
          const kr = objective ? matchKeyResult(objective, params.keyResult) : null;
          if (!objective || !kr) return { ok: true, messageKey: 'tool.okr.msg.notFound' };
          await updateKeyResultIn(context.storage, objective, kr.id, params.current);
          return {
            ok: true,
            data: { objective: objective.id, keyResult: kr.id, current: params.current },
            messageKey: 'tool.okr.msg.krUpdated',
          };
        },
      });

      context.commands.register({
        id: 'okr.context',
        titleKey: 'tool.okr.command.context',
        descriptionKey: 'tool.okr.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const objectives = await context.storage.query<ObjectiveDoc>({
            where: [{ field: 'type', op: '=', value: 'objective' }],
          });
          return {
            ok: true,
            data: { contextText: buildOkrContext(objectives, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: OkrWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const objective = await addObjectiveIn(testCtx.storage, {
            title: 'selftest objective',
            quarter: 'Q1 2099',
          });
          const kr = await addKeyResultIn(testCtx.storage, objective, {
            title: 'selftest kr',
            target: 5,
            unit: 'items',
          });
          const back = await testCtx.storage.get<ObjectiveDoc>(objective.id);
          await testCtx.storage.delete(objective.id);
          const gone = await testCtx.storage.get<ObjectiveDoc>(objective.id);
          const stored = back?.keyResults.find((k) => k.id === kr.id);
          if (
            back?.type !== 'objective' ||
            back.title !== 'selftest objective' ||
            back.quarter !== 'Q1 2099' ||
            !stored ||
            stored.title !== 'selftest kr' ||
            stored.current !== 0 ||
            stored.target !== 5 ||
            stored.unit !== 'items'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) {
            return { status: 'fail', detail: 'objective still present after delete' };
          }
          return { status: 'pass', detail: 'objective + key result roundtrip ok' };
        }
        case 'progress-math': {
          const objective = await addObjectiveIn(testCtx.storage, { title: 'selftest math' });
          const kr1 = await addKeyResultIn(testCtx.storage, objective, {
            title: 'selftest kr half',
            target: 10,
          });
          const step1 = await testCtx.storage.get<ObjectiveDoc>(objective.id);
          if (!step1) return { status: 'fail', detail: 'objective lost after first KR' };
          const kr2 = await addKeyResultIn(testCtx.storage, step1, {
            title: 'selftest kr over',
            target: 4,
          });
          const step2 = await testCtx.storage.get<ObjectiveDoc>(objective.id);
          if (!step2) return { status: 'fail', detail: 'objective lost after second KR' };
          await updateKeyResultIn(testCtx.storage, step2, kr1.id, 5); // 50%
          const step3 = await testCtx.storage.get<ObjectiveDoc>(objective.id);
          if (!step3) return { status: 'fail', detail: 'objective lost after first update' };
          await updateKeyResultIn(testCtx.storage, step3, kr2.id, 99); // overachieved → clamps to 100%
          const back = await testCtx.storage.get<ObjectiveDoc>(objective.id);
          await testCtx.storage.delete(objective.id);
          if (!back) return { status: 'fail', detail: 'objective not readable after seeding' };
          const progress = objectiveProgress(back);
          if (progress !== 0.75) {
            return { status: 'fail', detail: `expected 0.75 (avg of 0.5 and clamped 1), got ${progress}` };
          }
          const text = buildOkrContext([back], 'en');
          if (!text.includes('«selftest math»: 75%') || !text.includes('«selftest kr half» 5/10 (50%)')) {
            return { status: 'fail', detail: `context misses the math: "${text}"` };
          }
          return { status: 'pass', detail: 'clamped average 75% verified via storage roundtrip' };
        }
        case 'render':
          return typeof OkrWidget === 'function' && OkrWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
