/**
 * Pure, storage-free logic for the medication tool.
 * Kept separate from index.tsx so it can be unit-tested in a plain node
 * environment (no React, no DOM, no host).
 */

export type MedDoc = {
  /** Stable id, identical to the storage doc id ("med:<random>"). */
  id: string;
  type: 'med';
  name: string;
  /** Free-text dose, e.g. "400 mg" or "1 Tablette". */
  dose: string;
  /** Intake times "HH:MM" (local), sorted ascending. */
  times: string[];
  /** Scheduler handles of pending reminders, if armed. */
  scheduleIds?: string[];
  createdAt: string;
};

export type IntakeDoc = {
  /** Storage doc id: "intake:<yyyy-mm-dd>". */
  id: string;
  type: 'intake';
  /** yyyy-mm-dd (local). */
  date: string;
  /** "<medId>@<HH:MM>" → true once taken. */
  taken: Record<string, boolean>;
};

export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

/**
 * Parses a comma-separated "HH:MM, HH:MM" string into a sorted, deduped
 * list. Returns null when ANY entry is invalid (better a clear error than
 * silently dropping a dose time).
 */
export function parseTimes(text: string): string[] | null {
  const parts = text
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => !isValidTime(p))) return null;
  return [...new Set(parts)].sort();
}

/** Local date as yyyy-mm-dd (DST-safe – built from local components). */
export function localDateKey(now: Date): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

export function intakeKey(date: string): string {
  return `intake:${date}`;
}

/** Identity of one dose inside an intake doc. */
export function doseKey(medId: string, time: string): string {
  return `${medId}@${time}`;
}

export function isDoseTaken(
  intake: Pick<IntakeDoc, 'taken'> | null | undefined,
  medId: string,
  time: string,
): boolean {
  return intake?.taken[doseKey(medId, time)] === true;
}

/**
 * The next wall-clock occurrence of ANY time in `times`: the earliest
 * time still ahead today, otherwise the earliest time tomorrow.
 * Constructed via LOCAL Date components, so DST transitions cannot shift
 * the intended wall-clock time. Empty `times` → null.
 */
export function nextOccurrence(times: string[], now: Date): Date | null {
  const valid = times.filter(isValidTime).sort();
  if (valid.length === 0) return null;
  const at = (dayOffset: number, time: string): Date => {
    const h = Number(time.slice(0, 2));
    const min = Number(time.slice(3, 5));
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, h, min, 0, 0);
  };
  for (const time of valid) {
    const candidate = at(0, time);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  const first = valid[0];
  return first !== undefined ? at(1, first) : null;
}

/**
 * Adherence over the last `days` days ending at `today` (inclusive):
 * taken doses ÷ expected doses, in percent (rounded). A med only counts
 * from its (local) creation day on; days without any expected dose are
 * excluded entirely. Returns null when nothing was expected at all.
 */
export function adherence(
  intakes: IntakeDoc[],
  meds: Array<Pick<MedDoc, 'id' | 'times' | 'createdAt'>>,
  days: number,
  today: string,
): number | null {
  const byDate = new Map(intakes.map((i) => [i.date, i]));
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const d = Number(today.slice(8, 10));
  let expected = 0;
  let taken = 0;
  for (let offset = 0; offset < days; offset += 1) {
    const date = localDateKey(new Date(y, m - 1, d - offset, 12, 0, 0));
    const intake = byDate.get(date);
    for (const med of meds) {
      const created = new Date(med.createdAt);
      if (Number.isNaN(created.getTime()) || localDateKey(created) > date) continue;
      for (const time of med.times) {
        expected += 1;
        if (isDoseTaken(intake, med.id, time)) taken += 1;
      }
    }
  }
  if (expected === 0) return null;
  return Math.round((taken / expected) * 100);
}

const CONTEXT_LABEL = {
  en: {
    none: 'No medications set up.',
    allDone: (n: number) => `All ${n} doses for today are taken.`,
    open: (list: string, done: number, total: number) =>
      `Doses still open today (${done}/${total} taken): ${list}.`,
  },
  de: {
    none: 'Keine Medikamente angelegt.',
    allDone: (n: number) => `Alle ${n} Dosen für heute sind genommen.`,
    open: (list: string, done: number, total: number) =>
      `Heute noch offen (${done}/${total} genommen): ${list}.`,
  },
} as const;

/**
 * Compact snapshot for the assistant's "current state" context: today's
 * remaining doses with med name, dose and time. All data stays local –
 * the context only ever reaches the user's own assistant.
 */
export function buildMedicationContext(
  meds: MedDoc[],
  todayIntake: Pick<IntakeDoc, 'taken'> | null,
  language: string,
): string {
  const l = CONTEXT_LABEL[language === 'de' ? 'de' : 'en'];
  const all: Array<{ med: MedDoc; time: string; taken: boolean }> = [];
  for (const med of meds) {
    for (const time of med.times) {
      all.push({ med, time, taken: isDoseTaken(todayIntake, med.id, time) });
    }
  }
  if (all.length === 0) return l.none;
  const open = all.filter((dose) => !dose.taken);
  if (open.length === 0) return l.allDone(all.length);
  const list = open
    .sort((a, b) => a.time.localeCompare(b.time))
    .map((dose) => `${dose.time} ${dose.med.name} (${dose.med.dose})`)
    .join(', ');
  return l.open(list, all.length - open.length, all.length);
}
