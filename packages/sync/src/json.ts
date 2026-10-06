/**
 * serde_json compatibility helpers: key-order-insensitive equality,
 * byte-identical compact serialization (keys sorted by UTF-8 byte order –
 * serde_json without `preserve_order` stores objects in a BTreeMap), and the
 * storage.rs input validators.
 */
import { compareUtf8, utf8Length } from './bytes';
import { ValidationError } from './types';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** JSON round trip: drops undefined/functions, applies toJSON, NaN → null. */
export function normalizeDoc<T = JsonValue>(value: unknown): T {
  const text = JSON.stringify(value);
  return (text === undefined ? null : JSON.parse(text)) as T;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** serde_json `Value == Value` (object key order never matters). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isPlainObject(a)) {
    if (!isPlainObject(b)) return false;
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

export function sortedKeys(obj: Record<string, unknown>): string[] {
  return Object.keys(obj).sort(compareUtf8);
}

/**
 * Formats a number the way serde_json prints the value it would have parsed:
 * integers (within i64/u64) plainly, floats with the shortest round-trip
 * digits in serde's layout ("1e+21", "1.5e-7", "0.00001", "12.5", "-0.0").
 * Verified against real serde_json output in fixtures/rust-v1.
 */
export function formatJsonNumber(n: number): string {
  if (!Number.isFinite(n)) return 'null';
  // serde parses integer literals within i64/u64 as integers and prints them
  // plainly; String() gives the same digits (JS wrote them that way).
  if (Number.isInteger(n) && n >= -(2 ** 63) && n < 2 ** 64) {
    return Object.is(n, -0) ? '-0.0' : String(n);
  }
  const sign = n < 0 ? '-' : '';
  const [mantissa = '0', expText = '0'] = Math.abs(n).toExponential().split('e');
  const digits = mantissa.replace('.', '');
  const length = digits.length;
  const kk = Number(expText) + 1; // 10^(kk-1) <= v < 10^kk
  const k = kk - length;
  let out: string;
  if (k >= 0 && kk <= 16) {
    out = `${digits}${'0'.repeat(k)}.0`;
  } else if (kk > 0 && kk <= 16) {
    out = `${digits.slice(0, kk)}.${digits.slice(kk)}`;
  } else if (kk > -5 && kk <= 0) {
    out = `0.${'0'.repeat(-kk)}${digits}`;
  } else {
    const exp = kk - 1;
    const mant = length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
    out = `${mant}e${exp > 0 ? '+' : ''}${exp}`;
  }
  return sign + out;
}

/** serde_json `Value::to_string()`: compact, keys in UTF-8 byte order. */
export function stableStringify(value: unknown): string {
  return write(value) ?? 'null';
}

function write(value: unknown): string | undefined {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return formatJsonNumber(value);
    case 'string':
      // JSON.stringify escapes exactly like serde_json for well-formed strings.
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      return undefined;
    case 'bigint':
      return value.toString();
    default:
      break;
  }
  const obj = value as { toJSON?: () => unknown };
  if (typeof obj.toJSON === 'function') return write(obj.toJSON());
  if (Array.isArray(value)) return `[${value.map((v) => write(v) ?? 'null').join(',')}]`;
  const rec = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of sortedKeys(rec)) {
    const v = write(rec[key]);
    if (v !== undefined) parts.push(`${JSON.stringify(key)}:${v}`);
  }
  return `{${parts.join(',')}}`;
}

/* ── storage.rs validators ────────────────────────────────────────────── */

const NAMESPACE_PART = /^[a-z][a-z0-9-]*$/;
const FIELD_RE = /^[A-Za-z0-9_-]+$/;

export function isValidNamespace(ns: string): boolean {
  if (ns.length === 0 || utf8Length(ns) > 64) return false;
  const parts = ns.split('.');
  return parts.length <= 2 && parts.every((p) => NAMESPACE_PART.test(p));
}

/** Rust `char::is_control` = general category Cc: U+0000–U+001F, U+007F–U+009F. */
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

export function isValidId(id: string): boolean {
  return id.length > 0 && utf8Length(id) <= 128 && !hasControl(id);
}

export function isValidField(field: string): boolean {
  return field.length > 0 && field.length <= 64 && FIELD_RE.test(field);
}

export function validateNamespace(ns: string): void {
  if (!isValidNamespace(ns)) throw new ValidationError('namespace', ns, `invalid namespace: ${ns}`);
}

export function validateId(id: string): void {
  if (!isValidId(id)) throw new ValidationError('id', id, `invalid id: ${id}`);
}

export function validateField(field: string): void {
  if (!isValidField(field)) throw new ValidationError('field', field, `invalid field: ${field}`);
}
