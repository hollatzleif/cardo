import { useEffect, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, CommandResult, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { localDateKey, type DayDoc, type ItemDoc } from './routine';

/**
 * Routine – a daily checklist that starts fresh every (local) day.
 * Items live in `item:<id>` docs; the check state of a day lives in one
 * `day:<YYYY-MM-DD>` doc, so "resetting" at midnight needs no deletion.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Storage helpers ─────────────────────────────────────────────── */

  async function listItems(): Promise<ItemDoc[]> {
    if (!ctx) return [];
    // query() returns doc bodies without ids, so items carry their id inside
    // the doc. Day docs share the namespace – tell them apart by shape.
    const docs = await ctx.storage.query<Record<string, unknown>>();
    return docs
      .filter(
        (d): d is ItemDoc =>
          typeof d.id === 'string' && typeof d.title === 'string' && typeof d.order === 'number',
      )
      .sort((a, b) => a.order - b.order);
  }

  async function getDay(date: string): Promise<DayDoc> {
    const doc = await ctx?.storage.get<DayDoc>(`day:${date}`);
    return doc ?? { id: date, date, checked: [] };
  }

  async function addItem(title: string): Promise<string | null> {
    const trimmed = title.trim();
    if (!ctx || !trimmed) return null;
    const items = await listItems();
    const id = crypto.randomUUID();
    const item: ItemDoc = {
      id,
      title: trimmed,
      order: items.reduce((max, i) => Math.max(max, i.order), -1) + 1,
    };
    await ctx.storage.set(`item:${id}`, item);
    return id;
  }

  async function deleteItem(itemId: string): Promise<void> {
    await ctx?.storage.delete(`item:${itemId}`);
  }

  /** Check an item for today; emits routine events. Graceful on unknown ids. */
  async function checkItem(itemId: string): Promise<CommandResult> {
    if (!ctx) return { ok: false, messageKey: 'tool.routine.command.itemMissing' };
    const item = await ctx.storage.get<ItemDoc>(`item:${itemId}`);
    if (!item) return { ok: false, messageKey: 'tool.routine.command.itemMissing' };

    const date = localDateKey(new Date());
    const day = await getDay(date);
    if (!day.checked.includes(itemId)) {
      const next: DayDoc = { ...day, checked: [...day.checked, itemId] };
      await ctx.storage.set(`day:${date}`, next);
      ctx.events.emit('routine:item-checked', { itemId, date });
      const items = await listItems();
      if (items.length > 0 && items.every((i) => next.checked.includes(i.id))) {
        ctx.events.emit('routine:day-completed', { date });
      }
    }
    return { ok: true, data: { itemId, date } };
  }

  async function uncheckItem(itemId: string): Promise<void> {
    if (!ctx) return;
    const date = localDateKey(new Date());
    const day = await getDay(date);
    if (day.checked.includes(itemId)) {
      await ctx.storage.set<DayDoc>(`day:${date}`, {
        ...day,
        checked: day.checked.filter((id) => id !== itemId),
      });
    }
  }

  async function resetToday(): Promise<void> {
    if (!ctx) return;
    const date = localDateKey(new Date());
    await ctx.storage.set<DayDoc>(`day:${date}`, { id: date, date, checked: [] });
  }

  /* ── Widget ──────────────────────────────────────────────────────── */

  function RoutineWidget(_props: WidgetProps) {
    const [items, setItems] = useState<ItemDoc[] | null>(null);
    const [day, setDay] = useState<DayDoc | null>(null);
    const [dateKey, setDateKey] = useState(() => localDateKey(new Date()));
    const [draft, setDraft] = useState('');

    // Roll over to the new day at local midnight without a restart.
    useEffect(() => {
      const timer = window.setInterval(() => {
        const key = localDateKey(new Date());
        setDateKey((prev) => (prev === key ? prev : key));
      }, 30_000);
      return () => window.clearInterval(timer);
    }, []);

    useEffect(() => {
      let mounted = true;
      const load = () =>
        Promise.all([listItems(), getDay(dateKey)]).then(([nextItems, nextDay]) => {
          if (mounted) {
            setItems(nextItems);
            setDay(nextDay);
          }
        });
      void load();
      const unsub = ctx?.storage.subscribe(() => void load());
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [dateKey]);

    const checked = new Set(day?.checked ?? []);
    const total = items?.length ?? 0;
    const done = items?.filter((i) => checked.has(i.id)).length ?? 0;
    const allDone = total > 0 && done === total;
    const heading = new Intl.DateTimeFormat(ctx?.i18n.language, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date());

    async function submitDraft() {
      const title = draft.trim();
      if (!title) return;
      setDraft('');
      await addItem(title);
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
        <div style={{ fontWeight: 600 }}>{heading}</div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span className="c-muted" style={{ fontSize: '0.85em' }}>
            {done}/{total}
          </span>
          <div
            style={{
              flex: 1,
              height: '4px',
              borderRadius: '999px',
              background: 'var(--border-subtle)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: total > 0 ? `${(done / total) * 100}%` : '0%',
                height: '100%',
                borderRadius: '999px',
                background: 'var(--success)',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>

        {allDone && (
          <div style={{ color: 'var(--success)', fontSize: '0.9em' }}>
            {t('tool.routine.widget.allDone')}
          </div>
        )}

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {items !== null && total === 0 && (
            <div className="c-muted" style={{ fontSize: '0.9em' }}>
              {t('tool.routine.widget.empty')}
            </div>
          )}
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {(items ?? []).map((item) => {
              const isChecked = checked.has(item.id);
              return (
                <li
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-2)',
                    padding: 'var(--space-1) 0',
                  }}
                >
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 'var(--space-2)',
                      flex: 1,
                      minWidth: 0,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isChecked}
                      onChange={() => void (isChecked ? uncheckItem(item.id) : checkItem(item.id))}
                      style={{ accentColor: 'var(--success)', flexShrink: 0 }}
                    />
                    <span
                      className={isChecked ? 'c-muted' : undefined}
                      style={{
                        textDecoration: isChecked ? 'line-through' : 'none',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {item.title}
                    </span>
                  </label>
                  <button
                    className="c-btn c-btn--ghost"
                    aria-label={t('tool.routine.widget.remove')}
                    title={t('tool.routine.widget.remove')}
                    onClick={() => void deleteItem(item.id)}
                    style={{ padding: '0 var(--space-2)', fontSize: '0.85em' }}
                  >
                    ✕
                  </button>
                </li>
              );
            })}
          </ul>
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submitDraft();
          }}
          style={{ display: 'flex', gap: 'var(--space-2)' }}
        >
          <input
            className="c-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={t('tool.routine.widget.addPlaceholder')}
          />
          <button type="submit" className="c-btn c-btn--primary" disabled={!draft.trim()}>
            {t('tool.routine.widget.add')}
          </button>
        </form>
      </div>
    );
  }

  /* ── Tool ────────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
      context.commands.register({
        id: 'routine.add-item',
        titleKey: 'tool.routine.command.addItem',
        params: z.object({ title: z.string().min(1) }),
        selfTestParams: { title: 'probe' },
        async run({ title }) {
          const id = await addItem(title);
          return id
            ? { ok: true, data: { id } }
            : { ok: false, messageKey: 'tool.routine.command.itemMissing' };
        },
      });
      context.commands.register({
        id: 'routine.check',
        titleKey: 'tool.routine.command.check',
        params: z.object({ itemId: z.string().min(1) }),
        // Nonexistent id on purpose: must fail gracefully, never throw.
        selfTestParams: { itemId: 'selftest-nonexistent-item' },
        async run({ itemId }) {
          return checkItem(itemId);
        },
      });
      context.commands.register({
        id: 'routine.reset-today',
        titleKey: 'tool.routine.command.resetToday',
        params: z.object({}),
        selfTestParams: {},
        async run() {
          await resetToday();
          return { ok: true };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: RoutineWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'item-roundtrip': {
          const probe: ItemDoc = { id: 'selftest-item', title: 'probe', order: 0 };
          await testCtx.storage.set('item:selftest-item', probe);
          const roundtrip = await testCtx.storage.get<ItemDoc>('item:selftest-item');
          await testCtx.storage.delete('item:selftest-item');
          const gone = await testCtx.storage.get<ItemDoc>('item:selftest-item');
          if (roundtrip?.id !== 'selftest-item' || roundtrip.title !== 'probe') {
            return { status: 'fail', detail: `bad roundtrip: ${JSON.stringify(roundtrip)}` };
          }
          return gone === null
            ? { status: 'pass' }
            : { status: 'fail', detail: 'item still present after delete' };
        }
        case 'day-state': {
          const date = '2026-01-15';
          const dayDoc: DayDoc = { id: date, date, checked: ['selftest-item'] };
          await testCtx.storage.set(`day:${date}`, dayDoc);
          const roundtrip = await testCtx.storage.get<DayDoc>(`day:${date}`);
          await testCtx.storage.delete(`day:${date}`);
          return roundtrip?.date === date && roundtrip.checked.includes('selftest-item')
            ? { status: 'pass' }
            : { status: 'fail', detail: `bad day state: ${JSON.stringify(roundtrip)}` };
        }
        case 'date-key': {
          const key = localDateKey(new Date(2026, 0, 5, 12, 0, 0));
          return key === '2026-01-05'
            ? { status: 'pass' }
            : { status: 'fail', detail: `expected 2026-01-05, got ${key}` };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
