/**
 * SyncOp plaintext codec. Encoding is byte-identical to
 * `serde_json::to_vec(&SyncOp)` (struct field order, compact, value with
 * sorted keys); decoding accepts exactly what `serde_json::from_slice::<SyncOp>`
 * accepts, so the phone never applies an op the desktop counts as broken (or
 * vice versa). `JSON.parse` is too lenient for that (it turns `1.0` into an
 * integer, takes the last of duplicate fields and keeps lone surrogates), so
 * a small strict parser mirrors serde_json 1.0's rules:
 *
 *  - the op is a JSON object (or serde's sequence form: an array of exactly
 *    the nine fields in struct order);
 *  - a known field may appear only once ("duplicate field");
 *  - `created_at` is an i64 integer literal: no fraction, no exponent, not
 *    `-0` (serde reads all of those as floats) and within i64;
 *  - every string that serde decodes (keys, known fields, the value) has
 *    well-formed `\u` surrogate pairs; numbers in the value are finite;
 *    nesting is at most 127 levels deep (serde's recursion limit 128);
 *  - values of unknown fields are only checked for JSON syntax, exactly like
 *    serde's `IgnoredAny` (no surrogate, range or depth checks).
 *
 * The rules are pinned by Rust-verified vectors in
 * crates/cardo-core/tests/fixtures/sync-v1/wire-parse.json.
 */
import { utf8Decode, utf8Encode } from './bytes';
import { formatJsonNumber, setOwn, stableStringify, toWellFormed } from './json';
import type { SyncOp } from './types';

export function serializeSyncOp(op: SyncOp): string {
  // toWellFormed: serde cannot parse a lone-surrogate escape (see json.ts).
  const str = (s: string) => JSON.stringify(toWellFormed(s));
  return (
    `{"op_id":${str(op.op_id)},"device_id":${str(op.device_id)},"hlc":${str(op.hlc)},` +
    `"namespace":${str(op.namespace)},"doc_id":${str(op.doc_id)},"op":${str(op.op)},` +
    `"field":${op.field == null ? 'null' : str(op.field)},` +
    `"value":${op.value == null ? 'null' : stableStringify(op.value)},` +
    `"created_at":${formatJsonNumber(op.created_at)}}`
  );
}

export function encodeSyncOp(op: SyncOp): Uint8Array {
  return utf8Encode(serializeSyncOp(op));
}

export class SyncOpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncOpParseError';
  }
}

const FIELDS = ['op_id', 'device_id', 'hlc', 'namespace', 'doc_id', 'op', 'field', 'value', 'created_at'] as const;
type FieldName = (typeof FIELDS)[number];
const FIELD_SET: ReadonlySet<string> = new Set(FIELDS);

/** serde_json's `remaining_depth` starts at 128 and fails when it hits 0. */
const MAX_DEPTH = 127;
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

/** A parsed token: the JS value plus, for numbers, the raw lexeme. */
interface Parsed {
  value: unknown;
  lexeme?: string;
}

class StrictParser {
  pos = 0;
  constructor(private readonly text: string) {}

  fail(msg: string): never {
    throw new SyncOpParseError(`${msg} at offset ${this.pos}`);
  }

  ws(): void {
    for (;;) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else return;
    }
  }

  peek(): string {
    return this.text[this.pos] ?? '';
  }

  expect(ch: string): void {
    if (this.text[this.pos] !== ch) this.fail(`expected '${ch}'`);
    this.pos++;
  }

  literal(word: string): void {
    if (!this.text.startsWith(word, this.pos)) this.fail('invalid literal');
    this.pos += word.length;
  }

  hex4(): number {
    const h = this.text.slice(this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) this.fail('invalid \\u escape');
    this.pos += 4;
    return Number.parseInt(h, 16);
  }

  /** `validate`: serde's string decoding (lone surrogates are an error). */
  string(validate: boolean): string {
    this.expect('"');
    let out = '';
    let start = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) this.fail('EOF while parsing a string');
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x22) {
        out += this.text.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail('control character in string');
      if (c !== 0x5c) {
        this.pos++;
        continue;
      }
      out += this.text.slice(start, this.pos);
      this.pos++;
      const e = this.text[this.pos++];
      switch (e) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          const unit = this.hex4();
          if (unit >= 0xd800 && unit <= 0xdbff) {
            // A high surrogate must be followed by an escaped low surrogate.
            if (this.text.startsWith('\\u', this.pos)) {
              const save = this.pos;
              this.pos += 2;
              const low = this.hex4();
              if (low >= 0xdc00 && low <= 0xdfff) {
                out += String.fromCharCode(unit, low);
                break;
              }
              if (validate) this.fail('lone leading surrogate in hex escape');
              this.pos = save;
            } else if (validate) {
              this.fail('unexpected end of hex escape');
            }
            out += String.fromCharCode(unit);
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            if (validate) this.fail('lone trailing surrogate in hex escape');
            out += String.fromCharCode(unit);
          } else {
            out += String.fromCharCode(unit);
          }
          break;
        }
        default:
          this.fail('invalid escape');
      }
      start = this.pos;
    }
  }

  numberLexeme(): string {
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.text);
    if (!m) this.fail('invalid number');
    this.pos += m[0].length;
    return m[0];
  }

  /**
   * One JSON value. `strict` = serde decodes it (validated strings, finite
   * numbers, depth limit); otherwise it is an ignored unknown field.
   */
  value(depth: number, strict: boolean): Parsed {
    this.ws();
    const c = this.peek();
    switch (c) {
      case 'n': this.literal('null'); return { value: null };
      case 't': this.literal('true'); return { value: true };
      case 'f': this.literal('false'); return { value: false };
      case '"': return { value: this.string(strict) };
      case '[': {
        if (strict && depth + 1 > MAX_DEPTH) this.fail('recursion limit exceeded');
        this.pos++;
        const out: unknown[] = [];
        this.ws();
        if (this.peek() === ']') {
          this.pos++;
          return { value: out };
        }
        for (;;) {
          out.push(this.value(depth + 1, strict).value);
          this.ws();
          if (this.peek() === ',') {
            this.pos++;
            continue;
          }
          this.expect(']');
          return { value: out };
        }
      }
      case '{': {
        if (strict && depth + 1 > MAX_DEPTH) this.fail('recursion limit exceeded');
        this.pos++;
        const out: Record<string, unknown> = {};
        this.ws();
        if (this.peek() === '}') {
          this.pos++;
          return { value: out };
        }
        for (;;) {
          this.ws();
          const key = this.string(strict);
          this.ws();
          this.expect(':');
          // serde_json Map: a repeated key overwrites (like JSON.parse).
          setOwn(out, key, this.value(depth + 1, strict).value);
          this.ws();
          if (this.peek() === ',') {
            this.pos++;
            continue;
          }
          this.expect('}');
          return { value: out };
        }
      }
      default: {
        if (c !== '-' && !(c >= '0' && c <= '9')) this.fail('expected value');
        const lexeme = this.numberLexeme();
        const n = Number(lexeme);
        if (strict && !Number.isFinite(n)) this.fail('number out of range');
        return { value: n, lexeme };
      }
    }
  }

  end(): void {
    this.ws();
    if (this.pos !== this.text.length) this.fail('trailing characters');
  }
}

function createdAtOf(p: Parsed): number {
  const lex = p.lexeme;
  if (lex === undefined) throw new SyncOpParseError('op.created_at must be an integer');
  // serde_json reads fractions, exponents and `-0` as floats → i64 refuses.
  if (/[.eE]/.test(lex) || lex === '-0') throw new SyncOpParseError('op.created_at must be an integer');
  const big = BigInt(lex);
  if (big < I64_MIN || big > I64_MAX) throw new SyncOpParseError('op.created_at out of i64 range');
  return Number(big);
}

function build(fields: Partial<Record<FieldName, Parsed>>): SyncOp {
  const str = (key: FieldName): string => {
    const p = fields[key];
    if (p === undefined) throw new SyncOpParseError(`missing field ${key}`);
    if (typeof p.value !== 'string') throw new SyncOpParseError(`op.${key} must be a string`);
    return p.value;
  };
  const field = fields.field?.value ?? null;
  if (field !== null && typeof field !== 'string') {
    throw new SyncOpParseError('op.field must be a string or null');
  }
  const createdAt = fields.created_at;
  if (createdAt === undefined) throw new SyncOpParseError('missing field created_at');
  return {
    op_id: str('op_id'),
    device_id: str('device_id'),
    hlc: str('hlc'),
    namespace: str('namespace'),
    doc_id: str('doc_id'),
    op: str('op'),
    field,
    value: fields.value?.value ?? null,
    created_at: createdAtOf(createdAt),
  };
}

/** Throws `SyncOpParseError` exactly where serde would fail to deserialize. */
export function parseSyncOp(text: string): SyncOp {
  const p = new StrictParser(text);
  const fields: Partial<Record<FieldName, Parsed>> = {};
  p.ws();
  const open = p.peek();
  if (open === '{') {
    p.pos++;
    p.ws();
    if (p.peek() === '}') p.pos++;
    else {
      for (;;) {
        p.ws();
        const key = p.string(true);
        p.ws();
        p.expect(':');
        if (FIELD_SET.has(key)) {
          const name = key as FieldName;
          if (fields[name] !== undefined) throw new SyncOpParseError(`duplicate field ${key}`);
          fields[name] = p.value(1, true);
        } else {
          p.value(1, false); // unknown field: ignored like serde's IgnoredAny
        }
        p.ws();
        if (p.peek() === ',') {
          p.pos++;
          continue;
        }
        p.expect('}');
        break;
      }
    }
  } else if (open === '[') {
    // serde's derived Deserialize also accepts the struct as a sequence.
    p.pos++;
    for (let i = 0; i < FIELDS.length; i++) {
      p.ws();
      if (i > 0) p.expect(',');
      p.ws();
      if (p.peek() === ']') throw new SyncOpParseError('invalid length');
      fields[FIELDS[i]!] = p.value(1, true);
    }
    p.ws();
    p.expect(']');
  } else {
    throw new SyncOpParseError('op is not an object');
  }
  p.end();
  return build(fields);
}

export function decodeSyncOp(bytes: Uint8Array): SyncOp {
  let text: string;
  try {
    text = utf8Decode(bytes);
  } catch {
    throw new SyncOpParseError('op is not valid UTF-8');
  }
  return parseSyncOp(text);
}
