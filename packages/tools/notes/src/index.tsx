import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { CardoTool, FilesApi, ToolContext, WidgetProps } from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { renderMarkdown } from './markdown';

/*
 * Notes – Markdown notes as real .md files (Obsidian principle).
 * The host resolves file NAMES inside one user-chosen folder; this tool
 * never sees or stores paths, except the display path from getFolder()
 * and the user's explicit folder choice persisted via ctx.settings.
 */

const UI_DOC_ID = 'ui';
const SAVE_DEBOUNCE_MS = 800;

type UiDoc = { lastOpen: string | null; updatedAt: string };
type NoteFile = { name: string; modifiedMs: number; size: number };

/** Strip path-like characters from a user-entered note name and append ".md". */
export function sanitizeNoteName(raw: string): string | null {
  let name = raw
    .replace(/[/\\]/g, '')
    .replace(/\.\./g, '')
    .replace(/^\.+/, '')
    .trim();
  if (name.toLowerCase().endsWith('.md')) name = name.slice(0, -3).trim();
  if (!name) return null;
  return `${name}.md`;
}

const displayName = (fileName: string): string => fileName.replace(/\.md$/i, '');

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string => ctx?.i18n.t(key, vars) ?? key;

  /** Restore the persisted folder choice (or bootstrap the zero-setup default). */
  async function restoreFolder(context: ToolContext): Promise<void> {
    const files = context.files;
    if (!files) return;
    const stored = await context.settings.get<string>('folder');
    if (stored) {
      try {
        await files.setFolder(stored);
        return;
      } catch {
        // Stored folder vanished (moved/deleted) – fall through to the default.
      }
    }
    if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
  }

  async function rememberLastOpen(context: ToolContext, name: string | null): Promise<void> {
    await context.storage.set<UiDoc>(UI_DOC_ID, {
      lastOpen: name,
      updatedAt: new Date().toISOString(),
    });
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function NotesWidget(props: WidgetProps) {
    const files = ctx?.files ?? null;
    const wide = props.size.w >= 6;

    const [notes, setNotes] = useState<NoteFile[]>([]);
    const [folder, setFolder] = useState<string | null>(null);
    const [selected, setSelected] = useState<string | null>(null);
    const [content, setContent] = useState('');
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');
    const [pane, setPane] = useState<'list' | 'editor'>('list');
    const [nameDraft, setNameDraft] = useState<string | null>(null);
    const [renameDraft, setRenameDraft] = useState<string | null>(null);

    const selectedRef = useRef<string | null>(null);
    selectedRef.current = selected;
    const saveTimerRef = useRef<number | null>(null);
    const pendingRef = useRef<{ name: string; content: string } | null>(null);

    const reloadList = useCallback(async () => {
      if (!files) return;
      const all = await files.list();
      setNotes(
        all
          .filter((f) => f.name.toLowerCase().endsWith('.md'))
          .sort((a, b) => b.modifiedMs - a.modifiedMs),
      );
    }, [files]);

    /** Write the pending debounced change immediately (blur, unmount, note switch). */
    const flushSave = useCallback(async () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending && files) {
        await files.write(pending.name, pending.content);
        await reloadList();
      }
    }, [files, reloadList]);

    const openNote = useCallback(
      async (name: string, rememberInUiDoc = true) => {
        if (!files || !ctx) return;
        await flushSave();
        try {
          const text = await files.read(name);
          selectedRef.current = name; // keep the ref in sync before React re-renders
          setSelected(name);
          setContent(text);
          setPane('editor');
          if (rememberInUiDoc) await rememberLastOpen(ctx, name);
        } catch {
          setSelected(null);
          setContent('');
        }
      },
      [files, flushSave],
    );

    // Initial load + react to the 'ui' storage doc (notes.open command, other widgets).
    useEffect(() => {
      let mounted = true;
      async function init() {
        if (!ctx || !files) return;
        let path = await files.getFolder();
        if (path === null) path = await files.ensureDefaultFolder();
        if (!mounted) return;
        setFolder(path);
        await reloadList();
        const ui = await ctx.storage.get<UiDoc>(UI_DOC_ID);
        if (mounted && ui?.lastOpen) await openNote(ui.lastOpen, false);
      }
      void init();
      const unsub = ctx?.storage.subscribe((change) => {
        if (!mounted || change.docId !== UI_DOC_ID) return;
        void ctx?.storage.get<UiDoc>(UI_DOC_ID).then((ui) => {
          if (mounted && ui?.lastOpen && ui.lastOpen !== selectedRef.current) {
            void openNote(ui.lastOpen, false);
          }
        });
      });
      return () => {
        mounted = false;
        unsub?.();
        void flushSave();
      };
    }, [files, reloadList, openNote, flushSave]);

    function onEdit(next: string) {
      const name = selectedRef.current;
      if (!name) return;
      setContent(next);
      pendingRef.current = { name, content: next };
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
    }

    async function createNote() {
      if (!files || !ctx || nameDraft === null) return;
      const name = sanitizeNoteName(nameDraft);
      setNameDraft(null);
      if (!name) return;
      if (!notes.some((n) => n.name === name)) await files.write(name, '');
      await reloadList();
      await openNote(name);
    }

    async function renameNote() {
      if (!files || !ctx || renameDraft === null || !selected) return;
      const to = sanitizeNoteName(renameDraft);
      setRenameDraft(null);
      if (!to || to === selected) return;
      await flushSave();
      await files.rename(selected, to);
      setSelected(to);
      await rememberLastOpen(ctx, to);
      await reloadList();
    }

    async function deleteNote(name: string) {
      if (!files || !ctx) return;
      if (!window.confirm(t('tool.notes.list.deleteConfirm', { name: displayName(name) }))) return;
      if (name === selectedRef.current) {
        pendingRef.current = null;
        setSelected(null);
        setContent('');
        await rememberLastOpen(ctx, null);
      }
      await files.delete(name);
      await reloadList();
    }

    async function changeFolder() {
      if (!files || !ctx) return;
      const picked = await files.pickFolder();
      if (!picked) return;
      await flushSave();
      const path = await files.setFolder(picked);
      await ctx.settings.set('folder', path);
      setFolder(path);
      setSelected(null);
      setContent('');
      await rememberLastOpen(ctx, null);
      await reloadList();
    }

    if (!files) {
      return (
        <div
          className="c-muted"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: 'var(--space-4)',
            textAlign: 'center',
          }}
        >
          {t('tool.notes.msg.noBackend')}
        </div>
      );
    }

    const showList = wide || pane === 'list';
    const showEditor = wide || pane === 'editor';

    const listPane = (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
          minHeight: 0,
          ...(wide
            ? { width: '38%', maxWidth: 220, flexShrink: 0, borderRight: '1px solid var(--border-subtle)', paddingRight: 'var(--space-2)' }
            : { flex: 1 }),
        }}
      >
        {nameDraft !== null ? (
          <input
            className="c-input"
            autoFocus
            value={nameDraft}
            placeholder={t('tool.notes.list.namePlaceholder')}
            aria-label={t('tool.notes.list.new')}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void createNote();
              if (e.key === 'Escape') setNameDraft(null);
            }}
          />
        ) : (
          <button className="c-btn" style={{ flexShrink: 0 }} onClick={() => setNameDraft('')}>
            + {t('tool.notes.list.new')}
          </button>
        )}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
          {notes.length === 0 ? (
            <div className="c-muted" style={{ fontSize: 13, textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.notes.list.empty')}
            </div>
          ) : null}
          {notes.map((note) => {
            const active = note.name === selected;
            return (
              <div key={note.name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                <button
                  className="c-btn c-btn--ghost"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    justifyContent: 'flex-start',
                    padding: 'var(--space-1) var(--space-2)',
                    ...(active
                      ? { background: 'var(--bg-widget-hover)', boxShadow: 'inset 2px 0 0 0 var(--accent)' }
                      : { color: 'var(--text-muted)' }),
                  }}
                  onClick={() => void openNote(note.name)}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayName(note.name)}
                  </span>
                </button>
                <button
                  className="c-btn c-btn--ghost"
                  aria-label={t('tool.notes.list.delete', { name: displayName(note.name) })}
                  title={t('tool.notes.list.delete', { name: displayName(note.name) })}
                  style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
                  onClick={() => void deleteNote(note.name)}
                >
                  ×
                </button>
              </div>
            );
          })}
        </div>
      </div>
    );

    const editorPane = (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', flex: 1, minWidth: 0, minHeight: 0 }}>
        {selected ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
              {renameDraft !== null ? (
                <input
                  className="c-input"
                  autoFocus
                  value={renameDraft}
                  placeholder={t('tool.notes.list.renamePlaceholder')}
                  aria-label={t('tool.notes.list.rename')}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void renameNote();
                    if (e.key === 'Escape') setRenameDraft(null);
                  }}
                />
              ) : (
                <button
                  className="c-btn c-btn--ghost"
                  title={t('tool.notes.list.rename')}
                  style={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', padding: 'var(--space-1) var(--space-2)', fontWeight: 600 }}
                  onClick={() => setRenameDraft(displayName(selected))}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {displayName(selected)}
                  </span>
                </button>
              )}
              <div role="tablist" style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
                {(['edit', 'preview'] as const).map((m) => (
                  <button
                    key={m}
                    role="tab"
                    aria-selected={mode === m}
                    className="c-btn c-btn--ghost"
                    style={{
                      padding: 'var(--space-1) var(--space-2)',
                      fontSize: 12,
                      ...(mode === m
                        ? { background: 'var(--bg-widget-hover)', boxShadow: 'inset 0 -2px 0 0 var(--accent)' }
                        : { color: 'var(--text-muted)' }),
                    }}
                    onClick={() => {
                      if (m === 'preview') void flushSave();
                      setMode(m);
                    }}
                  >
                    {t(`tool.notes.editor.${m}`)}
                  </button>
                ))}
              </div>
            </div>
            {mode === 'edit' ? (
              <textarea
                className="c-input"
                value={content}
                placeholder={t('tool.notes.editor.placeholder')}
                aria-label={t('tool.notes.editor.edit')}
                spellCheck={false}
                style={{ flex: 1, minHeight: 0, resize: 'none', fontFamily: 'var(--font-mono)', fontSize: 13, lineHeight: 1.5 }}
                onChange={(e) => onEdit(e.target.value)}
                onBlur={() => void flushSave()}
              />
            ) : (
              <div
                className="cardo-notes-md"
                style={{ flex: 1, minHeight: 0, overflowY: 'auto', userSelect: 'text', lineHeight: 1.55 }}
                // Safe: renderMarkdown escapes ALL input HTML before inserting its own tags.
                dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
              />
            )}
          </>
        ) : (
          <div className="c-muted" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, textAlign: 'center', padding: 'var(--space-4)' }}>
            {t('tool.notes.editor.empty')}
          </div>
        )}
      </div>
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)', padding: 'var(--space-3)' }}>
        <style>{`
          .cardo-notes-md h1, .cardo-notes-md h2, .cardo-notes-md h3 { margin: 0.5em 0 0.3em; line-height: 1.25; }
          .cardo-notes-md p, .cardo-notes-md ul, .cardo-notes-md ol { margin: 0.4em 0; }
          .cardo-notes-md ul, .cardo-notes-md ol { padding-left: 1.4em; }
          .cardo-notes-md a { color: var(--accent); }
          .cardo-notes-md code { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-widget-hover); border-radius: var(--radius-sm); padding: 0 4px; }
          .cardo-notes-md pre { background: var(--bg-widget-hover); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: var(--space-2); overflow-x: auto; }
          .cardo-notes-md pre code { background: transparent; padding: 0; }
        `}</style>

        {!wide ? (
          <div role="tablist" style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
            {(['list', 'editor'] as const).map((p) => (
              <button
                key={p}
                role="tab"
                aria-selected={pane === p}
                className="c-btn c-btn--ghost"
                style={{
                  padding: 'var(--space-1) var(--space-2)',
                  fontSize: 12,
                  ...(pane === p
                    ? { background: 'var(--bg-widget-hover)', boxShadow: 'inset 0 -2px 0 0 var(--accent)' }
                    : { color: 'var(--text-muted)' }),
                }}
                onClick={() => setPane(p)}
              >
                {t(`tool.notes.pane.${p}`)}
              </button>
            ))}
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 1, minHeight: 0 }}>
          {showList ? listPane : null}
          {showEditor ? editorPane : null}
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            flexShrink: 0,
            borderTop: '1px solid var(--border-subtle)',
            paddingTop: 'var(--space-2)',
          }}
        >
          <span
            className="c-muted"
            title={folder ?? undefined}
            style={{ flex: 1, minWidth: 0, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }}
          >
            {folder ?? t('tool.notes.footer.noFolder')}
          </span>
          <button
            className="c-btn c-btn--ghost"
            style={{ fontSize: 12, padding: 'var(--space-1) var(--space-2)', flexShrink: 0, color: 'var(--text-muted)' }}
            onClick={() => void changeFolder()}
          >
            {t('tool.notes.footer.changeFolder')}
          </button>
        </div>
      </div>
    );
  }

  /* ── Tool object ────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context) {
      ctx = context;

      context.commands.register({
        id: 'notes.create',
        titleKey: 'tool.notes.command.create',
        icon: 'plus',
        params: z.object({ name: z.string().min(1) }),
        selfTestParams: { name: 'cardo-selftest-probe' },
        async run({ name }) {
          const files = context.files;
          if (!files) return { ok: false, messageKey: 'tool.notes.msg.noBackend' };
          const fileName = sanitizeNoteName(name);
          if (!fileName) return { ok: false, messageKey: 'tool.notes.msg.invalidName' };
          if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
          const existing = await files.list();
          if (!existing.some((f) => f.name === fileName)) await files.write(fileName, '');
          await rememberLastOpen(context, fileName);
          return { ok: true, data: { name: fileName }, messageKey: 'tool.notes.msg.created' };
        },
      });

      context.commands.register({
        id: 'notes.open',
        titleKey: 'tool.notes.command.open',
        icon: 'file-text',
        params: z.object({ name: z.string().min(1) }),
        selfTestParams: { name: 'cardo-selftest-probe' },
        async run({ name }) {
          const files = context.files;
          if (!files) return { ok: false, messageKey: 'tool.notes.msg.noBackend' };
          const fileName = sanitizeNoteName(name);
          if (!fileName) return { ok: false, messageKey: 'tool.notes.msg.invalidName' };
          if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
          const existing = await files.list();
          if (!existing.some((f) => f.name === fileName)) {
            // Graceful no-op (also keeps the diagnostics scratch run green).
            return { ok: true, messageKey: 'tool.notes.msg.notFound' };
          }
          // The widget subscribes to this doc and opens the note.
          await rememberLastOpen(context, fileName);
          return { ok: true, data: { name: fileName }, messageKey: 'tool.notes.msg.opened' };
        },
      });

      await restoreFolder(context);
    },

    deactivate() {
      ctx = null;
    },

    Widget: NotesWidget,

    async runSelfTest(testId, testCtx) {
      switch (testId) {
        case 'markdown-render': {
          const out = renderMarkdown('# Head\n\n**bold** `code`\n\n<script>alert(1)</script>');
          if (!out.includes('<h1>Head</h1>')) {
            return { status: 'fail', detail: `heading missing in: ${out}` };
          }
          if (!out.includes('<strong>bold</strong>') || !out.includes('<code>code</code>')) {
            return { status: 'fail', detail: `inline formatting missing in: ${out}` };
          }
          if (out.includes('<script') || !out.includes('&lt;script&gt;')) {
            return { status: 'fail', detail: `HTML not escaped: ${out}` };
          }
          return { status: 'pass', detail: 'headings, inline formatting and HTML escaping ok' };
        }
        case 'file-roundtrip': {
          const files: FilesApi | undefined = testCtx.files;
          if (!files) return { status: 'warn', detail: 'no file backend in scratch context' };
          const probe = 'cardo-selftest-probe.md';
          const body = `# probe ${Date.now()}`;
          if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
          await files.write(probe, body);
          const back = await files.read(probe);
          const listed = (await files.list()).some((f) => f.name === probe);
          await files.delete(probe);
          if (back !== body) {
            return { status: 'fail', detail: `read returned ${JSON.stringify(back)}` };
          }
          if (!listed) return { status: 'fail', detail: 'probe file missing from list()' };
          return { status: 'pass', detail: 'write → list → read → delete roundtrip ok' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
