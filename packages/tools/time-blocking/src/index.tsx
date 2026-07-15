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
  SLOT_MINUTES,
  addBlockParamsSchema,
  blockMinutes,
  buildTimeBlockingContext,
  findConflicts,
  formatTime,
  isValidDateKey,
  makeBlock,
  shiftDayKey,
  snapToGrid,
  sortBlocks,
  toMinutes,
  todayKey,
  type Block,
  type DayDoc,
  type SlotMinutes,
} from './logic';

/**
 * Time blocking – plan the day in blocks. One `day:<YYYY-MM-DD>` doc per
 * LOCAL day; all in-day math runs on "HH:MM" strings (DST-proof).
 */

type TimeBlockingSettings = {
  /** Grid granularity for the widget's add form, minutes. */
  slotMinutes: SlotMinutes;
  /** Work-hours window start, full hour 0–23. */
  dayStartHour: number;
  /** Work-hours window end, full hour 1–24. */
  dayEndHour: number;
  /** Display times as 12h AM/PM instead of 24h. */
  twelveHour: boolean;
};

const DEFAULT_SETTINGS: TimeBlockingSettings = {
  slotMinutes: 30,
  dayStartHour: 8,
  dayEndHour: 18,
  twelveHour: false,
};

/** Pixel height of one hour on the timeline. */
const HOUR_PX = 44;
/** Width of the hour-label gutter on the timeline. */
const GUTTER_PX = 52;

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

function dayDocId(date: string): string {
  return `day:${date}`;
}

async function getDayIn(storage: ToolStorage, date: string): Promise<DayDoc> {
  const doc = await storage.get<DayDoc>(dayDocId(date));
  return doc ?? { type: 'day', date, blocks: [] };
}

async function addBlockIn(storage: ToolStorage, date: string, block: Block): Promise<DayDoc> {
  const day = await getDayIn(storage, date);
  const next: DayDoc = { ...day, blocks: [...day.blocks, block] };
  await storage.set<DayDoc>(dayDocId(date), next);
  return next;
}

async function removeBlockIn(storage: ToolStorage, date: string, blockId: string): Promise<void> {
  const day = await getDayIn(storage, date);
  const blocks = day.blocks.filter((b) => b.id !== blockId);
  if (blocks.length === day.blocks.length) return;
  if (blocks.length === 0) {
    await storage.delete(dayDocId(date));
  } else {
    await storage.set<DayDoc>(dayDocId(date), { ...day, blocks });
  }
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<TimeBlockingSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [slotMinutes, dayStartHour, dayEndHour, twelveHour] = await Promise.all([
      c.settings.get<number>('slotMinutes'),
      c.settings.get<number>('dayStartHour'),
      c.settings.get<number>('dayEndHour'),
      c.settings.get<boolean>('twelveHour'),
    ]);
    const slot = SLOT_MINUTES.find((s) => s === slotMinutes) ?? DEFAULT_SETTINGS.slotMinutes;
    return {
      slotMinutes: slot,
      dayStartHour: dayStartHour ?? DEFAULT_SETTINGS.dayStartHour,
      dayEndHour: dayEndHour ?? DEFAULT_SETTINGS.dayEndHour,
      twelveHour: twelveHour ?? DEFAULT_SETTINGS.twelveHour,
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

  function TimeBlockingWidget(props: WidgetProps) {
    const [days, setDays] = useState<Record<string, DayDoc>>({});
    const [settings, setSettings] = useState<TimeBlockingSettings>({ ...DEFAULT_SETTINGS });
    const [showSettings, setShowSettings] = useState(false);
    const [baseKey, setBaseKey] = useState(() => todayKey());
    const [date, setDate] = useState(() => todayKey());
    const [start, setStart] = useState('');
    const [end, setEnd] = useState('');
    const [title, setTitle] = useState('');

    // Roll over to the new day at local midnight without a restart.
    useEffect(() => {
      const timer = window.setInterval(() => {
        const key = todayKey();
        setBaseKey((prev) => (prev === key ? prev : key));
      }, 30_000);
      return () => window.clearInterval(timer);
    }, []);

    // Keep the add form's target day in the visible range after a rollover.
    useEffect(() => {
      setDate((prev) => {
        const inRange =
          prev === baseKey || prev === shiftDayKey(baseKey, 1) || prev === shiftDayKey(baseKey, 2);
        return inRange ? prev : baseKey;
      });
    }, [baseKey]);

    const dayKeys =
      props.variant === 'three-day'
        ? [baseKey, shiftDayKey(baseKey, 1), shiftDayKey(baseKey, 2)]
        : [baseKey];

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const keys =
        props.variant === 'three-day'
          ? [baseKey, shiftDayKey(baseKey, 1), shiftDayKey(baseKey, 2)]
          : [baseKey];
      const [docs, loaded] = await Promise.all([
        Promise.all(keys.map((key) => getDayIn(c.storage, key))),
        loadSettings(),
      ]);
      const next: Record<string, DayDoc> = {};
      keys.forEach((key, i) => {
        const doc = docs[i];
        if (doc) next[key] = doc;
      });
      setDays(next);
      setSettings(loaded);
    }, [props.variant, baseKey]);

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
    const fmt = (hhmm: string) => formatTime(hhmm, settings.twelveHour);

    async function addBlock() {
      const c = ctx;
      if (!c || !title.trim()) return;
      // Only the three-day view offers a day picker; the single-day views
      // always plan on TODAY (baseKey follows local midnight).
      const targetDate = props.variant === 'three-day' ? date : baseKey;
      const snappedStart = snapToGrid(start, settings.slotMinutes);
      const snappedEnd = snapToGrid(end, settings.slotMinutes);
      if (!isValidDateKey(targetDate)) return;
      if (toMinutes(snappedEnd) <= toMinutes(snappedStart)) return;
      await addBlockIn(
        c.storage,
        targetDate,
        makeBlock({ start: snappedStart, end: snappedEnd, title }),
      );
      setTitle('');
    }

    async function removeBlock(dayDate: string, block: Block) {
      const c = ctx;
      if (!c) return;
      await removeBlockIn(c.storage, dayDate, block.id);
    }

    const addForm = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
        <input
          className="c-input"
          value={title}
          placeholder={t('tool.time-blocking.widget.titlePlaceholder')}
          aria-label={t('tool.time-blocking.widget.titlePlaceholder')}
          style={{ flex: 2, minWidth: 80 }}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addBlock();
          }}
        />
        {props.variant === 'three-day' ? (
          <select
            className="c-input"
            value={date}
            aria-label={t('tool.time-blocking.widget.dateLabel')}
            title={t('tool.time-blocking.widget.dateLabel')}
            style={{ width: 'auto', flexShrink: 0 }}
            onChange={(e) => setDate(e.target.value)}
          >
            {dayKeys.map((key) => (
              <option key={key} value={key}>
                {new Date(`${key}T12:00:00`).toLocaleDateString(lang, {
                  weekday: 'short',
                  day: 'numeric',
                  month: 'numeric',
                })}
              </option>
            ))}
          </select>
        ) : null}
        <input
          className="c-input"
          type="time"
          value={start}
          step={settings.slotMinutes * 60}
          aria-label={t('tool.time-blocking.widget.startLabel')}
          title={t('tool.time-blocking.widget.startLabel')}
          style={{ width: 'auto', flexShrink: 0 }}
          onChange={(e) => setStart(e.target.value)}
        />
        <input
          className="c-input"
          type="time"
          value={end}
          step={settings.slotMinutes * 60}
          aria-label={t('tool.time-blocking.widget.endLabel')}
          title={t('tool.time-blocking.widget.endLabel')}
          style={{ width: 'auto', flexShrink: 0 }}
          onChange={(e) => setEnd(e.target.value)}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.time-blocking.widget.add')}
          title={t('tool.time-blocking.widget.add')}
          style={{ flexShrink: 0 }}
          onClick={() => void addBlock()}
        >
          +
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.time-blocking.widget.settingsToggle')}
          title={t('tool.time-blocking.widget.settingsToggle')}
          aria-expanded={showSettings}
          style={{ flexShrink: 0 }}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
    );

    const settingsPanel = showSettings ? (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          flexShrink: 0,
          borderBottom: '1px solid var(--border-subtle)',
          paddingBottom: 'var(--space-2)',
        }}
      >
        <SettingRow labelKey="tool.time-blocking.settings.slotMinutes">
          <select
            className="c-input"
            value={settings.slotMinutes}
            style={{ width: 'auto' }}
            onChange={(e) => void ctx?.settings.set('slotMinutes', Number(e.target.value))}
          >
            {SLOT_MINUTES.map((s) => (
              <option key={s} value={s}>
                {s} min
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow labelKey="tool.time-blocking.settings.dayStart">
          <input
            className="c-input"
            type="number"
            min={0}
            max={23}
            value={settings.dayStartHour}
            style={{ width: 72, textAlign: 'right' }}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v >= 0 && v <= 23) {
                void ctx?.settings.set('dayStartHour', v);
              }
            }}
          />
        </SettingRow>
        <SettingRow labelKey="tool.time-blocking.settings.dayEnd">
          <input
            className="c-input"
            type="number"
            min={1}
            max={24}
            value={settings.dayEndHour}
            style={{ width: 72, textAlign: 'right' }}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v >= 1 && v <= 24) {
                void ctx?.settings.set('dayEndHour', v);
              }
            }}
          />
        </SettingRow>
        <SettingRow labelKey="tool.time-blocking.settings.twelveHour">
          <input
            type="checkbox"
            checked={settings.twelveHour}
            style={{ accentColor: 'var(--accent)' }}
            onChange={(e) => void ctx?.settings.set('twelveHour', e.target.checked)}
          />
        </SettingRow>
      </div>
    ) : null;

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.time-blocking.widget.empty')}
      </div>
    );

    /** Vertical timeline of one day between windowStart/windowEnd (hours). */
    function renderTimeline(day: DayDoc, windowStartHour: number, windowEndHour: number) {
      const startMin = windowStartHour * 60;
      const endMin = windowEndHour * 60;
      const windowMinutes = Math.max(60, endMin - startMin);
      const conflicts = findConflicts(day.blocks);
      const visible = sortBlocks(day.blocks).filter(
        (b) => blockMinutes(b) > 0 && toMinutes(b.end) > startMin && toMinutes(b.start) < endMin,
      );
      const hidden = day.blocks.filter(
        (b) => blockMinutes(b) > 0 && (toMinutes(b.end) <= startMin || toMinutes(b.start) >= endMin),
      ).length;
      const hours: number[] = [];
      for (let h = windowStartHour; h < windowEndHour; h += 1) hours.push(h);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          {hidden > 0 ? (
            <span className="c-muted" style={{ fontSize: 12, flexShrink: 0 }}>
              {t('tool.time-blocking.widget.outsideWindow', { count: hidden })}
            </span>
          ) : null}
          <div
            style={{
              position: 'relative',
              height: (windowMinutes / 60) * HOUR_PX,
              minWidth: 0,
            }}
          >
            {hours.map((h) => (
              <div
                key={h}
                aria-hidden
                style={{
                  position: 'absolute',
                  top: ((h * 60 - startMin) / 60) * HOUR_PX,
                  left: 0,
                  right: 0,
                  borderTop: '1px solid var(--border-subtle)',
                }}
              >
                <span
                  className="c-muted"
                  style={{ fontSize: 10, fontVariantNumeric: 'tabular-nums' }}
                >
                  {fmt(`${String(h).padStart(2, '0')}:00`)}
                </span>
              </div>
            ))}
            {visible.map((block) => {
              const top = ((Math.max(toMinutes(block.start), startMin) - startMin) / 60) * HOUR_PX;
              const bottom = ((Math.min(toMinutes(block.end), endMin) - startMin) / 60) * HOUR_PX;
              const conflicted = conflicts.has(block.id);
              return (
                <div
                  key={block.id}
                  title={`${fmt(block.start)}–${fmt(block.end)} ${block.title}`}
                  style={{
                    position: 'absolute',
                    top,
                    height: Math.max(14, bottom - top),
                    left: GUTTER_PX,
                    right: 0,
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 'var(--space-1)',
                    padding: '1px var(--space-2)',
                    borderRadius: 'var(--radius-sm)',
                    overflow: 'hidden',
                    background: conflicted ? 'var(--warning)' : 'var(--accent)',
                    color: 'var(--accent-text)',
                  }}
                >
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
                    {fmt(block.start)}–{fmt(block.end)} {block.title}
                    {block.category ? ` · ${block.category}` : ''}
                  </span>
                  <button
                    className="c-btn c-btn--ghost"
                    aria-label={t('tool.time-blocking.widget.delete', { title: block.title })}
                    title={t('tool.time-blocking.widget.delete', { title: block.title })}
                    style={{
                      padding: '0 var(--space-1)',
                      flexShrink: 0,
                      fontSize: 12,
                      color: 'var(--accent-text)',
                    }}
                    onClick={() => void removeBlock(day.date, block)}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    /** Compact list of one day's blocks (three-day columns). */
    function renderDayList(day: DayDoc) {
      const conflicts = findConflicts(day.blocks);
      const blocks = sortBlocks(day.blocks);
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
          {blocks.length === 0 ? (
            <span className="c-muted" style={{ fontSize: 12 }}>
              –
            </span>
          ) : (
            blocks.map((block) => (
              <div
                key={block.id}
                style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-1)', minWidth: 0 }}
              >
                <span
                  style={{
                    fontSize: 11,
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                    color: conflicts.has(block.id) ? 'var(--warning)' : 'var(--text-muted)',
                  }}
                >
                  {fmt(block.start)}
                </span>
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontSize: 12,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    ...(conflicts.has(block.id) ? { color: 'var(--warning)' } : {}),
                  }}
                >
                  {block.title}
                </span>
                <button
                  className="c-btn c-btn--ghost"
                  aria-label={t('tool.time-blocking.widget.delete', { title: block.title })}
                  title={t('tool.time-blocking.widget.delete', { title: block.title })}
                  style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
                  onClick={() => void removeBlock(day.date, block)}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      );
    }

    let body;
    if (props.variant === 'three-day') {
      body = (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'stretch' }}>
          {dayKeys.map((key) => {
            const day = days[key] ?? { type: 'day' as const, date: key, blocks: [] };
            return (
              <div
                key={key}
                style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    color: key === baseKey ? 'var(--accent)' : 'var(--text-muted)',
                    flexShrink: 0,
                  }}
                >
                  {new Date(`${key}T12:00:00`).toLocaleDateString(lang, {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'numeric',
                  })}
                </span>
                {renderDayList(day)}
              </div>
            );
          })}
        </div>
      );
    } else {
      const today = days[baseKey] ?? { type: 'day' as const, date: baseKey, blocks: [] };
      let windowStart = settings.dayStartHour;
      let windowEnd = Math.max(settings.dayEndHour, windowStart + 1);
      if (props.variant !== 'work-hours') {
        // Day view: widen the window so every planned block is visible.
        for (const block of today.blocks) {
          if (blockMinutes(block) <= 0) continue;
          windowStart = Math.min(windowStart, Math.floor(toMinutes(block.start) / 60));
          windowEnd = Math.max(windowEnd, Math.ceil(toMinutes(block.end) / 60));
        }
      }
      body =
        today.blocks.length === 0 ? empty : renderTimeline(today, windowStart, windowEnd);
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
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'time-blocking.add-block',
        titleKey: 'tool.time-blocking.command.add-block',
        descriptionKey: 'tool.time-blocking.command.add-blockDesc',
        icon: 'plus',
        params: addBlockParamsSchema,
        selfTestParams: {
          date: '2099-01-01',
          start: '09:00',
          end: '10:00',
          title: 'Cardo self-test block',
        },
        async run(params): Promise<CommandResult> {
          const date = params.date ?? todayKey();
          if (!isValidDateKey(date)) {
            return { ok: false, messageKey: 'tool.time-blocking.msg.invalidDate' };
          }
          if (toMinutes(params.end) <= toMinutes(params.start)) {
            return { ok: false, messageKey: 'tool.time-blocking.msg.invalidRange' };
          }
          const block = makeBlock(params);
          await addBlockIn(context.storage, date, block);
          return { ok: true, data: { date, block }, messageKey: 'tool.time-blocking.msg.added' };
        },
      });

      context.commands.register({
        id: 'time-blocking.context',
        titleKey: 'tool.time-blocking.command.context',
        descriptionKey: 'tool.time-blocking.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const key = todayKey();
          const day = await context.storage.get<DayDoc>(dayDocId(key));
          return {
            ok: true,
            data: { contextText: buildTimeBlockingContext(day, context.i18n.language, key) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: TimeBlockingWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const date = '2099-02-01';
          const block = makeBlock({
            start: '09:00',
            end: '10:30',
            title: 'selftest block',
            category: 'selftest',
          });
          await addBlockIn(testCtx.storage, date, block);
          const back = await testCtx.storage.get<DayDoc>(dayDocId(date));
          await removeBlockIn(testCtx.storage, date, block.id);
          const gone = await testCtx.storage.get<DayDoc>(dayDocId(date));
          const stored = back?.blocks.find((b) => b.id === block.id);
          if (
            back?.type !== 'day' ||
            back.date !== date ||
            !stored ||
            stored.start !== '09:00' ||
            stored.end !== '10:30' ||
            stored.title !== 'selftest block' ||
            stored.category !== 'selftest'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone?.blocks.some((b) => b.id === block.id)) {
            return { status: 'fail', detail: 'block still present after remove' };
          }
          return { status: 'pass', detail: 'add → read → remove roundtrip ok' };
        }
        case 'conflict-detection': {
          const date = '2099-02-02';
          const a = makeBlock({ start: '09:00', end: '10:00', title: 'selftest a' });
          const b = makeBlock({ start: '09:30', end: '10:30', title: 'selftest b' });
          const c = makeBlock({ start: '11:00', end: '12:00', title: 'selftest c' });
          const doc: DayDoc = { type: 'day', date, blocks: [a, b, c] };
          await testCtx.storage.set<DayDoc>(dayDocId(date), doc);
          const back = await testCtx.storage.get<DayDoc>(dayDocId(date));
          await testCtx.storage.delete(dayDocId(date));
          if (!back) return { status: 'fail', detail: 'day doc not readable after write' };
          const conflicts = findConflicts(back.blocks);
          if (conflicts.size !== 2 || !conflicts.has(a.id) || !conflicts.has(b.id) || conflicts.has(c.id)) {
            return {
              status: 'fail',
              detail: `expected exactly {a, b} in conflict, got ${JSON.stringify([...conflicts])}`,
            };
          }
          const text = buildTimeBlockingContext(back, 'en', date);
          if (!text.includes('overlapping')) {
            return { status: 'fail', detail: `context misses the conflict: "${text}"` };
          }
          return { status: 'pass', detail: 'overlap flagged through a storage roundtrip' };
        }
        case 'render':
          return typeof TimeBlockingWidget === 'function' && TimeBlockingWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
