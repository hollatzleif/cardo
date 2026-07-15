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
  addCardParamsSchema,
  buildFlashcardsContext,
  deckStats,
  dueCards,
  localDayKey,
  makeCard,
  makeDeck,
  review,
  reviewSeries,
  type CardDoc,
  type DeckDoc,
  type Grade,
  type ReviewLogDoc,
} from './logic';

/**
 * Flashcards – SM-2 spaced repetition, fully local.
 * Decks live in `deck:<id>` docs, cards in `card:<id>` docs; each review
 * bumps a per-day counter in `log:<yyyy-mm-dd>` for the stats variant.
 */

/** Grade buttons of the study variant: label key → SM-2 grade. */
const GRADE_BUTTONS: Array<{ labelKey: string; grade: Grade }> = [
  { labelKey: 'tool.flashcards.grade.again', grade: 2 },
  { labelKey: 'tool.flashcards.grade.hard', grade: 3 },
  { labelKey: 'tool.flashcards.grade.good', grade: 4 },
  { labelKey: 'tool.flashcards.grade.easy', grade: 5 },
];

/* ── Storage helpers (parameterized so commands, widget and self-tests share them) ── */

async function queryDecksIn(storage: ToolStorage): Promise<DeckDoc[]> {
  const decks = await storage.query<DeckDoc>({
    where: [{ field: 'type', op: '=', value: 'deck' }],
  });
  return [...decks].sort((a, b) => a.name.localeCompare(b.name));
}

async function queryCardsIn(storage: ToolStorage): Promise<CardDoc[]> {
  return storage.query<CardDoc>({ where: [{ field: 'type', op: '=', value: 'card' }] });
}

async function queryLogsIn(storage: ToolStorage): Promise<ReviewLogDoc[]> {
  return storage.query<ReviewLogDoc>({ where: [{ field: 'type', op: '=', value: 'log' }] });
}

/** Resolve a deck reference (doc id or display name, case-insensitive) – creates by name when missing. */
async function resolveDeckIn(storage: ToolStorage, ref: string): Promise<DeckDoc> {
  const name = ref.trim();
  const direct = await storage.get<DeckDoc>(name);
  if (direct && direct.type === 'deck') return direct;
  const decks = await queryDecksIn(storage);
  const byName = decks.find((d) => d.name.toLowerCase() === name.toLowerCase());
  if (byName) return byName;
  const created = makeDeck(name);
  await storage.set(created.id, created);
  return created;
}

async function addCardIn(
  storage: ToolStorage,
  input: { deck: string; front: string; back: string },
  today: string,
): Promise<{ deck: DeckDoc; card: CardDoc }> {
  const deck = await resolveDeckIn(storage, input.deck);
  const card = makeCard({ deckId: deck.id, front: input.front, back: input.back }, today);
  await storage.set(card.id, card);
  return { deck, card };
}

/** Persist one SM-2 review and bump today's review counter. */
async function reviewCardIn(
  storage: ToolStorage,
  card: CardDoc,
  grade: Grade,
  today: string,
): Promise<CardDoc> {
  const next: CardDoc = { ...card, ...review(card, grade, today) };
  await storage.set(next.id, next);
  const logId = `log:${today}`;
  const log = await storage.get<ReviewLogDoc>(logId);
  await storage.set<ReviewLogDoc>(logId, {
    id: logId,
    type: 'log',
    date: today,
    count: (log?.count ?? 0) + 1,
  });
  return next;
}

/* ── The tool ─────────────────────────────────────────────────────────── */

export function createTool(): CardoTool {
  let ctx: ToolContext | null = null;
  const t = (key: string, vars?: Record<string, unknown>): string =>
    ctx?.i18n.t(key, vars) ?? key;

  /** True when the OS asks for reduced motion – the card flip snaps instead of turning. */
  function prefersReducedMotion(): boolean {
    return (
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  /* ── Study variant: front → reveal → grade ─────────────────────────── */

  function StudyView() {
    const [queue, setQueue] = useState<CardDoc[] | null>(null);
    const [decks, setDecks] = useState<DeckDoc[]>([]);
    const [revealed, setRevealed] = useState(false);

    const loadQueue = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [cards, deckList] = await Promise.all([
        queryCardsIn(c.storage),
        queryDecksIn(c.storage),
      ]);
      setQueue(dueCards(cards, localDayKey()));
      setDecks(deckList);
      setRevealed(false);
    }, []);

    // The queue is loaded once per mount – NOT on every storage change,
    // otherwise grading would reshuffle the session mid-review.
    useEffect(() => {
      void loadQueue();
    }, [loadQueue]);

    const current = queue?.[0];
    const deckName = current ? decks.find((d) => d.id === current.deckId)?.name : undefined;

    async function grade(g: Grade) {
      const c = ctx;
      if (!c || !current) return;
      await reviewCardIn(c.storage, current, g, localDayKey());
      setQueue((q) => (q ? q.slice(1) : q));
      setRevealed(false);
    }

    if (queue === null) return <div className="c-muted">…</div>;

    if (!current) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            gap: 'var(--space-2)',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: '1.6em' }}>✓</div>
          <div style={{ color: 'var(--success)' }}>{t('tool.flashcards.study.done')}</div>
          <button className="c-btn c-btn--ghost" onClick={() => void loadQueue()}>
            {t('tool.flashcards.study.checkAgain')}
          </button>
        </div>
      );
    }

    const reduced = prefersReducedMotion();
    const face = (content: string, back: boolean) => (
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 'var(--space-3)',
          textAlign: 'center',
          overflow: 'hidden',
          overflowWrap: 'break-word',
          border: '1px solid var(--border-subtle)',
          borderRadius: 'var(--radius-md, 8px)',
          background: 'var(--bg-widget-hover)',
          backfaceVisibility: 'hidden',
          transform: back ? 'rotateY(180deg)' : undefined,
        }}
      >
        <span style={{ maxHeight: '100%', overflowY: 'auto' }}>{content}</span>
      </div>
    );

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div
          className="c-muted"
          style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, flexShrink: 0 }}
        >
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {deckName ?? ''}
          </span>
          <span style={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
            {t('tool.flashcards.study.dueCount', { count: queue.length })}
          </span>
        </div>

        <button
          aria-label={t(revealed ? 'tool.flashcards.study.backSide' : 'tool.flashcards.study.reveal')}
          onClick={() => setRevealed((r) => !r)}
          style={{
            flex: 1,
            minHeight: 0,
            border: 'none',
            background: 'none',
            padding: 0,
            cursor: 'pointer',
            perspective: '800px',
            color: 'inherit',
            font: 'inherit',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: '100%',
              height: '100%',
              transformStyle: 'preserve-3d',
              transition: reduced ? 'none' : 'transform 0.35s ease',
              transform: revealed ? 'rotateY(180deg)' : 'none',
            }}
          >
            {face(current.front, false)}
            {face(current.back, true)}
          </div>
        </button>

        {revealed ? (
          <div style={{ display: 'flex', gap: 'var(--space-1)', flexShrink: 0 }}>
            {GRADE_BUTTONS.map(({ labelKey, grade: g }) => (
              <button
                key={g}
                className={`c-btn${g === 2 ? '' : g === 4 ? ' c-btn--primary' : ' c-btn--ghost'}`}
                style={{ flex: 1, minWidth: 0, ...(g === 2 ? { color: 'var(--danger)' } : {}) }}
                onClick={() => void grade(g)}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        ) : (
          <button
            className="c-btn c-btn--primary"
            style={{ flexShrink: 0 }}
            onClick={() => setRevealed(true)}
          >
            {t('tool.flashcards.study.reveal')}
          </button>
        )}
      </div>
    );
  }

  /* ── Grid variant: deck overview + add form ────────────────────────── */

  function GridView() {
    const [decks, setDecks] = useState<DeckDoc[]>([]);
    const [cards, setCards] = useState<CardDoc[]>([]);
    const [deckDraft, setDeckDraft] = useState('');
    const [front, setFront] = useState('');
    const [back, setBack] = useState('');

    const reload = useCallback(async () => {
      const c = ctx;
      if (!c) return;
      const [deckList, cardList] = await Promise.all([
        queryDecksIn(c.storage),
        queryCardsIn(c.storage),
      ]);
      setDecks(deckList);
      setCards(cardList);
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

    async function addCard() {
      const c = ctx;
      if (!c || !deckDraft.trim() || !front.trim() || !back.trim()) return;
      await addCardIn(c.storage, { deck: deckDraft, front, back }, localDayKey());
      setFront('');
      setBack('');
    }

    const stats = deckStats(decks, cards, localDayKey());

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap', flexShrink: 0 }}>
          <input
            className="c-input"
            list="flashcards-decks"
            value={deckDraft}
            placeholder={t('tool.flashcards.grid.deckPlaceholder')}
            aria-label={t('tool.flashcards.grid.deckPlaceholder')}
            style={{ flex: 1, minWidth: 70 }}
            onChange={(e) => setDeckDraft(e.target.value)}
          />
          <datalist id="flashcards-decks">
            {decks.map((d) => (
              <option key={d.id} value={d.name} />
            ))}
          </datalist>
          <input
            className="c-input"
            value={front}
            placeholder={t('tool.flashcards.grid.frontPlaceholder')}
            aria-label={t('tool.flashcards.grid.frontPlaceholder')}
            style={{ flex: 1, minWidth: 70 }}
            onChange={(e) => setFront(e.target.value)}
          />
          <input
            className="c-input"
            value={back}
            placeholder={t('tool.flashcards.grid.backPlaceholder')}
            aria-label={t('tool.flashcards.grid.backPlaceholder')}
            style={{ flex: 1, minWidth: 70 }}
            onChange={(e) => setBack(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addCard();
            }}
          />
          <button
            className="c-btn c-btn--primary"
            aria-label={t('tool.flashcards.grid.add')}
            title={t('tool.flashcards.grid.add')}
            style={{ flexShrink: 0 }}
            onClick={() => void addCard()}
          >
            +
          </button>
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
          {stats.length === 0 ? (
            <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
              {t('tool.flashcards.widget.empty')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              {stats.map(({ deck, total, due }) => (
                <div
                  key={deck.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
                >
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {deck.name}
                  </span>
                  <span
                    className="c-muted"
                    style={{ fontSize: 12, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
                  >
                    {t('tool.flashcards.grid.cards', { count: total })}
                  </span>
                  <span
                    title={t('tool.flashcards.grid.due', { count: due })}
                    style={{
                      fontSize: 12,
                      fontVariantNumeric: 'tabular-nums',
                      color: due > 0 ? 'var(--warning)' : 'var(--text-muted)',
                      flexShrink: 0,
                    }}
                  >
                    {due > 0 ? `● ${due}` : '✓'}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ── Stats variant: reviews per day ────────────────────────────────── */

  function StatsView() {
    const [logs, setLogs] = useState<ReviewLogDoc[]>([]);

    useEffect(() => {
      let mounted = true;
      const load = () => {
        const c = ctx;
        if (!c) return;
        void queryLogsIn(c.storage).then((list) => {
          if (mounted) setLogs(list);
        });
      };
      load();
      const unsub = ctx?.storage.subscribe(() => load());
      return () => {
        mounted = false;
        unsub?.();
      };
    }, []);

    const series = reviewSeries(logs, 14, localDayKey());
    const max = Math.max(1, ...series.map((s) => s.count));
    const total = series.reduce((acc, s) => acc + s.count, 0);
    const barW = 100 / series.length;

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-2)' }}>
        <div className="c-muted" style={{ fontSize: 12, flexShrink: 0 }}>
          {t('tool.flashcards.stats.title', { count: total })}
        </div>
        {total === 0 ? (
          <div className="c-muted" style={{ textAlign: 'center', marginTop: 'var(--space-4)' }}>
            {t('tool.flashcards.stats.empty')}
          </div>
        ) : (
          <svg
            viewBox="0 0 100 40"
            preserveAspectRatio="none"
            role="img"
            aria-label={t('tool.flashcards.stats.title', { count: total })}
            style={{ flex: 1, minHeight: 0, width: '100%' }}
          >
            {series.map((s, i) => {
              const h = (s.count / max) * 36;
              return (
                <rect
                  key={s.date}
                  x={i * barW + barW * 0.15}
                  y={40 - h}
                  width={barW * 0.7}
                  height={h}
                  fill="var(--accent)"
                >
                  <title>{`${s.date}: ${s.count}`}</title>
                </rect>
              );
            })}
          </svg>
        )}
        <div
          className="c-muted"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 10,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          <span>{series[0]?.date ?? ''}</span>
          <span>{series[series.length - 1]?.date ?? ''}</span>
        </div>
      </div>
    );
  }

  function FlashcardsWidget(props: WidgetProps) {
    let body;
    switch (props.variant) {
      case 'grid':
        body = <GridView />;
        break;
      case 'stats':
        body = <StatsView />;
        break;
      case 'study':
      default:
        body = <StudyView />;
        break;
    }
    return <div style={{ height: '100%', padding: 'var(--space-3)' }}>{body}</div>;
  }

  return {
    manifest: manifest as CardoTool['manifest'],

    activate(context: ToolContext) {
      ctx = context;

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
          const { deck, card } = await addCardIn(context.storage, params, localDayKey());
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
          const cards = await queryCardsIn(context.storage);
          const due = dueCards(cards, localDayKey());
          return {
            ok: true,
            data: { due: due.length },
            messageKey:
              due.length > 0 ? 'tool.flashcards.msg.dueReady' : 'tool.flashcards.msg.nothingDue',
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
          const [decks, cards] = await Promise.all([
            queryDecksIn(context.storage),
            queryCardsIn(context.storage),
          ]);
          return {
            ok: true,
            data: {
              contextText: buildFlashcardsContext(
                decks,
                cards,
                context.i18n.language,
                localDayKey(),
              ),
            },
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
          // The SM-2 table from logic.test.ts, run in the packaged build.
          const fresh = { ease: 2.5, intervalDays: 0, reps: 0 };
          const table: Array<[Grade, number, number, number]> = [
            [0, 2.5, 1, 0],
            [2, 2.5, 1, 0],
            [3, 2.36, 1, 1],
            [4, 2.5, 1, 1],
            [5, 2.6, 1, 1],
          ];
          for (const [grade, ease, intervalDays, reps] of table) {
            const next = review(fresh, grade, '2026-07-15');
            if (next.ease !== ease || next.intervalDays !== intervalDays || next.reps !== reps) {
              return { status: 'fail', detail: `grade ${grade}: got ${JSON.stringify(next)}` };
            }
          }
          let c = { ...fresh };
          const intervals: number[] = [];
          for (const grade of [4, 4, 4] as const) {
            const next = review(c, grade, '2026-07-15');
            intervals.push(next.intervalDays);
            c = { ...c, ...next };
          }
          if (intervals.join(',') !== '1,6,15') {
            return { status: 'fail', detail: `4,4,4 gave intervals ${intervals.join(',')}` };
          }
          for (let i = 0; i < 20; i += 1) c = { ...c, ...review(c, 3, '2026-07-15') };
          if (c.ease !== 1.3) {
            return { status: 'fail', detail: `ease floor violated: ${c.ease}` };
          }
          return { status: 'pass', detail: 'grade table, 1-6-15 ladder and ease floor ok' };
        }
        case 'crud': {
          const { deck, card } = await addCardIn(
            testCtx.storage,
            { deck: 'selftest crud deck', front: 'F', back: 'B' },
            today,
          );
          const cardBack = await testCtx.storage.get<CardDoc>(card.id);
          const deckBack = await testCtx.storage.get<DeckDoc>(deck.id);
          await testCtx.storage.delete(card.id);
          await testCtx.storage.delete(deck.id);
          const gone = await testCtx.storage.get<CardDoc>(card.id);
          if (
            !cardBack ||
            !deckBack ||
            cardBack.front !== 'F' ||
            cardBack.back !== 'B' ||
            cardBack.deckId !== deck.id ||
            cardBack.ease !== 2.5 ||
            deckBack.name !== 'selftest crud deck'
          ) {
            return { status: 'fail', detail: `roundtrip mismatch: ${JSON.stringify(cardBack)}` };
          }
          if (gone !== null) return { status: 'fail', detail: 'card still present after delete' };
          return { status: 'pass', detail: 'deck+card create → read → delete roundtrip ok' };
        }
        case 'due-flow': {
          const { deck, card } = await addCardIn(
            testCtx.storage,
            { deck: 'selftest due deck', front: 'F', back: 'B' },
            today,
          );
          try {
            const allBefore = await queryCardsIn(testCtx.storage);
            if (!dueCards(allBefore, today).some((x) => x.id === card.id)) {
              return { status: 'fail', detail: 'fresh card is not due' };
            }
            const reviewed = await reviewCardIn(testCtx.storage, card, 5, today);
            const allAfter = await queryCardsIn(testCtx.storage);
            if (dueCards(allAfter, today).some((x) => x.id === card.id)) {
              return { status: 'fail', detail: 'card still due after a grade-5 review' };
            }
            const stored = await testCtx.storage.get<CardDoc>(card.id);
            const log = await testCtx.storage.get<ReviewLogDoc>(`log:${today}`);
            if (!stored || stored.due !== reviewed.due || stored.reps !== 1) {
              return { status: 'fail', detail: `review not persisted: ${JSON.stringify(stored)}` };
            }
            if (!log || log.count < 1) {
              return { status: 'fail', detail: 'review log counter was not bumped' };
            }
            return { status: 'pass', detail: `add → review → due moved to ${stored.due}` };
          } finally {
            await testCtx.storage.delete(card.id);
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
