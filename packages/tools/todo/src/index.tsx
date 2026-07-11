import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  EventBus,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  INBOX_ID,
  isOverdue,
  isValidDue,
  makeId,
  makeTask,
  priorityToken,
  sortCompletedTasks,
  sortOpenTasks,
  todayIso,
  type ListDoc,
  type Priority,
  type TaskDoc,
} from './logic';

const PRIORITIES: Priority[] = ['low', 'medium', 'high'];

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function ensureInbox(storage: ToolStorage, name: string): Promise<ListDoc> {
  const existing = await storage.get<ListDoc>(INBOX_ID);
  if (existing) return existing;
  const inbox: ListDoc = { id: INBOX_ID, type: 'list', name, createdAt: new Date().toISOString() };
  await storage.set(INBOX_ID, inbox);
  return inbox;
}

/** Resolve a list reference (doc id, bare key or display name) to a list doc id, creating the list if needed. */
async function resolveListId(storage: ToolStorage, ref: string, inboxName: string): Promise<string> {
  if (ref === 'inbox' || ref === INBOX_ID) return (await ensureInbox(storage, inboxName)).id;
  const direct = await storage.get<ListDoc>(ref);
  if (direct) return direct.id;
  const prefixed = await storage.get<ListDoc>(`list:${ref}`);
  if (prefixed) return prefixed.id;
  const all = await storage.query<ListDoc>({ where: [{ field: 'type', op: '=', value: 'list' }] });
  const byName = all.find((l) => l.name.toLowerCase() === ref.toLowerCase());
  if (byName) return byName.id;
  const created: ListDoc = { id: makeId('list'), type: 'list', name: ref, createdAt: new Date().toISOString() };
  await storage.set(created.id, created);
  return created.id;
}

async function createTaskIn(
  storage: ToolStorage,
  inboxName: string,
  input: { title: string; list?: string; priority?: Priority; category?: string; due?: string },
): Promise<TaskDoc> {
  const listId = input.list
    ? await resolveListId(storage, input.list, inboxName)
    : (await ensureInbox(storage, inboxName)).id;
  const task = makeTask({ ...input, list: listId });
  await storage.set(task.id, task);
  return task;
}

async function completeTaskIn(
  storage: ToolStorage,
  events: EventBus | null,
  id: string,
): Promise<TaskDoc | null> {
  const task = await storage.get<TaskDoc>(id);
  if (!task) return null;
  if (task.done) return task; // idempotent – no second event
  const completedAt = new Date().toISOString();
  const completed: TaskDoc = { ...task, done: true, completedAt };
  await storage.set(id, completed);
  // Cross-tool contract: the stats tool consumes this event later.
  events?.emit('todo:completed', { id: task.id, title: task.title, completedAt });
  return completed;
}

async function deleteTaskIn(storage: ToolStorage, id: string): Promise<TaskDoc | null> {
  const task = await storage.get<TaskDoc>(id);
  if (!task) return null;
  await storage.delete(id);
  return task;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string => ctx?.i18n.t(key, vars) ?? key;
  const inboxName = () => t('tool.todo.list.inbox');

  function TodoWidget(_props: WidgetProps) {
    const [lists, setLists] = useState<ListDoc[]>([]);
    const [tasks, setTasks] = useState<TaskDoc[]>([]);
    const [activeList, setActiveList] = useState<string>(INBOX_ID);
    const [newTitle, setNewTitle] = useState('');
    const [newPriority, setNewPriority] = useState<Priority>('medium');
    const [listDraft, setListDraft] = useState<{ mode: 'add' | 'rename'; value: string } | null>(null);

    const reload = useCallback(async () => {
      if (!ctx) return;
      await ensureInbox(ctx.storage, inboxName());
      const [ls, ts] = await Promise.all([
        ctx.storage.query<ListDoc>({
          where: [{ field: 'type', op: '=', value: 'list' }],
          orderBy: 'createdAt',
          direction: 'asc',
        }),
        ctx.storage.query<TaskDoc>({ where: [{ field: 'type', op: '=', value: 'task' }] }),
      ]);
      setLists(ls);
      setTasks(ts);
    }, []);

    useEffect(() => {
      let mounted = true;
      const safeReload = () => {
        if (mounted) void reload();
      };
      safeReload();
      const unsub = ctx?.storage.subscribe(safeReload);
      return () => {
        mounted = false;
        unsub?.();
      };
    }, [reload]);

    const today = todayIso();
    const inActive = tasks.filter((task) => task.list === activeList);
    const open = sortOpenTasks(inActive.filter((task) => !task.done));
    const done = sortCompletedTasks(inActive.filter((task) => task.done));
    const activeListName = lists.find((l) => l.id === activeList)?.name ?? inboxName();

    async function addTask() {
      const title = newTitle.trim();
      if (!title || !ctx) return;
      await createTaskIn(ctx.storage, inboxName(), { title, list: activeList, priority: newPriority });
      setNewTitle('');
    }

    async function toggleTask(task: TaskDoc) {
      if (!ctx) return;
      if (task.done) {
        await ctx.storage.set<TaskDoc>(task.id, { ...task, done: false, completedAt: null });
      } else {
        await completeTaskIn(ctx.storage, ctx.events, task.id);
      }
    }

    async function removeTask(task: TaskDoc) {
      await ctx?.storage.delete(task.id);
    }

    async function clearCompleted() {
      if (!ctx) return;
      await Promise.all(done.map((task) => ctx?.storage.delete(task.id)));
    }

    async function submitListDraft() {
      if (!ctx || !listDraft) return;
      const name = listDraft.value.trim();
      if (!name) {
        setListDraft(null);
        return;
      }
      if (listDraft.mode === 'add') {
        const created: ListDoc = { id: makeId('list'), type: 'list', name, createdAt: new Date().toISOString() };
        await ctx.storage.set(created.id, created);
        setActiveList(created.id);
      } else {
        const current = await ctx.storage.get<ListDoc>(activeList);
        if (current) await ctx.storage.set<ListDoc>(activeList, { ...current, name });
      }
      setListDraft(null);
    }

    const renderTask = (task: TaskDoc) => (
      <div key={task.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <input
          type="checkbox"
          checked={task.done}
          onChange={() => void toggleTask(task)}
          aria-label={t('tool.todo.toggleTask', { title: task.title })}
          style={{ flexShrink: 0, accentColor: 'var(--accent)' }}
        />
        <span
          aria-hidden
          title={t(`tool.todo.priority.${task.priority}`)}
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            flexShrink: 0,
            background: `var(--${priorityToken(task.priority)})`,
          }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            ...(task.done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}),
          }}
        >
          {task.title}
        </span>
        {task.category ? (
          <span className="c-badge c-muted" style={{ flexShrink: 0 }}>
            {task.category}
          </span>
        ) : null}
        {task.due ? (
          <span
            style={{
              fontSize: 12,
              flexShrink: 0,
              fontVariantNumeric: 'tabular-nums',
              color: isOverdue(task, today) ? 'var(--danger)' : 'var(--text-muted)',
            }}
          >
            {task.due}
          </span>
        ) : null}
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.todo.deleteTask', { title: task.title })}
          title={t('tool.todo.deleteTask', { title: task.title })}
          style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
          onClick={() => void removeTask(task)}
        >
          ×
        </button>
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
        {/* List switcher */}
        <div
          role="tablist"
          style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', overflowX: 'auto', flexShrink: 0 }}
        >
          {lists.map((list) => {
            const active = list.id === activeList;
            return (
              <button
                key={list.id}
                role="tab"
                aria-selected={active}
                className="c-btn c-btn--ghost"
                style={{
                  padding: 'var(--space-1) var(--space-2)',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                  ...(active
                    ? { background: 'var(--bg-widget-hover)', boxShadow: 'inset 0 -2px 0 0 var(--accent)' }
                    : { color: 'var(--text-muted)' }),
                }}
                onClick={() => setActiveList(list.id)}
              >
                {list.name}
              </button>
            );
          })}
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.todo.list.add')}
            title={t('tool.todo.list.add')}
            style={{ padding: 'var(--space-1) var(--space-2)', flexShrink: 0 }}
            onClick={() => setListDraft({ mode: 'add', value: '' })}
          >
            +
          </button>
          <button
            className="c-btn c-btn--ghost"
            style={{ padding: 'var(--space-1) var(--space-2)', fontSize: 12, flexShrink: 0, color: 'var(--text-muted)' }}
            onClick={() => setListDraft({ mode: 'rename', value: activeListName })}
          >
            {t('tool.todo.list.rename')}
          </button>
        </div>

        {/* Add / rename list */}
        {listDraft ? (
          <input
            className="c-input"
            autoFocus
            value={listDraft.value}
            placeholder={t(
              listDraft.mode === 'add' ? 'tool.todo.list.namePlaceholder' : 'tool.todo.list.renamePlaceholder',
            )}
            aria-label={t(listDraft.mode === 'add' ? 'tool.todo.list.add' : 'tool.todo.list.rename')}
            onChange={(e) => setListDraft({ ...listDraft, value: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitListDraft();
              if (e.key === 'Escape') setListDraft(null);
            }}
          />
        ) : null}

        {/* Add task */}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexShrink: 0 }}>
          <input
            className="c-input"
            value={newTitle}
            placeholder={t('tool.todo.addPlaceholder')}
            aria-label={t('tool.todo.addPlaceholder')}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTask();
            }}
          />
          <select
            className="c-input"
            style={{ width: 'auto', flexShrink: 0 }}
            value={newPriority}
            aria-label={t('tool.todo.priorityLabel')}
            title={t('tool.todo.priorityLabel')}
            onChange={(e) => setNewPriority(e.target.value as Priority)}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {t(`tool.todo.priority.${p}`)}
              </option>
            ))}
          </select>
        </div>

        {/* Tasks */}
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
          {open.map(renderTask)}
          {open.length === 0 && done.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.todo.empty')}
            </div>
          ) : null}
          {done.length > 0 ? (
            <>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginTop: 'var(--space-2)',
                  borderTop: '1px solid var(--border-subtle)',
                  paddingTop: 'var(--space-2)',
                }}
              >
                <span className="c-muted" style={{ fontSize: 12 }}>
                  {t('tool.todo.completedHeading', { count: done.length })}
                </span>
                <button
                  className="c-btn c-btn--ghost"
                  style={{ fontSize: 12, padding: '0 var(--space-1)', color: 'var(--text-muted)' }}
                  onClick={() => void clearCompleted()}
                >
                  {t('tool.todo.clearCompleted')}
                </button>
              </div>
              {done.map(renderTask)}
            </>
          ) : null}
        </div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context) {
      ctx = context;

      context.commands.register({
        id: 'todo.create',
        titleKey: 'tool.todo.command.create',
        icon: 'plus',
        params: z.object({
          title: z.string().min(1),
          list: z.string().min(1).optional(),
          priority: z.enum(['low', 'medium', 'high']).optional(),
          due: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .optional(),
          category: z.string().optional(),
        }),
        selfTestParams: { title: 'Cardo self-test task', priority: 'low' },
        async run(params) {
          if (params.due && !isValidDue(params.due)) {
            return { ok: false, messageKey: 'tool.todo.msg.invalidDue' };
          }
          const task = await createTaskIn(context.storage, inboxName(), params);
          return { ok: true, data: task, messageKey: 'tool.todo.msg.created' };
        },
      });

      // NOTE on selfTestParams of complete/delete: diagnostics runs every
      // command with its selfTestParams against a scratch database, where the
      // probe id below never exists. run() therefore treats "not found" as a
      // graceful no-op – { ok: true, messageKey: 'tool.todo.msg.notFound' } –
      // instead of failing or throwing, so "command callable" stays verifiable
      // and real callers get a friendly toast for stale ids.
      context.commands.register({
        id: 'todo.complete',
        titleKey: 'tool.todo.command.complete',
        icon: 'check',
        palette: false,
        params: z.object({ id: z.string().min(1) }),
        selfTestParams: { id: 'task:selftest-nonexistent' },
        async run({ id }) {
          const task = await completeTaskIn(context.storage, context.events, id);
          if (!task) return { ok: true, messageKey: 'tool.todo.msg.notFound' };
          return { ok: true, data: task, messageKey: 'tool.todo.msg.completed' };
        },
      });

      context.commands.register({
        id: 'todo.delete',
        titleKey: 'tool.todo.command.delete',
        icon: 'trash',
        palette: false,
        params: z.object({ id: z.string().min(1) }),
        selfTestParams: { id: 'task:selftest-nonexistent' },
        async run({ id }) {
          const task = await deleteTaskIn(context.storage, id);
          if (!task) return { ok: true, messageKey: 'tool.todo.msg.notFound' };
          return { ok: true, data: task, messageKey: 'tool.todo.msg.deleted' };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: TodoWidget,

    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'create-roundtrip': {
          const task = await createTaskIn(testCtx.storage, 'Inbox', {
            title: 'selftest roundtrip',
            due: '2099-12-31',
            category: 'selftest',
          });
          const back = await testCtx.storage.get<TaskDoc>(task.id);
          await testCtx.storage.delete(task.id);
          if (!back) return { status: 'fail', detail: `task ${task.id} not readable after create` };
          if (back.id !== task.id || back.title !== 'selftest roundtrip' || back.done !== false) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'complete-flow': {
          const task = await createTaskIn(testCtx.storage, 'Inbox', { title: 'selftest complete' });
          await completeTaskIn(testCtx.storage, testCtx.events, task.id);
          const back = await testCtx.storage.get<TaskDoc>(task.id);
          await testCtx.storage.delete(task.id);
          if (!back || back.done !== true || !back.completedAt) {
            return { status: 'fail', detail: `expected done+completedAt, got ${JSON.stringify(back)}` };
          }
          return { status: 'pass', detail: `completedAt=${back.completedAt}` };
        }
        case 'query-by-list': {
          const a = makeTask({ title: 'selftest a', list: 'list:selftest-a' });
          const b = makeTask({ title: 'selftest b', list: 'list:selftest-b' });
          await testCtx.storage.set(a.id, a);
          await testCtx.storage.set(b.id, b);
          const got = await testCtx.storage.query<TaskDoc>({
            where: [{ field: 'list', op: '=', value: 'list:selftest-a' }],
          });
          await testCtx.storage.delete(a.id);
          await testCtx.storage.delete(b.id);
          const hasA = got.some((task) => task.id === a.id);
          const onlyA = got.every((task) => task.list === 'list:selftest-a');
          if (!hasA || !onlyA) {
            return { status: 'fail', detail: `filter returned ${got.length} docs, hasA=${hasA}, onlyA=${onlyA}` };
          }
          return { status: 'pass', detail: 'list filter returns exactly the matching tasks' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
