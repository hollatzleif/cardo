import { describe, it, expect } from 'vitest';
import { newCardState, type CardDoc, type CardState } from './model';
import {
  addDays,
  cardCounts,
  deckBreakdown,
  forecast,
  heatLevel,
  heatmapCells,
  heatmapDays,
  retention,
  reviewCountsByDate,
  type ReviewEvent,
} from './stats';

function card(id: string, over: Omit<Partial<CardDoc>, 'state'> & { state?: Partial<CardState> } = {}): CardDoc {
  return {
    id,
    type: 'card',
    noteId: `n-${id}`,
    templateIndex: 0,
    deckId: over.deckId ?? 'deck:a',
    state: { ...newCardState(), ...(over.state ?? {}) },
    due: over.due ?? '2026-07-17',
    dueAt: over.dueAt ?? null,
    suspended: over.suspended ?? false,
    buried: over.buried ?? false,
    flag: 0,
    createdAt: '2026-07-10T00:00:00.000Z',
  };
}

const TODAY = '2026-07-17';
const NOW = '2026-07-17T09:00:00.000Z';

describe('heatmap grid helpers', () => {
  it('produces 182 days ending today', () => {
    const days = heatmapDays(TODAY);
    expect(days).toHaveLength(26 * 7);
    expect(days[days.length - 1]).toBe(TODAY);
    expect(days[0]).toBe(addDays(TODAY, -(26 * 7 - 1)));
  });

  it('maps ratios to 5 levels', () => {
    expect(heatLevel(0)).toBe(0);
    expect(heatLevel(0.2)).toBe(1);
    expect(heatLevel(0.5)).toBe(2);
    expect(heatLevel(0.75)).toBe(3);
    expect(heatLevel(1)).toBe(4);
  });
});

describe('cardCounts', () => {
  it('tallies phases, flags and due', () => {
    const cards = [
      card('1', { state: { phase: 'new' } }),
      card('2', { state: { phase: 'review', intervalDays: 3 }, due: '2026-07-16' }),
      card('3', { state: { phase: 'learning' }, dueAt: '2026-07-17T08:00:00.000Z' }),
      card('4', { state: { phase: 'review', intervalDays: 3 }, due: '2026-07-16', suspended: true }),
    ];
    const c = cardCounts(cards, TODAY, NOW);
    expect(c.total).toBe(4);
    expect(c.new).toBe(1);
    expect(c.review).toBe(2);
    expect(c.learning).toBe(1);
    expect(c.suspended).toBe(1);
    expect(c.due).toBe(2); // card 2 + card 3; suspended card 4 excluded
  });
});

describe('deckBreakdown', () => {
  it('groups by deck, sorted by name, with due counts', () => {
    const names = new Map([
      ['deck:a', 'Alpha'],
      ['deck:b', 'Beta'],
    ]);
    const cards = [
      card('1', { deckId: 'deck:b', state: { phase: 'review', intervalDays: 2 }, due: '2026-07-16' }),
      card('2', { deckId: 'deck:a', state: { phase: 'new' } }),
      card('3', { deckId: 'deck:a', state: { phase: 'review', intervalDays: 2 }, due: '2026-07-16' }),
    ];
    const b = deckBreakdown(cards, names, TODAY, NOW);
    expect(b.map((d) => d.name)).toEqual(['Alpha', 'Beta']);
    expect(b[0]).toMatchObject({ name: 'Alpha', total: 2, due: 1 });
    expect(b[1]).toMatchObject({ name: 'Beta', total: 1, due: 1 });
  });
});

describe('forecast', () => {
  it('buckets review cards by due day and folds overdue into today', () => {
    const cards = [
      card('overdue', { state: { phase: 'review', intervalDays: 5 }, due: '2026-07-10' }),
      card('today', { state: { phase: 'review', intervalDays: 5 }, due: '2026-07-17' }),
      card('tomorrow', { state: { phase: 'review', intervalDays: 5 }, due: '2026-07-18' }),
      card('far', { state: { phase: 'review', intervalDays: 5 }, due: '2026-08-01' }),
      card('new', { state: { phase: 'new' } }),
    ];
    const f = forecast(cards, TODAY, 3);
    expect(f).toEqual([
      { date: '2026-07-17', count: 2 }, // overdue + today
      { date: '2026-07-18', count: 1 },
      { date: '2026-07-19', count: 0 },
    ]);
  });
});

describe('retention & heatmap', () => {
  const events: ReviewEvent[] = [
    { date: '2026-07-17', rating: 'good' },
    { date: '2026-07-17', rating: 'again' },
    { date: '2026-07-16', rating: 'easy' },
    { date: '2026-05-01', rating: 'again' },
  ];

  it('retention = recalled / total, windowable', () => {
    expect(retention([])).toBe(0);
    // 4 events, two are "again" → 2 recalled / 4 = 0.5
    expect(retention(events)).toBe(2 / 4);
    // last 2 days: 3 events (07-17 ×2, 07-16 ×1), 2 recalled → 2/3
    expect(retention(events, { days: 2, today: TODAY })).toBeCloseTo(2 / 3);
  });

  it('counts reviews per date', () => {
    const counts = reviewCountsByDate(events);
    expect(counts.get('2026-07-17')).toBe(2);
    expect(counts.get('2026-07-16')).toBe(1);
  });

  it('heatmap has one cell per day with levels scaled to the busiest day', () => {
    const cells = heatmapCells(events, TODAY);
    expect(cells).toHaveLength(26 * 7);
    const todayCell = cells[cells.length - 1]!;
    expect(todayCell.date).toBe(TODAY);
    expect(todayCell.count).toBe(2);
    expect(todayCell.level).toBe(4); // busiest day → top level
    const empty = cells.find((c) => c.count === 0)!;
    expect(empty.level).toBe(0);
  });
});
