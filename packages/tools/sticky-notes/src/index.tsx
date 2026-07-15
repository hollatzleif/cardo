import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
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
  COLOR_TOKENS,
  bringToFront,
  buildStickyContext,
  clampPosition,
  makeNote,
  sortForGrid,
  type ColorToken,
  type NoteDoc,
} from './logic';

const COLOR_ENUM = z.enum(['chart-1', 'chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-6', 'chart-7', 'chart-8']);

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryNotesIn(storage: ToolStorage): Promise<NoteDoc[]> {
  return storage.query<NoteDoc>({ where: [{ field: 'type', op: '=', value: 'note' }] });
}

async function addNoteIn(
  storage: ToolStorage,
  input: { text: string; colorToken?: ColorToken; x?: number; y?: number },
): Promise<NoteDoc> {
  const note = makeNote(input, await queryNotesIn(storage));
  await storage.set(note.id, note);
  return note;
}

/** Sticky-note look: token-tinted background + border, never a raw color. */
function noteSurface(colorToken: ColorToken) {
  return {
    background: `color-mix(in srgb, var(--${colorToken}) 25%, var(--bg-widget))`,
    border: `1px solid var(--${colorToken})`,
    borderRadius: 'var(--radius-md)',
  } as const;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /** Shared per-note body: inline text editing, color dots, delete. */
  function NoteBody(props: { note: NoteDoc; editing: boolean }) {
    const { note, editing } = props;
    const [draft, setDraft] = useState<string | null>(null);

    async function saveDraft() {
      const text = draft?.trim();
      setDraft(null);
      if (!ctx || !text || text === note.text) return;
      await ctx.storage.set<NoteDoc>(note.id, { ...note, text });
    }

    async function recolor(colorToken: ColorToken) {
      if (!ctx || colorToken === note.colorToken) return;
      await ctx.storage.set<NoteDoc>(note.id, { ...note, colorToken });
    }

    return (
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minWidth: 0, height: '100%' }}
        onDoubleClick={() => setDraft((current) => current ?? note.text)}
      >
        {draft !== null ? (
          <>
            <textarea
              className="c-input"
              autoFocus
              value={draft}
              aria-label={t('tool.sticky-notes.widget.editLabel')}
              style={{ flex: 1, minHeight: 0, resize: 'none', fontSize: '0.85em' }}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => void saveDraft()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void saveDraft();
                }
                if (e.key === 'Escape') setDraft(null);
              }}
            />
            <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
              {COLOR_TOKENS.map((colorToken, index) => (
                <button
                  key={colorToken}
                  aria-label={t('tool.sticky-notes.widget.setColor', { index: index + 1 })}
                  title={t('tool.sticky-notes.widget.setColor', { index: index + 1 })}
                  // Color swatch button – intentionally no shared class, it IS the color.
                  style={{
                    width: 14,
                    height: 14,
                    padding: 0,
                    borderRadius: 999,
                    cursor: 'pointer',
                    background: `var(--${colorToken})`,
                    border:
                      colorToken === note.colorToken
                        ? '2px solid var(--text-primary)'
                        : '1px solid var(--border-subtle)',
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.preventDefault() /* keep textarea focus */}
                  onClick={() => void recolor(colorToken)}
                />
              ))}
            </div>
          </>
        ) : (
          <div style={{ display: 'flex', gap: 'var(--space-1)', minHeight: 0, flex: 1 }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                fontSize: '0.85em',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'break-word',
              }}
            >
              {note.text}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0 }}>
              <button
                className="c-btn c-btn--ghost"
                aria-label={t('tool.sticky-notes.widget.editLabel')}
                title={t('tool.sticky-notes.widget.editLabel')}
                style={{ padding: '0 var(--space-1)', fontSize: '0.8em', color: 'var(--text-muted)' }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => setDraft(note.text)}
              >
                ✎
              </button>
              {editing ? (
                <button
                  className="c-btn c-btn--ghost"
                  aria-label={t('tool.sticky-notes.widget.delete')}
                  title={t('tool.sticky-notes.widget.delete')}
                  style={{ padding: '0 var(--space-1)', fontSize: '0.8em', color: 'var(--text-muted)' }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => void ctx?.storage.delete(note.id)}
                >
                  ×
                </button>
              ) : null}
            </div>
          </div>
        )}
      </div>
    );
  }

  function useNotes(): NoteDoc[] {
    const [notes, setNotes] = useState<NoteDoc[]>([]);
    const reload = useCallback(async () => {
      if (!ctx) return;
      setNotes(await queryNotesIn(ctx.storage));
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
    return notes;
  }

  function AddForm(props: { notes: NoteDoc[] }) {
    const [newText, setNewText] = useState('');
    async function addNote() {
      const text = newText.trim();
      if (!text || !ctx) return;
      const note = makeNote({ text }, props.notes);
      await ctx.storage.set(note.id, note);
      setNewText('');
    }
    return (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        <input
          className="c-input"
          value={newText}
          placeholder={t('tool.sticky-notes.widget.addPlaceholder')}
          aria-label={t('tool.sticky-notes.widget.addPlaceholder')}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addNote();
          }}
        />
        <button
          className="c-btn c-btn--primary"
          aria-label={t('tool.sticky-notes.widget.add')}
          title={t('tool.sticky-notes.widget.add')}
          style={{ flexShrink: 0 }}
          onClick={() => void addNote()}
        >
          +
        </button>
      </div>
    );
  }

  function WallWidget(props: WidgetProps) {
    const notes = useNotes();
    const canvasRef = useRef<HTMLDivElement | null>(null);
    /** While dragging: local position override so moves stay smooth offline. */
    const [drag, setDrag] = useState<{ id: string; x: number; y: number } | null>(null);
    const dragRef = useRef<{
      id: string;
      pointerId: number;
      startClientX: number;
      startClientY: number;
      originX: number;
      originY: number;
      moved: boolean;
    } | null>(null);

    function positionOf(clientX: number, clientY: number): { x: number; y: number } | null {
      const state = dragRef.current;
      const canvas = canvasRef.current;
      if (!state || !canvas) return null;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;
      return clampPosition(
        state.originX + ((clientX - state.startClientX) / rect.width) * 100,
        state.originY + ((clientY - state.startClientY) / rect.height) * 100,
      );
    }

    function onNotePointerDown(note: NoteDoc, e: ReactPointerEvent<HTMLDivElement>) {
      // Buttons/inputs inside the note stop propagation themselves; textareas
      // (inline edit) must keep text selection working.
      if (e.target instanceof HTMLTextAreaElement) return;
      dragRef.current = {
        id: note.id,
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        originX: note.x,
        originY: note.y,
        moved: false,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    }

    function onNotePointerMove(e: ReactPointerEvent<HTMLDivElement>) {
      const state = dragRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      const pos = positionOf(e.clientX, e.clientY);
      if (!pos) return;
      state.moved = true;
      setDrag({ id: state.id, ...pos });
    }

    async function onNotePointerUp(note: NoteDoc, e: ReactPointerEvent<HTMLDivElement>) {
      const state = dragRef.current;
      if (!state || state.pointerId !== e.pointerId) return;
      dragRef.current = null;
      setDrag(null);
      if (!ctx) return;
      const z = bringToFront(notes, note.id);
      const pos = state.moved ? positionOf(e.clientX, e.clientY) : null;
      const next: NoteDoc = pos ? { ...note, x: pos.x, y: pos.y, z } : { ...note, z };
      // Persist only real changes (a plain click on the top note is a no-op).
      if (next.x !== note.x || next.y !== note.y || next.z !== note.z) {
        await ctx.storage.set<NoteDoc>(note.id, next);
      }
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
        <AddForm notes={notes} />
        <div ref={canvasRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {notes.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.sticky-notes.widget.empty')}
            </div>
          ) : null}
          {notes.map((note) => {
            const pos = drag?.id === note.id ? drag : note;
            return (
              <div
                key={note.id}
                onPointerDown={(e) => onNotePointerDown(note, e)}
                onPointerMove={onNotePointerMove}
                onPointerUp={(e) => void onNotePointerUp(note, e)}
                style={{
                  ...noteSurface(note.colorToken),
                  position: 'absolute',
                  left: `${pos.x}%`,
                  top: `${pos.y}%`,
                  zIndex: note.z,
                  width: '38%',
                  minWidth: 90,
                  maxWidth: 200,
                  minHeight: 56,
                  padding: 'var(--space-2)',
                  cursor: drag?.id === note.id ? 'grabbing' : 'grab',
                  touchAction: 'none',
                  boxSizing: 'border-box',
                }}
              >
                <NoteBody note={note} editing={props.editing} />
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function GridWidget(props: WidgetProps) {
    const notes = useNotes();
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
        <AddForm notes={notes} />
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
            gap: 'var(--space-2)',
            alignContent: 'start',
          }}
        >
          {notes.length === 0 ? (
            <div className="c-muted" style={{ gridColumn: '1 / -1', textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.sticky-notes.widget.empty')}
            </div>
          ) : null}
          {sortForGrid(notes).map((note) => (
            <div key={note.id} style={{ ...noteSurface(note.colorToken), padding: 'var(--space-2)', minHeight: 72 }}>
              <NoteBody note={note} editing={props.editing} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  function Widget(props: WidgetProps) {
    return props.variant === 'grid' ? <GridWidget {...props} /> : <WallWidget {...props} />;
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'sticky-notes.add',
        titleKey: 'tool.sticky-notes.command.add',
        descriptionKey: 'tool.sticky-notes.command.addDesc',
        icon: 'plus',
        params: z.object({ text: z.string().min(1), color: COLOR_ENUM.optional() }),
        selfTestParams: { text: 'Cardo self-test note' },
        async run({ text, color }): Promise<CommandResult> {
          const input: { text: string; colorToken?: ColorToken } = { text };
          if (color) input.colorToken = color;
          const note = await addNoteIn(context.storage, input);
          return { ok: true, data: note, messageKey: 'tool.sticky-notes.msg.added' };
        },
      });

      // Assistant "current state" provider – see todo.context for the contract.
      context.commands.register({
        id: 'sticky-notes.context',
        titleKey: 'tool.sticky-notes.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const notes = await queryNotesIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildStickyContext(notes, context.i18n.language) },
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
          const note = await addNoteIn(testCtx.storage, { text: 'selftest crud', colorToken: 'chart-5' });
          const back = await testCtx.storage.get<NoteDoc>(note.id);
          if (!back || back.text !== 'selftest crud' || back.colorToken !== 'chart-5') {
            await testCtx.storage.delete(note.id);
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          await testCtx.storage.set<NoteDoc>(note.id, { ...back, text: 'selftest updated' });
          const updated = await testCtx.storage.get<NoteDoc>(note.id);
          await testCtx.storage.delete(note.id);
          const gone = await testCtx.storage.get<NoteDoc>(note.id);
          if (updated?.text !== 'selftest updated') {
            return { status: 'fail', detail: `update lost: ${JSON.stringify(updated)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'note still present after delete' };
          return { status: 'pass', detail: 'create → read → update → delete roundtrip ok' };
        }
        case 'zorder': {
          // z-order logic through a real storage roundtrip.
          const a = await addNoteIn(testCtx.storage, { text: 'selftest z a' });
          const b = await addNoteIn(testCtx.storage, { text: 'selftest z b' });
          const stored = await queryNotesIn(testCtx.storage);
          const zA = bringToFront(stored, a.id);
          await testCtx.storage.set<NoteDoc>(a.id, { ...a, z: zA });
          const raised = await testCtx.storage.get<NoteDoc>(a.id);
          const afterRaise = await queryNotesIn(testCtx.storage);
          const stableTop = bringToFront(afterRaise, a.id);
          await testCtx.storage.delete(a.id);
          await testCtx.storage.delete(b.id);
          if (a.z >= b.z) {
            return { status: 'fail', detail: `later note must start on top: a.z=${a.z}, b.z=${b.z}` };
          }
          if (!raised || raised.z <= b.z) {
            return { status: 'fail', detail: `bringToFront must beat z=${b.z}, got ${raised?.z ?? 'null'}` };
          }
          if (stableTop !== raised.z) {
            return { status: 'fail', detail: `top note must keep z=${raised.z}, got ${stableTop}` };
          }
          return { status: 'pass', detail: 'buried note rises, top note z stays stable' };
        }
        case 'render':
          return typeof Widget === 'function' && Widget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
