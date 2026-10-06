/**
 * Look-back pull cursor for filename-ordered hubs – port of
 * crates/cardo-core/src/sync_cursor.rs (same stored form, same rules).
 *
 * Batch files are named `<uploader_ms:013>-<uuid>.cardo-ops`. A plain "last
 * name" cursor loses files whose name sorts below it (uploader clock behind,
 * slow upload). The cursor therefore keeps `last` plus the names already read
 * inside a window of `LOOKBACK_MS`; a name is due when it sorts after `last`,
 * or lies inside the window and was not read yet.
 *
 * The window ends at `min(ms(last), readerNow)`: `last` carries the
 * UPLOADER's clock, and one file from a device whose clock runs ahead must
 * not push the window past every correctly named file that follows.
 *
 * Stored form: "" (empty), a legacy plain filename (migrated), or compact
 * JSON `{"last":"…","seen":[…]}` with `seen` in byte order – identical to
 * Rust's `render()`.
 */
import { compareUtf8 } from './bytes';
import { isPlainObject } from './json';

export const LOOKBACK_MS = 24 * 60 * 60 * 1000;

export interface LookbackCursor {
  last: string;
  /** Names read inside the window (byte order, no duplicates). */
  seen: string[];
}

/** Millisecond prefix of a batch file name, or null. */
export function nameMs(name: string): number | null {
  const prefix = name.split('-')[0] ?? '';
  if (prefix === '' || !/^[0-9]+$/.test(prefix)) return null;
  const ms = Number(prefix);
  return Number.isSafeInteger(ms) ? ms : null;
}

export function parseCursor(raw: string): LookbackCursor {
  const text = raw.trim();
  if (text === '') return { last: '', seen: [] };
  if (text.startsWith('{')) {
    try {
      const v: unknown = JSON.parse(text);
      if (isPlainObject(v) && typeof v.last === 'string') {
        const seen = Array.isArray(v.seen) ? v.seen.filter((s): s is string => typeof s === 'string') : [];
        return { last: v.last, seen: [...new Set(seen)].sort(compareUtf8) };
      }
    } catch {
      // fall through: unparsable → full re-pull, never an error
    }
    return { last: '', seen: [] };
  }
  return { last: text, seen: [] };
}

export function renderCursor(c: LookbackCursor): string {
  if (c.last === '' && c.seen.length === 0) return '';
  const seen = [...new Set(c.seen)].sort(compareUtf8);
  return `{"last":${JSON.stringify(c.last)},"seen":[${seen.map((s) => JSON.stringify(s)).join(',')}]}`;
}

function windowFloor(c: LookbackCursor, nowMs: number): number | null {
  const ms = nameMs(c.last);
  return ms === null ? null : Math.max(0, Math.min(ms, nowMs) - LOOKBACK_MS);
}

export function isDue(c: LookbackCursor, name: string, nowMs: number, seen?: ReadonlySet<string>): boolean {
  if (compareUtf8(name, c.last) > 0) return true;
  if (name === c.last || (seen ?? new Set(c.seen)).has(name)) return false;
  const floor = windowFloor(c, nowMs);
  const ms = nameMs(name);
  return floor !== null && ms !== null && ms >= floor;
}

/** Due names of an ascending-sorted list, oldest first, at most `take`. */
export function selectDue(c: LookbackCursor, namesSorted: readonly string[], take: number, nowMs: number): string[] {
  const seen = new Set(c.seen);
  const out: string[] = [];
  for (const name of namesSorted) {
    if (out.length >= take) break;
    if (isDue(c, name, nowMs, seen)) out.push(name);
  }
  return out;
}

/** Cursor after reading `processed` (pass the `nowMs` used for selecting). */
export function advanceCursor(c: LookbackCursor, processed: readonly string[], nowMs: number): LookbackCursor {
  const seen = new Set(c.seen);
  let last = c.last;
  if (last !== '') seen.add(last);
  for (const name of processed) {
    if (compareUtf8(name, last) > 0) last = name;
    seen.add(name);
  }
  const next: LookbackCursor = { last, seen: [] };
  const floor = windowFloor(next, nowMs);
  next.seen =
    floor === null
      ? []
      : [...seen].filter((n) => {
          const ms = nameMs(n);
          return ms !== null && ms >= floor;
        }).sort(compareUtf8);
  return next;
}
