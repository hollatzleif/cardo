/**
 * Pure, storage-free logic for the meal-planner tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type Slot = 'breakfast' | 'lunch' | 'dinner' | 'snack';

/** The three fixed slots; "snack" is added via the widget setting. */
export const BASE_SLOTS: Slot[] = ['breakfast', 'lunch', 'dinner'];
export const ALL_SLOTS: Slot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

export type Ingredient = {
  name: string;
  qty?: number;
  unit?: string;
};

export type SlotDoc = {
  /** Stored inside the doc – identical to the storage doc id. */
  id: string;
  type: 'slot';
  /** yyyy-mm-dd (local). */
  date: string;
  slot: Slot;
  meal: string;
  ingredients: Ingredient[];
};

/** Checked state of the aggregated shopping list – a purely local doc. */
export type ShoppingStateDoc = {
  id: string;
  type: 'shopping-state';
  checked: Record<string, boolean>;
};

export const SHOPPING_STATE_ID = 'shopping-state';

/** Storage doc id of one meal slot. */
export function slotKey(date: string, slot: Slot): string {
  return `slot:${date}:${slot}`;
}

/** Local date as yyyy-mm-dd (DST-safe – built from local components). */
export function localDateKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

/** date + days in LOCAL time (noon anchor, so DST jumps cannot shift the day). */
export function addDaysLocal(date: string, days: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return localDateKey(new Date(y, m - 1, d + days, 12, 0, 0));
}

/**
 * The 7 dates (yyyy-mm-dd) of the week containing `startDate`.
 * `weekStartsMonday` picks Monday or Sunday as the first day.
 */
export function weekDates(startDate: Date, weekStartsMonday: boolean): string[] {
  const dow = startDate.getDay(); // 0 = Sunday … 6 = Saturday
  const offset = weekStartsMonday ? (dow + 6) % 7 : dow;
  const first = localDateKey(
    new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() - offset, 12, 0, 0),
  );
  const dates: string[] = [];
  for (let i = 0; i < 7; i += 1) dates.push(addDaysLocal(first, i));
  return dates;
}

/** Case-insensitive, whitespace-trimmed ingredient identity. */
export function normalizeName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export type AggregatedLine = {
  /** Display name – first-seen trimmed casing. */
  name: string;
  unit?: string;
  /** Sum of all quantities with this (name, unit); undefined if none had a qty. */
  qty?: number;
  /** Stable identity of this line: "<normalized name>|<unit>". */
  key: string;
};

/**
 * Merges the ingredients of many slots into one shopping list.
 * Identity is (normalized name, unit): quantities with the SAME unit are
 * summed, different units of the same ingredient stay separate lines
 * (1 l milk + 200 ml milk is NOT 201 of anything). Names dedupe
 * case-insensitively and trimmed ("Milch" and " milch " merge).
 */
export function aggregateIngredients(slots: Array<Pick<SlotDoc, 'ingredients'>>): AggregatedLine[] {
  const lines = new Map<string, AggregatedLine>();
  for (const slot of slots) {
    for (const ing of slot.ingredients) {
      const name = ing.name.trim();
      if (!name) continue;
      const unit = ing.unit?.trim() || undefined;
      const key = `${normalizeName(name)}|${unit ?? ''}`;
      const existing = lines.get(key);
      if (!existing) {
        const line: AggregatedLine = { name, key };
        if (unit !== undefined) line.unit = unit;
        if (ing.qty !== undefined) line.qty = ing.qty;
        lines.set(key, line);
      } else if (ing.qty !== undefined) {
        existing.qty = (existing.qty ?? 0) + ing.qty;
      }
    }
  }
  return [...lines.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || (a.unit ?? '').localeCompare(b.unit ?? ''),
  );
}

/**
 * Parses a comma/newline separated ingredient text like
 * "200 g Mehl, 2 Eier, Salz" into structured ingredients.
 * "<qty> <unit> <name>" and "<qty> <name>" are recognized; everything
 * else becomes a plain name.
 */
export function parseIngredients(text: string): Ingredient[] {
  return text
    // Commas separate ingredients – EXCEPT between two digits, where they
    // are a decimal comma ("1,5 l Milch").
    .split(/\n|,(?!(?<=\d,)\d)/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const match = /^(\d+(?:[.,]\d+)?)\s*([a-zA-ZäöüÄÖÜß]{0,6})\s+(.+)$/.exec(part);
      if (match && match[1] !== undefined && match[3] !== undefined) {
        const qty = Number(match[1].replace(',', '.'));
        const unit = match[2];
        const name = match[3].trim();
        if (Number.isFinite(qty) && name) {
          const ing: Ingredient = { name, qty };
          if (unit) ing.unit = unit;
          return ing;
        }
      }
      return { name: part };
    });
}

/** "200 g Mehl" / "2 Eier" / "Salz" – inverse of parseIngredients for editing. */
export function formatIngredient(ing: Ingredient): string {
  const qty = ing.qty !== undefined ? String(ing.qty).replace('.', ',') : '';
  return [qty, ing.unit ?? '', ing.name].filter((p) => p.length > 0).join(' ');
}

export function formatIngredients(ings: Ingredient[]): string {
  return ings.map(formatIngredient).join(', ');
}

const SLOT_LABEL: Record<'en' | 'de', Record<Slot, string>> = {
  en: { breakfast: 'breakfast', lunch: 'lunch', dinner: 'dinner', snack: 'snack' },
  de: { breakfast: 'Frühstück', lunch: 'Mittag', dinner: 'Abend', snack: 'Snack' },
};

/**
 * Compact snapshot for the assistant's "current state" context:
 * today's and tomorrow's planned meals.
 */
export function buildMealContext(slots: SlotDoc[], today: string, language: string): string {
  const de = language === 'de';
  const labels = SLOT_LABEL[de ? 'de' : 'en'];
  const tomorrow = addDaysLocal(today, 1);
  const describe = (date: string): string => {
    const planned = ALL_SLOTS.map((slot) =>
      slots.find((s) => s.date === date && s.slot === slot && s.meal.trim().length > 0),
    ).filter((s): s is SlotDoc => s !== undefined);
    if (planned.length === 0) return de ? 'nichts geplant' : 'nothing planned';
    return planned.map((s) => `${labels[s.slot]}: ${s.meal}`).join(', ');
  };
  return de
    ? `Heute (${today}): ${describe(today)}. Morgen (${tomorrow}): ${describe(tomorrow)}.`
    : `Today (${today}): ${describe(today)}. Tomorrow (${tomorrow}): ${describe(tomorrow)}.`;
}
