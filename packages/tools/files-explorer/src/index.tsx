import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CardoTool,
  FileBrowseEntry,
  FileKind,
  FilesApi,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import { Markdown, extractWikiLinks, linksTo } from './markdown';

/** Extensions we let the user create from the widget (all plain-text kinds). */
const TEXT_EXTENSIONS = ['md', 'txt', 'csv', 'json'] as const;

/** Order + label key of the kind groups in the file list. */
const KIND_ORDER: FileKind[] = ['text', 'image', 'pdf', 'html'];

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

function extensionOf(name: string): string {
  const m = /\.([^.]+)$/.exec(name);
  return m ? m[1]!.toLowerCase() : '';
}

/** Resolves a [[wiki-link]] target to an actual entry (name or base, case-insensitive). */
function resolveWikiTarget(entries: FileBrowseEntry[], target: string): FileBrowseEntry | null {
  const want = target.replace(/\.md$/i, '').toLowerCase();
  return (
    entries.find((e) => e.name.toLowerCase() === target.toLowerCase()) ??
    entries.find((e) => baseName(e.name).toLowerCase() === want) ??
    null
  );
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string => ctx?.i18n.t(key, vars) ?? key;

  function ExplorerWidget(_props: WidgetProps) {
    const files: FilesApi | undefined = ctx?.files;

    const [entries, setEntries] = useState<FileBrowseEntry[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [kind, setKind] = useState<FileKind | null>(null);
    const [buffer, setBuffer] = useState('');
    const [savedBuffer, setSavedBuffer] = useState('');
    const [preview, setPreview] = useState(false);
    const [dataUrl, setDataUrl] = useState<string | null>(null);
    const [backlinks, setBacklinks] = useState<string[]>([]);
    const [newName, setNewName] = useState('');
    const [status, setStatus] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const dirty = buffer !== savedBuffer;
    const selfName = selected ?? '';

    const reload = useCallback(async () => {
      if (!files) return;
      if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
      const list = await files.browse();
      setEntries(list);
    }, [files]);

    useEffect(() => {
      void reload();
    }, [reload]);

    /** Loads a file into the right pane according to its kind. */
    const openFile = useCallback(
      async (entry: FileBrowseEntry) => {
        if (!files) return;
        setStatus(null);
        setSelected(entry.name);
        setKind(entry.kind);
        setPreview(entry.kind === 'text' && extensionOf(entry.name) === 'md');
        setDataUrl(null);
        setBacklinks([]);
        if (entry.kind === 'text') {
          const text = await files.read(entry.name);
          setBuffer(text);
          setSavedBuffer(text);
          // Backlinks: every markdown note that [[links]] to this one.
          if (extensionOf(entry.name) === 'md') {
            const targets = entries.filter(
              (e) => e.kind === 'text' && extensionOf(e.name) === 'md' && e.name !== entry.name,
            );
            const hits: string[] = [];
            for (const other of targets) {
              try {
                const c = await files.read(other.name);
                if (linksTo(c, entry.name)) hits.push(other.name);
              } catch {
                /* skip unreadable */
              }
            }
            setBacklinks(hits);
          }
        } else if (entry.kind === 'image') {
          setBuffer('');
          setSavedBuffer('');
          setDataUrl(await files.readDataUrl(entry.name));
        } else {
          setBuffer('');
          setSavedBuffer('');
        }
      },
      [files, entries],
    );

    async function save() {
      if (!files || !selected) return;
      setBusy(true);
      try {
        await files.write(selected, buffer);
        setSavedBuffer(buffer);
        setStatus(t('tool.files-explorer.saved'));
        await reload();
      } catch (err) {
        setStatus(String(err));
      } finally {
        setBusy(false);
      }
    }

    async function createFile() {
      if (!files) return;
      let name = newName.trim();
      if (!name) return;
      if (!extensionOf(name)) name = `${name}.md`;
      if (!/^[^/\\]+$/.test(name)) {
        setStatus(t('tool.files-explorer.invalidName'));
        return;
      }
      setBusy(true);
      try {
        if (!entries.some((e) => e.name.toLowerCase() === name.toLowerCase())) {
          await files.write(name, '');
        }
        setNewName('');
        await reload();
        const back = await files.browse();
        const created = back.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (created) await openFile(created);
      } catch (err) {
        setStatus(String(err));
      } finally {
        setBusy(false);
      }
    }

    async function removeFile(name: string) {
      if (!files) return;
      await files.delete(name);
      if (selected === name) {
        setSelected(null);
        setKind(null);
        setBuffer('');
        setSavedBuffer('');
        setDataUrl(null);
      }
      await reload();
    }

    async function openExternally() {
      if (!files || !selected) return;
      await files.openExternal(selected);
    }

    async function revealFolder() {
      await files?.reveal();
    }

    const onWikiLink = useCallback(
      async (target: string) => {
        const hit = resolveWikiTarget(entries, target);
        if (hit) {
          await openFile(hit);
          return;
        }
        // Missing target: offer to create it as a new markdown note.
        if (!files) return;
        const name = extensionOf(target) ? target : `${target}.md`;
        if (!/^[^/\\]+$/.test(name)) return;
        await files.write(name, `# ${baseName(name)}\n`);
        await reload();
        const back = await files.browse();
        const created = back.find((e) => e.name.toLowerCase() === name.toLowerCase());
        if (created) await openFile(created);
      },
      [entries, files, openFile, reload],
    );

    const grouped = useMemo(() => {
      const by: Record<FileKind, FileBrowseEntry[]> = { text: [], image: [], pdf: [], html: [] };
      for (const e of entries) by[e.kind].push(e);
      for (const k of KIND_ORDER) by[k].sort((a, b) => a.name.localeCompare(b.name));
      return by;
    }, [entries]);

    if (!files) {
      return (
        <div style={{ padding: 'var(--space-4)', color: 'var(--text-muted)' }}>
          {t('tool.files-explorer.noBackend')}
        </div>
      );
    }

    const isMarkdown = kind === 'text' && extensionOf(selfName) === 'md';

    return (
      <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
        {/* ── File list ─────────────────────────────────────────── */}
        <div
          style={{
            width: 220,
            flexShrink: 0,
            display: 'flex',
            flexDirection: 'column',
            borderRight: '1px solid var(--border-subtle)',
            minHeight: 0,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-1)',
              padding: 'var(--space-2)',
              flexShrink: 0,
            }}
          >
            <input
              className="c-input"
              value={newName}
              placeholder={t('tool.files-explorer.newPlaceholder')}
              aria-label={t('tool.files-explorer.newPlaceholder')}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void createFile();
              }}
            />
            <button
              className="c-btn c-btn--ghost"
              aria-label={t('tool.files-explorer.new')}
              title={t('tool.files-explorer.new')}
              style={{ padding: '0 var(--space-2)', flexShrink: 0 }}
              disabled={busy}
              onClick={() => void createFile()}
            >
              +
            </button>
            <button
              className="c-btn c-btn--ghost"
              aria-label={t('tool.files-explorer.reveal')}
              title={t('tool.files-explorer.reveal')}
              style={{ padding: '0 var(--space-2)', flexShrink: 0 }}
              onClick={() => void revealFolder()}
            >
              📂
            </button>
          </div>
          <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 var(--space-1) var(--space-2)' }}>
            {entries.length === 0 ? (
              <div className="c-muted" style={{ padding: 'var(--space-2)', fontSize: 13 }}>
                {t('tool.files-explorer.empty')}
              </div>
            ) : null}
            {KIND_ORDER.filter((k) => grouped[k].length > 0).map((k) => (
              <div key={k} style={{ marginBottom: 'var(--space-2)' }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    color: 'var(--text-muted)',
                    padding: 'var(--space-1) var(--space-2)',
                  }}
                >
                  {t(`tool.files-explorer.kind.${k}`)}
                </div>
                {grouped[k].map((entry) => {
                  const active = entry.name === selected;
                  return (
                    <div
                      key={entry.name}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 'var(--space-1)',
                        borderRadius: 'var(--radius-sm)',
                        ...(active ? { background: 'var(--bg-widget-hover)' } : {}),
                      }}
                    >
                      <button
                        className="c-btn c-btn--ghost"
                        style={{
                          flex: 1,
                          minWidth: 0,
                          justifyContent: 'flex-start',
                          textAlign: 'left',
                          padding: 'var(--space-1) var(--space-2)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          ...(active ? {} : { color: 'var(--text-muted)' }),
                        }}
                        title={entry.name}
                        onClick={() => void openFile(entry)}
                      >
                        {entry.name}
                      </button>
                      <button
                        className="c-btn c-btn--ghost"
                        aria-label={t('tool.files-explorer.delete', { name: entry.name })}
                        title={t('tool.files-explorer.delete', { name: entry.name })}
                        style={{ padding: '0 var(--space-1)', flexShrink: 0, color: 'var(--text-muted)' }}
                        onClick={() => void removeFile(entry.name)}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* ── Content pane ──────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {selected === null ? (
            <div
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: 'var(--text-muted)',
                padding: 'var(--space-4)',
                textAlign: 'center',
              }}
            >
              {t('tool.files-explorer.pickHint')}
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-2)',
                  padding: 'var(--space-2)',
                  borderBottom: '1px solid var(--border-subtle)',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    fontWeight: 600,
                  }}
                  title={selected}
                >
                  {selected}
                  {dirty ? ' •' : ''}
                </span>
                {isMarkdown ? (
                  <button
                    className="c-btn c-btn--ghost"
                    aria-pressed={preview}
                    style={preview ? { background: 'var(--bg-widget-hover)' } : undefined}
                    onClick={() => setPreview((p) => !p)}
                  >
                    {preview ? t('tool.files-explorer.edit') : t('tool.files-explorer.preview')}
                  </button>
                ) : null}
                {kind === 'text' ? (
                  <button className="c-btn" disabled={!dirty || busy} onClick={() => void save()}>
                    {t('tool.files-explorer.save')}
                  </button>
                ) : null}
                {kind === 'pdf' || kind === 'html' ? (
                  <button className="c-btn" onClick={() => void openExternally()}>
                    {t('tool.files-explorer.openExternal')}
                  </button>
                ) : null}
              </div>

              {/* Body */}
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {kind === 'text' && !preview ? (
                  <textarea
                    className="c-input"
                    value={buffer}
                    aria-label={t('tool.files-explorer.editorLabel', { name: selected })}
                    onChange={(e) => setBuffer(e.target.value)}
                    spellCheck={false}
                    style={{
                      width: '100%',
                      height: '100%',
                      minHeight: 0,
                      resize: 'none',
                      border: 'none',
                      borderRadius: 0,
                      fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                      lineHeight: 1.6,
                    }}
                  />
                ) : null}

                {kind === 'text' && preview ? (
                  <div style={{ padding: 'var(--space-4)' }}>
                    <Markdown source={buffer} onWikiLink={(name) => void onWikiLink(name)} />
                    {backlinks.length > 0 ? (
                      <div
                        style={{
                          marginTop: 'var(--space-4)',
                          paddingTop: 'var(--space-3)',
                          borderTop: '1px solid var(--border-subtle)',
                        }}
                      >
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            textTransform: 'uppercase',
                            letterSpacing: '0.04em',
                            color: 'var(--text-muted)',
                            marginBottom: 'var(--space-2)',
                          }}
                        >
                          {t('tool.files-explorer.backlinks', { count: backlinks.length })}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
                          {backlinks.map((name) => (
                            <button
                              key={name}
                              className="c-btn c-btn--ghost"
                              style={{ justifyContent: 'flex-start', textAlign: 'left' }}
                              onClick={() => {
                                const hit = entries.find((e) => e.name === name);
                                if (hit) void openFile(hit);
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {kind === 'image' ? (
                  <div style={{ padding: 'var(--space-4)', display: 'flex', justifyContent: 'center' }}>
                    {dataUrl ? (
                      <img
                        src={dataUrl}
                        alt={selected ?? ''}
                        style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                      />
                    ) : (
                      <span className="c-muted">{t('tool.files-explorer.loading')}</span>
                    )}
                  </div>
                ) : null}

                {kind === 'pdf' || kind === 'html' ? (
                  <div
                    style={{
                      padding: 'var(--space-4)',
                      color: 'var(--text-muted)',
                      textAlign: 'center',
                    }}
                  >
                    {t('tool.files-explorer.externalHint')}
                  </div>
                ) : null}
              </div>

              {status ? (
                <div
                  style={{
                    padding: 'var(--space-1) var(--space-2)',
                    fontSize: 12,
                    color: 'var(--text-muted)',
                    borderTop: '1px solid var(--border-subtle)',
                    flexShrink: 0,
                  }}
                >
                  {status}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    );
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context) {
      ctx = context;
    },

    deactivate() {
      ctx = null;
    },

    Widget: ExplorerWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'browse': {
          const files = testCtx.files;
          if (!files) return { status: 'warn', detail: 'no file backend in this context' };
          if ((await files.getFolder()) === null) await files.ensureDefaultFolder();
          const probe = `cardo-selftest-${TEXT_EXTENSIONS[0]}.md`;
          await files.write(probe, '# probe\n');
          const listed = (await files.browse()).find((e) => e.name === probe);
          await files.delete(probe);
          if (!listed) return { status: 'fail', detail: `probe ${probe} not returned by browse()` };
          if (listed.kind !== 'text') {
            return { status: 'fail', detail: `probe classified as "${listed.kind}", expected "text"` };
          }
          return { status: 'pass', detail: 'browse lists a written file with the right kind' };
        }
        case 'markdown': {
          const md = 'Link to [[Reise|meine Reise]] and [[Packliste]].';
          const links = extractWikiLinks(md);
          if (links.length !== 2 || links[0] !== 'Reise' || links[1] !== 'Packliste') {
            return { status: 'fail', detail: `wiki-links parsed as ${JSON.stringify(links)}` };
          }
          if (!linksTo(md, 'reise.md') || linksTo(md, 'Anderes')) {
            return { status: 'fail', detail: 'linksTo matching is wrong' };
          }
          return { status: 'pass', detail: 'markdown wiki-links extracted and matched correctly' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
