import { describe, expect, it } from 'vitest';
import {
  addExpenseParamsSchema,
  applyTransfers,
  balances,
  buildExpensesContext,
  formatCents,
  makeId,
  orderByMembers,
  settleUp,
  splitList,
  splitShares,
  toCents,
  todayIso,
  type ExpenseDoc,
  type GroupDoc,
} from './logic';

function expense(partial: Partial<ExpenseDoc>): ExpenseDoc {
  return {
    id: 'expense:test',
    type: 'expense',
    groupId: 'group:test',
    payer: 'Anna',
    amount: 10,
    description: 'Test',
    participants: [],
    date: '2026-07-15',
    ...partial,
  };
}

function group(partial: Partial<GroupDoc>): GroupDoc {
  return {
    id: 'group:test',
    type: 'group',
    name: 'WG',
    members: ['Anna', 'Ben', 'Cleo'],
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  };
}

const sum = (record: Record<string, number>) =>
  Object.values(record).reduce((acc, v) => acc + v, 0);

/** Tiny deterministic PRNG for the property-style fixtures below. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('helpers', () => {
  it('toCents rounds to integer cents', () => {
    expect(toCents(10)).toBe(1000);
    expect(toCents(0.1)).toBe(10);
    expect(toCents(19.99)).toBe(1999);
    // Classic float trap: 4.35 * 100 = 434.99999…
    expect(toCents(4.35)).toBe(435);
  });

  it('splitList trims, drops empties and dedupes case-insensitively', () => {
    expect(splitList(' Anna, Ben ,, anna , Cleo')).toEqual(['Anna', 'Ben', 'Cleo']);
    expect(splitList(undefined)).toEqual([]);
    expect(splitList('  ,  ')).toEqual([]);
  });

  it('orderByMembers follows the member order, unknowns last alphabetically', () => {
    expect(orderByMembers(['Cleo', 'Anna', 'Zoe', 'Ben'], ['Anna', 'Ben', 'Cleo'])).toEqual([
      'Anna',
      'Ben',
      'Cleo',
      'Zoe',
    ]);
  });

  it('makeId and todayIso produce well-formed values', () => {
    expect(makeId('group').startsWith('group:')).toBe(true);
    expect(makeId('expense').startsWith('expense:')).toBe(true);
    expect(todayIso(new Date(2026, 6, 5, 23, 30))).toBe('2026-07-05');
  });
});

describe('splitShares', () => {
  const members = ['Anna', 'Ben', 'Cleo'];

  it('splits 10.00 / 3 cent-exactly with the remainder cent by member order', () => {
    const shares = splitShares(1000, members, members);
    expect(shares).toEqual({ Anna: 334, Ben: 333, Cleo: 333 });
    expect(sum(shares)).toBe(1000);
  });

  it('distributes several remainder cents deterministically', () => {
    const shares = splitShares(1001, members, members);
    expect(shares).toEqual({ Anna: 334, Ben: 334, Cleo: 333 });
  });

  it('remainder order is member order, not the participants order', () => {
    const shares = splitShares(1000, ['Cleo', 'Anna', 'Ben'], members);
    expect(shares).toEqual({ Anna: 334, Ben: 333, Cleo: 333 });
  });

  it('handles a single participant and empty input', () => {
    expect(splitShares(999, ['Anna'], members)).toEqual({ Anna: 999 });
    expect(splitShares(1000, [], members)).toEqual({});
  });
});

describe('balances', () => {
  const members = ['Anna', 'Ben', 'Cleo'];

  it('is zero everywhere without expenses', () => {
    expect(balances([], members)).toEqual({ Anna: 0, Ben: 0, Cleo: 0 });
  });

  it('computes paid − share with an uneven split (10.00 / 3)', () => {
    const result = balances([expense({ payer: 'Anna', amount: 10 })], members);
    expect(result).toEqual({ Anna: 1000 - 334, Ben: -333, Cleo: -333 });
    expect(sum(result)).toBe(0);
  });

  it('empty participants means "all members"', () => {
    const all = balances([expense({ payer: 'Ben', amount: 9, participants: [] })], members);
    expect(all).toEqual({ Anna: -300, Ben: 600, Cleo: -300 });
  });

  it('respects a participant subset (payer not included)', () => {
    const result = balances(
      [expense({ payer: 'Anna', amount: 8, participants: ['Ben', 'Cleo'] })],
      members,
    );
    expect(result).toEqual({ Anna: 800, Ben: -400, Cleo: -400 });
    expect(sum(result)).toBe(0);
  });

  it('a single member paying for themself stays at zero', () => {
    const result = balances(
      [expense({ payer: 'Solo', amount: 12.34, participants: ['Solo'] })],
      ['Solo'],
    );
    expect(result).toEqual({ Solo: 0 });
  });

  it('Σ balances ≡ 0 across pseudo-random expense sets', () => {
    const rand = mulberry32(42);
    const names = ['Anna', 'Ben', 'Cleo', 'Dana', 'Emil'];
    for (let run = 0; run < 20; run++) {
      const expenses: ExpenseDoc[] = [];
      const count = 1 + Math.floor(rand() * 10);
      for (let i = 0; i < count; i++) {
        const payer = names[Math.floor(rand() * names.length)] ?? 'Anna';
        const participants = names.filter(() => rand() > 0.4);
        expenses.push(
          expense({
            payer,
            amount: Math.round(rand() * 10000) / 100,
            participants,
          }),
        );
      }
      const result = balances(expenses, names);
      expect(sum(result)).toBe(0);
    }
  });
});

describe('settleUp', () => {
  it('returns nothing when everyone is settled', () => {
    expect(settleUp({ Anna: 0, Ben: 0 })).toEqual([]);
    expect(settleUp({})).toEqual([]);
  });

  it('one debtor, one creditor → exactly one transfer', () => {
    expect(settleUp({ Anna: 500, Ben: -500 })).toEqual([
      { from: 'Ben', to: 'Anna', amountCents: 500 },
    ]);
  });

  it('biggest debtor pays biggest creditor first', () => {
    const transfers = settleUp({ Anna: 700, Ben: 300, Cleo: -900, Dana: -100 });
    expect(transfers[0]).toEqual({ from: 'Cleo', to: 'Anna', amountCents: 700 });
    expect(transfers).toHaveLength(3);
    expect(applyTransfers({ Anna: 700, Ben: 300, Cleo: -900, Dana: -100 }, transfers)).toEqual({
      Anna: 0,
      Ben: 0,
      Cleo: 0,
      Dana: 0,
    });
  });

  it('needs at most n−1 transfers for typical cases', () => {
    const transfers = settleUp({ Anna: 100, Ben: 200, Cleo: -150, Dana: -150 });
    expect(transfers.length).toBeLessThanOrEqual(3);
  });

  it('clears every balance for pseudo-random balanced inputs', () => {
    const rand = mulberry32(7);
    const names = ['Anna', 'Ben', 'Cleo', 'Dana', 'Emil', 'Fritz'];
    for (let run = 0; run < 25; run++) {
      const balance: Record<string, number> = {};
      let total = 0;
      for (let i = 0; i < names.length - 1; i++) {
        const name = names[i];
        if (name === undefined) continue;
        const cents = Math.floor(rand() * 2000) - 1000;
        balance[name] = cents;
        total += cents;
      }
      const last = names[names.length - 1];
      if (last !== undefined) balance[last] = -total; // force Σ = 0
      const transfers = settleUp(balance);
      const after = applyTransfers(balance, transfers);
      for (const cents of Object.values(after)) expect(cents).toBe(0);
      // Never more transfers than participating people minus one.
      const active = Object.values(balance).filter((c) => c !== 0).length;
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, active === 0 ? 0 : active - 1) + 2);
      for (const transfer of transfers) expect(transfer.amountCents).toBeGreaterThan(0);
    }
  });
});

describe('formatCents', () => {
  it('formats per UI language', () => {
    expect(formatCents(123450, 'de', '€')).toBe('1.234,50 €');
    expect(formatCents(1999, 'en', '€')).toBe('19.99 €');
    expect(formatCents(50, 'en', '')).toBe('0.50');
  });
});

describe('buildExpensesContext', () => {
  const g = group({});

  it('reports the empty state in both languages', () => {
    expect(buildExpensesContext([], [], 'en')).toBe('No groups yet.');
    expect(buildExpensesContext([], [], 'de')).toBe('Keine Gruppen angelegt.');
  });

  it('summarizes counts, totals and open balances (en)', () => {
    const text = buildExpensesContext([g], [expense({ payer: 'Anna', amount: 9 })], 'en');
    expect(text).toContain('«WG» (3 members, 1 expenses, 9.00 € total)');
    expect(text).toContain('Anna is owed 6.00 €');
    expect(text).toContain('Ben owes 3.00 €');
  });

  it('speaks German and reports settled groups', () => {
    const settled = buildExpensesContext([g], [], 'de');
    expect(settled).toContain('«WG» (3 Mitglieder, 0 Ausgaben, 0,00 € gesamt): alles ausgeglichen.');
    const open = buildExpensesContext([g], [expense({ payer: 'Anna', amount: 9 })], 'de');
    expect(open).toContain('Anna bekommt 6,00 €');
    expect(open).toContain('Ben schuldet 3,00 €');
  });
});

describe('addExpenseParamsSchema', () => {
  const valid = { group: 'WG', payer: 'Anna', amount: 10, description: 'Pizza' };

  it('accepts valid params with and without participants', () => {
    expect(addExpenseParamsSchema.safeParse(valid).success).toBe(true);
    expect(
      addExpenseParamsSchema.safeParse({ ...valid, participants: 'Anna, Ben' }).success,
    ).toBe(true);
  });

  it('rejects empty fields and non-positive amounts', () => {
    expect(addExpenseParamsSchema.safeParse({ ...valid, group: '' }).success).toBe(false);
    expect(addExpenseParamsSchema.safeParse({ ...valid, payer: '' }).success).toBe(false);
    expect(addExpenseParamsSchema.safeParse({ ...valid, amount: 0 }).success).toBe(false);
    expect(addExpenseParamsSchema.safeParse({ ...valid, amount: -5 }).success).toBe(false);
    expect(addExpenseParamsSchema.safeParse({ ...valid, description: '' }).success).toBe(false);
  });
});
