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
  READING_STATUSES,
  buildNoteMarkdown,
  buildReadingContext,
  filterByStatus,
  makeItem,
  slugify,
  sortItems,
  validateUrl,
  type ReadingItem,
  type ReadingStatus,
} from './logic';

/*
 * Reading list – a queue for articles & books. Items live as `item:<id>`
 * storage docs; "send to notes" additionally writes a markdown file via the
 * files API (hidden when the host provides no file backend).
 */

/* ── Storage helpers (shared by commands, widget and self-tests) ────────── */

async function addItemIn(
  storage: ToolStorage,
  input: { title: string; url?: string },
): Promise<ReadingItem> {
  const item = makeItem(input);
  await storage.set(item.id, item);
  return item;
}

async function setStatusIn(
  storage: ToolStorage,
  id: string,
  status: ReadingStatus,
): Promise<ReadingItem | null> {
  const item = await storage.get<ReadingItem>(id);
  if (!item) return null;
  if (item.status === status) return item;
  const updated: ReadingItem = { ...item, status };
  await storage.set(id, updated);
  return updated;
}

async function queryItems(storage: ToolStorage): Promise<ReadingItem[]> {
  return storage.query<ReadingItem>({ where: [{ field: 'type', op: '=', value: 'item' }] });
}

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /** Write `reading-<slug>.md` into the notes folder. Returns the file name. */
  async function sendToNotes(item: ReadingItem): Promise<string | null> {
    const files = ctx?.files;
    if (!files) return null;
    if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
    const name = `reading-${slugify(item.title)}.md`;
    await files.write(name, buildNoteMarkdown(item));
    return name;
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function useItems(): ReadingItem[] {
    const [items, setItems] = useState<ReadingItem[]>([]);
    useEffect(() => {
      let mounted = true;
      const reload = async () => {
        if (!ctx) return;
        const all = await queryItems(ctx.storage);
        if (mounted) setItems(sortItems(all));
      };
      void reload();
      const unsub = ctx?.storage.subscribe(() => void reload());
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);
    return items;
  }

  function AddForm() {
    const [title, setTitle] = useState('');
    const [url, setUrl] = useState('');
    const [invalidUrl, setInvalidUrl] = useState(false);

    async function add() {
      const trimmedTitle = title.trim();
      const trimmedUrl = url.trim();
      if (!trimmedTitle || !ctx) return;
      if (trimmedUrl && !validateUrl(trimmedUrl)) {
        setInvalidUrl(true);
        return;
      }
      const params: { title: string; url?: string } = { title: trimmedTitle };
      if (trimmedUrl) params.url = trimmedUrl;
      const result = await ctx.commands.execute('reading-list.add', params);
      if (result.ok) {
        setTitle('');
        setUrl('');
        setInvalidUrl(false);
      }
    }

    return (
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
        <input
          className="c-input"
          style={{ flex: 2, minWidth: 0 }}
          value={title}
          placeholder={t('tool.reading-list.widget.addPlaceholder')}
          aria-label={t('tool.reading-list.widget.addPlaceholder')}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
        <input
          className="c-input"
          style={{
            flex: 1,
            minWidth: 0,
            ...(invalidUrl ? { boxShadow: 'inset 0 0 0 1px var(--danger)' } : {}),
          }}
          value={url}
          placeholder={t('tool.reading-list.widget.urlPlaceholder')}
          aria-label={t('tool.reading-list.widget.urlPlaceholder')}
          aria-invalid={invalidUrl}
          title={invalidUrl ? t('tool.reading-list.msg.invalidUrl') : undefined}
          onChange={(e) => {
            setUrl(e.target.value);
            setInvalidUrl(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void add();
          }}
        />
      </div>
    );
  }

  function ItemTitle(props: { item: ReadingItem; done: boolean }) {
    const style = {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      ...(props.done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}),
    } as const;
    return props.item.url ? (
      <a
        href={props.item.url}
        target="_blank"
        rel="noopener noreferrer"
        style={{ ...style, color: props.done ? 'var(--text-muted)' : 'var(--accent)' }}
      >
        {props.item.title}
      </a>
    ) : (
      <span style={style}>{props.item.title}</span>
    );
  }

  function ItemActions(props: { item: ReadingItem; onNotesToggle?: () => void }) {
    const { item } = props;
    const [sent, setSent] = useState(false);
    const hasFiles = Boolean(ctx?.files);

    async function send() {
      await sendToNotes(item);
      setSent(true);
      window.setTimeout(() => setSent(false), 2000);
    }

    return (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0, alignItems: 'center' }}>
        {props.onNotesToggle ? (
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.reading-list.widget.notesToggle', { title: item.title })}
            title={t('tool.reading-list.widget.notesToggle', { title: item.title })}
            style={{ padding: '0 var(--space-1)', color: item.notes ? 'var(--accent)' : 'var(--text-muted)' }}
            onClick={props.onNotesToggle}
          >
            ✎
          </button>
        ) : null}
        {hasFiles ? (
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.reading-list.widget.sendToNotes', { title: item.title })}
            title={
              sent
                ? t('tool.reading-list.widget.sent')
                : t('tool.reading-list.widget.sendToNotes', { title: item.title })
            }
            style={{ padding: '0 var(--space-1)', color: sent ? 'var(--success)' : 'var(--text-muted)' }}
            onClick={() => void send()}
          >
            {sent ? '✓' : '📝'}
          </button>
        ) : null}
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.reading-list.widget.delete', { title: item.title })}
          title={t('tool.reading-list.widget.delete', { title: item.title })}
          style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)' }}
          onClick={() => void ctx?.storage.delete(item.id)}
        >
          ×
        </button>
      </div>
    );
  }

  function StatusSelect(props: { item: ReadingItem }) {
    return (
      <select
        className="c-input"
        style={{ width: 'auto', flexShrink: 0, fontSize: 12, padding: 'var(--space-1)' }}
        value={props.item.status}
        aria-label={t('tool.reading-list.widget.statusLabel', { title: props.item.title })}
        title={t('tool.reading-list.widget.statusLabel', { title: props.item.title })}
        onChange={(e) =>
          void ctx?.commands.execute('reading-list.set-status', {
            id: props.item.id,
            status: e.target.value,
          })
        }
      >
        {READING_STATUSES.map((s) => (
          <option key={s} value={s}>
            {t(`tool.reading-list.status.${s}`)}
          </option>
        ))}
      </select>
    );
  }

  function NotesEditor(props: { item: ReadingItem }) {
    const [draft, setDraft] = useState(props.item.notes);
    async function save() {
      if (!ctx || draft === props.item.notes) return;
      await ctx.storage.set<ReadingItem>(props.item.id, { ...props.item, notes: draft });
    }
    return (
      <textarea
        className="c-input"
        value={draft}
        placeholder={t('tool.reading-list.widget.notesPlaceholder')}
        aria-label={t('tool.reading-list.widget.notesPlaceholder')}
        style={{ resize: 'vertical', minHeight: 48, fontSize: 13 }}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void save()}
      />
    );
  }

  function Empty() {
    return (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t('tool.reading-list.widget.empty')}
      </div>
    );
  }

  function ListVariant() {
    const items = useItems();
    const [notesOpen, setNotesOpen] = useState<string | null>(null);
    return (
      <>
        <AddForm />
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
          {items.length === 0 ? <Empty /> : null}
          {items.map((item) => (
            <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                <StatusSelect item={item} />
                <span style={{ flex: 1, minWidth: 0, display: 'flex' }}>
                  <ItemTitle item={item} done={item.status === 'done'} />
                </span>
                <ItemActions
                  item={item}
                  onNotesToggle={() => setNotesOpen((open) => (open === item.id ? null : item.id))}
                />
              </div>
              {notesOpen === item.id ? <NotesEditor item={item} /> : null}
            </div>
          ))}
        </div>
      </>
    );
  }

  function CardsVariant() {
    const items = useItems();
    return (
      <>
        <AddForm />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
            gap: 'var(--space-2)',
            alignContent: 'start',
          }}
        >
          {items.length === 0 ? <Empty /> : null}
          {items.map((item) => (
            <div
              key={item.id}
              className="c-card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                padding: 'var(--space-2)',
                minWidth: 0,
              }}
            >
              <div style={{ display: 'flex', minWidth: 0 }}>
                <ItemTitle item={item} done={item.status === 'done'} />
              </div>
              {item.notes ? (
                <div
                  className="c-muted"
                  style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {item.notes}
                </div>
              ) : null}
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', justifyContent: 'space-between' }}>
                <StatusSelect item={item} />
                <ItemActions item={item} />
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  function KanbanVariant() {
    const items = useItems();
    const [dragOver, setDragOver] = useState<ReadingStatus | null>(null);

    const move = useCallback(async (id: string, status: ReadingStatus) => {
      if (!id) return;
      await ctx?.commands.execute('reading-list.set-status', { id, status });
    }, []);

    return (
      <>
        <AddForm />
        <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 1, minHeight: 0 }}>
          {READING_STATUSES.map((status) => (
            <div
              key={status}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                setDragOver(status);
              }}
              onDragLeave={() => setDragOver((current) => (current === status ? null : current))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                void move(e.dataTransfer.getData('text/plain'), status);
              }}
              style={{
                flex: 1,
                minWidth: 0,
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-2)',
                padding: 'var(--space-1)',
                borderRadius: 'var(--radius-sm)',
                ...(dragOver === status ? { boxShadow: 'inset 0 0 0 1px var(--accent)' } : {}),
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t(`tool.reading-list.status.${status}`)}
                </span>
                <span className="c-badge c-muted" style={{ flexShrink: 0 }}>
                  {filterByStatus(items, status).length}
                </span>
              </div>
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
                {filterByStatus(items, status).map((item) => (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/plain', item.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-sm)',
                      background: 'var(--bg-canvas)',
                      padding: 'var(--space-2)',
                      cursor: 'grab',
                      flexShrink: 0,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 'var(--space-1)',
                    }}
                  >
                    <div style={{ display: 'flex', minWidth: 0 }}>
                      <ItemTitle item={item} done={status === 'done'} />
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                      <ItemActions item={item} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </>
    );
  }

  function Widget(props: WidgetProps) {
    const inner =
      props.variant === 'kanban' ? (
        <KanbanVariant />
      ) : props.variant === 'cards' ? (
        <CardsVariant />
      ) : (
        <ListVariant />
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
        {inner}
      </div>
    );
  }

  /* ── Tool object ────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'reading-list.add',
        titleKey: 'tool.reading-list.command.add',
        descriptionKey: 'tool.reading-list.command.addDesc',
        icon: 'plus',
        params: z.object({ title: z.string().min(1), url: z.string().min(1).optional() }),
        selfTestParams: { title: 'Cardo self-test article' },
        async run(params): Promise<CommandResult> {
          if (params.url && !validateUrl(params.url)) {
            return { ok: false, messageKey: 'tool.reading-list.msg.invalidUrl' };
          }
          const item = await addItemIn(context.storage, params);
          return { ok: true, data: item, messageKey: 'tool.reading-list.msg.created' };
        },
      });

      // NOTE on selfTestParams: diagnostics executes this against a scratch
      // database where the probe id never exists – run() treats "not found"
      // as a graceful no-op so the command stays verifiable (todo pattern).
      context.commands.register({
        id: 'reading-list.set-status',
        titleKey: 'tool.reading-list.command.setStatus',
        descriptionKey: 'tool.reading-list.command.setStatusDesc',
        palette: false,
        assistant: true,
        params: z.object({
          id: z.string().min(1),
          status: z.enum(['queued', 'reading', 'done']),
        }),
        selfTestParams: { id: 'item:selftest-nonexistent', status: 'reading' },
        async run({ id, status }): Promise<CommandResult> {
          const item = await setStatusIn(context.storage, id, status);
          if (!item) return { ok: true, messageKey: 'tool.reading-list.msg.notFound' };
          return { ok: true, data: item, messageKey: 'tool.reading-list.msg.statusSet' };
        },
      });

      // Assistant "current state" provider (see todo.context).
      context.commands.register({
        id: 'reading-list.context',
        titleKey: 'tool.reading-list.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const items = await queryItems(context.storage);
          return {
            ok: true,
            data: { contextText: buildReadingContext(items, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const item = await addItemIn(testCtx.storage, {
            title: 'selftest crud',
            url: 'https://example.org/selftest',
          });
          const back = await testCtx.storage.get<ReadingItem>(item.id);
          await testCtx.storage.delete(item.id);
          const gone = await testCtx.storage.get<ReadingItem>(item.id);
          if (!back || back.title !== 'selftest crud' || back.status !== 'queued') {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (back.url !== 'https://example.org/selftest') {
            return { status: 'fail', detail: `url not persisted: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'item still present after delete' };
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'status-flow': {
          const item = await addItemIn(testCtx.storage, { title: 'selftest status flow' });
          const reading = await setStatusIn(testCtx.storage, item.id, 'reading');
          const done = await setStatusIn(testCtx.storage, item.id, 'done');
          const back = await testCtx.storage.get<ReadingItem>(item.id);
          await testCtx.storage.delete(item.id);
          if (reading?.status !== 'reading') {
            return { status: 'fail', detail: `queued → reading produced ${JSON.stringify(reading)}` };
          }
          if (done?.status !== 'done' || back?.status !== 'done') {
            return { status: 'fail', detail: `reading → done produced ${JSON.stringify(back)}` };
          }
          const missing = await setStatusIn(testCtx.storage, 'item:selftest-missing', 'done');
          if (missing !== null) {
            return { status: 'fail', detail: 'set-status on a missing item must return null' };
          }
          return { status: 'pass', detail: 'queued → reading → done persisted' };
        }
        case 'render': {
          if (typeof Widget !== 'function' || Widget.length > 1) {
            return { status: 'fail', detail: 'Widget export contract violated' };
          }
          const sorted = sortItems([
            makeItem({ title: 'b' }, new Date('2026-01-02')),
            { ...makeItem({ title: 'a' }, new Date('2026-01-01')), status: 'reading' },
          ]);
          if (sorted[0]?.title !== 'a') {
            return { status: 'fail', detail: 'sortItems must put reading items first' };
          }
          return { status: 'pass', detail: 'widget contract and sort order ok' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
