import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, ToolContext, ToolStorage, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  isCapturable,
  makeItem,
  sortItems,
  UI_DOC_ID,
  type ItemDoc,
  type UiDoc,
} from './logic';

/** Stable DOM id – the host and tour can always find the capture input. */
const INPUT_DOM_ID = 'quickcapture-input';

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function addItem(storage: ToolStorage, text: string): Promise<ItemDoc | null> {
  if (!isCapturable(text)) return null;
  const item = makeItem(text);
  await storage.set(item.id, item);
  return item;
}

async function listItems(storage: ToolStorage): Promise<ItemDoc[]> {
  const items = await storage.query<ItemDoc>({
    where: [{ field: 'type', op: '=', value: 'item' }],
  });
  return sortItems(items);
}

async function requestFocus(storage: ToolStorage): Promise<void> {
  const doc: UiDoc = { id: UI_DOC_ID, type: 'ui', focusRequested: Date.now() };
  await storage.set(UI_DOC_ID, doc);
}

/**
 * Quick capture – jot a thought instantly, sort it later (GTD inbox).
 * The global OS shortcut is wired by the host: it invokes "quickcapture.focus",
 * which writes the "ui" doc; the widget subscribes and focuses its input.
 */
export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  function QuickCaptureWidget(_props: WidgetProps) {
    const [items, setItems] = useState<ItemDoc[] | null>(null);
    const [draft, setDraft] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    const refresh = useCallback(async () => {
      if (!ctx) return;
      setItems(await listItems(ctx.storage));
    }, []);

    useEffect(() => {
      let mounted = true;
      if (ctx) {
        listItems(ctx.storage).then((all) => mounted && setItems(all));
      }
      const unsub = ctx?.storage.subscribe((change) => {
        if (!mounted) return;
        if (change.docId === UI_DOC_ID) {
          // The host's global shortcut ran "quickcapture.focus" → bring the input up.
          inputRef.current?.focus();
          return;
        }
        void refresh();
      });
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [refresh]);

    const capture = useCallback(async () => {
      if (!ctx || !isCapturable(draft)) return;
      await addItem(ctx.storage, draft);
      setDraft('');
      inputRef.current?.focus(); // Enter adds, input stays focused
    }, [draft]);

    const remove = useCallback(async (id: string) => {
      await ctx?.storage.delete(id);
    }, []);

    const sendToTodo = useCallback(async (item: ItemDoc) => {
      if (!ctx) return;
      // Cross-tool automation goes through EVENTS, never direct imports:
      // the host / todo tool listens for "quickcapture:toTodo" and creates the task.
      ctx.events.emit('quickcapture:toTodo', { text: item.text });
      await ctx.storage.delete(item.id);
    }, []);

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
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          <input
            id={INPUT_DOM_ID}
            data-tour-anchor="widget:quickcapture:main"
            ref={inputRef}
            className="c-input"
            style={{ fontSize: '1.1em' }}
            placeholder={t('tool.quickcapture.input.placeholder')}
            aria-label={t('tool.quickcapture.input.label')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void capture();
            }}
          />
          <span className="c-badge" title={t('tool.quickcapture.count.title')}>
            {items?.length ?? 0}
          </span>
        </div>

        {items !== null && items.length === 0 ? (
          <div
            className="c-muted"
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              textAlign: 'center',
              padding: 'var(--space-3)',
            }}
          >
            {t('tool.quickcapture.empty')}
          </div>
        ) : (
          <ul
            style={{
              flex: 1,
              overflowY: 'auto',
              margin: 0,
              padding: 0,
              listStyle: 'none',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            {(items ?? []).map((item) => (
              <li
                key={item.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-1) var(--space-2)',
                  borderRadius: 'var(--radius-sm)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <span style={{ flex: 1, overflowWrap: 'anywhere' }}>{item.text}</span>
                <button
                  className="c-btn c-btn--ghost"
                  title={t('tool.quickcapture.action.toTodo')}
                  aria-label={t('tool.quickcapture.action.toTodo')}
                  onClick={() => void sendToTodo(item)}
                >
                  →
                </button>
                <button
                  className="c-btn c-btn--ghost"
                  title={t('tool.quickcapture.action.delete')}
                  aria-label={t('tool.quickcapture.action.delete')}
                  onClick={() => void remove(item.id)}
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    activate(context) {
      ctx = context;
      context.commands.register({
        id: 'quickcapture.add',
        titleKey: 'tool.quickcapture.command.add',
        params: z.object({ text: z.string().min(1) }),
        selfTestParams: { text: 'probe' },
        async run({ text }) {
          const item = await addItem(context.storage, text);
          return item
            ? { ok: true, messageKey: 'tool.quickcapture.toast.added', data: item }
            : { ok: false, messageKey: 'tool.quickcapture.toast.empty' };
        },
      });
      context.commands.register({
        id: 'quickcapture.focus',
        titleKey: 'tool.quickcapture.command.focus',
        params: z.object({}),
        palette: true,
        selfTestParams: {},
        async run() {
          // The host's GLOBAL shortcut invokes this command. We only write the
          // "ui" doc – the widget subscribes to it and focuses the input.
          await requestFocus(context.storage);
          return { ok: true };
        },
      });
    },
    deactivate() {
      ctx = null;
    },
    Widget: QuickCaptureWidget,
    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'item-roundtrip': {
          const created = await addItem(testCtx.storage, '  roundtrip probe  ');
          if (!created) return { status: 'fail', detail: 'addItem returned null' };
          const read = await testCtx.storage.get<ItemDoc>(created.id);
          await testCtx.storage.delete(created.id);
          const gone = await testCtx.storage.get<ItemDoc>(created.id);
          if (read?.text !== 'roundtrip probe' || read.id !== created.id) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(read)}` };
          }
          return gone === null
            ? { status: 'pass' }
            : { status: 'fail', detail: 'item still present after delete' };
        }
        case 'add-command': {
          // Same internal add function the command uses, run against the scratch storage.
          const item = await addItem(testCtx.storage, 'add-command probe');
          if (!item) return { status: 'fail', detail: 'addItem rejected valid text' };
          const items = await listItems(testCtx.storage);
          const found = items.some((i) => i.id === item.id && i.text === 'add-command probe');
          await testCtx.storage.delete(item.id);
          return found
            ? { status: 'pass' }
            : { status: 'fail', detail: 'added item not found via query' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
