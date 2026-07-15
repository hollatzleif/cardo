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
  addSnippetParamsSchema,
  allTags,
  buildSnippetsContext,
  filterSnippets,
  highlightLines,
  LANGUAGE_IDS,
  makeSnippet,
  splitTags,
  type SnippetDoc,
  type SpanKind,
} from './logic';

type SnippetsSettings = {
  /** Code font size in px. */
  fontSize: number;
  /** Wrap long lines instead of horizontal scrolling. */
  wrap: boolean;
};

const DEFAULT_SETTINGS: SnippetsSettings = { fontSize: 12, wrap: false };

/** Highlight colors – semantic tokens only. 'code' inherits the text color. */
const KIND_COLOR: Record<SpanKind, string | undefined> = {
  code: undefined,
  keyword: 'var(--accent)',
  string: 'var(--success)',
  comment: 'var(--text-muted)',
};

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function querySnippetsIn(storage: ToolStorage): Promise<SnippetDoc[]> {
  const snippets = await storage.query<SnippetDoc>({
    where: [{ field: 'type', op: '=', value: 'snippet' }],
  });
  return [...snippets].sort(
    (a, b) => b.createdAt.localeCompare(a.createdAt) || a.title.localeCompare(b.title),
  );
}

async function addSnippetIn(
  storage: ToolStorage,
  input: { title: string; language: string; body: string; tags?: string },
): Promise<SnippetDoc> {
  const snippet = makeSnippet({ ...input, tags: splitTags(input.tags) });
  await storage.set(snippet.id, snippet);
  return snippet;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  async function loadSettings(): Promise<SnippetsSettings> {
    const c = ctx;
    if (!c) return { ...DEFAULT_SETTINGS };
    const [fontSize, wrap] = await Promise.all([
      c.settings.get<number>('fontSize'),
      c.settings.get<boolean>('wrap'),
    ]);
    return {
      fontSize: fontSize ?? DEFAULT_SETTINGS.fontSize,
      wrap: wrap ?? DEFAULT_SETTINGS.wrap,
    };
  }

  function CodeView(props: {
    body: string;
    language: string;
    settings: SnippetsSettings;
    maxLines?: number;
  }) {
    const lines = highlightLines(props.body, props.language);
    const shown = props.maxLines ? lines.slice(0, props.maxLines) : lines;
    return (
      <pre
        style={{
          margin: 0,
          padding: 'var(--space-2)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-subtle)',
          background: 'var(--bg-canvas)',
          fontSize: props.settings.fontSize,
          lineHeight: 1.5,
          overflowX: props.settings.wrap ? 'hidden' : 'auto',
          whiteSpace: props.settings.wrap ? 'pre-wrap' : 'pre',
          wordBreak: props.settings.wrap ? 'break-word' : 'normal',
        }}
      >
        <code>
          {shown.map((spans, lineNo) => (
            <div key={lineNo} style={{ minHeight: '1.5em' }}>
              {spans.map((span, i) => (
                <span key={i} style={KIND_COLOR[span.kind] ? { color: KIND_COLOR[span.kind] } : undefined}>
                  {span.text}
                </span>
              ))}
            </div>
          ))}
          {props.maxLines && lines.length > props.maxLines ? (
            <div className="c-muted">…</div>
          ) : null}
        </code>
      </pre>
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

  function SnippetsWidget(props: WidgetProps) {
    const [snippets, setSnippets] = useState<SnippetDoc[]>([]);
    const [settings, setSettings] = useState<SnippetsSettings>({ ...DEFAULT_SETTINGS });
    const [query, setQuery] = useState('');
    const [tag, setTag] = useState('');
    const [expanded, setExpanded] = useState<string | null>(null);
    const [showAdd, setShowAdd] = useState(false);
    const [showSettings, setShowSettings] = useState(false);
    const [title, setTitle] = useState('');
    const [language, setLanguage] = useState('js');
    const [body, setBody] = useState('');
    const [tags, setTags] = useState('');
    const [copied, setCopied] = useState<string | null>(null);

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [list, loaded] = await Promise.all([querySnippetsIn(c.storage), loadSettings()]);
      setSnippets(list);
      setSettings(loaded);
    }, []);

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

    useEffect(() => {
      if (!copied) return;
      const timer = window.setTimeout(() => setCopied(null), 1500);
      return () => window.clearTimeout(timer);
    }, [copied]);

    const copy = (snippet: SnippetDoc) => {
      void navigator.clipboard?.writeText(snippet.body);
      setCopied(snippet.id);
    };

    async function addSnippet() {
      const c = ctx;
      if (!c || !title.trim() || !body.trim()) return;
      await addSnippetIn(c.storage, { title, language, body, tags });
      setTitle('');
      setBody('');
      setTags('');
      setShowAdd(false);
    }

    async function removeSnippet(snippet: SnippetDoc) {
      await ctx?.storage.delete(snippet.id);
    }

    const filtered = filterSnippets(snippets, query, tag || undefined);
    const tagOptions = allTags(snippets);

    const copyButton = (snippet: SnippetDoc) => (
      <button
        className="c-btn c-btn--ghost"
        aria-label={t('tool.snippets.widget.copy', { title: snippet.title })}
        title={t('tool.snippets.widget.copy', { title: snippet.title })}
        style={{
          padding: '0 var(--space-1)',
          flexShrink: 0,
          color: copied === snippet.id ? 'var(--success)' : 'var(--text-muted)',
        }}
        onClick={() => copy(snippet)}
      >
        {copied === snippet.id ? '✓' : '⧉'}
      </button>
    );

    const deleteButton = (snippet: SnippetDoc) => (
      <button
        className="c-btn c-btn--ghost"
        aria-label={t('tool.snippets.widget.delete', { title: snippet.title })}
        title={t('tool.snippets.widget.delete', { title: snippet.title })}
        style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
        onClick={() => void removeSnippet(snippet)}
      >
        ×
      </button>
    );

    const languageBadge = (snippet: SnippetDoc) => (
      <span className="c-badge c-muted" style={{ flexShrink: 0 }}>
        {snippet.language}
      </span>
    );

    const empty = (
      <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
        {t(snippets.length === 0 ? 'tool.snippets.widget.empty' : 'tool.snippets.widget.noMatches')}
      </div>
    );

    const addForm = showAdd ? (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
          <input
            className="c-input"
            value={title}
            placeholder={t('tool.snippets.widget.titlePlaceholder')}
            aria-label={t('tool.snippets.widget.titlePlaceholder')}
            style={{ flex: 2, minWidth: 100 }}
            onChange={(e) => setTitle(e.target.value)}
          />
          <select
            className="c-input"
            value={language}
            aria-label={t('tool.snippets.widget.languageLabel')}
            title={t('tool.snippets.widget.languageLabel')}
            style={{ width: 'auto', flexShrink: 0 }}
            onChange={(e) => setLanguage(e.target.value)}
          >
            {LANGUAGE_IDS.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
          <input
            className="c-input"
            value={tags}
            placeholder={t('tool.snippets.widget.tagsPlaceholder')}
            aria-label={t('tool.snippets.widget.tagsPlaceholder')}
            style={{ flex: 1, minWidth: 80 }}
            onChange={(e) => setTags(e.target.value)}
          />
        </div>
        <textarea
          className="c-input"
          value={body}
          placeholder={t('tool.snippets.widget.bodyPlaceholder')}
          aria-label={t('tool.snippets.widget.bodyPlaceholder')}
          rows={4}
          spellCheck={false}
          style={{ resize: 'vertical', fontSize: settings.fontSize, whiteSpace: 'pre' }}
          onChange={(e) => setBody(e.target.value)}
        />
        <button className="c-btn c-btn--primary" onClick={() => void addSnippet()}>
          {t('tool.snippets.widget.save')}
        </button>
      </div>
    ) : null;

    const settingsPanel = showSettings ? (
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
        <SettingRow labelKey="tool.snippets.settings.fontSize">
          <input
            className="c-input"
            type="number"
            min={8}
            max={32}
            value={settings.fontSize}
            style={{ width: 72, textAlign: 'right' }}
            onChange={(e) => {
              const v = Math.round(Number(e.target.value));
              if (Number.isFinite(v) && v >= 8 && v <= 32) void ctx?.settings.set('fontSize', v);
            }}
          />
        </SettingRow>
        <SettingRow labelKey="tool.snippets.settings.wrap">
          <input
            type="checkbox"
            checked={settings.wrap}
            style={{ accentColor: 'var(--accent)' }}
            onChange={(e) => void ctx?.settings.set('wrap', e.target.checked)}
          />
        </SettingRow>
      </div>
    ) : null;

    const toolbar = (
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
        <input
          className="c-input"
          value={query}
          placeholder={t('tool.snippets.widget.searchPlaceholder')}
          aria-label={t('tool.snippets.widget.searchPlaceholder')}
          style={{ flex: 1, minWidth: 0 }}
          onChange={(e) => setQuery(e.target.value)}
        />
        {tagOptions.length > 0 ? (
          <select
            className="c-input"
            value={tag}
            aria-label={t('tool.snippets.widget.tagFilterLabel')}
            title={t('tool.snippets.widget.tagFilterLabel')}
            style={{ width: 'auto', flexShrink: 0 }}
            onChange={(e) => setTag(e.target.value)}
          >
            <option value="">{t('tool.snippets.widget.allTags')}</option>
            {tagOptions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : null}
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.snippets.widget.addToggle')}
          title={t('tool.snippets.widget.addToggle')}
          aria-expanded={showAdd}
          style={{ flexShrink: 0 }}
          onClick={() => setShowAdd((s) => !s)}
        >
          +
        </button>
        <button
          className="c-btn c-btn--ghost"
          aria-label={t('tool.snippets.widget.settingsToggle')}
          title={t('tool.snippets.widget.settingsToggle')}
          aria-expanded={showSettings}
          style={{ flexShrink: 0 }}
          onClick={() => setShowSettings((s) => !s)}
        >
          ⚙
        </button>
      </div>
    );

    let listBody;
    if (props.variant === 'grid') {
      listBody =
        filtered.length === 0 ? (
          empty
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
              gap: 'var(--space-2)',
              alignContent: 'start',
            }}
          >
            {filtered.map((snippet) => (
              <div
                key={snippet.id}
                style={{
                  border: '1px solid var(--border-subtle)',
                  borderRadius: 'var(--radius-sm)',
                  padding: 'var(--space-2)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 'var(--space-1)',
                  minWidth: 0,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      fontWeight: 600,
                    }}
                  >
                    {snippet.title}
                  </span>
                  {copyButton(snippet)}
                  {deleteButton(snippet)}
                </div>
                <div style={{ display: 'flex', gap: 'var(--space-1)', alignItems: 'center' }}>
                  {languageBadge(snippet)}
                  {snippet.tags.map((own) => (
                    <span key={own} className="c-badge c-muted" style={{ flexShrink: 0 }}>
                      {own}
                    </span>
                  ))}
                </div>
                <CodeView body={snippet.body} language={snippet.language} settings={settings} maxLines={5} />
              </div>
            ))}
          </div>
        );
    } else if (props.variant === 'focused') {
      const focus = filtered[0] ?? null;
      listBody = !focus ? (
        empty
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', minHeight: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexShrink: 0 }}>
            <span
              style={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontWeight: 600,
              }}
            >
              {focus.title}
            </span>
            {languageBadge(focus)}
            {copyButton(focus)}
          </div>
          <CodeView body={focus.body} language={focus.language} settings={settings} />
        </div>
      );
    } else {
      // Default variant: searchable list with expandable code view.
      listBody =
        filtered.length === 0 ? (
          empty
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {filtered.map((snippet) => (
              <div key={snippet.id} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-1)' }}>
                  <button
                    className="c-btn c-btn--ghost"
                    aria-expanded={expanded === snippet.id}
                    style={{
                      flex: 1,
                      minWidth: 0,
                      justifyContent: 'flex-start',
                      textAlign: 'left',
                      padding: '0 var(--space-1)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    onClick={() => setExpanded((prev) => (prev === snippet.id ? null : snippet.id))}
                  >
                    {snippet.title}
                  </button>
                  {snippet.tags.slice(0, 2).map((own) => (
                    <span key={own} className="c-badge c-muted" style={{ flexShrink: 0 }}>
                      {own}
                    </span>
                  ))}
                  {languageBadge(snippet)}
                  {copyButton(snippet)}
                  {deleteButton(snippet)}
                </div>
                {expanded === snippet.id ? (
                  <CodeView body={snippet.body} language={snippet.language} settings={settings} />
                ) : null}
              </div>
            ))}
          </div>
        );
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
        {toolbar}
        {settingsPanel}
        {addForm}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{listBody}</div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

      context.commands.register({
        id: 'snippets.add',
        titleKey: 'tool.snippets.command.add',
        descriptionKey: 'tool.snippets.command.addDesc',
        icon: 'plus',
        params: addSnippetParamsSchema,
        selfTestParams: {
          title: 'Cardo self-test snippet',
          language: 'js',
          body: 'const probe = true;',
          tags: 'selftest',
        },
        async run(params): Promise<CommandResult> {
          const snippet = await addSnippetIn(context.storage, params);
          return { ok: true, data: snippet, messageKey: 'tool.snippets.msg.added' };
        },
      });

      context.commands.register({
        id: 'snippets.context',
        titleKey: 'tool.snippets.command.context',
        descriptionKey: 'tool.snippets.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const snippets = await querySnippetsIn(context.storage);
          return {
            ok: true,
            data: { contextText: buildSnippetsContext(snippets, context.i18n.language) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: SnippetsWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'crud': {
          const snippet = await addSnippetIn(testCtx.storage, {
            title: 'selftest snippet',
            language: 'TypeScript',
            body: 'const x: number = 1;',
            tags: 'selftest, probe',
          });
          const back = await testCtx.storage.get<SnippetDoc>(snippet.id);
          await testCtx.storage.delete(snippet.id);
          const gone = await testCtx.storage.get<SnippetDoc>(snippet.id);
          if (
            !back ||
            back.title !== 'selftest snippet' ||
            back.language !== 'ts' ||
            back.tags.join(',') !== 'selftest,probe' ||
            back.body !== 'const x: number = 1;'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'snippet still present after delete' };
          return { status: 'pass', detail: 'create → read → delete roundtrip ok' };
        }
        case 'highlight-logic': {
          const [jsLine] = highlightLines('const url = "http://x"; // note', 'js');
          if (!jsLine) return { status: 'fail', detail: 'highlighter returned no line' };
          const kinds = new Map(jsLine.map((span) => [span.text, span.kind]));
          if (kinds.get('const') !== 'keyword') {
            return { status: 'fail', detail: `"const" not a keyword: ${JSON.stringify(jsLine)}` };
          }
          if (kinds.get('"http://x"') !== 'string') {
            return { status: 'fail', detail: '"//" inside a string leaked into a comment' };
          }
          if (kinds.get('// note') !== 'comment') {
            return { status: 'fail', detail: 'trailing comment not detected' };
          }
          const joined = jsLine.map((span) => span.text).join('');
          if (joined !== 'const url = "http://x"; // note') {
            return { status: 'fail', detail: `span texts do not reproduce the line: "${joined}"` };
          }
          const [plain] = highlightLines('const x = 1;', 'cobol');
          if (!plain || plain.length !== 1 || plain[0]?.kind !== 'code') {
            return { status: 'fail', detail: 'unknown language must fall back to plain code' };
          }
          return { status: 'pass', detail: 'keyword/string/comment spans + plain fallback ok' };
        }
        case 'filter-logic': {
          const probes = [
            await addSnippetIn(testCtx.storage, {
              title: 'selftest fetch helper',
              language: 'js',
              body: 'fetch(url)',
              tags: 'selftest-filter, http',
            }),
            await addSnippetIn(testCtx.storage, {
              title: 'selftest css grid',
              language: 'css',
              body: 'display: grid;',
              tags: 'selftest-filter',
            }),
          ];
          const stored = await testCtx.storage.query<SnippetDoc>({
            where: [{ field: 'type', op: '=', value: 'snippet' }],
          });
          const mine = stored.filter((s) => s.tags.includes('selftest-filter'));
          const byQuery = filterSnippets(mine, 'fetch');
          const byTag = filterSnippets(mine, '', 'http');
          const none = filterSnippets(mine, 'nonexistent-xyz');
          await Promise.all(probes.map((p) => testCtx.storage.delete(p.id)));
          if (mine.length !== 2 || byQuery.length !== 1 || byQuery[0]?.title !== 'selftest fetch helper') {
            return { status: 'fail', detail: `query filter wrong: ${byQuery.length}/${mine.length}` };
          }
          if (byTag.length !== 1 || none.length !== 0) {
            return { status: 'fail', detail: `tag filter ${byTag.length}, empty query ${none.length}` };
          }
          return { status: 'pass', detail: 'query + tag filtering verified via storage roundtrip' };
        }
        case 'render':
          return typeof SnippetsWidget === 'function' && SnippetsWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
