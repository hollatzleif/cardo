/**
 * In-memory reproduction of SqliteStorage::query (storage.rs): each filter is
 * `json_extract(data, '$.field') <op> ?` with SQLite's typing rules.
 *
 *  - json_extract yields NULL (missing / JSON null), INTEGER/REAL (numbers,
 *    true → 1, false → 0) or TEXT (strings; arrays/objects as JSON text).
 *  - Bound parameters: number → numeric, bool → 0/1, string → TEXT (except
 *    for `in`), anything else → its JSON text.
 *  - Comparisons with NULL never match (also for `!=`); numbers sort before
 *    text; text compares by bytes (BINARY collation).
 *  - `like` = `LIKE '%' || ? || '%'`: ASCII case-insensitive, `%`/`_` in the
 *    needle act as wildcards.
 *  - `in` = `IN (SELECT value FROM json_each(<value as JSON text>))`.
 *  - ORDER BY puts NULL first on asc; ties keep id order.
 */
import type { StorageQuery } from '@cardo/plugin-api';

import { compareUtf8 } from '../bytes';
import { isPlainObject, stableStringify, validateField } from '../json';

export type SqlValue = null | number | { text: string };

const OPS = new Set(['=', '!=', '<', '>', '<=', '>=', 'like', 'in']);

export function sqlFromJson(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return { text: value };
  return { text: stableStringify(value) };
}

function sqlParam(value: unknown, op: string): SqlValue {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && op !== 'in') return { text: value };
  return { text: stableStringify(value ?? null) };
}

/** SQLite cross-type ordering for non-NULL values. */
export function sqlCompare(a: number | { text: string }, b: number | { text: string }): number {
  if (typeof a === 'number') {
    if (typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
    return -1;
  }
  if (typeof b === 'number') return 1;
  return compareUtf8(a.text, b.text);
}

function sqlText(v: number | { text: string }): string {
  if (typeof v !== 'number') return v.text;
  return String(v);
}

const asciiLower = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** SQLite LIKE without ESCAPE: `%` any run, `_` one character, ASCII case folding. */
export function sqlLike(pattern: string, text: string): boolean {
  let re = '^';
  for (const ch of asciiLower(pattern)) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  return new RegExp(`${re}$`, 'u').test(asciiLower(text));
}

function jsonEachValues(paramText: string): SqlValue[] {
  const parsed: unknown = JSON.parse(paramText);
  if (Array.isArray(parsed)) return parsed.map(sqlFromJson);
  if (isPlainObject(parsed)) return Object.values(parsed).map(sqlFromJson);
  return [sqlFromJson(parsed)];
}

function extract(doc: unknown, field: string): SqlValue {
  return isPlainObject(doc) && Object.prototype.hasOwnProperty.call(doc, field)
    ? sqlFromJson(doc[field])
    : null;
}

/** Throws exactly where Rust's query() would refuse the input. */
export function validateQuery(q: StorageQuery): void {
  for (const f of q.where ?? []) {
    validateField(f.field);
    if (!OPS.has(f.op)) throw new Error(`unsupported query op: ${f.op}`);
  }
  if (q.orderBy !== undefined && q.orderBy !== null) validateField(q.orderBy);
}

/** `rows` must already be live docs of one namespace in id byte order. */
export function runQuery<T>(rows: readonly T[], q: StorageQuery, dataOf: (row: T) => unknown): T[] {
  validateQuery(q);
  let out = [...rows];
  for (const f of q.where ?? []) {
    const param = sqlParam(f.value, f.op);
    const list = f.op === 'in' ? jsonEachValues(stableStringify(f.value ?? null)) : [];
    out = out.filter((row) => {
      const left = extract(dataOf(row), f.field);
      if (left === null) return false;
      switch (f.op) {
        case 'like': {
          if (param === null) return false;
          return sqlLike(`%${sqlText(param)}%`, sqlText(left));
        }
        case 'in':
          return list.some((v) => v !== null && sqlCompare(left, v) === 0);
        default: {
          if (param === null) return false;
          const c = sqlCompare(left, param);
          switch (f.op) {
            case '=': return c === 0;
            case '!=': return c !== 0;
            case '<': return c < 0;
            case '>': return c > 0;
            case '<=': return c <= 0;
            default: return c >= 0;
          }
        }
      }
    });
  }
  if (q.orderBy) {
    const key = q.orderBy;
    const dir = q.direction === 'desc' ? -1 : 1;
    const keyed = out.map((row) => ({ row, k: extract(dataOf(row), key) }));
    keyed.sort((a, b) => {
      if (a.k === null || b.k === null) {
        if (a.k === b.k) return 0;
        return (a.k === null ? -1 : 1) * dir;
      }
      return sqlCompare(a.k, b.k) * dir;
    });
    out = keyed.map((x) => x.row);
  }
  if (q.limit !== undefined && q.limit !== null && q.limit >= 0) {
    out = out.slice(0, Math.trunc(q.limit));
  }
  return out;
}
