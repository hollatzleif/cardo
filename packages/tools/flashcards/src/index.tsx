import { useCallback, useEffect, useMemo, useState } from 'react';
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
  makeCard,
  makeDeck,
  makeNote,
  newCardState,
  type CardDoc,
  type DeckDoc,
  type DeckOptionsDoc,
  type NoteDoc,
} from './model';
import { ensureDefaults, importAnkiCollection, loadCollection, migrateIfNeeded, type Collection } from './store';
import { docsToAnkiCollection } from './anki-import';
import { review as scheduleReview, isSubDay } from './scheduler';
import {
  buildQueue,
  currentCard,
  queueCounts,
  recordAnswer,
  startSession,
  undo as undoSession,
  canUndo,
  type Rating,
  type Session,
} from './session';
import { StudyView } from './StudyView';
import { filterCards, setSuspended, type BrowseContext } from './browse';
import { cardCounts, deckBreakdown, forecast, heatmapCells, retention, type ReviewEvent } from './stats';

/**
 * Flashcards – an Anki-class spaced-repetition tool, fully local.
 * Documents: noteType/note/card/deck/deckOptions/media (+ reviewEvent for
 * stats). Scheduling (SM-2 or FSRS) runs in JS so the tool works offline.
 */

/* ── Dates ────────────────────────────────────────────────────────────────── */

function localDayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}
function addDays(dayKey: string, days: number): string {
  const ms = new Date(`${dayKey}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* ── Storage helpers shared by commands, widget and self-tests ────────────── */

const addCardParamsSchema = z.object({
  deck: z.string().min(1),
  front: z.string().min(1),
  back: z.string().min(1),
});

async function resolveDeck(storage: ToolStorage, ref: string, optionsId: string): Promise<DeckDoc> {
  const name = ref.trim();
  const decks = await storage.query<DeckDoc>({ where: [{ field: 'type', op: '=', value: 'deck' }] });
  const byName = decks.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  const created = makeDeck(name, optionsId);
  await storage.set(created.id, created);
  return created;
}

async function addNoteCard(
  storage: ToolStorage,
  input: { deck: string; front: string; back: string },
  today: string,
): Promise<{ deck: DeckDoc; note: NoteDoc; card: CardDoc }> {
  const { noteType, options } = await ensureDefaults(storage);
  const deck = await resolveDeck(storage, input.deck, options.id);
  const [front, back] = noteType.fields;
  const note = makeNote(noteType.id, { [front!]: input.front, [back!]: input.back });
  await storage.set(note.id, note);
  const card = makeCard({ noteId: note.id, templateIndex: 0, deckId: deck.id }, today);
  await storage.set(card.id, card);
  return { deck, note, card };
}

function optionsFor(collection: Collection, deck: DeckDoc | undefined): DeckOptionsDoc {
  const byId = deck && collection.options.find((o) => o.id === deck.optionsId);
  return byId ?? collection.options[0]!;
}

async function persistAnswer(
  storage: ToolStorage,
  collection: Collection,
  card: CardDoc,
  rating: Rating,
  today: string,
  now: Date,
): Promise<{ card: CardDoc; requeue: boolean }> {
  const deck = collection.decks.find((d) => d.id === card.deckId);
  const options = optionsFor(collection, deck);
  const result = scheduleReview(card.state, rating, options, { now });
  const sub = isSubDay(result.interval);
  const iv = result.interval;
  const next: CardDoc = {
    ...card,
    state: result.state,
    due: 'minutes' in iv ? today : addDays(today, iv.days),
    dueAt: 'minutes' in iv ? new Date(now.getTime() + iv.minutes * 60_000).toISOString() : null,
  };
  await storage.set(next.id, next);
  const ev: ReviewEvent & { id: string; type: string } = {
    id: `ev:${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'reviewEvent',
    date: today,
    rating,
  };
  await storage.set(ev.id, ev as unknown as Record<string, unknown>);
  return { card: next, requeue: sub };
}

/* ── Data hook ────────────────────────────────────────────────────────────── */

function useCollection(ctx: ToolContext | null): { collection: Collection | null; reload: () => void } {
  const [collection, setCollection] = useState<Collection | null>(null);
  const reload = useCallback(() => {
    if (!ctx) return;
    void loadCollection(ctx.storage).then(setCollection);
  }, [ctx]);
  useEffect(() => {
    let alive = true;
    if (!ctx) return undefined;
    void loadCollection(ctx.storage).then((c) => alive && setCollection(c));
    const unsub = ctx.storage.subscribe(() => {
      if (alive) void loadCollection(ctx.storage).then(setCollection);
    });
    return () => {
      alive = false;
      unsub();
    };
  }, [ctx]);
  return { collection, reload };
}

/* ── The tool ─────────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string => ctx?.i18n.t(key, vars) ?? key;

  const studyLabels = () => ({
    show: t('tool.flashcards.study.reveal'),
    again: t('tool.flashcards.grade.again'),
    hard: t('tool.flashcards.grade.hard'),
    good: t('tool.flashcards.grade.good'),
    easy: t('tool.flashcards.grade.easy'),
    undo: t('tool.flashcards.study.undo'),
    done: t('tool.flashcards.study.done'),
    empty: t('tool.flashcards.widget.empty'),
  });

  /* Study pane ---------------------------------------------------------- */
  function StudyPane() {
    const { collection } = useCollection(ctx);
    const [session, setSession] = useState<Session | null>(null);

    // Build the session ONCE per collection load (not on every answer).
    useEffect(() => {
      if (!collection || session) return;
      const options = collection.options[0];
      const limits = {
        newPerDay: options?.newPerDay ?? 20,
        reviewsPerDay: options?.reviewsPerDay ?? 200,
      };
      const queue = buildQueue(collection.cards, limits, localDayKey(), new Date().toISOString());
      setSession(startSession(queue, limits, localDayKey(), new Date().toISOString()));
    }, [collection, session]);

    const card = session ? currentCard(session) : null;
    const note = card && collection ? collection.notes.find((n) => n.id === card.noteId) : null;
    const noteType =
      note && collection ? collection.noteTypes.find((nt) => nt.id === note.noteTypeId) : null;

    async function onRate(rating: Rating) {
      const c = ctx;
      if (!c || !collection || !card || !session) return;
      const { card: updated, requeue } = await persistAnswer(
        c.storage,
        collection,
        card,
        rating,
        localDayKey(),
        new Date(),
      );
      setSession((s) => (s ? recordAnswer(s, updated, requeue) : s));
    }

    return (
      <StudyView
        card={card}
        noteType={noteType ?? null}
        note={note ?? null}
        counts={session ? queueCounts(session.queue) : { new: 0, learning: 0, review: 0 }}
        answered={session?.answered ?? 0}
        canUndo={session ? canUndo(session) : false}
        onRate={(r) => void onRate(r)}
        onUndo={() => setSession((s) => (s ? undoSession(s) : s))}
        labels={studyLabels()}
        finished={(session?.answered ?? 0) > 0}
      />
    );
  }

  /* Manage pane: deck list + add card + search browser ------------------ */
  function ManagePane({ onStudy }: { onStudy: () => void }) {
    const { collection } = useCollection(ctx);
    const [deckDraft, setDeckDraft] = useState('');
    const [front, setFront] = useState('');
    const [back, setBack] = useState('');
    const [search, setSearch] = useState('');
    const [panel, setPanel] = useState<'none' | 'add' | 'options'>('none');
    const [importMsg, setImportMsg] = useState('');
    const hasAnki = ctx?.anki != null;

    const today = localDayKey();
    const nowIso = new Date().toISOString();

    const deckNameById = useMemo(
      () => new Map((collection?.decks ?? []).map((d) => [d.id, d.name])),
      [collection],
    );
    const noteById = useMemo(
      () => new Map((collection?.notes ?? []).map((n) => [n.id, n])),
      [collection],
    );

    async function add() {
      const c = ctx;
      if (!c || !deckDraft.trim() || !front.trim() || !back.trim()) return;
      await addNoteCard(c.storage, { deck: deckDraft, front, back }, today);
      setFront('');
      setBack('');
    }

    async function importApkg() {
      const c = ctx;
      if (!c?.anki) return;
      setImportMsg(t('tool.flashcards.import.running'));
      try {
        const coll = await c.anki.importFile();
        if (!coll) {
          setImportMsg('');
          return;
        }
        const s = await importAnkiCollection(c.storage, coll, today);
        setImportMsg(t('tool.flashcards.import.done', { decks: s.decks, cards: s.cards }));
      } catch (e) {
        setImportMsg(t('tool.flashcards.import.failed', { error: String(e) }));
      }
    }

    async function exportApkg() {
      const c = ctx;
      if (!c?.anki || !collection) return;
      try {
        await c.anki.exportFile(docsToAnkiCollection(collection));
      } catch (e) {
        setImportMsg(t('tool.flashcards.import.failed', { error: String(e) }));
      }
    }

    async function saveOptions(patch: Partial<DeckOptionsDoc>) {
      const c = ctx;
      const opt = collection?.options[0];
      if (!c || !opt) return;
      await c.storage.set(opt.id, { ...opt, ...patch });
    }

    if (!collection) return <div className="c-muted">…</div>;
    const options = collection.options[0];

    const browseCtx: BrowseContext = { today, nowIso, deckNameById, noteById };
    const found = search.trim()
      ? filterCards(collection.cards, browseCtx, search).slice(0, 100)
      : [];
    const decks = deckBreakdown(collection.cards, deckNameById, today, nowIso);

    async function suspendCard(id: string) {
      const c = ctx;
      if (!c || !collection) return;
      const [updated] = setSuspended(collection.cards, new Set([id]), true);
      if (updated) await c.storage.set(updated.id, updated);
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
          <button
            className={`c-btn${panel === 'add' ? ' c-btn--primary' : ''}`}
            style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={t('tool.flashcards.grid.add')}
            onClick={() => setPanel((p) => (p === 'add' ? 'none' : 'add'))}
          >
            ＋ {t('tool.flashcards.toolbar.add')}
          </button>
          {hasAnki && (
            <button
              className="c-btn"
              style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
              title={t('tool.flashcards.import.button')}
              onClick={() => void importApkg()}
            >
              ⬆ {t('tool.flashcards.toolbar.import')}
            </button>
          )}
          <button
            className={`c-btn${panel === 'options' ? ' c-btn--primary' : ''}`}
            style={{ flex: 1, minWidth: 0, fontSize: 13, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            title={t('tool.flashcards.options.button')}
            onClick={() => setPanel((p) => (p === 'options' ? 'none' : 'options'))}
          >
            ⚙ {t('tool.flashcards.toolbar.options')}
          </button>
          {hasAnki && (
            <button
              className="c-btn c-btn--ghost"
              title={t('tool.flashcards.export.button')}
              aria-label={t('tool.flashcards.export.button')}
              style={{ flexShrink: 0, fontSize: 13 }}
              onClick={() => void exportApkg()}
            >
              ⬇
            </button>
          )}
        </div>

        {importMsg && (
          <div className="c-muted" style={{ fontSize: 12, flexShrink: 0 }}>
            {importMsg}
          </div>
        )}

        {panel === 'add' && (
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
            <input className="c-input" list="flashcards-decks" value={deckDraft} placeholder={t('tool.flashcards.grid.deckPlaceholder')} aria-label={t('tool.flashcards.grid.deckPlaceholder')} style={{ flex: 1, minWidth: 70 }} onChange={(e) => setDeckDraft(e.target.value)} />
            <datalist id="flashcards-decks">
              {decks.map((d) => (<option key={d.deckId} value={d.name} />))}
            </datalist>
            <input className="c-input" value={front} placeholder={t('tool.flashcards.grid.frontPlaceholder')} aria-label={t('tool.flashcards.grid.frontPlaceholder')} style={{ flex: 1, minWidth: 70 }} onChange={(e) => setFront(e.target.value)} />
            <input className="c-input" value={back} placeholder={t('tool.flashcards.grid.backPlaceholder')} aria-label={t('tool.flashcards.grid.backPlaceholder')} style={{ flex: 1, minWidth: 70 }} onChange={(e) => setBack(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} />
            <button className="c-btn c-btn--primary" aria-label={t('tool.flashcards.grid.add')} title={t('tool.flashcards.grid.add')} style={{ flexShrink: 0 }} onClick={() => void add()}>+</button>
          </div>
        )}

        {panel === 'options' && options && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)', flexShrink: 0, fontSize: 13, borderBottom: '1px solid var(--border-subtle)', paddingBottom: 'var(--space-2)' }}>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
              {t('tool.flashcards.options.scheduler')}
              <select className="c-input" value={options.scheduler} style={{ width: 110 }} onChange={(e) => void saveOptions({ scheduler: e.target.value as DeckOptionsDoc['scheduler'] })}>
                <option value="fsrs">FSRS</option>
                <option value="sm2">SM-2</option>
              </select>
            </label>
            {options.scheduler === 'fsrs' && (
              <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
                {t('tool.flashcards.options.retention')}: {Math.round(options.desiredRetention * 100)}%
                <input type="range" min={70} max={97} value={Math.round(options.desiredRetention * 100)} onChange={(e) => void saveOptions({ desiredRetention: Number(e.target.value) / 100 })} />
              </label>
            )}
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
              {t('tool.flashcards.options.newPerDay')}
              <input className="c-input" type="number" min={0} value={options.newPerDay} style={{ width: 80 }} onChange={(e) => void saveOptions({ newPerDay: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
              {t('tool.flashcards.options.reviewsPerDay')}
              <input className="c-input" type="number" min={0} value={options.reviewsPerDay} style={{ width: 80 }} onChange={(e) => void saveOptions({ reviewsPerDay: Math.max(0, Number(e.target.value) || 0) })} />
            </label>
            <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 'var(--space-2)' }}>
              {t('tool.flashcards.options.learningSteps')}
              <input className="c-input" value={options.learningStepsMin.join(' ')} style={{ width: 100 }} onChange={(e) => void saveOptions({ learningStepsMin: e.target.value.split(/[\s,]+/).map(Number).filter((x) => x > 0) })} />
            </label>
          </div>
        )}

        <input
          className="c-input"
          value={search}
          placeholder={t('tool.flashcards.browse.search')}
          aria-label={t('tool.flashcards.browse.searchLabel')}
          style={{ flexShrink: 0 }}
          onChange={(e) => setSearch(e.target.value)}
        />

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {search.trim() ? (
            found.length === 0 ? (
              <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
                {t('tool.flashcards.browse.noMatches')}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {found.map((c) => {
                  const n = noteById.get(c.noteId);
                  const label = n ? Object.values(n.fields)[0] ?? '' : c.id;
                  return (
                    <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
                      <span
                        style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: c.suspended ? 0.5 : 1 }}
                        dangerouslySetInnerHTML={{ __html: label }}
                      />
                      {!c.suspended && (
                        <button
                          className="c-btn c-btn--ghost"
                          style={{ flexShrink: 0, fontSize: 11 }}
                          title={t('tool.flashcards.browse.suspend')}
                          onClick={() => void suspendCard(c.id)}
                        >
                          ⏸
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )
          ) : decks.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.flashcards.widget.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {decks.map((d) => (
                <button
                  key={d.deckId}
                  className="c-btn c-btn--ghost"
                  title={t('tool.flashcards.grid.study')}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', width: '100%', textAlign: 'left', padding: 'var(--space-1)' }}
                  onClick={onStudy}
                >
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {d.name}
                  </span>
                  <span className="c-muted" style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                    {t('tool.flashcards.grid.cards', { count: d.total })}
                  </span>
                  <span
                    title={t('tool.flashcards.grid.due', { count: d.due })}
                    style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', color: d.due > 0 ? 'var(--warning)' : 'var(--text-muted)', flexShrink: 0 }}
                  >
                    {d.due > 0 ? `● ${d.due}` : '✓'}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* Stats pane: counts + forecast + retention + heatmap ----------------- */
  function StatsPane() {
    const { collection } = useCollection(ctx);
    const [events, setEvents] = useState<ReviewEvent[]>([]);
    useEffect(() => {
      if (!ctx) return;
      void ctx.storage
        .query<ReviewEvent>({ where: [{ field: 'type', op: '=', value: 'reviewEvent' }] })
        .then(setEvents);
    }, []);

    const today = localDayKey();
    if (!collection) return <div className="c-muted">…</div>;
    const counts = cardCounts(collection.cards, today, new Date().toISOString());
    const fc = forecast(collection.cards, today, 14);
    const ret = retention(events, { days: 30, today });
    const cells = heatmapCells(events, today);
    const maxFc = Math.max(1, ...fc.map((f) => f.count));

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-2)', fontSize: 12, flexShrink: 0 }}>
          <span title={t('tool.flashcards.stats.new')} style={{ color: 'var(--chart-1, var(--accent))' }}>● {counts.new}</span>
          <span title={t('tool.flashcards.stats.learning')} style={{ color: 'var(--warning)' }}>● {counts.learning}</span>
          <span title={t('tool.flashcards.stats.review')} style={{ color: 'var(--success)' }}>● {counts.review}</span>
          <span className="c-muted" style={{ marginLeft: 'auto' }}>
            {t('tool.flashcards.stats.retention')} {Math.round(ret * 100)}%
          </span>
        </div>

        <div className="c-muted" style={{ fontSize: 11, flexShrink: 0 }}>{t('tool.flashcards.stats.forecast')}</div>
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img" aria-label={t('tool.flashcards.stats.forecast')} style={{ width: '100%', height: 40, flexShrink: 0 }}>
          {fc.map((f, i) => {
            const h = (f.count / maxFc) * 28;
            const w = 100 / fc.length;
            return <rect key={f.date} x={i * w + w * 0.15} y={30 - h} width={w * 0.7} height={h} fill="var(--accent)"><title>{`${f.date}: ${f.count}`}</title></rect>;
          })}
        </svg>

        <div className="c-muted" style={{ fontSize: 11, flexShrink: 0 }}>{t('tool.flashcards.stats.activity')}</div>
        <div style={{ display: 'grid', gridAutoFlow: 'column', gridTemplateRows: 'repeat(7, 1fr)', gap: 1, flex: 1, minHeight: 0, overflow: 'hidden' }}>
          {cells.map((cell) => (
            <div
              key={cell.date}
              title={`${cell.date}: ${cell.count}`}
              style={{ width: 8, height: 8, borderRadius: 2, background: cell.level === 0 ? 'var(--border-subtle)' : 'var(--chart-3, var(--accent))', opacity: cell.level === 0 ? 0.4 : cell.level * 0.25 }}
            />
          ))}
        </div>
      </div>
    );
  }

  function FlashcardsWidget(props: WidgetProps) {
    // Open on the deck list (like Anki's home screen) unless the frame's variant
    // explicitly asks for study or stats. The tab bar keeps every view — decks,
    // import, options, studying, stats — reachable inside the one widget.
    const initialTab: 'grid' | 'study' | 'stats' =
      props.variant === 'study' ? 'study' : props.variant === 'stats' ? 'stats' : 'grid';
    const [tab, setTab] = useState<'grid' | 'study' | 'stats'>(initialTab);

    const tabButton = (id: 'grid' | 'study' | 'stats', label: string) => (
      <button
        className={`c-btn${tab === id ? ' c-btn--primary' : ''}`}
        style={{ flex: 1, minWidth: 0, fontSize: 13, padding: '5px 4px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        onClick={() => setTab(id)}
      >
        {label}
      </button>
    );

    let body;
    switch (tab) {
      case 'study':
        body = <StudyPane />;
        break;
      case 'stats':
        body = <StatsPane />;
        break;
      case 'grid':
      default:
        body = <ManagePane onStudy={() => setTab('study')} />;
        break;
    }

    return (
      <div style={{ height: '100%', padding: 'var(--space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
          {tabButton('grid', `🗂 ${t('tool.flashcards.tab.manage')}`)}
          {tabButton('study', `🎓 ${t('tool.flashcards.tab.study')}`)}
          {tabButton('stats', `📊 ${t('tool.flashcards.tab.stats')}`)}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>{body}</div>
      </div>
    );
  }

  function buildContext(collection: Collection, language: string, today: string): string {
    const de = language !== 'en';
    const counts = cardCounts(collection.cards, today, new Date().toISOString());
    if (collection.cards.length === 0) return de ? 'Noch keine Karteikarten.' : 'No flashcards yet.';
    return de
      ? `${collection.decks.length} Stapel, ${counts.total} Karten, ${counts.due} heute fällig.`
      : `${collection.decks.length} decks, ${counts.total} cards, ${counts.due} due today.`;
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    async activate(context: ToolContext) {
      ctx = context;
      await migrateIfNeeded(context.storage);

      context.commands.register({
        id: 'flashcards.add-card',
        titleKey: 'tool.flashcards.command.addCard',
        descriptionKey: 'tool.flashcards.command.addCardDesc',
        icon: '🃏',
        params: addCardParamsSchema,
        selfTestParams: { deck: 'Cardo self-test deck', front: 'front?', back: 'back!' },
        async run(params): Promise<CommandResult> {
          if (!params.deck.trim() || !params.front.trim() || !params.back.trim()) {
            return { ok: false, messageKey: 'tool.flashcards.msg.invalidCard' };
          }
          const { deck, card } = await addNoteCard(context.storage, params, localDayKey());
          return {
            ok: true,
            data: { cardId: card.id, deckId: deck.id, deckName: deck.name },
            messageKey: 'tool.flashcards.msg.cardAdded',
          };
        },
      });

      context.commands.register({
        id: 'flashcards.review-due',
        titleKey: 'tool.flashcards.command.reviewDue',
        descriptionKey: 'tool.flashcards.command.reviewDueDesc',
        icon: '🎓',
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const collection = await loadCollection(context.storage);
          const options = collection.options[0];
          const queue = buildQueue(
            collection.cards,
            { newPerDay: options?.newPerDay ?? 20, reviewsPerDay: options?.reviewsPerDay ?? 200 },
            localDayKey(),
            new Date().toISOString(),
          );
          return {
            ok: true,
            data: { due: queue.length },
            messageKey: queue.length > 0 ? 'tool.flashcards.msg.dueReady' : 'tool.flashcards.msg.nothingDue',
          };
        },
      });

      context.commands.register({
        id: 'flashcards.context',
        titleKey: 'tool.flashcards.command.context',
        descriptionKey: 'tool.flashcards.command.contextDesc',
        palette: false,
        params: z.object({}),
        selfTestParams: {},
        async run(): Promise<CommandResult> {
          const collection = await loadCollection(context.storage);
          return {
            ok: true,
            data: { contextText: buildContext(collection, context.i18n.language, localDayKey()) },
          };
        },
      });
    },

    deactivate() {
      ctx = null;
    },

    Widget: FlashcardsWidget,

    async runSelfTest(testId: string, testCtx: SelfTestContext): Promise<SelfTestResult> {
      const today = localDayKey();
      switch (testId) {
        case 'sm2': {
          const { options } = await ensureDefaults(testCtx.storage);
          const sm2 = { ...options, scheduler: 'sm2' as const };
          const easy = scheduleReview(newCardState(), 'easy', sm2);
          if (!('days' in easy.interval) || easy.interval.days !== 4) {
            return { status: 'fail', detail: `easy graduate expected 4 days, got ${JSON.stringify(easy.interval)}` };
          }
          const good = scheduleReview(easy.state, 'good', sm2);
          if (!('days' in good.interval) || good.interval.days !== 10) {
            return { status: 'fail', detail: `review good expected 10 days, got ${JSON.stringify(good.interval)}` };
          }
          let s = easy.state;
          for (let i = 0; i < 20; i += 1) s = scheduleReview(s, 'hard', sm2).state;
          if (s.ease < 1.3 - 1e-9) return { status: 'fail', detail: `ease floor violated: ${s.ease}` };
          return { status: 'pass', detail: 'SM-2 graduate/grow/ease-floor ok' };
        }
        case 'crud': {
          const { deck, note, card } = await addNoteCard(
            testCtx.storage,
            { deck: 'selftest crud deck', front: 'F', back: 'B' },
            today,
          );
          const cardBack = await testCtx.storage.get<CardDoc>(card.id);
          const noteBack = await testCtx.storage.get<NoteDoc>(note.id);
          await testCtx.storage.delete(card.id);
          await testCtx.storage.delete(note.id);
          await testCtx.storage.delete(deck.id);
          const gone = await testCtx.storage.get<CardDoc>(card.id);
          if (!cardBack || !noteBack || cardBack.deckId !== deck.id || Object.values(noteBack.fields)[0] !== 'F') {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(cardBack)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'card still present after delete' };
          return { status: 'pass', detail: 'note+card create → read → delete ok' };
        }
        case 'due-flow': {
          const { deck, note, card } = await addNoteCard(
            testCtx.storage,
            { deck: 'selftest due deck', front: 'F', back: 'B' },
            today,
          );
          try {
            const collection = await loadCollection(testCtx.storage);
            const queueBefore = buildQueue(collection.cards, { newPerDay: 20, reviewsPerDay: 200 }, today, new Date().toISOString());
            if (!queueBefore.some((x) => x.id === card.id)) {
              return { status: 'fail', detail: 'fresh card is not due' };
            }
            const { card: reviewed } = await persistAnswer(testCtx.storage, collection, card, 'easy', today, new Date());
            if (reviewed.state.phase !== 'review') {
              return { status: 'fail', detail: `easy did not graduate: ${JSON.stringify(reviewed.state)}` };
            }
            const stored = await testCtx.storage.get<CardDoc>(card.id);
            if (!stored || stored.state.phase !== 'review') {
              return { status: 'fail', detail: `review not persisted: ${JSON.stringify(stored)}` };
            }
            return { status: 'pass', detail: `add → review → graduated (due ${stored.due})` };
          } finally {
            await testCtx.storage.delete(card.id);
            await testCtx.storage.delete(note.id);
            await testCtx.storage.delete(deck.id);
          }
        }
        case 'render':
          return typeof FlashcardsWidget === 'function' && FlashcardsWidget.length <= 1
            ? { status: 'pass' }
            : { status: 'fail', detail: 'Widget export contract violated' };
        default:
          return { status: 'fail', detail: `unknown test "${testId}"` };
      }
    },
  };
}
