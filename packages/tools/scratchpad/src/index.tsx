import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import { renderMarkdown } from '@cardo/ui';
import manifest from '../manifest.json';
import { appendLine, buildScratchpadContext, firstLines } from './logic';
import { PAD_DOC_ID, createPadStore, type PadStore } from './store';

/*
 * Scratchpad – ONE always-there markdown note ("scratchpad.md" via the files
 * API, storage-doc fallback without a file backend). Debounced autosave,
 * live preview via the shared @cardo/ui markdown renderer.
 */

const SAVE_DEBOUNCE_MS = 500;

/** Tiny UI doc the append/clear commands touch so open widgets reload. */
const UI_DOC_ID = 'ui';
type UiDoc = { at: number };

type PadSettings = {
  /** Monospace font in the textarea. */
  monospace: boolean;
  /** Offer the preview tab in the "edit" variant. */
  previewRender: boolean;
};

const DEFAULT_SETTINGS: PadSettings = { monospace: true, previewRender: true };

/** Shared by the append command and self-tests. Returns the new content. */
async function appendIn(store: PadStore, text: string): Promise<string> {
  const next = appendLine(await store.load(), text);
  await store.save(next);
  return next;
}

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  let store: PadStore | null = null;

  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<PadSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [monospace, previewRender] = await Promise.all([
      c.settings.get<boolean>('monospace'),
      c.settings.get<boolean>('previewRender'),
    ]);
    return {
      monospace: monospace ?? DEFAULT_SETTINGS.monospace,
      previewRender: previewRender ?? DEFAULT_SETTINGS.previewRender,
    };
  }

  /* ── Widget ─────────────────────────────────────────────────────────── */

  function Preview(props: { content: string }) {
    return (
      <div
        className="cardo-scratch-md"
        style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto', userSelect: 'text', lineHeight: 1.55 }}
        // Safe: renderMarkdown escapes ALL input HTML before inserting its own tags.
        dangerouslySetInnerHTML={{ __html: renderMarkdown(props.content) }}
      />
    );
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

  function ScratchpadWidget(props: WidgetProps) {
    const variant = props.variant ?? 'edit';
    const [content, setContent] = useState('');
    const [settings, setSettings] = useState<PadSettings>({ ...DEFAULT_SETTINGS });
    const [showSettings, setShowSettings] = useState(false);
    const [mode, setMode] = useState<'edit' | 'preview'>('edit');

    const pendingRef = useRef<string | null>(null);
    const saveTimerRef = useRef<number | null>(null);

    /** Write the pending debounced change immediately (blur, unmount, reload). */
    const flushSave = useCallback(async () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      const pending = pendingRef.current;
      pendingRef.current = null;
      if (pending !== null && store) await store.save(pending);
    }, []);

    useEffect(() => {
      let mounted = true;
      const reload = async () => {
        if (!store) return;
        // Never clobber unsaved keystrokes with a stale read.
        if (pendingRef.current !== null) return;
        const text = await store.load();
        if (mounted && pendingRef.current === null) setContent(text);
      };
      void reload();
      void loadSettings().then((next) => {
        if (mounted) setSettings(next);
      });
      // Commands (append/clear) touch the 'ui' doc; the fallback backend
      // additionally emits a change for the pad doc itself.
      const unsubStorage = ctx?.storage.subscribe((change) => {
        if (change.docId === UI_DOC_ID || change.docId === PAD_DOC_ID) void reload();
      });
      const unsubSettings = ctx?.settings.subscribe(() => {
        void loadSettings().then((next) => {
          if (mounted) setSettings(next);
        });
      });
      return () => {
        mounted = false;
        unsubStorage?.();
        unsubSettings?.();
        void flushSave();
      };
    }, [flushSave]);

    function onEdit(next: string) {
      setContent(next);
      pendingRef.current = next;
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void flushSave(), SAVE_DEBOUNCE_MS);
    }

    async function clearPad() {
      if (!ctx) return;
      if (!window.confirm(t('tool.scratchpad.widget.clearConfirm'))) return;
      pendingRef.current = null;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      setContent('');
      await ctx.commands.execute('scratchpad.clear', {});
    }

    async function updateSetting(key: keyof PadSettings, value: boolean) {
      await ctx?.settings.set(key, value);
    }

    const editor = (
      <textarea
        className="c-input"
        value={content}
        placeholder={t('tool.scratchpad.widget.placeholder')}
        aria-label={t('tool.scratchpad.widget.editorLabel')}
        spellCheck={false}
        style={{
          flex: 1,
          minWidth: 0,
          minHeight: 0,
          resize: 'none',
          fontSize: 13,
          lineHeight: 1.5,
          ...(settings.monospace ? { fontFamily: 'var(--font-mono)' } : {}),
        }}
        onChange={(e) => onEdit(e.target.value)}
        onBlur={() => void flushSave()}
      />
    );

    const preview = content.trim() ? (
      <Preview content={content} />
    ) : (
      <div
        className="c-muted"
        style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center' }}
      >
        {t('tool.scratchpad.widget.empty')}
      </div>
    );

    const showTabs = variant === 'edit' && settings.previewRender;
    const body =
      variant === 'split' ? (
        <div style={{ display: 'flex', gap: 'var(--space-2)', flex: 1, minHeight: 0 }}>
          {editor}
          {preview}
        </div>
      ) : variant === 'preview' ? (
        preview
      ) : showTabs && mode === 'preview' ? (
        preview
      ) : (
        editor
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
        <style>{`
          .cardo-scratch-md h1, .cardo-scratch-md h2, .cardo-scratch-md h3 { margin: 0.5em 0 0.3em; line-height: 1.25; }
          .cardo-scratch-md p, .cardo-scratch-md ul, .cardo-scratch-md ol { margin: 0.4em 0; }
          .cardo-scratch-md ul, .cardo-scratch-md ol { padding-left: 1.4em; }
          .cardo-scratch-md a { color: var(--accent); }
          .cardo-scratch-md .md-wikilink { cursor: default; }
          .cardo-scratch-md code { font-family: var(--font-mono); font-size: 0.9em; background: var(--bg-widget-hover); border-radius: var(--radius-sm); padding: 0 4px; }
          .cardo-scratch-md pre { background: var(--bg-widget-hover); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); padding: var(--space-2); overflow-x: auto; }
          .cardo-scratch-md pre code { background: transparent; padding: 0; }
        `}</style>

        {showTabs ? (
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
                {t(`tool.scratchpad.widget.tab.${m}`)}
              </button>
            ))}
          </div>
        ) : null}

        {body}

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'flex-end',
            gap: 'var(--space-1)',
            flexShrink: 0,
          }}
        >
          {variant !== 'preview' ? (
            <button
              className="c-btn c-btn--ghost"
              style={{ fontSize: 12, padding: '0 var(--space-1)', color: 'var(--text-muted)' }}
              onClick={() => void clearPad()}
            >
              {t('tool.scratchpad.widget.clear')}
            </button>
          ) : null}
          <button
            className="c-btn c-btn--ghost"
            aria-label={t('tool.scratchpad.widget.settingsToggle')}
            title={t('tool.scratchpad.widget.settingsToggle')}
            aria-expanded={showSettings}
            style={{ padding: '0 var(--space-1)', color: 'var(--text-muted)' }}
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙
          </button>
        </div>

        {showSettings ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              flexShrink: 0,
              borderTop: '1px solid var(--border-subtle)',
              paddingTop: 'var(--space-2)',
            }}
          >
            <SettingRow labelKey="tool.scratchpad.settings.monospace">
              <input
                type="checkbox"
                checked={settings.monospace}
                style={{ accentColor: 'var(--accent)' }}
                onChange={(e) => void updateSetting('monospace', e.target.checked)}
              />
            </SettingRow>
            <SettingRow labelKey="tool.scratchpad.settings.previewRender">
              <input
                type="checkbox"
                checked={settings.previewRender}
                style={{ accentColor: 'var(--accent)' }}
                onChange={(e) => void updateSetting('previewRender', e.target.checked)}
              />
            </SettingRow>
          </div>
        ) : null}
      </div>
    );
  }

  /* ── Tool object ────────────────────────────────────────────────────── */

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;
      store = createPadStore(context.files, context.storage);

      context.commands.register({
        id: 'scratchpad.append',
        titleKey: 'tool.scratchpad.command.append',
        descriptionKey: 'tool.scratchpad.command.appendDesc',
        icon: 'plus',
        params: z.object({ text: z.string().min(1) }),
        selfTestParams: { text: 'Cardo self-test line' },
        async run({ text }): Promise<CommandResult> {
          const s = store ?? createPadStore(context.files, context.storage);
          const next = await appendIn(s, text);
          await context.storage.set<UiDoc>(UI_DOC_ID, { at: Date.now() });
          return {
            ok: true,
            data: { firstLines: firstLines(next, 3) },
            messageKey: 'tool.scratchpad.msg.appended',
          };
        },
      });

      // The widget asks for confirmation BEFORE executing this command;
      // the command itself clears unconditionally (assistant/palette path).
      context.commands.register({
        id: 'scratchpad.clear',
        titleKey: 'tool.scratchpad.command.clear',
        descriptionKey: 'tool.scratchpad.command.clearDesc',
        icon: 'trash',
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const s = store ?? createPadStore(context.files, context.storage);
          await s.save('');
          await context.storage.set<UiDoc>(UI_DOC_ID, { at: Date.now() });
          return { ok: true, messageKey: 'tool.scratchpad.msg.cleared' };
        },
      });

      // Assistant "current state" provider (see todo.context).
      context.commands.register({
        id: 'scratchpad.context',
        titleKey: 'tool.scratchpad.command.context',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const s = store ?? createPadStore(context.files, context.storage);
          const content = await s.load();
          return {
            ok: true,
            data: { contextText: buildScratchpadContext(content, context.i18n.language) },
          };
        },
      });

      // Zero-setup default folder, like notes (no folder picker here).
      if (context.files && (await context.files.getFolder()) === null) {
        await context.files.ensureDefaultFolder();
      }
    },

    deactivate() {
      ctx = null;
      store = null;
    },

    Widget: ScratchpadWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'roundtrip': {
          // Explicitly exercises the storage FALLBACK store (files may be
          // undefined in the scratch context anyway).
          const s = createPadStore(undefined, testCtx.storage);
          const before = await s.load();
          await s.save('erste Zeile');
          const first = await s.load();
          await appendIn(s, 'zweite Zeile');
          const second = await s.load();
          await s.save(before); // restore whatever the scratch doc held
          if (first !== 'erste Zeile') {
            return { status: 'fail', detail: `save → load returned ${JSON.stringify(first)}` };
          }
          if (second !== 'erste Zeile\nzweite Zeile') {
            return { status: 'fail', detail: `append → load returned ${JSON.stringify(second)}` };
          }
          return { status: 'pass', detail: 'save → load → append → load roundtrip ok' };
        }
        case 'append-command': {
          const s = createPadStore(undefined, testCtx.storage);
          const before = await s.load();
          await s.save('a\n');
          await appendIn(s, 'b'); // same helper the scratchpad.append command runs
          const noDouble = await s.load();
          await s.save('');
          await appendIn(s, 'x');
          const fromEmpty = await s.load();
          await s.save(before);
          if (noDouble !== 'a\nb') {
            return { status: 'fail', detail: `trailing newline handled wrong: ${JSON.stringify(noDouble)}` };
          }
          if (fromEmpty !== 'x') {
            return { status: 'fail', detail: `append to empty pad returned ${JSON.stringify(fromEmpty)}` };
          }
          return { status: 'pass', detail: 'append handles trailing newline and empty pad' };
        }
        case 'render': {
          if (typeof ScratchpadWidget !== 'function' || ScratchpadWidget.length > 1) {
            return { status: 'fail', detail: 'Widget export contract violated' };
          }
          const html = renderMarkdown('# Pad\n\n[[Link]] and $x^2$');
          if (!html.includes('<h1>Pad</h1>')) {
            return { status: 'fail', detail: `heading missing in: ${html}` };
          }
          if (!html.includes('md-wikilink') || !html.includes('katex')) {
            return { status: 'fail', detail: `wiki-link/KaTeX missing in: ${html}` };
          }
          const context = buildScratchpadContext('a\nb', 'en');
          if (!context.includes('a\nb')) {
            return { status: 'fail', detail: `context text malformed: ${context}` };
          }
          return { status: 'pass', detail: 'widget contract, shared renderer and context ok' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
