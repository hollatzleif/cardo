/**
 * Pure, storage-free logic for the subscriptions tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

import { z } from 'zod';

export type Cycle = 'weekly' | 'monthly' | 'quarterly' | 'yearly';

export const CYCLES: Cycle[] = ['weekly', 'monthly', 'quarterly', 'yearly'];

export type SubDoc = {
  /** Stable id, identical to the storage doc id ("sub:<random>"). */
  id: string;
  type: 'sub';
  name: string;
  /** Price per billing cycle in the user's display currency (no FX math). */
  amount: number;
  cycle: Cycle;
  /** Next due date, yyyy-mm-dd. */
  nextDue: string;
  category?: string;
  createdAt: string;
};

/** Params of the subscriptions.add command (zero/negative amounts reject). */
export const addSubParamsSchema = z.object({
  name: z.string().min(1),
  amount: z.number().positive(),
  cycle: z.enum(['weekly', 'monthly', 'quarterly', 'yearly']),
  nextDue: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.string().optional(),
});
export type AddSubParams = z.infer<typeof addSubParamsSchema>;

export function makeSubId(): string {
  return `sub:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function makeSub(
  input: { name: string; amount: number; cycle: Cycle; nextDue: string; category?: string },
  now: Date = new Date(),
): SubDoc {
  const sub: SubDoc = {
    id: makeSubId(),
    type: 'sub',
    name: input.name.trim(),
    amount: input.amount,
    cycle: input.cycle,
    nextDue: input.nextDue,
    createdAt: now.toISOString(),
  };
  const category = input.category?.trim();
  if (category) sub.category = category;
  return sub;
}

/** yyyy-mm-dd and actually a real calendar date (rejects e.g. 2026-13-40). */
export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === date;
}

/** Local date as yyyy-mm-dd (lexicographically comparable with nextDue). */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/**
 * UNROUNDED cost per month for one subscription. Rounding to cents happens
 * exactly once – at SUM time in totalMonthly() – so per-item rounding errors
 * never accumulate (3 × 1.00/year is 0.25/month, not 3 × 0.08 = 0.24).
 */
export function monthlyCost(amount: number, cycle: Cycle): number {
  switch (cycle) {
    case 'weekly':
      return (amount * 52) / 12;
    case 'monthly':
      return amount;
    case 'quarterly':
      return amount / 3;
    case 'yearly':
      return amount / 12;
  }
}

/** Sum of all monthly costs, rounded to cents exactly once. */
export function totalMonthly(subs: Array<Pick<SubDoc, 'amount' | 'cycle'>>): number {
  const sum = subs.reduce((acc, sub) => acc + monthlyCost(sub.amount, sub.cycle), 0);
  return Math.round(sum * 100) / 100;
}

/* ── Calendar math (UTC-based on yyyy-mm-dd strings, so it is timezone-proof) ── */

function parseIso(date: string): { y: number; m: number; d: number } | null {
  if (!isValidDate(date)) return null;
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return { y, m, d };
}

function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Days in month `m` (1-12) of year `y` – leap years included. */
export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** date + days, as yyyy-mm-dd. */
export function addDays(date: string, days: number): string {
  const ms = new Date(`${date}T00:00:00Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * date + months with the day-of-month clamped into the target month.
 * `anchorDay` (defaults to the date's own day) is re-applied on every call, so
 * an anchor of 31 yields Jan 31 → Feb 28 → Mar 31 instead of drifting to 28.
 */
export function addMonthsClamped(date: string, months: number, anchorDay?: number): string {
  const parsed = parseIso(date);
  if (!parsed) return date;
  const anchor = anchorDay ?? parsed.d;
  const total = parsed.m - 1 + months;
  const y = parsed.y + Math.floor(total / 12);
  const m = ((total % 12) + 12) % 12 + 1;
  return toIso(y, m, Math.min(anchor, daysInMonth(y, m)));
}

/** Whole days from `today` until `date` (both yyyy-mm-dd); negative when past. */
export function daysUntil(date: string, today: string): number {
  const a = new Date(`${today}T00:00:00Z`).getTime();
  const b = new Date(`${date}T00:00:00Z`).getTime();
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/** Hard cap against runaway loops on absurd dates (≈ 100 years of monthly cycles). */
const MAX_ADVANCE_STEPS = 1200;

/**
 * Rolls nextDue forward in cycle steps until it lies strictly AFTER `today`
 * ("mark as paid"). Month-based cycles always step from the ORIGINAL date
 * with its day-of-month as anchor, so Jan 31 clamps to Feb 28 (Feb 29 in
 * leap years) and returns to the 31st in March. Future due dates and
 * invalid docs are returned unchanged.
 */
export function advanceDue(sub: SubDoc, today: string): SubDoc {
  if (!isValidDate(sub.nextDue) || sub.nextDue > today) return sub;
  if (sub.cycle === 'weekly') {
    let next = sub.nextDue;
    let steps = 0;
    while (next <= today && steps < MAX_ADVANCE_STEPS) {
      next = addDays(next, 7);
      steps += 1;
    }
    return { ...sub, nextDue: next };
  }
  const monthsPerStep = sub.cycle === 'monthly' ? 1 : sub.cycle === 'quarterly' ? 3 : 12;
  const anchor = parseIso(sub.nextDue)?.d ?? 1;
  let next = sub.nextDue;
  let steps = 0;
  while (next <= today && steps < MAX_ADVANCE_STEPS) {
    steps += 1;
    next = addMonthsClamped(sub.nextDue, monthsPerStep * steps, anchor);
  }
  return { ...sub, nextDue: next };
}

/**
 * Subscriptions due within the next `days` days (inclusive), sorted by due
 * date. Overdue entries are included – they are MORE urgent, not less.
 */
export function dueWithin(subs: SubDoc[], days: number, today: string): SubDoc[] {
  const horizon = addDays(today, days);
  return subs
    .filter((sub) => isValidDate(sub.nextDue) && sub.nextDue <= horizon)
    .sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : a.name.localeCompare(b.name)));
}

/**
 * All known due days inside a given month (for the calendar variant).
 * Projects each subscription's occurrences forward from its nextDue, so a
 * weekly subscription can appear several times in one month.
 */
export function duesInMonth(
  subs: SubDoc[],
  year: number,
  month: number,
): Array<{ day: number; sub: SubDoc }> {
  const monthEnd = toIso(year, month, daysInMonth(year, month));
  const result: Array<{ day: number; sub: SubDoc }> = [];
  for (const sub of subs) {
    if (!isValidDate(sub.nextDue)) continue;
    const anchor = parseIso(sub.nextDue)?.d ?? 1;
    const monthsPerStep =
      sub.cycle === 'monthly' ? 1 : sub.cycle === 'quarterly' ? 3 : sub.cycle === 'yearly' ? 12 : 0;
    let occurrence = sub.nextDue;
    let steps = 0;
    while (occurrence <= monthEnd && steps < MAX_ADVANCE_STEPS) {
      const parsed = parseIso(occurrence);
      if (parsed && parsed.y === year && parsed.m === month) {
        result.push({ day: parsed.d, sub });
      }
      steps += 1;
      occurrence =
        sub.cycle === 'weekly'
          ? addDays(sub.nextDue, 7 * steps)
          : addMonthsClamped(sub.nextDue, monthsPerStep * steps, anchor);
    }
  }
  return result.sort((a, b) => a.day - b.day || a.sub.name.localeCompare(b.sub.name));
}

const CYCLE_LABEL: Record<'en' | 'de', Record<Cycle, string>> = {
  en: { weekly: 'weekly', monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly' },
  de: { weekly: 'wöchentlich', monthly: 'monatlich', quarterly: 'quartalsweise', yearly: 'jährlich' },
};

/**
 * Compact snapshot for the assistant's "current state" context: count,
 * exact monthly total and the next three due subscriptions.
 */
export function buildSubsContext(
  subs: SubDoc[],
  language: string,
  today: string,
  currency = '€',
): string {
  const de = language === 'de';
  if (subs.length === 0) return de ? 'Keine Abos angelegt.' : 'No subscriptions yet.';
  const nf = new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const labels = CYCLE_LABEL[de ? 'de' : 'en'];
  const total = nf.format(totalMonthly(subs));
  const next = [...subs]
    .sort((a, b) => (a.nextDue < b.nextDue ? -1 : a.nextDue > b.nextDue ? 1 : 0))
    .slice(0, 3)
    .map((sub) => {
      const price = `${nf.format(sub.amount)} ${currency} ${labels[sub.cycle]}`;
      return de
        ? `«${sub.name}» (${price}) am ${sub.nextDue}`
        : `«${sub.name}» (${price}) on ${sub.nextDue}`;
    });
  const head = de
    ? `${subs.length} Abos, insgesamt ≈ ${total} ${currency} pro Monat.`
    : `${subs.length} subscriptions, ≈ ${total} ${currency} per month in total.`;
  const tail = de ? `Als Nächstes fällig: ${next.join(', ')}.` : `Next due: ${next.join(', ')}.`;
  return `${head} ${tail}`;
}

/** "1,234.5 €" style display string – number formatting follows the UI language. */
export function formatMoney(value: number, language: string, currency: string): string {
  const num = new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
  return currency ? `${num} ${currency}` : num;
}
