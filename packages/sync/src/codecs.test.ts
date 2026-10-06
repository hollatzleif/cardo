import { describe, expect, it } from 'vitest';

import { b64Decode, b64Encode } from './b64';
import { decodeBatchFile, encodeBatchFile, batchFileName, isBatchFileName, pullBatchFiles } from './batchFile';
import { compareUtf8, utf8Length } from './bytes';
import { formatHlc, Hlc, tickHlc } from './hlc';
import {
  deepEqual,
  formatJsonNumber,
  isValidField,
  isValidId,
  isValidNamespace,
  normalizeDoc,
  stableStringify,
} from './json';
import { uuidV4, uuidV7 } from './uuid';
import { decodeSyncOp, encodeSyncOp, parseSyncOp, serializeSyncOp } from './wire';
import type { SyncOp } from './types';

describe('base64', () => {
  it('roundtrips like the Rust tests and pads', () => {
    for (let len = 0; len < 40; len++) {
      const data = Uint8Array.from({ length: len }, (_, i) => (i * 37) & 0xff);
      expect([...b64Decode(b64Encode(data))!]).toEqual([...data]);
      expect(b64Encode(data)).toBe(Buffer.from(data).toString('base64'));
    }
  });
  it('accepts unpadded input and rejects garbage', () => {
    expect([...b64Decode('AQI')!]).toEqual([1, 2]);
    expect([...b64Decode('AQ')!]).toEqual([1]);
    expect(b64Decode('A')).toBeNull();
    expect(b64Decode('AQ!=')).toBeNull();
  });
});

describe('json helpers', () => {
  it('sorts keys by UTF-8 bytes, compact', () => {
    const v = { b: 1, a: [true, null], A: 'x', '\u{e000}': 1, '😀': 2, ä: 3, '': 4, '10': 5, '9': 6 };
    expect(stableStringify(v)).toBe('{"":4,"10":5,"9":6,"A":"x","a":[true,null],"b":1,"ä":3,"\u{e000}":1,"😀":2}');
    expect(compareUtf8('\u{e000}', '😀')).toBeLessThan(0);
    expect('\u{e000}' < '😀').toBe(false); // why compareUtf8 exists
  });
  it('formats numbers like serde_json', () => {
    const cases: [number, string][] = [
      [1, '1'], [-42, '-42'], [2.5, '2.5'], [0.1, '0.1'], [1e-7, '1e-7'], [1e21, '1e+21'],
      [1e20, '1e+20'], [0.00001, '0.00001'], [0.000001, '1e-6'], [12345678901234567000, '12345678901234567000'],
      [-1.5e-10, '-1.5e-10'], [2.5e25, '2.5e+25'], [-0, '-0.0'], [123456.789, '123456.789'],
    ];
    for (const [n, s] of cases) expect(formatJsonNumber(n), String(n)).toBe(s);
  });
  it('deepEqual ignores key order only', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual({ a: null }, {})).toBe(false);
    expect(deepEqual(1, '1')).toBe(false);
  });
  it('normalizeDoc drops undefined', () => {
    expect(normalizeDoc({ a: undefined, b: 1 })).toEqual({ b: 1 });
  });
  it('validators mirror storage.rs', () => {
    expect(isValidNamespace('todo')).toBe(true);
    expect(isValidNamespace('core.layout')).toBe(true);
    expect(isValidNamespace('a-1.b2')).toBe(true);
    for (const bad of ['', 'Todo', '1abc', 'a.b.c', 'a..b', '.a', 'a.', '../evil', 'a_b', 'a'.repeat(65)]) {
      expect(isValidNamespace(bad), bad).toBe(false);
    }
    expect(isValidNamespace('a'.repeat(64))).toBe(true);
    expect(isValidId('task:1 ü')).toBe(true);
    expect(isValidId('é'.repeat(64))).toBe(true); // 128 bytes
    expect(isValidId('é'.repeat(65))).toBe(false); // 130 bytes
    expect(isValidId('a\u0085b')).toBe(false); // C1 control
    expect(isValidId('a\nb')).toBe(false);
    expect(isValidId('')).toBe(false);
    expect(isValidField('due_at-2')).toBe(true);
    expect(isValidField('a.b')).toBe(false);
    expect(isValidField("p'); DROP TABLE")).toBe(false);
    expect(isValidField('x'.repeat(65))).toBe(false);
    expect(utf8Length('😀é')).toBe(6);
  });
});

describe('SyncOp wire format', () => {
  const op: SyncOp = {
    op_id: '01a1113e-5224-75b3-8c26-bd028f40ab1e',
    device_id: 'dev',
    hlc: '0000000000001-0000-dev',
    namespace: 'todo',
    doc_id: '1',
    op: 'set_field',
    field: 'title',
    value: { z: 1, a: 'x/"' },
    created_at: 1700000000000,
  };
  it('serializes in struct field order with sorted value keys', () => {
    expect(serializeSyncOp(op)).toBe(
      '{"op_id":"01a1113e-5224-75b3-8c26-bd028f40ab1e","device_id":"dev","hlc":"0000000000001-0000-dev",' +
        '"namespace":"todo","doc_id":"1","op":"set_field","field":"title","value":{"a":"x/\\"","z":1},"created_at":1700000000000}',
    );
    expect(serializeSyncOp({ ...op, op: 'delete_doc', field: null, value: null })).toContain(
      '"field":null,"value":null,"created_at"',
    );
  });
  it('roundtrips and rejects what serde rejects', () => {
    expect(decodeSyncOp(encodeSyncOp(op))).toEqual(op);
    const noOptionals: Partial<SyncOp> = { ...op };
    delete noOptionals.field;
    delete noOptionals.value;
    expect(parseSyncOp(JSON.stringify(noOptionals))).toMatchObject({ field: null, value: null });
    expect(() => parseSyncOp('{"op_id":1}')).toThrow();
    expect(() => parseSyncOp(JSON.stringify({ ...op, created_at: '1' }))).toThrow();
    expect(() => parseSyncOp('not json')).toThrow();
    expect(() => decodeSyncOp(Uint8Array.of(0xff, 0xfe))).toThrow();
  });
});

describe('batch files', () => {
  it('encodes like serde and decodes', () => {
    const text = encodeBatchFile([{ opId: 'op-1', blob: Uint8Array.of(1, 2, 3) }]);
    expect(text).toBe('{"version":1,"ops":[{"op_id":"op-1","blob_b64":"AQID"}]}');
    expect(decodeBatchFile(text)).toEqual([{ opId: 'op-1', blob: Uint8Array.of(1, 2, 3) }]);
    // Drive writes serde_json::Value (sorted keys) – also accepted.
    expect(decodeBatchFile('{"ops":[{"blob_b64":"BAU=","op_id":"op-2"}],"version":1}')).toHaveLength(1);
  });
  it('skips unknown versions and broken entries', () => {
    expect(decodeBatchFile('{"version":2,"ops":[]}')).toBeNull();
    expect(decodeBatchFile('{"version":1,"ops":[{"op_id":"x"},{"op_id":"y","blob_b64":"A"},{"op_id":"z","blob_b64":"AA=="}]}')).toEqual([
      { opId: 'z', blob: Uint8Array.of(0) },
    ]);
    expect(() => decodeBatchFile('{nope')).toThrow();
  });
  it('names sort chronologically and hidden temp files are ignored', () => {
    const name = batchFileName(42, '7207d29d-db8e-4811-bf81-784c1bb97552');
    expect(name).toBe('0000000000042-7207d29d-db8e-4811-bf81-784c1bb97552.cardo-ops');
    expect(isBatchFileName(name)).toBe(true);
    expect(isBatchFileName(`.${name}.tmp`)).toBe(false);
    expect(isBatchFileName('notes.txt')).toBe(false);
  });
  it('pull advances the cursor over skipped files and stops at the limit', async () => {
    const files = new Map<string, string>();
    files.set(batchFileName(1), '{"version":9,"ops":[]}');
    for (let i = 2; i < 60; i++) files.set(batchFileName(i), encodeBatchFile([{ opId: `op-${i}`, blob: Uint8Array.of(i) }]));
    const read = async (n: string) => files.get(n)!;
    const first = await pullBatchFiles([...files.keys()], '', read);
    expect(first.ops).toHaveLength(49);
    const second = await pullBatchFiles([...files.keys()], first.nextCursor, read);
    expect(second.ops).toHaveLength(9);
    const third = await pullBatchFiles([...files.keys()], second.nextCursor, read);
    expect(third).toEqual({ ops: [], nextCursor: second.nextCursor });
  });
});

describe('hlc + uuid', () => {
  it('formats and rolls over like hlc.rs', () => {
    expect(formatHlc({ lastMs: 5, counter: 7 }, 'dev')).toBe('0000000000005-0007-dev');
    expect(tickHlc({ lastMs: 5, counter: 9999 }, 1)).toEqual({ lastMs: 6, counter: 0 });
    expect(tickHlc({ lastMs: 5, counter: 3 }, 9)).toEqual({ lastMs: 9, counter: 0 });
    expect(tickHlc({ lastMs: 5, counter: 3 }, 5)).toEqual({ lastMs: 5, counter: 4 });
  });
  it('is strictly increasing even with a frozen clock', () => {
    const hlc = new Hlc('dev-a', undefined, () => 1000);
    let prev = hlc.now();
    for (let i = 0; i < 20_000; i++) {
      const next = hlc.now();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });
  it('uuids have the right shape and v7 sorts by time', () => {
    expect(uuidV4()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ids = Array.from({ length: 5000 }, () => uuidV7());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    const ts = parseInt(uuidV7(1_700_000_000_123).replace(/-/g, '').slice(0, 12), 16);
    expect(ts).toBeGreaterThanOrEqual(1_700_000_000_123);
  });
});
