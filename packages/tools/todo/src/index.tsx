import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  EventBus,
  SearchResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  buildTodoContext,
  INBOX_ID,
  computeTodayData,
  deriveStatus,
  isOverdue,
  isValidDue,
  makeId,
  makeTask,
  matchesQuery,
  priorityToken,
  sortCompletedTasks,
  sortOpenTasks,
  todayIso,
  type ListDoc,
  type Priority,
  type TaskDoc,
  type TaskStatus,
  type TodayData,
} from './logic';

const PRIORITIES: Priority[] = ['low', 'medium', 'high'];
const STATUSES: TaskStatus[] = ['todo', 'doing', 'done'];

/** Board scope value meaning "show tasks of every list". */
const ALL_LISTS = 'all';

/**
 * Doc id of the tiny UI-state doc used for cross-widget signals
 * (e.g. the global search asks the main widget to highlight a task).
 */
const UI_DOC_ID = 'ui';
/** A focus request older than this is stale and ignored. */
const FOCUS_TTL_MS = 10_000;
/** How long the highlight stays visible. */
const FOCUS_HIGHLIGHT_MS = 2_500;

type UiDoc = { focusTask?: string; at?: number };

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

/**
 * Move a task to a Kanban status, keeping `done`/`completedAt` in sync
 * (done:true ⇔ status:'done'). Completing emits 'todo:completed' exactly
 * once – re-completing an already done task is a no-op.
 */
async function setTaskStatusIn(
  storage: ToolStorage,
  events: EventBus | null,
  id: string,
  status: TaskStatus,
): Promise<TaskDoc | null> {
  const task = await storage.get<TaskDoc>(id);
  if (!task) return null;
  if (status === 'done') {
    if (task.done) {
      if (task.status === 'done') return task; // idempotent – no second event
      const synced: TaskDoc = { ...task, status: 'done' };
      await storage.set(id, synced);
      return synced;
    }
    const completedAt = new Date().toISOString();
    const completed: TaskDoc = { ...task, done: true, status: 'done', completedAt };
    await storage.set(id, completed);
    // Cross-tool contract: the stats tool consumes this event later.
    events?.emit('todo:completed', { id: task.id, title: task.title, completedAt });
    return completed;
  }
  if (!task.done && task.status === status) return task;
  const updated: TaskDoc = { ...task, done: false, status, completedAt: null };
  await storage.set(id, updated);
  return updated;
}

async function completeTaskIn(
  storage: ToolStorage,
  events: EventBus | null,
  id: string,
): Promise<TaskDoc | null> {
  return setTaskStatusIn(storage, events, id, 'done');
}

async function deleteTaskIn(storage: ToolStorage, id: string): Promise<TaskDoc | null> {
  const task = await storage.get<TaskDoc>(id);
  if (!task) return null;
  await storage.delete(id);
  return task;
}

async function queryTodayIn(storage: ToolStorage): Promise<TodayData> {
  const [tasks, lists] = await Promise.all([
    storage.query<TaskDoc>({ where: [{ field: 'type', op: '=', value: 'task' }] }),
    storage.query<ListDoc>({ where: [{ field: 'type', op: '=', value: 'list' }] }),
  ]);
  return computeTodayData(tasks, lists, todayIso());
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
    const [focusTask, setFocusTask] = useState<string | null>(null);
    const rowRefs = useRef(new Map<string, HTMLDivElement>());

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

    // Focus requests from the global search: highlight + scroll to the task.
    useEffect(() => {
      let mounted = true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const applyFocus = async () => {
        const ui = await ctx?.storage.get<UiDoc>(UI_DOC_ID);
        if (!mounted || !ui?.focusTask || typeof ui.at !== 'number') return;
        if (Date.now() - ui.at > FOCUS_TTL_MS) return; // stale request
        const task = await ctx?.storage.get<TaskDoc>(ui.focusTask);
        if (!mounted) return;
        if (task) setActiveList(task.list);
        setFocusTask(ui.focusTask);
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (mounted) setFocusTask(null);
        }, FOCUS_HIGHLIGHT_MS);
      };
      void applyFocus();
      const unsub = ctx?.storage.subscribe((change) => {
        if (change.docId === UI_DOC_ID) void applyFocus();
      });
      return () => {
        mounted = false;
        if (timer) clearTimeout(timer);
        unsub?.();
      };
    }, []);

    useEffect(() => {
      if (!focusTask) return;
      rowRefs.current.get(focusTask)?.scrollIntoView({ block: 'nearest' });
    }, [focusTask, tasks, activeList]);

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
        await setTaskStatusIn(ctx.storage, ctx.events, task.id, 'todo');
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
      <div
        key={task.id}
        ref={(el) => {
          if (el) rowRefs.current.set(task.id, el);
          else rowRefs.current.delete(task.id);
        }}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          ...(task.id === focusTask ? { boxShadow: 'inset 0 0 0 1px var(--accent)' } : {}),
        }}
      >
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

  function BoardWidget(_props: WidgetProps) {
    const [lists, setLists] = useState<ListDoc[]>([]);
    const [tasks, setTasks] = useState<TaskDoc[]>([]);
    const [scope, setScope] = useState<string>(ALL_LISTS);
    const [newTitle, setNewTitle] = useState('');
    const [dragOver, setDragOver] = useState<TaskStatus | null>(null);

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
    const inScope = scope === ALL_LISTS ? tasks : tasks.filter((task) => task.list === scope);
    const columns: Record<TaskStatus, TaskDoc[]> = { todo: [], doing: [], done: [] };
    for (const task of inScope) columns[deriveStatus(task)].push(task);
    columns.todo = sortOpenTasks(columns.todo);
    columns.doing = sortOpenTasks(columns.doing);
    columns.done = sortCompletedTasks(columns.done);

    async function addTask() {
      const title = newTitle.trim();
      if (!title || !ctx) return;
      await createTaskIn(ctx.storage, inboxName(), {
        title,
        list: scope === ALL_LISTS ? undefined : scope,
      });
      setNewTitle('');
    }

    async function moveTask(id: string, status: TaskStatus) {
      if (!ctx || !id) return;
      await setTaskStatusIn(ctx.storage, ctx.events, id, status);
    }

    async function clearDone() {
      if (!ctx) return;
      await Promise.all(columns.done.map((task) => ctx?.storage.delete(task.id)));
    }

    const renderCard = (task: TaskDoc) => {
      const isDone = deriveStatus(task) === 'done';
      return (
        <div
          key={task.id}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData('text/plain', task.id);
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
            overflowWrap: 'break-word',
          }}
        >
          <div style={isDone ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : undefined}>
            {task.title}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', marginTop: 'var(--space-1)' }}>
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
            {task.due ? (
              <span
                style={{
                  fontSize: 12,
                  fontVariantNumeric: 'tabular-nums',
                  color: isOverdue(task, today) ? 'var(--danger)' : 'var(--text-muted)',
                }}
              >
                {task.due}
              </span>
            ) : null}
          </div>
        </div>
      );
    };

    const renderColumn = (status: TaskStatus) => (
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
          void moveTask(e.dataTransfer.getData('text/plain'), status);
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
        {/* Column header */}
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
            {t(`tool.todo.board.column.${status}`)}
          </span>
          <span className="c-badge c-muted" style={{ flexShrink: 0 }}>
            {columns[status].length}
          </span>
          {status === 'done' && columns.done.length > 0 ? (
            <button
              className="c-btn c-btn--ghost"
              style={{ fontSize: 12, padding: '0 var(--space-1)', marginLeft: 'auto', color: 'var(--text-muted)' }}
              onClick={() => void clearDone()}
            >
              {t('tool.todo.clearCompleted')}
            </button>
          ) : null}
        </div>

        {/* Quick add lives in the first column */}
        {status === 'todo' ? (
          <input
            className="c-input"
            style={{ flexShrink: 0 }}
            value={newTitle}
            placeholder={t('tool.todo.board.addPlaceholder')}
            aria-label={t('tool.todo.board.addPlaceholder')}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addTask();
            }}
          />
        ) : null}

        {/* Cards */}
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
          {columns[status].map(renderCard)}
        </div>
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
        {/* List scope */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
          <select
            className="c-input"
            style={{ width: 'auto' }}
            value={scope}
            aria-label={t('tool.todo.board.listLabel')}
            title={t('tool.todo.board.listLabel')}
            onChange={(e) => setScope(e.target.value)}
          >
            <option value={ALL_LISTS}>{t('tool.todo.board.allLists')}</option>
            {lists.map((list) => (
              <option key={list.id} value={list.id}>
                {list.name}
              </option>
            ))}
          </select>
        </div>

        {/* Columns */}
        <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 1, minHeight: 0 }}>
          {STATUSES.map(renderColumn)}
        </div>
      </div>
    );
  }

  function Widget(props: WidgetProps) {
    return props.widgetId === 'board' ? <BoardWidget {...props} /> : <TodoWidget {...props} />;
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

      // Data feed for the upcoming "Today" widget: open tasks that are due
      // today, overdue or high priority, plus day counters. Local date.
      context.commands.register({
        id: 'todo.query-today',
        titleKey: 'tool.todo.command.queryToday',
        icon: 'calendar',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run() {
          const data = await queryTodayIn(context.storage);
          return { ok: true, data };
        },
      });

      // Assistant "current state" provider: any command ending in `.context`
      // is executed (no params, read-only) before the assistant prompts, and
      // its `contextText` is injected so the assistant knows existing/completed
      // tasks and can flag duplicates instead of blindly re-creating them.
      context.commands.register({
        id: 'todo.context',
        titleKey: 'tool.todo.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run() {
          const tasks = await context.storage.query<TaskDoc>({
            where: [{ field: 'type', op: '=', value: 'task' }],
          });
          return {
            ok: true,
            data: { contextText: buildTodoContext(tasks, context.i18n.language) },
          };
        },
      });

      // Global search: open tasks by title/category. Picking a result NEVER
      // completes the task – it only asks the main widget (via the shared
      // 'ui' doc) to highlight and scroll to it.
      context.search.register(async (query): Promise<SearchResult[]> => {
        const q = query.trim();
        if (!q) return [];
        const [tasks, lists] = await Promise.all([
          context.storage.query<TaskDoc>({ where: [{ field: 'type', op: '=', value: 'task' }] }),
          context.storage.query<ListDoc>({ where: [{ field: 'type', op: '=', value: 'list' }] }),
        ]);
        const listName = new Map(lists.map((l) => [l.id, l.name]));
        return sortOpenTasks(tasks.filter((task) => !task.done && matchesQuery(task, q)))
          .slice(0, 5)
          .map((task) => ({
            title: task.title,
            subtitle: listName.get(task.list) ?? task.list,
            icon: '✓',
            action: async () => {
              await context.storage.set(UI_DOC_ID, { focusTask: task.id, at: Date.now() });
            },
          }));
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget,

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
        case 'board-status': {
          // Legacy derivation: docs without a status field.
          const probe = makeTask({ title: 'selftest board', list: 'list:selftest-board' });
          if (deriveStatus(probe) !== 'todo') {
            return { status: 'fail', detail: `fresh task derived as "${deriveStatus(probe)}", expected "todo"` };
          }
          if (deriveStatus({ done: true }) !== 'done') {
            return { status: 'fail', detail: 'legacy done doc (no status field) must derive as "done"' };
          }
          await testCtx.storage.set(probe.id, probe);
          const doing = await setTaskStatusIn(testCtx.storage, testCtx.events, probe.id, 'doing');
          const done = await setTaskStatusIn(testCtx.storage, testCtx.events, probe.id, 'done');
          const reopened = await setTaskStatusIn(testCtx.storage, testCtx.events, probe.id, 'todo');
          const back = await testCtx.storage.get<TaskDoc>(probe.id);
          await testCtx.storage.delete(probe.id);
          if (!doing || doing.done || doing.status !== 'doing' || deriveStatus(doing) !== 'doing') {
            return { status: 'fail', detail: `move to doing produced ${JSON.stringify(doing)}` };
          }
          if (!done || !done.done || done.status !== 'done' || !done.completedAt) {
            return { status: 'fail', detail: `move to done must sync done+completedAt, got ${JSON.stringify(done)}` };
          }
          if (!reopened || reopened.done || reopened.status !== 'todo' || reopened.completedAt !== null) {
            return { status: 'fail', detail: `reopen must clear done+completedAt, got ${JSON.stringify(reopened)}` };
          }
          if (!back || deriveStatus(back) !== 'todo') {
            return { status: 'fail', detail: `persisted doc derived as "${back ? deriveStatus(back) : 'missing'}"` };
          }
          return { status: 'pass', detail: 'status ⇄ done stay in sync across todo → doing → done → todo' };
        }
        case 'query-today': {
          const listId = 'list:selftest-today';
          const listDoc: ListDoc = {
            id: listId,
            type: 'list',
            name: 'Selftest Today',
            createdAt: new Date().toISOString(),
          };
          const today = todayIso();
          const yesterday = new Date();
          yesterday.setDate(yesterday.getDate() - 1);
          const tomorrow = new Date();
          tomorrow.setDate(tomorrow.getDate() + 1);
          const overdueTask = makeTask({
            title: 'selftest overdue',
            list: listId,
            due: todayIso(yesterday),
            priority: 'low',
          });
          const todayTask = makeTask({
            title: 'selftest due today',
            list: listId,
            due: today,
            priority: 'low',
          });
          const futureTask = makeTask({
            title: 'selftest future',
            list: listId,
            due: todayIso(tomorrow),
            priority: 'low',
          });
          const doneTask: TaskDoc = {
            ...makeTask({ title: 'selftest done', list: listId }),
            done: true,
            status: 'done',
            completedAt: new Date().toISOString(),
          };
          const probes = [overdueTask, todayTask, futureTask, doneTask];
          await testCtx.storage.set(listDoc.id, listDoc);
          await Promise.all(probes.map((task) => testCtx.storage.set(task.id, task)));
          // Same internal function the todo.query-today command uses, fed with
          // exactly our probes (isolated via the probe list) after a storage roundtrip.
          const stored = await testCtx.storage.query<TaskDoc>({
            where: [{ field: 'list', op: '=', value: listId }],
          });
          const data = computeTodayData(stored, [listDoc], today);
          await Promise.all(probes.map((task) => testCtx.storage.delete(task.id)));
          await testCtx.storage.delete(listDoc.id);
          if (data.overdue !== 1 || data.dueToday !== 1 || data.completedToday !== 1) {
            return {
              status: 'fail',
              detail: `counts overdue=${data.overdue}, dueToday=${data.dueToday}, completedToday=${data.completedToday} – expected 1/1/1`,
            };
          }
          if (data.open.length !== 2 || data.open[0]?.id !== overdueTask.id || data.open[1]?.id !== todayTask.id) {
            return {
              status: 'fail',
              detail: `open should be [overdue, dueToday], got ${JSON.stringify(data.open.map((i) => i.title))}`,
            };
          }
          if (data.open[0]?.overdue !== true || data.open[0]?.list !== 'Selftest Today') {
            return { status: 'fail', detail: `first item malformed: ${JSON.stringify(data.open[0])}` };
          }
          return { status: 'pass', detail: 'query-today counts and ordering match the probe set' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
