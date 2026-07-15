/**
 * Pure, storage-free logic for the shared-expenses tool.
 * All money math happens in INTEGER CENTS so balances are cent-exact and
 * always sum to zero – rounding never leaks value.
 */

import { z } from 'zod';

export type GroupDoc = {
  /** Stable id, identical to the storage doc id ("group:<random>"). */
  id: string;
  type: 'group';
  name: string;
  /** Display names; the array ORDER is the deterministic remainder order. */
  members: string[];
  createdAt: string;
};

export type ExpenseDoc = {
  /** Stable id, identical to the storage doc id ("expense:<random>"). */
  id: string;
  type: 'expense';
  groupId: string;
  payer: string;
  /** Amount in currency units (e.g. 12.5 = 12,50 €). */
  amount: number;
  description: string;
  /** Who shares this expense. Empty ⇒ all group members (resolved at math time). */
  participants: string[];
  /** yyyy-mm-dd */
  date: string;
};

/** Params of the shared-expenses.add command (participants comma-separated). */
export const addExpenseParamsSchema = z.object({
  group: z.string().min(1),
  payer: z.string().min(1),
  amount: z.number().positive(),
  description: z.string().min(1),
  participants: z.string().optional(),
});
export type AddExpenseParams = z.infer<typeof addExpenseParamsSchema>;

export function makeId(prefix: 'group' | 'expense'): string {
  return `${prefix}:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Local date as yyyy-mm-dd. */
export function todayIso(now: Date = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** Currency units → integer cents (the only rounding step in the tool). */
export function toCents(amount: number): number {
  return Math.round(amount * 100);
}

/** "Anna, Ben , anna" → ["Anna", "Ben"] (trimmed, case-insensitively deduped). */
export function splitList(input?: string): string[] {
  if (!input) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(',')) {
    const name = raw.trim();
    const key = name.toLowerCase();
    if (name && !seen.has(key)) {
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/**
 * Sorts `names` by their position in `memberOrder`; unknown names go last
 * (alphabetically). This is THE deterministic order used for remainder cents.
 */
export function orderByMembers(names: string[], memberOrder: string[]): string[] {
  const index = new Map(memberOrder.map((member, i) => [member, i]));
  return [...names].sort((a, b) => {
    const ia = index.get(a);
    const ib = index.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return a.localeCompare(b);
  });
}

/**
 * Equal split of `amountCents` among `participants`: everyone pays the floor
 * share, the remaining cents go one-by-one to the FIRST participants in
 * member order. Σ shares === amountCents by construction.
 */
export function splitShares(
  amountCents: number,
  participants: string[],
  memberOrder: string[],
): Record<string, number> {
  const ordered = orderByMembers(participants, memberOrder);
  const n = ordered.length;
  if (n === 0) return {};
  const base = Math.floor(amountCents / n);
  let remainder = amountCents - base * n;
  const shares: Record<string, number> = {};
  for (const name of ordered) {
    shares[name] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return shares;
}

/**
 * Per-member balance in cents: paid − own share, summed over all expenses.
 * Positive ⇒ the member is owed money, negative ⇒ the member owes.
 * Σ over all names is ALWAYS exactly 0 (shares sum to the paid amount).
 */
export function balances(expenses: ExpenseDoc[], members: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const member of members) result[member] = 0;
  for (const expense of expenses) {
    const cents = toCents(expense.amount);
    const participants = expense.participants.length > 0 ? expense.participants : members;
    result[expense.payer] = (result[expense.payer] ?? 0) + cents;
    const shares = splitShares(cents, participants, members);
    for (const [name, share] of Object.entries(shares)) {
      result[name] = (result[name] ?? 0) - share;
    }
  }
  return result;
}

export type Transfer = { from: string; to: string; amountCents: number };

/**
 * Greedy settlement: the biggest debtor pays the biggest creditor the
 * smaller of the two open amounts, repeat. For balanced inputs (Σ = 0) the
 * transfers clear every balance; ties break by name so the plan is stable.
 */
export function settleUp(balanceCents: Record<string, number>): Transfer[] {
  const creditors: Array<{ name: string; cents: number }> = [];
  const debtors: Array<{ name: string; cents: number }> = [];
  for (const [name, cents] of Object.entries(balanceCents)) {
    if (cents > 0) creditors.push({ name, cents });
    else if (cents < 0) debtors.push({ name, cents: -cents });
  }
  const biggestFirst = (a: { name: string; cents: number }, b: { name: string; cents: number }) =>
    b.cents - a.cents || a.name.localeCompare(b.name);
  const transfers: Transfer[] = [];
  let guard = creditors.length + debtors.length + 1;
  while (creditors.length > 0 && debtors.length > 0 && guard > 0) {
    guard -= 1;
    creditors.sort(biggestFirst);
    debtors.sort(biggestFirst);
    const creditor = creditors[0];
    const debtor = debtors[0];
    if (!creditor || !debtor) break;
    const amount = Math.min(creditor.cents, debtor.cents);
    transfers.push({ from: debtor.name, to: creditor.name, amountCents: amount });
    creditor.cents -= amount;
    debtor.cents -= amount;
    if (creditor.cents === 0) creditors.shift();
    if (debtor.cents === 0) debtors.shift();
  }
  return transfers;
}

/** Balances AFTER executing the transfers (a payment moves the payer toward 0). */
export function applyTransfers(
  balanceCents: Record<string, number>,
  transfers: Transfer[],
): Record<string, number> {
  const next = { ...balanceCents };
  for (const transfer of transfers) {
    next[transfer.from] = (next[transfer.from] ?? 0) + transfer.amountCents;
    next[transfer.to] = (next[transfer.to] ?? 0) - transfer.amountCents;
  }
  return next;
}

/** "12,34 €" / "12.34 €" – number formatting follows the UI language. */
export function formatCents(cents: number, language: string, currency = '€'): string {
  const num = new Intl.NumberFormat(language, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
  return currency ? `${num} ${currency}` : num;
}

/**
 * Compact snapshot for the assistant's "current state" context: per group
 * the member/expense counts plus who is owed and who owes what.
 */
export function buildExpensesContext(
  groups: GroupDoc[],
  expenses: ExpenseDoc[],
  language: string,
  currency = '€',
): string {
  const de = language === 'de';
  if (groups.length === 0) return de ? 'Keine Gruppen angelegt.' : 'No groups yet.';
  const lines = groups.map((group) => {
    const groupExpenses = expenses.filter((expense) => expense.groupId === group.id);
    const totalCents = groupExpenses.reduce((acc, expense) => acc + toCents(expense.amount), 0);
    const head = de
      ? `«${group.name}» (${group.members.length} Mitglieder, ${groupExpenses.length} Ausgaben, ${formatCents(totalCents, language, currency)} gesamt)`
      : `«${group.name}» (${group.members.length} members, ${groupExpenses.length} expenses, ${formatCents(totalCents, language, currency)} total)`;
    const balance = balances(groupExpenses, group.members);
    const open = Object.entries(balance)
      .filter(([, cents]) => cents !== 0)
      .sort((a, b) => b[1] - a[1])
      .map(([name, cents]) =>
        cents > 0
          ? de
            ? `${name} bekommt ${formatCents(cents, language, currency)}`
            : `${name} is owed ${formatCents(cents, language, currency)}`
          : de
            ? `${name} schuldet ${formatCents(-cents, language, currency)}`
            : `${name} owes ${formatCents(-cents, language, currency)}`,
      );
    const tail =
      open.length === 0 ? (de ? 'alles ausgeglichen' : 'all settled') : open.join(', ');
    return `${head}: ${tail}.`;
  });
  return lines.join(' ');
}
