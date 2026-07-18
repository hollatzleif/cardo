/**
 * Statistics for the flashcards tool: card counts, per-deck breakdown, a due
 * forecast, retention, and a review heatmap. Pure and framework-free so it
 * unit-tests in plain node.
 *
 * The heatmap mirrors Cardo's established 26-week / 5-level pattern (as used
 * by the habits tool) locally – tools must not import each other (plugin
 * boundary), so the small grid helpers are reproduced here.
 */

import type { CardDoc } from './model';
import type { Rating } from './session';

const HEATMAP_DAYS = 26 * 7;

export function addDays(dayKey: string, days: number): string {
  const ms = new Date(`${dayKey}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Date keys of the last 26 weeks, oldest first, ending at `todayKey`. */
export function heatmapDays(todayKey: string): string[] {
  const days: string[] = [];
  for (let i = HEATMAP_DAYS - 1; i >= 0; i -= 1) days.push(addDays(todayKey, -i));
  return days;
}

/** Ratio (0..1) → one of 5 discrete heat levels (rendered as opacity steps). */
export function heatLevel(ratio: number): 0 | 1 | 2 | 3 | 4 {
  if (ratio <= 0) return 0;
  if (ratio <= 0.25) return 1;
  if (ratio <= 0.5) return 2;
  if (ratio <= 0.75) return 3;
  return 4;
}

function isDue(card: CardDoc, today: string, nowIso: string): boolean {
  if (card.suspended || card.buried) return false;
  if (card.state.phase === 'review') return card.due <= today;
  if (card.state.phase === 'learning' || card.state.phase === 'relearning') {
    return card.dueAt === null || card.dueAt <= nowIso;
  }
  return false;
}

/* ── Counts ───────────────────────────────────────────────────────────────── */

export interface CardCounts {
  total: number;
  new: number;
  learning: number;
  review: number;
  suspended: number;
  buried: number;
  due: number;
}

export function cardCounts(cards: CardDoc[], today: string, nowIso: string): CardCounts {
  const c: CardCounts = { total: 0, new: 0, learning: 0, review: 0, suspended: 0, buried: 0, due: 0 };
  for (const card of cards) {
    c.total += 1;
    if (card.suspended) c.suspended += 1;
    if (card.buried) c.buried += 1;
    if (card.state.phase === 'new') c.new += 1;
    else if (card.state.phase === 'review') c.review += 1;
    else c.learning += 1;
    if (isDue(card, today, nowIso)) c.due += 1;
  }
  return c;
}

export interface DeckStat {
  deckId: string;
  name: string;
  total: number;
  due: number;
}

export function deckBreakdown(
  cards: CardDoc[],
  deckNameById: Map<string, string>,
  today: string,
  nowIso: string,
): DeckStat[] {
  const by = new Map<string, DeckStat>();
  for (const card of cards) {
    const name = deckNameById.get(card.deckId) ?? card.deckId;
    const stat = by.get(card.deckId) ?? { deckId: card.deckId, name, total: 0, due: 0 };
    stat.total += 1;
    if (isDue(card, today, nowIso)) stat.due += 1;
    by.set(card.deckId, stat);
  }
  return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ── Forecast ─────────────────────────────────────────────────────────────── */

/**
 * How many review cards fall due on each of the next `days` days. Overdue
 * cards (due before today) are folded into today's bucket (the backlog).
 */
export function forecast(
  cards: CardDoc[],
  today: string,
  days: number,
): Array<{ date: string; count: number }> {
  const horizon = addDays(today, days - 1);
  const buckets = new Map<string, number>();
  for (const card of cards) {
    if (card.suspended || card.buried || card.state.phase !== 'review') continue;
    const day = card.due < today ? today : card.due;
    if (day > horizon) continue;
    buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }
  return Array.from({ length: Math.max(0, days) }, (_, i) => {
    const date = addDays(today, i);
    return { date, count: buckets.get(date) ?? 0 };
  });
}

/* ── Review history: retention + heatmap ──────────────────────────────────── */

export interface ReviewEvent {
  /** yyyy-mm-dd of the answer. */
  date: string;
  rating: Rating;
}

/**
 * Fraction of answers that were NOT "again" (i.e. recalled), optionally over
 * the last `days` days ending at `today`. Returns 0 when there is no history.
 */
export function retention(
  events: ReviewEvent[],
  window?: { days: number; today: string },
): number {
  let pool = events;
  if (window) {
    const from = addDays(window.today, -(window.days - 1));
    pool = events.filter((e) => e.date >= from && e.date <= window.today);
  }
  if (pool.length === 0) return 0;
  const recalled = pool.filter((e) => e.rating !== 'again').length;
  return recalled / pool.length;
}

export function reviewCountsByDate(events: ReviewEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.date, (counts.get(e.date) ?? 0) + 1);
  return counts;
}

export interface HeatmapCell {
  date: string;
  count: number;
  level: 0 | 1 | 2 | 3 | 4;
}

/** The 26-week review heatmap cells, oldest first, ending today. */
export function heatmapCells(events: ReviewEvent[], todayKey: string): HeatmapCell[] {
  const counts = reviewCountsByDate(events);
  const days = heatmapDays(todayKey);
  const max = Math.max(1, ...days.map((d) => counts.get(d) ?? 0));
  return days.map((date) => {
    const count = counts.get(date) ?? 0;
    return { date, count, level: heatLevel(count / max) };
  });
}
