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
  QUADRANTS,
  buildEisenhowerContext,
  groupByQuadrant,
  makeTask,
  moveTask,
  quadrantToken,
  setDone,
  type Quadrant,
  type TaskDoc,
} from './logic';

const QUADRANT_ENUM = z.enum(['q1', 'q2', 'q3', 'q4']);

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function addTaskIn(
  storage: ToolStorage,
  input: { title: string; quadrant: Quadrant },
): Promise<TaskDoc> {
  const task = makeTask(input);
  await storage.set(task.id, task);
  return task;
}

async function moveTaskIn(storage: ToolStorage, id: string, quadrant: Quadrant): Promise<TaskDoc | null> {
  const task = await storage.get<TaskDoc>(id);
  if (!task) return null;
  const moved = moveTask(task, quadrant);
  if (moved !== task) await storage.set(id, moved);
  return moved;
}

async function setDoneIn(storage: ToolStorage, id: string, done: boolean): Promise<TaskDoc | null> {
  const task = await storage.get<TaskDoc>(id);
  if (!task) return null;
  const updated = setDone(task, done);
  if (updated !== task) await storage.set(id, updated);
  return updated;
}

async function queryTasksIn(storage: ToolStorage): Promise<TaskDoc[]> {
  return storage.query<TaskDoc>({ where: [{ field: 'type', op: '=', value: 'task' }] });
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /* ── Widget building blocks ──────────────────────────────────────── */

  function TaskRow(props: { task: TaskDoc; editing: boolean; showQuadrant: boolean }) {
    const { task, editing, showQuadrant } = props;
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', minWidth: 0 }}>
        <input
          type="checkbox"
          checked={task.done}
          onChange={() => {
            if (ctx) void setDoneIn(ctx.storage, task.id, !task.done);
          }}
          aria-label={t('tool.eisenhower.widget.toggle', { title: task.title })}
          style={{ flexShrink: 0, accentColor: `var(--${quadrantToken(task.quadrant)})` }}
        />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontSize: '0.9em',
            ...(task.done ? { textDecoration: 'line-through', color: 'var(--text-muted)' } : {}),
          }}
        >
          {task.title}
        </span>
        {showQuadrant ? (
          <select
            className="c-input"
            value={task.quadrant}
            aria-label={t('tool.eisenhower.widget.moveLabel', { title: task.title })}
            title={t('tool.eisenhower.widget.moveLabel', { title: task.title })}
            style={{ width: 'auto', flexShrink: 0, fontSize: '0.8em', padding: '0 var(--space-1)' }}
            onChange={(e) => {
              if (ctx) void moveTaskIn(ctx.storage, task.id, e.target.value as Quadrant);
            }}
          >
            {QUADRANTS.map((quadrant) => (
              <option key={quadrant} value={quadrant}>
                {t(`tool.eisenhower.quadrant.${quadrant}`)}
              </option>
            ))}
          </select>
        ) : null}
        {editing ? (
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.eisenhower.widget.delete', { title: task.title })}
            title={t('tool.eisenhower.widget.delete', { title: task.title })}
            style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
            onClick={() => void ctx?.storage.delete(task.id)}
          >
            ×
          </button>
        ) : null}
      </div>
    );
  }

  function Widget(props: WidgetProps) {
    const [tasks, setTasks] = useState<TaskDoc[]>([]);
    const [newTitle, setNewTitle] = useState('');
    const [newQuadrant, setNewQuadrant] = useState<Quadrant>('q1');

    const reload = useCallback(async () => {
      if (!ctx) return;
      setTasks(await queryTasksIn(ctx.storage));
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

    const groups = groupByQuadrant(tasks);

    async function addTask() {
      const title = newTitle.trim();
      if (!title || !ctx) return;
      await addTaskIn(ctx.storage, { title, quadrant: newQuadrant });
      setNewTitle('');
    }

    const addForm = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        <input
          className="c-input"
          value={newTitle}
          placeholder={t('tool.eisenhower.widget.addPlaceholder')}
          aria-label={t('tool.eisenhower.widget.addPlaceholder')}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addTask();
          }}
        />
        <select
          className="c-input"
          value={newQuadrant}
          aria-label={t('tool.eisenhower.widget.quadrantLabel')}
          title={t('tool.eisenhower.widget.quadrantLabel')}
          style={{ width: 'auto', flexShrink: 0 }}
          onChange={(e) => setNewQuadrant(e.target.value as Quadrant)}
        >
          {QUADRANTS.map((quadrant) => (
            <option key={quadrant} value={quadrant}>
              {t(`tool.eisenhower.quadrant.${quadrant}`)}
            </option>
          ))}
        </select>
      </div>
    );

    const quadrantHeader = (quadrant: Quadrant) => (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)', flexShrink: 0, minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            flexShrink: 0,
            background: `var(--${quadrantToken(quadrant)})`,
          }}
        />
        <span
          style={{
            fontSize: '0.75em',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {t(`tool.eisenhower.quadrant.${quadrant}`)}
        </span>
        <span className="c-badge c-muted" style={{ flexShrink: 0 }}>
          {groups[quadrant].filter((task) => !task.done).length}
        </span>
      </div>
    );

    if (props.variant === 'list') {
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
            {tasks.length === 0 ? (
              <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
                {t('tool.eisenhower.widget.empty')}
              </div>
            ) : (
              QUADRANTS.map((quadrant) =>
                groups[quadrant].length === 0 ? null : (
                  <div key={quadrant} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                    {quadrantHeader(quadrant)}
                    {groups[quadrant].map((task) => (
                      <TaskRow key={task.id} task={task} editing={props.editing} showQuadrant />
                    ))}
                  </div>
                ),
              )
            )}
          </div>
        </div>
      );
    }

    // Default variant: the 2×2 matrix.
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
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gridTemplateRows: '1fr 1fr',
            gap: 'var(--space-2)',
          }}
        >
          {QUADRANTS.map((quadrant) => (
            <div
              key={quadrant}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-1)',
                minWidth: 0,
                minHeight: 0,
                padding: 'var(--space-2)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-subtle)',
                boxShadow: `inset 3px 0 0 0 var(--${quadrantToken(quadrant)})`,
              }}
            >
              {quadrantHeader(quadrant)}
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
                {groups[quadrant].map((task) => (
                  <TaskRow key={task.id} task={task} editing={props.editing} showQuadrant />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;

      context.commands.register<{ title: string; quadrant: Quadrant }>({
        id: 'eisenhower.add',
        titleKey: 'tool.eisenhower.command.add',
        descriptionKey: 'tool.eisenhower.command.addDesc',
        icon: 'plus',
        params: z.object({ title: z.string().min(1), quadrant: QUADRANT_ENUM }),
        selfTestParams: { title: 'Cardo self-test task', quadrant: 'q4' },
        async run(params): Promise<CommandResult> {
          const task = await addTaskIn(context.storage, params);
          return { ok: true, data: task, messageKey: 'tool.eisenhower.msg.added' };
        },
      });

      // NOTE on selfTestParams of move/complete: diagnostics runs every command
      // with its selfTestParams against a scratch database, where the probe id
      // below never exists. run() therefore treats "not found" as a graceful
      // no-op instead of failing, so "command callable" stays verifiable and
      // real callers get a friendly toast for stale ids (same as todo).
      context.commands.register<{ id: string; quadrant: Quadrant }>({
        id: 'eisenhower.move',
        titleKey: 'tool.eisenhower.command.move',
        descriptionKey: 'tool.eisenhower.command.moveDesc',
        icon: 'move',
        palette: false,
        assistant: true,
        params: z.object({ id: z.string().min(1), quadrant: QUADRANT_ENUM }),
        selfTestParams: { id: 'task:selftest-nonexistent', quadrant: 'q1' },
        async run({ id, quadrant }): Promise<CommandResult> {
          const task = await moveTaskIn(context.storage, id, quadrant);
          if (!task) return { ok: true, messageKey: 'tool.eisenhower.msg.notFound' };
          return { ok: true, data: task, messageKey: 'tool.eisenhower.msg.moved' };
        },
      });

      context.commands.register({
        id: 'eisenhower.complete',
        titleKey: 'tool.eisenhower.command.complete',
        descriptionKey: 'tool.eisenhower.command.completeDesc',
        icon: 'check',
        palette: false,
        assistant: true,
        params: z.object({ id: z.string().min(1) }),
        selfTestParams: { id: 'task:selftest-nonexistent' },
        async run({ id }): Promise<CommandResult> {
          const task = await setDoneIn(context.storage, id, true);
          if (!task) return { ok: true, messageKey: 'tool.eisenhower.msg.notFound' };
          return { ok: true, data: task, messageKey: 'tool.eisenhower.msg.completed' };
        },
      });

      // Assistant "current state" provider – see todo.context for the contract.
      context.commands.register({
        id: 'eisenhower.context',
        titleKey: 'tool.eisenhower.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const tasks = await queryTasksIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildEisenhowerContext(tasks, context.i18n.language) },
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
          const task = await addTaskIn(testCtx.storage, { title: 'selftest crud', quadrant: 'q2' });
          const moved = await moveTaskIn(testCtx.storage, task.id, 'q3');
          const completed = await setDoneIn(testCtx.storage, task.id, true);
          const back = await testCtx.storage.get<TaskDoc>(task.id);
          await testCtx.storage.delete(task.id);
          const gone = await testCtx.storage.get<TaskDoc>(task.id);
          if (moved?.quadrant !== 'q3') {
            return { status: 'fail', detail: `move produced ${JSON.stringify(moved)}` };
          }
          if (completed?.done !== true) {
            return { status: 'fail', detail: `complete produced ${JSON.stringify(completed)}` };
          }
          if (!back || back.quadrant !== 'q3' || back.done !== true || back.title !== 'selftest crud') {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'task still present after delete' };
          return { status: 'pass', detail: 'add → move → complete → delete roundtrip ok' };
        }
        case 'render':
          return typeof Widget === 'function' && Widget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        case 'context': {
          const task = await addTaskIn(testCtx.storage, {
            title: 'selftest context probe',
            quadrant: 'q1',
          });
          const stored = await testCtx.storage.query<TaskDoc>({
            where: [{ field: 'type', op: '=', value: 'task' }],
          });
          const text = buildEisenhowerContext(stored, 'en');
          await testCtx.storage.delete(task.id);
          if (!text.includes('selftest context probe')) {
            return { status: 'fail', detail: `context text misses the seeded title: "${text}"` };
          }
          return { status: 'pass', detail: 'context text contains the seeded task' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
