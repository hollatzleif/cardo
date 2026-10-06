/**
 * Local pull cursor for the web Drive transport. A plain "last file name"
 * cursor skips files forever when another device's clock is behind or its
 * upload lands after a newer file was already read (names start with the
 * uploader's clock). So we also look back a window before the last name and
 * read anything in it we have not seen yet. Local state only – the hub format
 * is unchanged.
 */

export const LOOKBACK_MS = 10 * 60_000;

export interface LookbackCursor {
  last: string;
  seen: string[];
}

export function msOfName(name: string): number {
  const ms = Number(name.slice(0, 13));
  return Number.isFinite(ms) ? ms : 0;
}

export function parseCursor(raw: string): LookbackCursor {
  if (raw.startsWith('{')) {
    try {
      const v = JSON.parse(raw) as Partial<LookbackCursor>;
      return {
        last: typeof v.last === 'string' ? v.last : '',
        seen: Array.isArray(v.seen) ? v.seen.filter((s) => typeof s === 'string') : [],
      };
    } catch {
      return { last: '', seen: [] };
    }
  }
  // Legacy / desktop-style cursor: just the last name.
  return { last: raw, seen: [] };
}

export function renderCursor(c: LookbackCursor): string {
  return JSON.stringify({ last: c.last, seen: [...c.seen].sort() });
}

/** Names to read next, in name order, at most `take`. */
export function selectNames(
  names: readonly string[],
  cursor: LookbackCursor,
  take: number,
): string[] {
  const seen = new Set(cursor.seen);
  const floor = cursor.last ? msOfName(cursor.last) - LOOKBACK_MS : -Infinity;
  return [...names]
    .filter((n) => n > cursor.last || (msOfName(n) >= floor && !seen.has(n)))
    .filter((n) => !seen.has(n))
    .sort()
    .slice(0, take);
}

/** Cursor after processing `processed` (all of them read, in any order). */
export function advance(cursor: LookbackCursor, processed: readonly string[]): LookbackCursor {
  if (processed.length === 0) return cursor;
  const last = [cursor.last, ...processed].sort().at(-1) ?? cursor.last;
  const floor = msOfName(last) - LOOKBACK_MS;
  const seen = [...new Set([...cursor.seen, ...processed])].filter((n) => msOfName(n) >= floor);
  return { last, seen };
}
