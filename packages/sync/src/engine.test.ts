import 'fake-indexeddb/auto';

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { b64Decode } from './b64';
import { encodeBatchFile } from './batchFile';
import { SyncCipher } from './cipher';
import { SyncEngine } from './engine';
import { createIdbStore, type IdbStore } from './idb/store';
import { deriveKeys, generateSyncKey } from './keys';
import { MemoryHub } from './testing/memoryHub';
import { FolderHub } from './testing/folderHub';
import { encodeSyncOp } from './wire';
import type { EncryptedOp, PullBatch, SyncOp, SyncTransport } from './types';

let n = 0;
const stores: IdbStore[] = [];
const dirs: string[] = [];
function device(): IdbStore {
  const s = createIdbStore(`engine-${++n}-${Date.now()}`, { broadcast: false });
  stores.push(s);
  return s;
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});
const newKey = () => deriveKeys(generateSyncKey()).dataKey;

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('SyncEngine (ports of sync_engine.rs tests)', () => {
  it('two devices converge', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const a = device();
    const b = device();
    await a.set('todo', '1', { type: 'task', title: 'buy milk', done: false });
    const ea = new SyncEngine(a, key, 'test');
    const eb = new SyncEngine(b, key, 'test');
    expect((await ea.syncOnce(hub)).pushed).toBeGreaterThanOrEqual(1);
    expect((await eb.syncOnce(hub)).applied).toBeGreaterThanOrEqual(1);
    expect(await b.get('todo', '1')).toMatchObject({ title: 'buy milk' });
    await b.set('todo', '1', { type: 'task', title: 'buy milk', done: true });
    await eb.syncOnce(hub);
    await ea.syncOnce(hub);
    expect(await a.get('todo', '1')).toMatchObject({ done: true });
  });

  it('the hub never holds plaintext and requires the key', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cardo-hub-'));
    dirs.push(root);
    const hub = new FolderHub(root);
    const key = newKey();
    const SECRET = 'TOP-SECRET-MARKER-3f9c1a8e2b7d4655-buy-insulin';
    const a = device();
    await a.set('notes', 'n1', { type: 'note', title: SECRET, body: SECRET });
    expect((await new SyncEngine(a, key, 'test').syncOnce(hub)).pushed).toBeGreaterThanOrEqual(1);

    const secret = new TextEncoder().encode(SECRET);
    let files = 0;
    for (const name of readdirSync(hub.opsDir)) {
      if (!name.endsWith('.cardo-ops')) continue;
      files += 1;
      const raw = readFileSync(join(hub.opsDir, name));
      expect(contains(raw, secret)).toBe(false);
      for (const op of JSON.parse(raw.toString('utf8')).ops as { blob_b64: string }[]) {
        expect(contains(b64Decode(op.blob_b64)!, secret)).toBe(false);
      }
    }
    expect(files).toBeGreaterThanOrEqual(1);

    const eve = device();
    const report = await new SyncEngine(eve, newKey(), 'test').syncOnce(hub);
    expect(report.applied).toBe(0);
    expect(report.undecryptable).toBeGreaterThanOrEqual(1);
    expect(await eve.get('notes', 'n1')).toBeNull();

    const b = device();
    expect((await new SyncEngine(b, key, 'test').syncOnce(hub)).applied).toBeGreaterThanOrEqual(1);
    expect(await b.get('notes', 'n1')).toMatchObject({ title: SECRET, body: SECRET });
  });

  it('own ops do not echo', async () => {
    const hub = new MemoryHub();
    const a = device();
    const engine = new SyncEngine(a, newKey(), 'test');
    await a.set('notes', 'n1', { body: 'hello' });
    await engine.syncOnce(hub);
    const second = await engine.syncOnce(hub);
    expect(second.applied).toBe(0);
    expect(second.pushed).toBe(0);
  });

  it('re-pull after cursor loss changes nothing', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const a = device();
    const b = device();
    const ea = new SyncEngine(a, key, 'test');
    const eb = new SyncEngine(b, key, 'test');
    await a.set('todo', '1', { title: 'x' });
    await ea.syncOnce(hub);
    await eb.syncOnce(hub);
    await b.cursorSet('test', '');
    const report = await eb.syncOnce(hub);
    expect(report.applied).toBe(0);
    expect(report.skipped).toBeGreaterThanOrEqual(1);
  });

  it('LWW per field converges', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const a = device();
    const b = device();
    const ea = new SyncEngine(a, key, 'test');
    const eb = new SyncEngine(b, key, 'test');
    await a.set('todo', '1', { title: 'orig', done: false });
    await ea.syncOnce(hub);
    await eb.syncOnce(hub);
    await a.set('todo', '1', { title: 'renamed', done: false });
    await b.set('todo', '1', { title: 'orig', done: true });
    await ea.syncOnce(hub);
    await eb.syncOnce(hub);
    await ea.syncOnce(hub);
    await eb.syncOnce(hub);
    const docA = await a.get('todo', '1');
    expect(docA).toEqual(await b.get('todo', '1'));
    expect(docA).toEqual({ title: 'renamed', done: true });
  });

  it('delete respects LWW', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const a = device();
    const b = device();
    const ea = new SyncEngine(a, key, 'test');
    const eb = new SyncEngine(b, key, 'test');
    await a.set('todo', '1', { title: 'x' });
    await ea.syncOnce(hub);
    await eb.syncOnce(hub);
    await b.delete('todo', '1');
    await eb.syncOnce(hub);
    await ea.syncOnce(hub);
    expect(await a.get('todo', '1')).toBeNull();
    expect(await b.get('todo', '1')).toBeNull();
  });

  it('wrong-key blobs are skipped, not fatal', async () => {
    const hub = new MemoryHub();
    const a = device();
    const b = device();
    await a.set('todo', '1', { title: 'secret' });
    await new SyncEngine(a, newKey(), 'test').syncOnce(hub);
    const report = await new SyncEngine(b, newKey(), 'test').syncOnce(hub);
    expect(report.applied).toBe(0);
    expect(report.undecryptable).toBeGreaterThanOrEqual(1);
    expect(await b.get('todo', '1')).toBeNull();
  });
});

describe('SyncEngine (TS-specific behaviour)', () => {
  it('excluded namespaces stay local and remote ones are skipped', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const a = device();
    const b = device();
    await a.set('core.layout', 'p', { w: 1 });
    await a.set('todo', '1', { t: 1 });
    const ra = await new SyncEngine(a, key, 'test', { exclude: ['core.layout'] }).syncOnce(hub);
    expect(ra.pushed).toBe(1);
    expect(await a.unsyncedOpCount()).toBe(1);
    // Opt in on A: the pending layout op flows now.
    expect((await new SyncEngine(a, key, 'test').syncOnce(hub)).pushed).toBe(1);
    const rb = await new SyncEngine(b, key, 'test', { exclude: ['core.layout'] }).syncOnce(hub);
    expect(rb).toMatchObject({ applied: 1, skipped: 1 });
    expect(await b.get('core.layout', 'p')).toBeNull();
  });

  it('pushes in batches of 500 and marks synced only after the transport accepted', async () => {
    const hub = new MemoryHub();
    const a = device();
    for (let i = 0; i < 501; i++) await a.set('todo', `t${i}`, { i });
    const failing: SyncTransport = {
      pull: (since) => hub.pull(since),
      push: async () => {
        throw new Error('offline');
      },
    };
    const engine = new SyncEngine(a, newKey(), 'test');
    await expect(engine.syncOnce(failing)).rejects.toThrow('offline');
    expect(await a.unsyncedOpCount()).toBe(501);
    const report = await engine.pushOnce(hub);
    expect(report.pushed).toBe(501);
    expect(hub.files.size).toBe(2);
    expect(await a.unsyncedOpCount()).toBe(0);
  });

  it('counts ops failing validation as rejected and keeps going', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const cipher = new SyncCipher(key);
    const op = (o: Partial<SyncOp>): EncryptedOp => {
      const full: SyncOp = {
        op_id: `x-${Math.random()}`, device_id: 'evil', hlc: '9999999999999-0000-evil', namespace: 'todo',
        doc_id: '1', op: 'create', field: null, value: { ok: true }, created_at: 0, ...o,
      };
      return { opId: full.op_id, blob: cipher.encrypt(full.op_id, encodeSyncOp(full)) };
    };
    await hub.push([
      op({ namespace: 'Bad NS' }),
      op({ op: 'explode' }),
      { opId: 'junk', blob: cipher.encrypt('junk', new TextEncoder().encode('{"not":"an op"}')) },
      op({}),
    ]);
    const b = device();
    const report = await new SyncEngine(b, key, 'test').syncOnce(hub);
    expect(report).toMatchObject({ pulled: 4, rejected: 2, undecryptable: 1, applied: 1 });
    expect(await b.get('todo', '1')).toEqual({ ok: true });
  });

  it('the pull loop follows the cursor past empty batches and stops when it stalls', async () => {
    const key = newKey();
    const cipher = new SyncCipher(key);
    const op: SyncOp = {
      op_id: 'op-z', device_id: 'd', hlc: '0000000000005-0000-d', namespace: 'todo', doc_id: 'z',
      op: 'create', field: null, value: {}, created_at: 0,
    };
    const pages: Record<string, PullBatch> = {
      '': { ops: [], nextCursor: 'f1' }, // e.g. a file of an unknown version
      f1: { ops: [{ opId: op.op_id, blob: cipher.encrypt(op.op_id, encodeSyncOp(op)) }], nextCursor: 'f2' },
      f2: { ops: [], nextCursor: 'f2' },
    };
    const calls: string[] = [];
    const transport: SyncTransport = {
      push: async () => undefined,
      pull: async (since) => {
        calls.push(since);
        return pages[since]!;
      },
    };
    const b = device();
    const report = await new SyncEngine(b, key, 'test').pullOnce(transport);
    expect(report.applied).toBe(1);
    expect(calls).toEqual(['', 'f1', 'f2']);
    expect(await b.cursorGet('test')).toBe('f2');
  });

  it('a pushed blob decrypts to exactly the serde-shaped plaintext', async () => {
    const hub = new MemoryHub();
    const key = newKey();
    const a = device();
    await a.set('todo', '1', { z: 1, a: { y: [1.5, null], b: 'x' } });
    const [expected] = await a.unsyncedOps(1, []);
    await new SyncEngine(a, key, 'test').syncOnce(hub);
    const [file] = [...hub.files.values()];
    const wire = JSON.parse(file!) as { version: number; ops: { op_id: string; blob_b64: string }[] };
    expect(wire.version).toBe(1);
    const plain = new TextDecoder().decode(new SyncCipher(key).decrypt(wire.ops[0]!.op_id, b64Decode(wire.ops[0]!.blob_b64)!));
    expect(plain).toBe(
      `{"op_id":"${expected!.op_id}","device_id":"${await a.deviceId()}","hlc":"${expected!.hlc}","namespace":"todo",` +
        `"doc_id":"1","op":"create","field":null,"value":{"a":{"b":"x","y":[1.5,null]},"z":1},"created_at":${expected!.created_at}}`,
    );
    expect(file).toBe(encodeBatchFile([{ opId: wire.ops[0]!.op_id, blob: b64Decode(wire.ops[0]!.blob_b64)! }]));
  });
});
