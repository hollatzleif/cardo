import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
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
  ALL_SLOTS,
  BASE_SLOTS,
  SHOPPING_STATE_ID,
  aggregateIngredients,
  buildMealContext,
  formatIngredients,
  localDateKey,
  parseIngredients,
  slotKey,
  weekDates,
  type AggregatedLine,
  type ShoppingStateDoc,
  type Slot,
  type SlotDoc,
} from './logic';

/**
 * Meal planner – a week of meals plus an aggregated shopping list, fully
 * local. Every meal slot lives in its own `slot:<date>:<slot>` doc; the
 * shopping list is aggregated on the fly from the visible week and its
 * checked state lives in a single local `shopping-state` doc.
 */

type MealPlannerSettings = {
  /** Show the optional fourth "snack" slot. */
  snackSlot: boolean;
  weekStartsMonday: boolean;
};

const DEFAULT_SETTINGS: MealPlannerSettings = { snackSlot: false, weekStartsMonday: true };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function querySlotsIn(storage: ToolStorage): Promise<SlotDoc[]> {
  return storage.query<SlotDoc>({ where: [{ field: 'type', op: '=', value: 'slot' }] });
}

async function setMealIn(
  storage: ToolStorage,
  date: string,
  slot: Slot,
  meal: string,
  ingredients?: SlotDoc['ingredients'],
): Promise<SlotDoc | null> {
  const id = slotKey(date, slot);
  const existing = await storage.get<SlotDoc>(id);
  const trimmed = meal.trim();
  const nextIngredients = ingredients ?? existing?.ingredients ?? [];
  if (!trimmed && nextIngredients.length === 0) {
    // Clearing a slot removes the doc entirely.
    if (existing) await storage.delete(id);
    return null;
  }
  const doc: SlotDoc = { id, type: 'slot', date, slot, meal: trimmed, ingredients: nextIngredients };
  await storage.set<SlotDoc>(id, doc);
  return doc;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<MealPlannerSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [snackSlot, weekStartsMonday] = await Promise.all([
      c.settings.get<boolean>('snackSlot'),
      c.settings.get<boolean>('weekStartsMonday'),
    ]);
    return {
      snackSlot: snackSlot ?? DEFAULT_SETTINGS.snackSlot,
      weekStartsMonday: weekStartsMonday ?? DEFAULT_SETTINGS.weekStartsMonday,
    };
  }

  /* ── Widget ──────────────────────────────────────────────────────── */

  function SlotEditor(props: {
    doc: SlotDoc | undefined;
    date: string;
    slot: Slot;
    onDone: () => void;
  }) {
    const [meal, setMeal] = useState(props.doc?.meal ?? '');
    const [ingredientsText, setIngredientsText] = useState(
      formatIngredients(props.doc?.ingredients ?? []),
    );

    const save = async () => {
      const c = ctx;
      if (!c) return;
      await setMealIn(c.storage, props.date, props.slot, meal, parseIngredients(ingredientsText));
      props.onDone();
    };

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <input
          className="c-input"
          value={meal}
          autoFocus
          placeholder={t('tool.meal-planner.widget.mealPlaceholder')}
          aria-label={t('tool.meal-planner.widget.mealPlaceholder')}
          onChange={(e) => setMeal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') props.onDone();
          }}
        />
        <input
          className="c-input"
          value={ingredientsText}
          placeholder={t('tool.meal-planner.widget.ingredientsPlaceholder')}
          aria-label={t('tool.meal-planner.widget.ingredientsPlaceholder')}
          title={t('tool.meal-planner.widget.ingredientsHint')}
          onChange={(e) => setIngredientsText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
            if (e.key === 'Escape') props.onDone();
          }}
        />
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          <button className="c-btn c-btn--primary" style={{ flex: 1 }} onClick={() => void save()}>
            {t('tool.meal-planner.widget.save')}
          </button>
          <button className="c-btn c-btn--ghost" onClick={props.onDone}>
            {t('tool.meal-planner.widget.cancel')}
          </button>
        </div>
      </div>
    );
  }

  function MealPlannerWidget(props: WidgetProps) {
    const [slots, setSlots] = useState<SlotDoc[]>([]);
    const [settings, setSettings] = useState<MealPlannerSettings>({ ...DEFAULT_SETTINGS });
    const [shopping, setShopping] = useState<Record<string, boolean>>({});
    const [editing, setEditing] = useState<{ date: string; slot: Slot } | null>(null);
    const [showSettings, setShowSettings] = useState(false);
    const [exported, setExported] = useState(false);
    const [today, setToday] = useState(() => localDateKey(new Date()));

    // Roll over to the new day at local midnight without a restart.
    useEffect(() => {
      const timer = window.setInterval(() => {
        const key = localDateKey(new Date());
        setToday((prev) => (prev === key ? prev : key));
      }, 30_000);
      return () => window.clearInterval(timer);
    }, []);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, state, loaded] = await Promise.all([
        querySlotsIn(c.storage),
        c.storage.get<ShoppingStateDoc>(SHOPPING_STATE_ID),
        loadSettings(),
      ]);
      setSlots(list);
      setShopping(state?.checked ?? {});
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

    const visibleSlots: Slot[] = settings.snackSlot ? ALL_SLOTS : BASE_SLOTS;
    const dates = weekDates(new Date(), settings.weekStartsMonday);
    const weekSlots = slots.filter((s) => dates.includes(s.date));
    const byKey = new Map(weekSlots.map((s) => [s.id, s]));
    const lang = ctx?.i18n.language ?? 'en';

    const slotLabel = (slot: Slot) => t(`tool.meal-planner.slot.${slot}`);
    const dayLabel = (date: string) =>
      new Date(`${date}T12:00:00`).toLocaleDateString(lang, { weekday: 'short' });

    const cell = (date: string, slot: Slot): ReactNode => {
      const doc = byKey.get(slotKey(date, slot));
      const isEditing = editing?.date === date && editing.slot === slot;
      if (isEditing) {
        return <SlotEditor doc={doc} date={date} slot={slot} onDone={() => setEditing(null)} />;
      }
      return (
        <button
          className="c-btn c-btn--ghost"
          style={{
            width: '100%',
            justifyContent: 'flex-start',
            textAlign: 'left',
            padding: 'var(--space-1)',
            minHeight: '1.8em',
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
            color: doc?.meal ? 'var(--text-primary)' : 'var(--text-muted)',
          }}
          title={
            doc?.meal
              ? `${doc.meal}${doc.ingredients.length > 0 ? ` · ${formatIngredients(doc.ingredients)}` : ''}`
              : t('tool.meal-planner.widget.emptySlot')
          }
          aria-label={t('tool.meal-planner.widget.editSlot', {
            slot: slotLabel(slot),
            date,
          })}
          onClick={() => setEditing({ date, slot })}
        >
          {doc?.meal || '·'}
        </button>
      );
    };

    const settingsPanel = showSettings ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-1)',
          borderTop: '1px solid var(--border-subtle)',
          paddingTop: 'var(--space-2)',
          flexShrink: 0,
        }}
      >
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="checkbox"
            checked={settings.snackSlot}
            style={{ accentColor: 'var(--accent)' }}
            onChange={(e) => void ctx?.settings.set('snackSlot', e.target.checked)}
          />
          <span className="c-muted" style={{ fontSize: '0.85em' }}>
            {t('tool.meal-planner.settings.snackSlot')}
          </span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            type="checkbox"
            checked={settings.weekStartsMonday}
            style={{ accentColor: 'var(--accent)' }}
            onChange={(e) => void ctx?.settings.set('weekStartsMonday', e.target.checked)}
          />
          <span className="c-muted" style={{ fontSize: '0.85em' }}>
            {t('tool.meal-planner.settings.weekStartsMonday')}
          </span>
        </label>
      </div>
    ) : null;

    const header = (title: string) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
        <strong style={{ flex: 1, minWidth: 0 }}>{title}</strong>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.meal-planner.widget.settingsToggle')}
          title={t('tool.meal-planner.widget.settingsToggle')}
          aria-expanded={showSettings}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
    );

    let body: ReactNode;
    if (props.variant === 'day') {
      body = (
        <>
          {header(t('tool.meal-planner.widget.todayTitle'))}
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
            {visibleSlots.map((slot) => {
              const doc = byKey.get(slotKey(today, slot));
              const isEditing = editing?.date === today && editing.slot === slot;
              return (
                <div key={slot} style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="c-muted" style={{ fontSize: '0.75em' }}>
                    {slotLabel(slot)}
                  </span>
                  {isEditing ? (
                    <SlotEditor doc={doc} date={today} slot={slot} onDone={() => setEditing(null)} />
                  ) : (
                    <button
                      className="c-btn c-btn--ghost"
                      style={{
                        justifyContent: 'flex-start',
                        textAlign: 'left',
                        fontSize: '1.2em',
                        color: doc?.meal ? 'var(--text-primary)' : 'var(--text-muted)',
                      }}
                      aria-label={t('tool.meal-planner.widget.editSlot', {
                        slot: slotLabel(slot),
                        date: today,
                      })}
                      onClick={() => setEditing({ date: today, slot })}
                    >
                      {doc?.meal || t('tool.meal-planner.widget.emptySlot')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      );
    } else if (props.variant === 'shopping-list') {
      const lines = aggregateIngredients(weekSlots);
      const lineText = (line: AggregatedLine) =>
        [line.qty !== undefined ? String(line.qty).replace('.', ',') : '', line.unit ?? '', line.name]
          .filter((p) => p.length > 0)
          .join(' ');

      const toggle = async (line: AggregatedLine) => {
        const c = ctx;
        if (!c) return;
        const state = (await c.storage.get<ShoppingStateDoc>(SHOPPING_STATE_ID)) ?? {
          id: SHOPPING_STATE_ID,
          type: 'shopping-state' as const,
          checked: {},
        };
        const checked = { ...state.checked, [line.key]: !state.checked[line.key] };
        await c.storage.set<ShoppingStateDoc>(SHOPPING_STATE_ID, { ...state, checked });
      };

      const exportList = async () => {
        const c = ctx;
        if (!c || lines.length === 0) return;
        const open = lines.filter((l) => !shopping[l.key]);
        const items = (open.length > 0 ? open : lines).map(lineText);
        // ONE todo per export run – the sanctioned cross-tool path.
        const result = await c.commands.execute('todo.create', {
          title: t('tool.meal-planner.widget.exportTitle', { items: items.join(', ') }),
        });
        if (result.ok) {
          setExported(true);
          window.setTimeout(() => setExported(false), 2500);
        }
      };

      body = (
        <>
          {header(t('tool.meal-planner.widget.shoppingTitle'))}
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
            {lines.length === 0 ? (
              <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
                {t('tool.meal-planner.widget.shoppingEmpty')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                {lines.map((line) => {
                  const checked = shopping[line.key] === true;
                  return (
                    <label
                      key={line.key}
                      style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        style={{ accentColor: 'var(--accent)' }}
                        onChange={() => void toggle(line)}
                      />
                      <span
                        className={checked ? 'c-muted' : undefined}
                        style={{
                          textDecoration: checked ? 'line-through' : 'none',
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {lineText(line)}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          {ctx?.commands.has('todo.create') && lines.length > 0 ? (
            <button
              className="c-btn c-btn--primary"
              style={{ flexShrink: 0 }}
              onClick={() => void exportList()}
            >
              {exported
                ? t('tool.meal-planner.widget.exported')
                : t('tool.meal-planner.widget.exportButton')}
            </button>
          ) : null}
        </>
      );
    } else {
      // week-grid (default)
      body = (
        <>
          {header(t('tool.meal-planner.widget.weekTitle'))}
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: `auto repeat(${visibleSlots.length}, minmax(64px, 1fr))`,
                gap: 'var(--space-1)',
                alignItems: 'start',
              }}
            >
              <span />
              {visibleSlots.map((slot) => (
                <span key={slot} className="c-muted" style={{ fontSize: '0.7em' }}>
                  {slotLabel(slot)}
                </span>
              ))}
              {dates.map((date) => (
                <Fragment key={date}>
                  <span
                    className="c-muted"
                    style={{
                      fontSize: '0.75em',
                      fontWeight: date === today ? 700 : 400,
                      color: date === today ? 'var(--accent)' : undefined,
                      alignSelf: 'center',
                    }}
                  >
                    {dayLabel(date)}
                  </span>
                  {visibleSlots.map((slot) => (
                    <div key={slot} style={{ minWidth: 0 }}>
                      {cell(date, slot)}
                    </div>
                  ))}
                </Fragment>
              ))}
            </div>
          </div>
        </>
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
        {body}
        {settingsPanel}
      </div>
    );
  }

  /* ── Tool export ─────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'meal-planner.set-meal',
        titleKey: 'tool.meal-planner.command.set-meal',
        descriptionKey: 'tool.meal-planner.command.set-mealDesc',
        icon: '🍽',
        params: z.object({
          date: z.string().regex(DATE_RE),
          slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
          meal: z.string().min(1),
        }),
        selfTestParams: { date: '2099-01-01', slot: 'lunch' as const, meal: 'Cardo self-test meal' },
        async run({ date, slot, meal }): Promise<CommandResult> {
          const doc = await setMealIn(context.storage, date, slot, meal);
          return doc
            ? { ok: true, data: doc, messageKey: 'tool.meal-planner.msg.saved' }
            : { ok: true, messageKey: 'tool.meal-planner.msg.cleared' };
        },
      });

      context.commands.register({
        id: 'meal-planner.context',
        titleKey: 'tool.meal-planner.command.context',
        descriptionKey: 'tool.meal-planner.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const slots = await querySlotsIn(context.storage);
          return {
            ok: true,
            data: {
              contextText: buildMealContext(
                slots,
                localDateKey(new Date()),
                context.i18n.language,
              ),
            },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: MealPlannerWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const created = await setMealIn(testCtx.storage, '2099-02-01', 'dinner', 'selftest meal', [
            { name: 'Probe', qty: 1, unit: 'kg' },
          ]);
          const back = await testCtx.storage.get<SlotDoc>(slotKey('2099-02-01', 'dinner'));
          // Clearing (empty meal, empty ingredients) must delete the doc.
          await setMealIn(testCtx.storage, '2099-02-01', 'dinner', '', []);
          const gone = await testCtx.storage.get<SlotDoc>(slotKey('2099-02-01', 'dinner'));
          if (
            !created ||
            back?.meal !== 'selftest meal' ||
            back.ingredients[0]?.name !== 'Probe' ||
            back.ingredients[0]?.qty !== 1
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'slot still present after clearing' };
          return { status: 'pass', detail: 'set → read → clear roundtrip ok' };
        }
        case 'aggregate': {
          // Logic through storage: two slots, overlapping ingredients.
          const a = slotKey('2099-03-01', 'lunch');
          const b = slotKey('2099-03-02', 'dinner');
          await setMealIn(testCtx.storage, '2099-03-01', 'lunch', 'selftest a', [
            { name: 'Mehl', qty: 200, unit: 'g' },
            { name: 'Milch', qty: 1, unit: 'l' },
          ]);
          await setMealIn(testCtx.storage, '2099-03-02', 'dinner', 'selftest b', [
            { name: 'mehl', qty: 300, unit: 'g' },
            { name: 'Milch', qty: 200, unit: 'ml' },
          ]);
          const stored = (await querySlotsIn(testCtx.storage)).filter(
            (s) => s.id === a || s.id === b,
          );
          await testCtx.storage.delete(a);
          await testCtx.storage.delete(b);
          const lines = aggregateIngredients(stored);
          const mehl = lines.find((l) => l.unit === 'g');
          const milchL = lines.find((l) => l.unit === 'l');
          const milchMl = lines.find((l) => l.unit === 'ml');
          if (stored.length !== 2 || lines.length !== 3) {
            return {
              status: 'fail',
              detail: `expected 3 aggregated lines from 2 slots, got ${lines.length} from ${stored.length}`,
            };
          }
          if (mehl?.qty !== 500 || milchL?.qty !== 1 || milchMl?.qty !== 200) {
            return { status: 'fail', detail: `wrong sums: ${JSON.stringify(lines)}` };
          }
          return { status: 'pass', detail: '200 g + 300 g = 500 g; 1 l and 200 ml stay separate' };
        }
        case 'render':
          return typeof MealPlannerWidget === 'function' && MealPlannerWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
