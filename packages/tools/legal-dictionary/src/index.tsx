import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import type {
  CardoTool,
  CommandResult,
  LegalBook,
  LegalNorm,
  LegalSourceInfo,
  SelfTestContext,
  SelfTestResult,
  ToolContext,
  ToolStorage,
  WidgetProps,
} from '@cardo/plugin-api';
import manifest from '../manifest.json';
import {
  addParagraphSchema,
  buildContext,
  makeParagraph,
  paragraphLabel,
  searchParagraphs,
  textHash,
  type AddParagraphInput,
  type ParagraphDoc,
} from './logic';

/**
 * Legal paragraphs – a jurist stores statute sections (§§ / articles) with
 * their own comment. Offline (type it in) always works; the online path fetches
 * the official text from a legal source via the host's `legal` capability (the
 * Rust adapters), and re-checks its "as of" date on demand.
 */

async function queryParagraphs(storage: ToolStorage): Promise<ParagraphDoc[]> {
  return storage.query<ParagraphDoc>({ where: [{ field: 'type', op: '=', value: 'paragraph' }] });
}

async function addParagraph(storage: ToolStorage, input: AddParagraphInput): Promise<ParagraphDoc> {
  const doc = makeParagraph(input);
  await storage.set(doc.id, doc);
  return doc;
}

const EMPTY_DRAFT: AddParagraphInput = {
  jurisdiction: '',
  book: '',
  norm: '',
  section: '',
  title: '',
  text: '',
  comment: '',
};

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string => ctx?.i18n.t(key, vars) ?? key;

  function Widget(_props: WidgetProps) {
    const [list, setList] = useState<ParagraphDoc[] | null>(null);
    const [search, setSearch] = useState('');
    const [pane, setPane] = useState<'list' | 'menu' | 'offline' | 'online'>('list');
    const [draft, setDraft] = useState<AddParagraphInput>(EMPTY_DRAFT);
    const [note, setNote] = useState('');

    // Online flow state.
    const [sources, setSources] = useState<LegalSourceInfo[]>([]);
    const [sourceId, setSourceId] = useState('');
    const [books, setBooks] = useState<LegalBook[]>([]);
    const [bookId, setBookId] = useState('');
    const [norms, setNorms] = useState<LegalNorm[]>([]);
    const [normId, setNormId] = useState('');
    const [section, setSection] = useState('');
    const [fetched, setFetched] = useState<{ text: string; stand: string; sourceUrl: string } | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');

    const hasLegal = ctx?.legal != null;

    const reload = useCallback(() => {
      const c = ctx;
      if (!c) return;
      void queryParagraphs(c.storage).then(setList);
    }, []);

    useEffect(() => {
      let alive = true;
      const c = ctx;
      if (!c) return undefined;
      void queryParagraphs(c.storage).then((l) => alive && setList(l));
      const unsub = c.storage.subscribe(() => alive && reload());
      return () => {
        alive = false;
        unsub();
      };
    }, [reload]);

    async function openOnline() {
      setError('');
      setFetched(null);
      setPane('online');
      const legal = ctx?.legal;
      if (!legal) return;
      try {
        setSources(await legal.sources());
      } catch (e) {
        setError(t('tool.legal-dictionary.online.fetchFailed', { error: String(e) }));
      }
    }

    async function chooseSource(id: string) {
      setSourceId(id);
      setBookId('');
      setNorms([]);
      setNormId('');
      setFetched(null);
      setError('');
      const legal = ctx?.legal;
      if (!legal || !id) return;
      try {
        setBusy(true);
        setBooks(await legal.listBooks(id));
      } catch (e) {
        setError(t('tool.legal-dictionary.online.fetchFailed', { error: String(e) }));
      } finally {
        setBusy(false);
      }
    }

    async function chooseBook(id: string) {
      setBookId(id);
      setNormId('');
      setFetched(null);
      setError('');
      const legal = ctx?.legal;
      if (!legal || !id) return;
      try {
        setBusy(true);
        setNorms(await legal.listNorms(sourceId, id));
      } catch (e) {
        setError(t('tool.legal-dictionary.online.fetchFailed', { error: String(e) }));
      } finally {
        setBusy(false);
      }
    }

    async function fetchNorm() {
      const legal = ctx?.legal;
      if (!legal || !sourceId || !bookId || !normId) return;
      try {
        setBusy(true);
        setError('');
        setFetched(await legal.fetchNorm(sourceId, bookId, normId, section));
      } catch (e) {
        setError(t('tool.legal-dictionary.online.fetchFailed', { error: String(e) }));
        setFetched(null);
      } finally {
        setBusy(false);
      }
    }

    async function saveOnline() {
      const c = ctx;
      if (!c || !fetched) return;
      const src = sources.find((s) => s.id === sourceId);
      const bk = books.find((b) => b.id === bookId);
      const nm = norms.find((n) => n.id === normId);
      const doc = makeParagraph(
        {
          jurisdiction: src?.jurisdiction ?? '',
          book: bk?.name ?? bookId,
          norm: nm?.label ?? normId,
          section,
          title: nm?.label ?? '',
          text: fetched.text,
          comment: note,
        },
        new Date(),
        'online',
        { stand: fetched.stand, sourceUrl: fetched.sourceUrl, sourceId, bookId, normId },
      );
      await c.storage.set(doc.id, doc);
      setPane('list');
      setNote('');
      setFetched(null);
    }

    async function saveOffline() {
      const c = ctx;
      const parsed = addParagraphSchema.safeParse(draft);
      if (!c || !parsed.success) return;
      await addParagraph(c.storage, parsed.data);
      setDraft(EMPTY_DRAFT);
      setPane('list');
    }

    async function remove(id: string) {
      await ctx?.storage.delete(id);
    }

    async function checkStand(doc: ParagraphDoc) {
      const legal = ctx?.legal;
      const c = ctx;
      if (!legal || !c || !doc.sourceId) return;
      try {
        setBusy(true);
        const fresh = await legal.fetchNorm(doc.sourceId, doc.bookId, doc.normId, doc.section);
        const changed = textHash(fresh.text.trim()) !== doc.textHash;
        const updated: ParagraphDoc = changed
          ? { ...doc, text: fresh.text.trim(), stand: fresh.stand, textHash: textHash(fresh.text.trim()) }
          : { ...doc, stand: fresh.stand || doc.stand };
        await c.storage.set(updated.id, updated);
        await c.notifications.notify({
          titleKey: changed ? 'tool.legal-dictionary.online.changed' : 'tool.legal-dictionary.online.unchanged',
          vars: { label: paragraphLabel(doc) },
        });
      } catch (e) {
        setError(t('tool.legal-dictionary.online.fetchFailed', { error: String(e) }));
      } finally {
        setBusy(false);
      }
    }

    const set = (patch: Partial<AddParagraphInput>) => setDraft((d) => ({ ...d, ...patch }));
    const rows = list ? searchParagraphs(list, search) : [];
    const selectedSource = sources.find((s) => s.id === sourceId);

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)', padding: 'var(--space-3)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
          <input
            className="c-input"
            value={search}
            placeholder={t('tool.legal-dictionary.searchPlaceholder')}
            aria-label={t('tool.legal-dictionary.searchPlaceholder')}
            style={{ flex: 1, minWidth: 0 }}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button
            className="c-btn c-btn--primary"
            title={t('tool.legal-dictionary.add.open')}
            aria-label={t('tool.legal-dictionary.add.open')}
            style={{ flexShrink: 0 }}
            onClick={() => setPane((p) => (p === 'list' ? 'menu' : 'list'))}
          >
            +
          </button>
        </div>

        {pane === 'menu' && (
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
            <button className="c-btn" style={{ flex: 1 }} onClick={() => { setDraft(EMPTY_DRAFT); setPane('offline'); }}>
              {t('tool.legal-dictionary.online.own')}
            </button>
            <button
              className="c-btn c-btn--primary"
              style={{ flex: 1 }}
              disabled={!hasLegal}
              title={hasLegal ? undefined : t('tool.legal-dictionary.online.unavailable')}
              onClick={() => void openOnline()}
            >
              {t('tool.legal-dictionary.online.fetch')}
            </button>
          </div>
        )}

        {pane === 'offline' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
              <input className="c-input" value={draft.book} placeholder={t('tool.legal-dictionary.add.book')} aria-label={t('tool.legal-dictionary.add.book')} style={{ flex: 2, minWidth: 0 }} onChange={(e) => set({ book: e.target.value })} />
              <input className="c-input" value={draft.norm} placeholder={t('tool.legal-dictionary.add.norm')} aria-label={t('tool.legal-dictionary.add.norm')} style={{ flex: 2, minWidth: 0 }} onChange={(e) => set({ norm: e.target.value })} />
              <input className="c-input" value={draft.section} placeholder={t('tool.legal-dictionary.add.section')} aria-label={t('tool.legal-dictionary.add.section')} style={{ flex: 1, minWidth: 0 }} onChange={(e) => set({ section: e.target.value })} />
            </div>
            <input className="c-input" value={draft.title} placeholder={t('tool.legal-dictionary.add.title')} aria-label={t('tool.legal-dictionary.add.title')} onChange={(e) => set({ title: e.target.value })} />
            <textarea className="c-input" value={draft.text} placeholder={t('tool.legal-dictionary.add.text')} aria-label={t('tool.legal-dictionary.add.text')} rows={3} style={{ resize: 'vertical' }} onChange={(e) => set({ text: e.target.value })} />
            <textarea className="c-input" value={draft.comment} placeholder={t('tool.legal-dictionary.add.comment')} aria-label={t('tool.legal-dictionary.add.comment')} rows={2} style={{ resize: 'vertical' }} onChange={(e) => set({ comment: e.target.value })} />
            <button className="c-btn c-btn--primary" style={{ alignSelf: 'flex-end' }} disabled={!draft.book.trim() || !draft.norm.trim()} onClick={() => void saveOffline()}>
              {t('tool.legal-dictionary.add.save')}
            </button>
          </div>
        )}

        {pane === 'online' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <select className="c-input" value={sourceId} aria-label={t('tool.legal-dictionary.online.source')} onChange={(e) => void chooseSource(e.target.value)}>
              <option value="">{t('tool.legal-dictionary.online.source')}</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}{s.requiresKey ? ` (${t('tool.legal-dictionary.online.needsKey')})` : ''}</option>
              ))}
            </select>
            {selectedSource && (
              <select className="c-input" value={bookId} aria-label={t('tool.legal-dictionary.online.book')} onChange={(e) => void chooseBook(e.target.value)}>
                <option value="">{t('tool.legal-dictionary.online.book')}</option>
                {books.map((b) => (<option key={b.id} value={b.id}>{b.name}</option>))}
              </select>
            )}
            {bookId && (
              <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
                <select className="c-input" value={normId} aria-label={t('tool.legal-dictionary.online.norm')} style={{ flex: 2, minWidth: 0 }} onChange={(e) => setNormId(e.target.value)}>
                  <option value="">{t('tool.legal-dictionary.online.norm')}</option>
                  {norms.map((n) => (<option key={n.id} value={n.id}>{n.label}</option>))}
                </select>
                <input className="c-input" value={section} placeholder={t('tool.legal-dictionary.add.section')} aria-label={t('tool.legal-dictionary.add.section')} style={{ flex: 1, minWidth: 0 }} onChange={(e) => setSection(e.target.value)} />
                <button className="c-btn c-btn--primary" disabled={!normId || busy} onClick={() => void fetchNorm()}>
                  {busy ? '…' : t('tool.legal-dictionary.online.get')}
                </button>
              </div>
            )}
            {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}
            {fetched && (
              <>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', maxHeight: 120, overflowY: 'auto', border: '1px solid var(--border-subtle)', borderRadius: 4, padding: 'var(--space-1)' }}>{fetched.text}</div>
                {fetched.stand && <div className="c-muted" style={{ fontSize: 11 }}>{t('tool.legal-dictionary.list.stand')}: {fetched.stand}</div>}
                <textarea className="c-input" value={note} placeholder={t('tool.legal-dictionary.add.comment')} aria-label={t('tool.legal-dictionary.add.comment')} rows={2} style={{ resize: 'vertical' }} onChange={(e) => setNote(e.target.value)} />
                <button className="c-btn c-btn--primary" style={{ alignSelf: 'flex-end' }} onClick={() => void saveOnline()}>
                  {t('tool.legal-dictionary.add.save')}
                </button>
              </>
            )}
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {list === null ? (
            <div className="c-muted">…</div>
          ) : rows.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.legal-dictionary.widget.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {rows.map((p) => (
                <div key={p.id} style={{ borderBottom: '1px solid var(--border-subtle)', paddingBottom: 'var(--space-1)' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
                    <strong style={{ flexShrink: 0 }}>{paragraphLabel(p)}</strong>
                    <span className="c-muted" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12 }}>{p.title}</span>
                    {p.stand && <span className="c-muted" style={{ fontSize: 11, flexShrink: 0 }}>{t('tool.legal-dictionary.list.stand')}: {p.stand}</span>}
                    {p.mode === 'online' && p.sourceId && hasLegal && (
                      <button className="c-btn c-btn--ghost" style={{ flexShrink: 0, fontSize: 11 }} disabled={busy} title={t('tool.legal-dictionary.online.checkStand')} onClick={() => void checkStand(p)}>↻</button>
                    )}
                    <button className="c-btn c-btn--ghost" style={{ flexShrink: 0, fontSize: 11 }} title={t('tool.legal-dictionary.list.delete')} onClick={() => void remove(p.id)}>✕</button>
                  </div>
                  {p.text && <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', marginTop: 2 }}>{p.text}</div>}
                  {p.comment && <div className="c-muted" style={{ fontSize: 12, marginTop: 2, fontStyle: 'italic' }}>{p.comment}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  async function registerCommands(context: ToolContext): Promise<void> {
    context.commands.register({
      id: 'legal-dictionary.add',
      titleKey: 'tool.legal-dictionary.command.add',
      descriptionKey: 'tool.legal-dictionary.command.addDesc',
      icon: '§',
      params: addParagraphSchema,
      selfTestParams: { jurisdiction: 'DE', book: 'BGB', norm: '§ 242', section: '', title: 'Treu und Glauben', text: 'probe', comment: '' },
      async run(params): Promise<CommandResult> {
        const data = addParagraphSchema.parse(params);
        if (!data.book.trim() || !data.norm.trim()) {
          return { ok: false, messageKey: 'tool.legal-dictionary.msg.invalid' };
        }
        const doc = await addParagraph(context.storage, data);
        return { ok: true, data: { id: doc.id, label: paragraphLabel(doc) }, messageKey: 'tool.legal-dictionary.msg.added' };
      },
    });

    context.commands.register({
      id: 'legal-dictionary.context',
      titleKey: 'tool.legal-dictionary.command.context',
      palette: false,
      params: z.object({}),
      selfTestParams: {},
      async run(): Promise<CommandResult> {
        const list = await queryParagraphs(context.storage);
        return { ok: true, data: { contextText: buildContext(list, context.i18n.language) } };
      },
    });
  }

  return {
    manifest: manifest as CardoTool['manifest'],
    async activate(context: ToolContext) {
      ctx = context;
      await registerCommands(context);
    },
    deactivate() {
      ctx = null;
    },
    Widget,
    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      switch (testId) {
        case 'render':
          return typeof Widget === 'function' && Widget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        case 'storage': {
          const doc = await addParagraph(testCtx.storage, {
            jurisdiction: 'DE', book: 'BGB', norm: '§ 242', section: 'Abs. 1', title: 'T', text: 'body', comment: 'c',
          });
          const back = await testCtx.storage.get<ParagraphDoc>(doc.id);
          await testCtx.storage.delete(doc.id);
          const gone = await testCtx.storage.get<ParagraphDoc>(doc.id);
          if (!back || back.book !== 'BGB' || back.norm !== '§ 242' || back.textHash !== doc.textHash) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(back)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'paragraph still present after delete' };
          return { status: 'pass', detail: 'add → read → delete roundtrip ok' };
        }
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
