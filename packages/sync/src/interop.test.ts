/**
 * Interop with the real Rust implementation. fixtures/rust-v1 was produced by
 * cardo-core (SqliteStorage + SyncEngine + FolderTransport): a hub folder, the
 * sync key that encrypted it, and what the Rust store looked like afterwards.
 */
import 'fake-indexeddb/auto';

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import type { StorageQuery } from '@cardo/plugin-api';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { afterEach, describe, expect, it } from 'vitest';

import { b64Decode, b64Encode } from './b64';
import { base32Encode } from './base32';
import { toHex } from './bytes';
import { NONCE_LEN, openRaw, sealRaw, SyncCipher } from './cipher';
import { SyncEngine } from './engine';
import { createIdbStore, type IdbStore } from './idb/store';
import { deepEqual, stableStringify } from './json';
import { deriveKeys, displaySyncKey, generateSyncKey, parseSyncKey, SyncKeyError } from './keys';
import { notesContentHash } from './notes';
import { FolderHub } from './testing/folderHub';
import {
  copyHub,
  fixtureKey,
  fixturePath,
  fromHex,
  hubFileNames,
  prettyJson,
  readFixture,
} from './testing/fixtures';
import type { SyncOp } from './types';
import { decodeSyncOp, encodeSyncOp, parseSyncOp, serializeSyncOp } from './wire';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'rust-v1');
interface Expected {
  key: string;
  authToken: string;
  dataKeyHex: string;
  licenseId: string;
  deviceId: string;
  pushed: number;
  dump: Record<string, Record<string, unknown>>;
  logs: Record<string, { opId: string; hlc: string; op: string; field: string | null; value: unknown }[]>;
  serde: { input: string; output: string }[];
}
const expected = JSON.parse(readFileSync(join(fixtureDir, 'expected.json'), 'utf8')) as Expected;

const stores: IdbStore[] = [];
afterEach(() => stores.splice(0).forEach((s) => s.close()));

describe('interop with cardo-core (Rust)', () => {
  it('derives the same keys from the same CRD1 string', () => {
    const derived = deriveKeys(parseSyncKey(expected.key));
    expect(derived.authToken).toBe(expected.authToken);
    expect(toHex(derived.dataKey)).toBe(expected.dataKeyHex);
    expect(derived.licenseId).toBe(expected.licenseId);
  });

  it('decrypts every Rust blob and re-serializes it byte-identically', async () => {
    const cipher = new SyncCipher(deriveKeys(parseSyncKey(expected.key)).dataKey);
    const batch = await new FolderHub(join(fixtureDir, 'hub')).pull('');
    expect(batch.ops).toHaveLength(expected.pushed);
    for (const encrypted of batch.ops) {
      const plain = cipher.decrypt(encrypted.opId, encrypted.blob);
      const op = decodeSyncOp(plain);
      expect(op.op_id).toBe(encrypted.opId);
      expect(op.device_id).toBe(expected.deviceId);
      expect(serializeSyncOp(op)).toBe(new TextDecoder().decode(plain));
    }
  });

  it('applying the Rust hub reproduces the Rust store', async () => {
    const store = createIdbStore(`interop-${Date.now()}`, { broadcast: false });
    stores.push(store);
    const engine = new SyncEngine(store, deriveKeys(parseSyncKey(expected.key)).dataKey, 'fx');
    const report = await engine.pullOnce(new FolderHub(join(fixtureDir, 'hub')));
    expect(report).toMatchObject({ pulled: expected.pushed, applied: expected.pushed, undecryptable: 0, rejected: 0 });
    expect(await store.dumpAll()).toEqual(expected.dump);
    for (const [key, rustLog] of Object.entries(expected.logs)) {
      const slash = key.indexOf('/');
      const log = await store.changeLogFor(key.slice(0, slash), key.slice(slash + 1));
      expect(log.map(({ opId, hlc, op, field, value }) => ({ opId, hlc, op, field, value }))).toEqual(
        rustLog.map(({ opId, hlc, op, field, value }) => ({ opId, hlc, op, field, value })),
      );
    }
  });

  it('query() returns exactly what SqliteStorage::query returned', async () => {
    const store = createIdbStore(`interop-q-${Date.now()}`, { broadcast: false });
    stores.push(store);
    // Same seed as the generator (fixgen `query` mode).
    await store.set('todo', '1', { p: 3, done: false, title: 'write plan' });
    await store.set('todo', '2', { p: 1, done: true, title: 'old task' });
    await store.set('todo', '3', { p: 2, done: false, title: 'Plan more' });
    await store.set('todo', '4', { done: false, title: 'no prio', tags: ['a', 'b'] });
    await store.set('todo', '5', { p: null, done: false, title: '100%_done' });
    await store.set('todo', '6', { p: 'high', title: 'text prio' });
    await store.set('x', '1', { t: 'ÄRGER' });
    const cases = JSON.parse(readFileSync(join(fixtureDir, 'queries.json'), 'utf8')) as {
      ns: string;
      q: StorageQuery;
      rows: unknown[];
    }[];
    expect(cases.length).toBeGreaterThan(20);
    for (const c of cases) {
      expect(await store.query(c.ns, c.q), JSON.stringify(c.q)).toEqual(c.rows);
    }
  });

  it('stableStringify matches serde_json Value::to_string', () => {
    for (const { input, output } of expected.serde) {
      // Known, inherent limit: integers beyond 2^53 lose precision in a JS
      // number (i64::MIN parses to -9223372036854776000).
      const jsOutput = output.replace('-9223372036854775808', '-9223372036854776000');
      expect(stableStringify(JSON.parse(input))).toBe(jsOutput);
    }
  });
});

/* ── crates/cardo-core/tests/fixtures/sync-v1 (Rust-verified ground truth) ── */

interface KeysJson {
  valid: { input: string; note: string; licenseId: string; authToken: string }[];
  invalid: { input: string; reason: string; note?: string }[];
}
interface KatVector {
  name: string;
  keyHex: string;
  nonceHex: string;
  aadHex: string;
  aadUtf8?: string;
  plaintextHex: string;
  plaintextUtf8: string;
  ciphertextHex: string;
  tagHex: string;
  sealedHex: string;
  blobHex?: string;
  blobB64?: string;
}
interface NotesCase {
  name: string;
  text: string;
  utf8Hex: string;
  sha256: string;
}

/** Rust `SyncKeyError` texts per keys.json `reason` (checks run in this order). */
const KEY_REASONS: Record<string, string> = {
  missing_prefix: 'missing CRD1',
  invalid_chars: 'invalid characters',
  wrong_length: 'wrong length',
  unsupported_version: 'unsupported sync key version',
  checksum_mismatch: 'checksum mismatch',
};

/**
 * Rewrites whole-number floats (`1.0`, `-3.0`, `2.0e5` stays as is) to their
 * integer spelling, outside string literals. JS has a single number type, so
 * a value serde printed as `1.0` comes back from TS as `1` – the one known,
 * inherent byte difference (values stay equal; Rust's own diff may treat
 * `1.0` vs `1` as a change and log a redundant set_field).
 */
function collapseIntegralFloats(json: string): string {
  let out = '';
  let i = 0;
  while (i < json.length) {
    const c = json[i] as string;
    if (c === '"') {
      let j = i + 1;
      while (j < json.length && json[j] !== '"') j += json[j] === '\\' ? 2 : 1;
      out += json.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' || (c >= '0' && c <= '9')) {
      let j = i + 1;
      while (j < json.length && /[0-9.eE+-]/.test(json[j] as string)) j++;
      const token = json.slice(i, j);
      out += /^-?\d+\.0$/.test(token) && token !== '-0.0' ? token.slice(0, -2) : token;
      i = j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

describe('sync-v1 fixtures from cardo-core', () => {
  const key = fixtureKey();
  const dataKey = fromHex(key.dataKeyHex);
  const rustHub = fixturePath('rust-hub');

  it('key.json: parse, derive, payload layout, independent HKDF, canonical display', () => {
    const parsed = parseSyncKey(key.key);
    const derived = deriveKeys(parsed);
    expect(derived.licenseId).toBe(key.licenseId);
    expect(derived.authToken).toBe(key.authToken);
    expect(toHex(derived.dataKey)).toBe(key.dataKeyHex);
    expect(toHex(parsed.licenseId)).toBe(key.licenseId);
    expect(toHex(parsed.secret)).toBe(key.secretHex);
    const payload = fromHex(key.payloadHex);
    expect(payload.length).toBe(33);
    expect(payload[0]).toBe(key.version);
    expect(toHex(payload.subarray(29))).toBe(key.checkHex);
    expect(toHex(sha256(payload.subarray(0, 29)).subarray(0, 4))).toBe(key.checkHex);
    expect(base32Encode(payload)).toBe(key.key.slice(5).replaceAll('-', ''));
    const salt = new TextEncoder().encode(key.hkdfSalt);
    const secret = fromHex(key.secretHex);
    expect(toHex(hkdf(sha256, secret, salt, new TextEncoder().encode('auth'), 32))).toBe(key.authToken);
    expect(toHex(hkdf(sha256, secret, salt, new TextEncoder().encode('data'), 32))).toBe(key.dataKeyHex);
    expect(displaySyncKey(parsed)).toBe(key.key);
  });

  it('keys.json: every messy valid spelling parses, every invalid one fails for the right reason', () => {
    const keys = readFixture<KeysJson>('keys.json');
    expect(keys.valid.length).toBeGreaterThanOrEqual(5);
    for (const c of keys.valid) {
      const derived = deriveKeys(parseSyncKey(c.input));
      expect(derived.licenseId, c.note).toBe(c.licenseId);
      expect(derived.authToken, c.note).toBe(c.authToken);
    }
    expect(keys.invalid.length).toBeGreaterThanOrEqual(5);
    for (const c of keys.invalid) {
      const want = KEY_REASONS[c.reason];
      expect(want, c.reason).toBeDefined();
      let error: unknown = null;
      try {
        parseSyncKey(c.input);
      } catch (err) {
        error = err;
      }
      expect(error, `${JSON.stringify(c.input)} must be rejected`).toBeInstanceOf(SyncKeyError);
      expect((error as Error).message, JSON.stringify(c.input)).toContain(want);
    }
  });

  it('xchacha-kat.json: draft A.3.1 and the Cardo wire vector', () => {
    const { vectors } = readFixture<{ vectors: KatVector[] }>('xchacha-kat.json');
    expect(vectors).toHaveLength(2);
    for (const v of vectors) {
      const k = fromHex(v.keyHex);
      const nonce = fromHex(v.nonceHex);
      const aad = fromHex(v.aadHex);
      const pt = fromHex(v.plaintextHex);
      expect(new TextDecoder().decode(pt)).toBe(v.plaintextUtf8);
      expect(v.sealedHex).toBe(v.ciphertextHex + v.tagHex);
      expect(toHex(sealRaw(k, nonce, aad, pt)), v.name).toBe(v.sealedHex);
      expect(toHex(openRaw(k, nonce, aad, fromHex(v.sealedHex))), v.name).toBe(v.plaintextHex);
    }
    const v = vectors[1] as KatVector;
    expect(v.keyHex).toBe(key.dataKeyHex);
    const cipher = new SyncCipher(dataKey);
    const opId = v.aadUtf8 as string;
    const blob = cipher.encrypt(opId, fromHex(v.plaintextHex), fromHex(v.nonceHex));
    expect(toHex(blob)).toBe(v.blobHex);
    expect(b64Encode(blob)).toBe(v.blobB64);
    expect(b64Decode(v.blobB64 as string)).toEqual(blob);
    const opened = cipher.decrypt(opId, fromHex(v.blobHex as string));
    expect(toHex(opened)).toBe(v.plaintextHex);
    const op = decodeSyncOp(opened);
    expect(op.op_id).toBe(opId);
    expect(serializeSyncOp(op)).toBe(v.plaintextUtf8);
    expect(() => cipher.decrypt('other-op', blob)).toThrow();
  });

  it('notes-hash.json: SHA-256 over the raw UTF-8 bytes', () => {
    const { cases } = readFixture<{ cases: NotesCase[] }>('notes-hash.json');
    expect(cases.length).toBeGreaterThanOrEqual(5);
    for (const c of cases) {
      expect(toHex(new TextEncoder().encode(c.text)), c.name).toBe(c.utf8Hex);
      expect(notesContentHash(c.text), c.name).toBe(c.sha256);
    }
    expect(notesContentHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rust-hub: every blob decrypts to the plaintext.json bytes; TS re-serializes and re-encrypts byte-identically', async () => {
    const cipher = new SyncCipher(dataKey);
    const plaintext = readFixture<SyncOp[]>('rust-hub', 'plaintext.json');
    const names = hubFileNames(rustHub);
    expect(names.length).toBeGreaterThanOrEqual(3);
    const batch = await new FolderHub(rustHub).pull('');
    expect(batch.nextCursor).toBe(names[names.length - 1]);
    expect(batch.ops).toHaveLength(plaintext.length);

    const integralFloatOps: string[] = [];
    batch.ops.forEach((encrypted, i) => {
      const rustBytes = cipher.decrypt(encrypted.opId, encrypted.blob);
      const rustText = new TextDecoder().decode(rustBytes);
      const fromFixture = parseSyncOp(JSON.stringify(plaintext[i]));
      expect(encrypted.opId).toBe(fromFixture.op_id);

      // TS serialization of the parsed op – from the blob and from plaintext.json.
      const tsFromBlob = serializeSyncOp(decodeSyncOp(rustBytes));
      const tsFromFixture = serializeSyncOp(fromFixture);
      expect(tsFromFixture, `op #${i}`).toBe(tsFromBlob);
      if (tsFromBlob !== rustText) integralFloatOps.push(encrypted.opId);
      expect(tsFromBlob, `op #${i}`).toBe(collapseIntegralFloats(rustText));

      // Re-encrypt with Rust's own nonce: the blob must be identical whenever
      // the plaintext bytes are; and every TS blob round-trips byte-exactly.
      const nonce = encrypted.blob.subarray(0, NONCE_LEN);
      const tsBytes = encodeSyncOp(fromFixture);
      const tsBlob = cipher.encrypt(fromFixture.op_id, tsBytes, nonce);
      if (tsFromBlob === rustText) expect(toHex(tsBlob), `op #${i}`).toBe(toHex(encrypted.blob));
      expect(cipher.decrypt(fromFixture.op_id, tsBlob)).toEqual(tsBytes);
      const fresh = cipher.encrypt(fromFixture.op_id, tsBytes);
      expect(new TextDecoder().decode(cipher.decrypt(fromFixture.op_id, fresh))).toBe(tsFromBlob);
    });
    // Only the documented `"ratio":1.0` create differs (JS has no 1.0 ≠ 1).
    expect(integralFloatOps.length).toBeLessThanOrEqual(1);
  });

  it('rust-hub: a fresh IndexedDB store pulling the hub equals expected-docs.json', async () => {
    const hub = new FolderHub(copyHub(rustHub));
    const opCount = readFixture<unknown[]>('rust-hub', 'plaintext.json').length;
    const store = createIdbStore(`fx-rust-hub-${Date.now()}`, { broadcast: false });
    stores.push(store);
    const engine = new SyncEngine(store, deriveKeys(parseSyncKey(key.key)).dataKey, 'fixture-reader');
    const report = await engine.pullOnce(hub);
    expect(report).toMatchObject({ pulled: opCount, applied: opCount, undecryptable: 0, rejected: 0, skipped: 0 });
    const expectedDocs = readFixture('rust-hub', 'expected-docs.json');
    expect(await store.dumpAll()).toEqual(expectedDocs);
    expect(deepEqual(await store.dumpAll(), expectedDocs)).toBe(true);

    expect((await engine.pullOnce(hub)).pulled).toBe(0);
    await store.cursorSet('fixture-reader', '');
    expect(await engine.pullOnce(hub)).toMatchObject({ pulled: opCount, applied: 0, skipped: opCount });
    expect(deepEqual(await store.dumpAll(), expectedDocs)).toBe(true);
    expect(await store.unsyncedOpCount()).toBe(0);

    const note = (await store.get('files.notes', 'Grüße 🎉.md')) as { content: string; hash: string };
    expect(note.hash).toBe(notesContentHash(note.content));
  });

  it('rust-hub: a wrong key decrypts nothing', async () => {
    const store = createIdbStore(`fx-eve-${Date.now()}`, { broadcast: false });
    stores.push(store);
    const wrong = deriveKeys(generateSyncKey()).dataKey;
    const report = await new SyncEngine(store, wrong, 'eve').pullOnce(new FolderHub(copyHub(rustHub)));
    expect(report.pulled).toBeGreaterThan(0);
    expect(report.undecryptable).toBe(report.pulled);
    expect(report.applied).toBe(0);
    expect(await store.dumpAll()).toEqual({});
  });

  it('ts-hub (committed): blobs decrypt to plaintext.json bytes and replay to expected-docs.json', async () => {
    const tsHub = fixturePath('ts-hub');
    if (!existsSync(join(tsHub, 'expected-docs.json'))) {
      throw new Error('ts-hub missing: run CARDO_WRITE_VECTORS=1 pnpm vitest run packages/sync -t "writes the ts-hub"');
    }
    const cipher = new SyncCipher(dataKey);
    const plaintext = readFixture<SyncOp[]>('ts-hub', 'plaintext.json');
    const batch = await new FolderHub(tsHub).pull('');
    expect(batch.ops).toHaveLength(plaintext.length);
    batch.ops.forEach((encrypted, i) => {
      const text = new TextDecoder().decode(cipher.decrypt(encrypted.opId, encrypted.blob));
      expect(text, `op #${i}`).toBe(serializeSyncOp(parseSyncOp(JSON.stringify(plaintext[i]))));
    });
    const store = createIdbStore(`fx-ts-hub-${Date.now()}`, { broadcast: false });
    stores.push(store);
    const report = await new SyncEngine(store, dataKey, 'r').pullOnce(new FolderHub(copyHub(tsHub)));
    expect(report).toMatchObject({ pulled: plaintext.length, applied: plaintext.length, undecryptable: 0 });
    expect(await store.dumpAll()).toEqual(readFixture('ts-hub', 'expected-docs.json'));
  });

  /**
   * Generator for crates/cardo-core/tests/fixtures/sync-v1/ts-hub: the same
   * scripted sequence as `write_rust_hub` in crates/cardo-core/tests/
   * sync_vectors.rs, written through the IndexedDB store and pushed via the
   * folder hub. Verified by `cargo test -p cardo-core --test sync_interop`.
   *
   *   CARDO_WRITE_VECTORS=1 pnpm vitest run packages/sync -t "writes the ts-hub"
   */
  it.runIf(process.env.CARDO_WRITE_VECTORS === '1')('writes the ts-hub fixture', async () => {
    const out = fixturePath('ts-hub');
    rmSync(out, { recursive: true, force: true });
    const transport = new FolderHub(out);
    const s = createIdbStore(`fx-ts-writer-${Date.now()}`, { broadcast: false });
    stores.push(s);
    const engine = new SyncEngine(s, dataKey, 'fixture-writer');
    const plaintext: SyncOp[] = [];
    const flush = async () => {
      const pending = await s.unsyncedOps(100_000, []);
      const report = await engine.pushOnce(transport);
      expect(report.pushed).toBe(pending.length);
      plaintext.push(...pending);
      // Distinct millisecond file names → batch files sort in push order.
      await new Promise((r) => setTimeout(r, 20));
    };

    const noteV1 = '# Grüße 🎉\r\n\r\nErste Zeile.\r\n';
    const noteV2 = '# Grüße 🎉\r\n\r\nErste Zeile.\r\nZweite Zeile – mit Ümlaut.\r\n';
    const note = (c: string) => ({ content: c, hash: notesContentHash(c) });
    const contactId = 'Jürgen Müller–Lüdenscheidt';

    // Phase 1 – creates across namespaces.
    await s.set('todo', 'task-1', {
      type: 'task', title: 'Milch kaufen', done: false, prio: 2, tags: ['einkauf', 'dringend'], due: null,
    });
    await s.set('todo', 'task-2', { type: 'task', title: 'Steuer 2025', done: false, prio: 1 });
    await s.set('contacts', contactId, {
      name: 'Jürgen Müller-Lüdenscheidt',
      address: { street: 'Königsallee 1', city: 'Düsseldorf', geo: { lat: 51.2254, lng: 6.7763 } },
      phones: ['+49 211 000000', '+49 170 1234567'],
      balance: -1234, neg: -42, temp: -273.15, ratio: 1.0, tiny: 1.5e-7,
      big: 9007199254740991, zero: 0,
      emoji: '👩‍💻🇩🇪', escapes: 'tab\tquote"backslash\\ newline\n',
      emptyObj: {}, emptyArr: [], nothing: null,
      mixed: [1, 'zwei', null, true, { k: [] }, -0.5],
    });
    await s.set('files.notes', 'Grüße 🎉.md', note(noteV1));
    await s.set('core', 'sync-devices', {
      devices: [{ deviceId: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'Heikes MacBook', lastSeenMs: 1760000000000 }],
    });
    await s.set('core.sync-control', 'join-policy', { type: 'join-policy', open: true });
    await flush();

    // Phase 2 – field updates, delete_field, delete_doc, short-lived doc.
    await s.set('todo', 'task-1', {
      type: 'task', title: 'Milch & Brot kaufen', done: true, prio: 2, tags: ['einkauf', 'dringend', 'rewe'],
    });
    const contact = (await s.get('contacts', contactId)) as Record<string, unknown> & {
      address: Record<string, unknown>;
    };
    contact.address.city = 'Köln';
    contact.nothing = 'now something';
    delete contact.emptyArr;
    await s.set('contacts', contactId, contact);
    await s.delete('todo', 'task-2');
    await s.set('files.notes', 'Grüße 🎉.md', note(noteV2));
    await s.set('core', 'sync-devices', {
      devices: [
        { deviceId: '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b', name: 'Heikes MacBook', lastSeenMs: 1760000100000 },
        { deviceId: '0b8e1f2a-3c4d-4e5f-9a6b-7c8d9e0f1a2b', name: 'iPhone', lastSeenMs: 1760000200000 },
      ],
    });
    await s.set('todo', 'task-3', { type: 'task', title: 'kurzlebig' });
    await s.delete('todo', 'task-3');
    await flush();

    // Phase 3 – re-create after delete, float field, policy flip.
    await s.set('todo', 'task-2', { type: 'task', title: 'Steuer 2025 (neu)', done: false });
    const t1 = (await s.get('todo', 'task-1')) as Record<string, unknown>;
    t1.prio = 3.5;
    await s.set('todo', 'task-1', t1);
    await s.set('core.sync-control', 'join-policy', { type: 'join-policy', open: false });
    await flush();

    expect(plaintext).toHaveLength(22); // same op count as the Rust hub
    writeFileSync(join(out, 'expected-docs.json'), prettyJson(await s.dumpAll()));
    writeFileSync(
      join(out, 'plaintext.json'),
      prettyJson(plaintext.map((op) => JSON.parse(serializeSyncOp(op)) as unknown)),
    );
  });
});
