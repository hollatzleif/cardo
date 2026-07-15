import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EASE,
  MIN_EASE,
  addCardParamsSchema,
  addDays,
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
} from './logic';

const TODAY = '2026-07-15';

function card(partial: Partial<CardDoc> = {}): CardDoc {
  return {
    id: 'card:test',
    type: 'card',
    deckId: 'deck:test',
    front: 'front',
    back: 'back',
    ease: DEFAULT_EASE,
    intervalDays: 0,
    due: TODAY,
    reps: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

function deck(partial: Partial<DeckDoc> = {}): DeckDoc {
  return {
    id: 'deck:test',
    type: 'deck',
    name: 'Test deck',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

describe('review (SM-2)', () => {
  it('table: every grade from a fresh card', () => {
    // [grade, ease', interval', reps'] – lapses (0-2) keep the ease untouched.
    const table: Array<[Grade, number, number, number]> = [
      [0, 2.5, 1, 0],
      [1, 2.5, 1, 0],
      [2, 2.5, 1, 0],
      [3, 2.36, 1, 1], // 2.5 + 0.1 − 2·(0.08 + 2·0.02)
      [4, 2.5, 1, 1], // delta 0
      [5, 2.6, 1, 1], // delta +0.1
    ];
    for (const [grade, ease, intervalDays, reps] of table) {
      const next = review(card(), grade, TODAY);
      expect(next, `grade ${grade}`).toEqual({
        ease,
        intervalDays,
        reps,
        due: addDays(TODAY, intervalDays),
      });
    }
  });

  it('sequence 4,4,4 → intervals 1, 6, 15 (ease stays 2.5)', () => {
    let c = card();
    const intervals: number[] = [];
    for (const grade of [4, 4, 4] as const) {
      const next = review(c, grade, TODAY);
      intervals.push(next.intervalDays);
      c = { ...c, ...next };
    }
    expect(intervals).toEqual([1, 6, 15]); // round(6 × 2.5)
    expect(c.ease).toBe(2.5);
    expect(c.reps).toBe(3);
  });

  it('sequence 5,5,5 → intervals 1, 6, 17 (ease grows to 2.8)', () => {
    let c = card();
    const intervals: number[] = [];
    for (const grade of [5, 5, 5] as const) {
      const next = review(c, grade, TODAY);
      intervals.push(next.intervalDays);
      c = { ...c, ...next };
    }
    expect(intervals).toEqual([1, 6, 17]); // round(6 × 2.8)
    expect(c.ease).toBe(2.8);
  });

  it('never drops the ease below 1.3 (grade-3 grind)', () => {
    let c = card();
    for (let i = 0; i < 20; i += 1) {
      c = { ...c, ...review(c, 3, TODAY) };
    }
    expect(c.ease).toBe(MIN_EASE);
  });

  it('a lapse resets reps and interval but keeps the ease', () => {
    let c = card();
    c = { ...c, ...review(c, 5, TODAY) }; // ease 2.6, reps 1
    c = { ...c, ...review(c, 5, TODAY) }; // ease 2.7, reps 2, interval 6
    const lapsed = review(c, 1, TODAY);
    expect(lapsed.reps).toBe(0);
    expect(lapsed.intervalDays).toBe(1);
    expect(lapsed.ease).toBe(2.7);
    expect(lapsed.due).toBe(addDays(TODAY, 1));
    // Recovery restarts the 1 → 6 → n ladder.
    const recovered = review({ ...c, ...lapsed }, 4, TODAY);
    expect(recovered.reps).toBe(1);
    expect(recovered.intervalDays).toBe(1);
  });

  it('due is always today + interval', () => {
    const c = card({ intervalDays: 6, reps: 2, ease: 2.5 });
    const next = review(c, 4, '2026-12-30');
    expect(next.intervalDays).toBe(15);
    expect(next.due).toBe('2027-01-14'); // crosses the year boundary
  });
});

describe('dueCards', () => {
  it('includes overdue and today, sorted most-overdue first', () => {
    const a = card({ id: 'card:a', due: '2026-07-15' });
    const b = card({ id: 'card:b', due: '2026-07-10' });
    const c = card({ id: 'card:c', due: '2026-07-16' });
    expect(dueCards([a, b, c], TODAY).map((x) => x.id)).toEqual(['card:b', 'card:a']);
  });

  it('breaks due-date ties by creation time', () => {
    const older = card({ id: 'card:old', createdAt: '2026-01-01T00:00:00.000Z' });
    const newer = card({ id: 'card:new', createdAt: '2026-02-01T00:00:00.000Z' });
    expect(dueCards([newer, older], TODAY).map((x) => x.id)).toEqual(['card:old', 'card:new']);
  });

  it('is empty when nothing is due', () => {
    expect(dueCards([card({ due: '2099-01-01' })], TODAY)).toEqual([]);
  });
});

describe('deckStats', () => {
  it('counts totals and dues per deck, sorted by name, keeping empty decks', () => {
    const spanish = deck({ id: 'deck:es', name: 'Spanish' });
    const bio = deck({ id: 'deck:bio', name: 'Bio' });
    const empty = deck({ id: 'deck:x', name: 'Empty' });
    const cards = [
      card({ id: 'card:1', deckId: 'deck:es', due: '2026-07-10' }),
      card({ id: 'card:2', deckId: 'deck:es', due: '2099-01-01' }),
      card({ id: 'card:3', deckId: 'deck:bio', due: TODAY }),
    ];
    const stats = deckStats([spanish, bio, empty], cards, TODAY);
    expect(stats.map((s) => [s.deck.name, s.total, s.due])).toEqual([
      ['Bio', 1, 1],
      ['Empty', 0, 0],
      ['Spanish', 2, 1],
    ]);
  });
});

describe('reviewSeries', () => {
  it('fills gaps with 0 and ends at today', () => {
    const logs = [
      { id: 'log:2026-07-15', type: 'log' as const, date: '2026-07-15', count: 4 },
      { id: 'log:2026-07-13', type: 'log' as const, date: '2026-07-13', count: 2 },
    ];
    expect(reviewSeries(logs, 3, TODAY)).toEqual([
      { date: '2026-07-13', count: 2 },
      { date: '2026-07-14', count: 0 },
      { date: '2026-07-15', count: 4 },
    ]);
  });
});

describe('dates', () => {
  it('localDayKey renders the LOCAL date (00:30 stays today)', () => {
    expect(localDayKey(new Date(2026, 6, 15, 0, 30))).toBe('2026-07-15');
    expect(localDayKey(new Date(2026, 6, 15, 23, 59))).toBe('2026-07-15');
  });

  it('addDays crosses month and year boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-02-28', 1)).toBe('2024-02-29'); // leap year
    expect(addDays('2026-07-15', 0)).toBe('2026-07-15');
  });
});

describe('doc factories', () => {
  it('makeCard starts fresh: ease 2.5, interval 0, due today, reps 0', () => {
    const c = makeCard({ deckId: 'deck:x', front: ' Q ', back: ' A ' }, TODAY);
    expect(c.ease).toBe(DEFAULT_EASE);
    expect(c.intervalDays).toBe(0);
    expect(c.due).toBe(TODAY);
    expect(c.reps).toBe(0);
    expect(c.front).toBe('Q');
    expect(c.back).toBe('A');
    expect(c.id.startsWith('card:')).toBe(true);
    expect(c.type).toBe('card');
  });

  it('makeDeck trims the name', () => {
    const d = makeDeck('  Spanish  ');
    expect(d.name).toBe('Spanish');
    expect(d.id.startsWith('deck:')).toBe(true);
  });
});

describe('addCardParamsSchema', () => {
  it('accepts a full card and rejects empty fields', () => {
    expect(addCardParamsSchema.safeParse({ deck: 'D', front: 'f', back: 'b' }).success).toBe(true);
    expect(addCardParamsSchema.safeParse({ deck: '', front: 'f', back: 'b' }).success).toBe(false);
    expect(addCardParamsSchema.safeParse({ deck: 'D', front: '', back: 'b' }).success).toBe(false);
    expect(addCardParamsSchema.safeParse({ deck: 'D', front: 'f' }).success).toBe(false);
  });
});

describe('buildFlashcardsContext', () => {
  const decks = [deck({ id: 'deck:es', name: 'Spanish' }), deck({ id: 'deck:bio', name: 'Bio' })];
  const cards = [
    card({ id: 'card:1', deckId: 'deck:es', due: '2026-07-10' }),
    card({ id: 'card:2', deckId: 'deck:es', due: TODAY }),
    card({ id: 'card:3', deckId: 'deck:bio', due: '2099-01-01' }),
  ];

  it('reports the empty state in both languages', () => {
    expect(buildFlashcardsContext([], [], 'en', TODAY)).toBe('No flashcards yet.');
    expect(buildFlashcardsContext([], [], 'de', TODAY)).toBe('Noch keine Karteikarten angelegt.');
  });

  it('lists totals and due counts per deck (en)', () => {
    const text = buildFlashcardsContext(decks, cards, 'en', TODAY);
    expect(text).toContain('2 decks with 3 cards, 2 due today.');
    expect(text).toContain('«Spanish» 2');
    expect(text).not.toContain('«Bio»'); // nothing due there
  });

  it('uses German wording (de)', () => {
    const text = buildFlashcardsContext(decks, cards, 'de', TODAY);
    expect(text).toContain('2 Stapel mit 3 Karten, 2 heute fällig.');
    expect(text).toContain('Fällig je Stapel:');
  });

  it('celebrates when nothing is due', () => {
    const done = [card({ id: 'card:1', deckId: 'deck:es', due: '2099-01-01' })];
    expect(buildFlashcardsContext(decks, done, 'en', TODAY)).toContain('All caught up');
    expect(buildFlashcardsContext(decks, done, 'de', TODAY)).toContain('Alles gelernt');
  });
});
