/**
 * Pure, storage-free logic for the flashcards tool (SM-2 spaced repetition).
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

/* ── Docs ─────────────────────────────────────────────────────────────── */

export type DeckDoc = {
  /** Stable id, identical to the storage doc id ("deck:<random>"). */
  id: string;
  type: 'deck';
  name: string;
  createdAt: string;
};

export type CardDoc = {
  /** Stable id, identical to the storage doc id ("card:<random>"). */
  id: string;
  type: 'card';
  deckId: string;
  front: string;
  back: string;
  /** SM-2 ease factor, starts at 2.5, floored at 1.3. */
  ease: number;
  /** Current review interval in days (0 = brand-new). */
  intervalDays: number;
  /** Next review date, yyyy-mm-dd LOCAL. Due when due <= today. */
  due: string;
  /** Successful repetitions in a row; resets on a lapse (grade < 3). */
  reps: number;
  createdAt: string;
};

/** Per-day review counter for the stats variant ("log:<yyyy-mm-dd>"). */
export type ReviewLogDoc = {
  id: string;
  type: 'log';
  date: string;
  count: number;
};

/* ── Constants / params ───────────────────────────────────────────────── */

export const DEFAULT_EASE = 2.5;
export const MIN_EASE = 1.3;

/** SM-2 grade: 0-2 = lapse ("again"), 3 = hard, 4 = good, 5 = easy. */
export type Grade = 0 | 1 | 2 | 3 | 4 | 5;

export const addCardParamsSchema = z.object({
  /** Deck name or deck doc id – created by name when missing. */
  deck: z.string().min(1),
  front: z.string().min(1),
  back: z.string().min(1),
});
export type AddCardParams = z.infer<typeof addCardParamsSchema>;

/* ── Dates (LOCAL day keys; arithmetic runs in UTC on the key → no drift) ── */

/** Local calendar date as yyyy-mm-dd (00:30 local is still "today"). */
export function localDayKey(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** day key + days, as yyyy-mm-dd (pure string math via UTC – timezone-proof). */
export function addDays(date: string, days: number): string {
  const ms = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/* ── Doc factories ────────────────────────────────────────────────────── */

export function makeId(prefix: 'deck' | 'card'): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeDeck(name: string, now: Date = new Date()): DeckDoc {
  return { id: makeId('deck'), type: 'deck', name: name.trim(), createdAt: now.toISOString() };
}

/** A fresh card is due immediately (interval 0, due today). */
export function makeCard(
  input: { deckId: string; front: string; back: string },
  today: string,
  now: Date = new Date(),
): CardDoc {
  return {
    id: makeId('card'),
    type: 'card',
    deckId: input.deckId,
    front: input.front.trim(),
    back: input.back.trim(),
    ease: DEFAULT_EASE,
    intervalDays: 0,
    due: today,
    reps: 0,
    createdAt: now.toISOString(),
  };
}

/* ── SM-2 ─────────────────────────────────────────────────────────────── */

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Full SM-2 review step.
 *
 * grade < 3 (lapse): repetitions restart – reps 0, interval 1 day,
 * ease UNCHANGED (per the original algorithm).
 *
 * grade >= 3: ease' = ease + 0.1 − (5−g)·(0.08 + (5−g)·0.02), floored at
 * 1.3; reps+1; interval 1 day after the first success, 6 after the second,
 * then round(previousInterval × ease').
 */
export function review(
  card: Pick<CardDoc, 'ease' | 'intervalDays' | 'reps'>,
  grade: Grade,
  today: string,
): { ease: number; intervalDays: number; due: string; reps: number } {
  if (grade < 3) {
    return { ease: card.ease, intervalDays: 1, due: addDays(today, 1), reps: 0 };
  }
  const q = grade;
  const ease = round2(Math.max(MIN_EASE, card.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
  const reps = card.reps + 1;
  const intervalDays = reps === 1 ? 1 : reps === 2 ? 6 : Math.round(card.intervalDays * ease);
  return { ease, intervalDays, due: addDays(today, intervalDays), reps };
}

/* ── Queries / stats ──────────────────────────────────────────────────── */

/** Cards due today or earlier, most overdue first (stable via createdAt). */
export function dueCards(cards: CardDoc[], today: string): CardDoc[] {
  return cards
    .filter((card) => card.due <= today)
    .sort((a, b) =>
      a.due < b.due ? -1 : a.due > b.due ? 1 : a.createdAt.localeCompare(b.createdAt),
    );
}

export type DeckStat = { deck: DeckDoc; total: number; due: number };

/** Per-deck card counts, sorted by deck name. Empty decks stay listed. */
export function deckStats(decks: DeckDoc[], cards: CardDoc[], today: string): DeckStat[] {
  return [...decks]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((deck) => {
      const deckCards = cards.filter((card) => card.deckId === deck.id);
      return {
        deck,
        total: deckCards.length,
        due: deckCards.filter((card) => card.due <= today).length,
      };
    });
}

/** Review counts of the last `days` day keys ending at `today` (oldest first). */
export function reviewSeries(
  logs: ReviewLogDoc[],
  days: number,
  today: string,
): Array<{ date: string; count: number }> {
  const byDate = new Map(logs.map((log) => [log.date, log.count]));
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, i - (days - 1));
    return { date, count: byDate.get(date) ?? 0 };
  });
}

/* ── Assistant context ────────────────────────────────────────────────── */

/**
 * Compact snapshot for the assistant's "current state" context:
 * deck/card totals and today's due counts per deck.
 */
export function buildFlashcardsContext(
  decks: DeckDoc[],
  cards: CardDoc[],
  language: string,
  today: string,
): string {
  const de = language === 'de';
  if (decks.length === 0 && cards.length === 0) {
    return de ? 'Noch keine Karteikarten angelegt.' : 'No flashcards yet.';
  }
  const stats = deckStats(decks, cards, today);
  const due = dueCards(cards, today).length;
  const head = de
    ? `${decks.length} Stapel mit ${cards.length} Karten, ${due} heute fällig.`
    : `${decks.length} decks with ${cards.length} cards, ${due} due today.`;
  if (due === 0) {
    return `${head} ${de ? 'Alles gelernt – nichts offen.' : 'All caught up – nothing to review.'}`;
  }
  const perDeck = stats
    .filter((s) => s.due > 0)
    .map((s) => `«${s.deck.name}» ${s.due}`)
    .join(', ');
  const tail = de ? `Fällig je Stapel: ${perDeck}.` : `Due per deck: ${perDeck}.`;
  return `${head} ${tail}`;
}
