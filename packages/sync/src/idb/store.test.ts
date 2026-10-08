import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import { ValidationError, type SyncOp } from '../types';
import { createIdbStore, type IdbStore } from './store';

let counter = 0;
const opened: IdbStore[] = [];
function open(name = `db-${++counter}`, now?: () => number): IdbStore {
  const s = createIdbStore(name, { now, broadcast: false });
  opened.push(s);
  return s;
}
afterEach(() => {
  opened.splice(0).forEach((s) => s.close());
});

const hlcAt = (ms: number, dev = 'remote') => `${String(ms).padStart(13, '0')}-0000-${dev}`;
let opSeq = 0;
function remote(partial: Partial<SyncOp>): SyncOp {
  return {
    op_id: `remote-${++opSeq}`,
    device_id: 'remote',
    hlc: hlcAt(1),
    namespace: 'todo',
    doc_id: '1',
    op: 'create',
    field: null,
    value: null,
    created_at: 1,
    ...partial,
  };
}

describe('IdbStore local writes (storage.rs parity)', () => {
  it('roundtrip and namespacing', async () => {
    const s = open();
    await s.set('todo', '1', { title: 'hello', done: false });
    expect(await s.get('todo', '1')).toEqual({ title: 'hello', done: false });
    expect(await s.get('notes', '1')).toBeNull();
  });

  it('every write hits the change log exactly like Rust', async () => {
    const s = open();
    expect(await s.write('todo', '1', { title: 'a', prio: 1 })).toEqual({
      namespace: 'todo', docId: '1', operation: 'create', ops_logged: 1,
    });
    expect(await s.write('todo', '1', { title: 'b', prio: 1 })).toMatchObject({ operation: 'update', ops_logged: 1 });
    expect((await s.write('todo', '1', { title: 'b' })).ops_logged).toBe(1);
    expect((await s.write('todo', '1', { title: 'b' })).ops_logged).toBe(0);
    const log = await s.changeLogFor('todo', '1');
    expect(log.map((e) => [e.op, e.field])).toEqual([
      ['create', null],
      ['set_field', 'title'],
      ['delete_field', 'prio'],
    ]);
    expect(log[0]!.value).toEqual({ title: 'a', prio: 1 });
    expect(log[2]!.value).toBeNull();
    expect(log[0]!.hlc < log[1]!.hlc && log[1]!.hlc < log[2]!.hlc).toBe(true);
    expect(await s.unsyncedOpCount()).toBe(3);
  });

  it('diffs fields in UTF-8 byte order, sets before deletes, deep-equal values are unchanged', async () => {
    const s = open();
    await s.set('todo', '1', { keep: { a: 1, b: [1, 2] }, z: 1, gone2: 1, gone1: 1 });
    const n = await s.write('todo', '1', { b: 2, keep: { b: [1, 2], a: 1 }, '😀': 1, '\u{e000}': 1, A: 1, z: 2 });
    expect(n.ops_logged).toBe(7);
    const log = (await s.changeLogFor('todo', '1')).slice(1);
    expect(log.map((e) => `${e.op}:${e.field}`)).toEqual([
      'set_field:A', 'set_field:b', 'set_field:z', 'set_field:\u{e000}', 'set_field:😀',
      'delete_field:gone1', 'delete_field:gone2',
    ]);
  });

  it('delete is a tombstone, logged only for live docs; re-create logs create', async () => {
    const s = open();
    await s.set('todo', '1', { title: 'x' });
    expect((await s.remove('todo', '1')).ops_logged).toBe(1);
    expect((await s.remove('todo', '1')).ops_logged).toBe(0);
    expect((await s.remove('todo', 'never')).ops_logged).toBe(0);
    expect(await s.get('todo', '1')).toBeNull();
    expect((await s.changeLogFor('todo', '1')).at(-1)!.op).toBe('delete_doc');
    expect((await s.write('todo', '1', { title: 'again' })).operation).toBe('create');
    expect(await s.query('todo', {})).toEqual([{ title: 'again' }]);
  });

  it('emits a change event for every write', async () => {
    const s = open();
    const events: string[] = [];
    const off = s.onChange((e) => events.push(`${e.namespace}/${e.docId}:${e.operation}`));
    await s.set('todo', '1', { a: 1 });
    await s.set('todo', '1', { a: 1 }); // unchanged – still an event, like Tauri
    await s.delete('todo', '1');
    await s.applyRemoteOp(remote({ op: 'create', doc_id: '2', hlc: hlcAt(9e12), value: { r: 1 } }));
    off();
    await s.set('todo', '3', { a: 1 });
    expect(events).toEqual(['todo/1:create', 'todo/1:update', 'todo/1:delete', 'todo/2:create']);
  });

  it('rejects bad input', async () => {
    const s = open();
    await expect(s.set('../evil', '1', {})).rejects.toBeInstanceOf(ValidationError);
    await expect(s.set('todo', '', {})).rejects.toBeInstanceOf(ValidationError);
    await expect(s.set('todo', '1', 'nope' as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(s.set('todo', '1', [] as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(
      s.query('todo', { where: [{ field: "p'); DROP TABLE", op: '=', value: 1 }] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(s.query('todo', { where: [{ field: 'p', op: 'regex' as never, value: 1 }] })).rejects.toThrow(
      'unsupported query op',
    );
  });

  it('persists device id and keeps the hlc monotonic across instances on one DB', async () => {
    let clock = 5_000_000;
    const a = open('shared-hlc', () => clock);
    await a.set('todo', '1', { n: 1 });
    await a.set('todo', '1', { n: 2 });
    const devA = await a.deviceId();
    const lastA = (await a.changeLogFor('todo', '1')).at(-1)!.hlc;
    a.close();
    clock = 1_000; // wall clock jumped backwards
    const b = open('shared-hlc', () => clock);
    expect(await b.deviceId()).toBe(devA);
    await b.set('todo', '1', { n: 3 });
    const log = await b.changeLogFor('todo', '1');
    expect(log).toHaveLength(3);
    expect(log[2]!.hlc > lastA).toBe(true);
    expect(log[2]!.hlc).toBe(`0000005000000-0002-${devA}`);
    // Two live instances interleaving writes stay monotonic too.
    const c = open('shared-hlc', () => clock);
    await c.set('todo', '1', { n: 4 });
    await b.set('todo', '1', { n: 5 });
    const hlcs = (await c.changeLogFor('todo', '1')).map((e) => e.hlc);
    expect([...hlcs].sort()).toEqual(hlcs);
    expect(new Set(hlcs).size).toBe(hlcs.length);
  });

  it('sync bookkeeping: unsynced ops, exclude, markSynced, markAllUnsynced, cursors', async () => {
    const s = open();
    await s.set('todo', '1', { a: 1 });
    await s.set('core.layout', 'p', { w: [] });
    await s.set('todo', '1', { a: 2 });
    const all = await s.unsyncedOps(10, []);
    expect(all.map((o) => o.op)).toEqual(['create', 'create', 'set_field']);
    expect(all[2]).toMatchObject({ field: 'a', value: 2, namespace: 'todo', device_id: await s.deviceId() });
    const noLayout = await s.unsyncedOps(10, ['core.layout']);
    expect(noLayout.map((o) => o.namespace)).toEqual(['todo', 'todo']);
    expect(await s.unsyncedOps(1, [])).toHaveLength(1);
    await s.markOpsSynced(noLayout.map((o) => o.op_id));
    expect(await s.unsyncedOpCount()).toBe(1);
    expect(await s.isOpKnown(noLayout[0]!.op_id)).toBe(true);
    expect(await s.isOpKnown('nope')).toBe(false);
    // Remote winners are synced=1 but not ours: markAllUnsynced leaves them.
    await s.applyRemoteOp(remote({ doc_id: 'r', hlc: hlcAt(9e12), value: {} }));
    expect(await s.markAllUnsynced()).toBe(2);
    expect(await s.unsyncedOpCount()).toBe(3);
    expect(await s.cursorGet('t')).toBe('');
    await s.cursorSet('t', 'abc');
    expect(await s.cursorGet('t')).toBe('abc');
  });

  it('local kv, dumpAll, listWithMeta and wipe', async () => {
    const s = open();
    await s.localSet('syncKey', { k: 'CRD1-…' });
    expect(await s.localGet('syncKey')).toEqual({ k: 'CRD1-…' });
    expect(await s.localGet('missing')).toBeNull();
    await s.set('todo', 'b', { x: 1 });
    await s.set('todo', 'a', { x: 2 });
    await s.set('notes', 'n', { t: 'x' });
    await s.delete('notes', 'n');
    expect(await s.dumpAll()).toEqual({ todo: { a: { x: 2 }, b: { x: 1 } } });
    expect(Object.keys((await s.dumpAll()).todo!)).toEqual(['a', 'b']);
    const meta = await s.listWithMeta('todo');
    expect(meta.map((m) => m.id)).toEqual(['a', 'b']);
    expect(meta[0]!.createdAt).toBeTypeOf('number');
    expect(await s.unsyncedOpCount()).toBe(4);
    const dev = await s.deviceId();
    await s.wipe();
    expect(await s.dumpAll()).toEqual({});
    expect(await s.unsyncedOpCount()).toBe(0);
    expect(await s.localGet('syncKey')).toBeNull();
    expect(await s.deviceId()).toBe(dev);
  });
});

describe('applyRemoteOp LWW rules', () => {
  it('create on an empty store wins; duplicates are skipped', async () => {
    const s = open();
    const op = remote({ op: 'create', value: { title: 'r' } });
    expect(await s.applyRemoteOp(op)).toEqual({ namespace: 'todo', docId: '1', operation: 'create', ops_logged: 1 });
    expect(await s.applyRemoteOp(op)).toBeNull();
    expect(await s.get('todo', '1')).toEqual({ title: 'r' });
    const log = await s.changeLogFor('todo', '1');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ synced: true, deviceId: 'remote', opId: op.op_id });
    expect(await s.unsyncedOpCount()).toBe(0);
  });

  it('a tie loses (remote must be strictly greater)', async () => {
    const s = open();
    await s.applyRemoteOp(remote({ op: 'create', hlc: hlcAt(10), value: { a: 1 } }));
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 2, hlc: hlcAt(10) }))).toBeNull();
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 3, hlc: hlcAt(11) }))).not.toBeNull();
    expect(await s.get('todo', '1')).toEqual({ a: 3 });
  });

  it('field ops compete per field; other fields do not block them', async () => {
    const s = open();
    await s.applyRemoteOp(remote({ op: 'create', hlc: hlcAt(10), value: { a: 1, b: 1 } }));
    await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 2, hlc: hlcAt(30) }));
    // b at 20 is older than the a-edit at 30 but newer than the create → wins.
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'b', value: 2, hlc: hlcAt(20) }))).not.toBeNull();
    // a at 25 loses to a at 30.
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 9, hlc: hlcAt(25) }))).toBeNull();
    expect(await s.get('todo', '1')).toEqual({ a: 2, b: 2 });
    // delete_field competes in the same slot.
    expect(await s.applyRemoteOp(remote({ op: 'delete_field', field: 'a', hlc: hlcAt(29) }))).toBeNull();
    expect(await s.applyRemoteOp(remote({ op: 'delete_field', field: 'a', hlc: hlcAt(31) }))).not.toBeNull();
    expect(await s.get('todo', '1')).toEqual({ b: 2 });
  });

  it('a create loses to any newer op on the doc, including a field op', async () => {
    const s = open();
    await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 1, hlc: hlcAt(50) }));
    expect(await s.applyRemoteOp(remote({ op: 'create', hlc: hlcAt(40), value: { z: 1 } }))).toBeNull();
    expect(await s.get('todo', '1')).toEqual({ a: 1 });
    // delete_doc likewise competes with MAX over the whole doc.
    expect(await s.applyRemoteOp(remote({ op: 'delete_doc', hlc: hlcAt(45) }))).toBeNull();
    expect(await s.get('todo', '1')).toEqual({ a: 1 });
  });

  it('a field op older than the create/delete_doc loses', async () => {
    const s = open();
    await s.applyRemoteOp(remote({ op: 'create', hlc: hlcAt(50), value: { a: 1 } }));
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'b', value: 1, hlc: hlcAt(40) }))).toBeNull();
    await s.applyRemoteOp(remote({ op: 'delete_doc', hlc: hlcAt(60) }));
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 2, hlc: hlcAt(55) }))).toBeNull();
    expect(await s.get('todo', '1')).toBeNull();
  });

  it('a newer field op on a deleted doc resurrects its old data plus the field', async () => {
    const s = open();
    await s.set('todo', '1', { title: 'x', done: false });
    await s.delete('todo', '1');
    const notice = await s.applyRemoteOp(remote({ op: 'set_field', field: 'done', value: true, hlc: hlcAt(9e12) }));
    expect(notice).toMatchObject({ operation: 'update' });
    expect(await s.get('todo', '1')).toEqual({ title: 'x', done: true });
  });

  it('a newer delete_doc wins and is logged; on a missing doc it still yields a notice', async () => {
    const s = open();
    await s.set('todo', '1', { title: 'x' });
    expect(await s.applyRemoteOp(remote({ op: 'delete_doc', hlc: hlcAt(9e12) }))).toMatchObject({ operation: 'delete' });
    expect(await s.get('todo', '1')).toBeNull();
    const n = await s.applyRemoteOp(remote({ op: 'delete_doc', doc_id: 'missing', hlc: hlcAt(5) }));
    expect(n).toEqual({ namespace: 'todo', docId: 'missing', operation: 'delete', ops_logged: 1 });
    expect(await s.get('todo', 'missing')).toBeNull();
    expect((await s.changeLogFor('todo', 'missing'))[0]!.op).toBe('delete_doc');
  });

  it('a remote create without value creates an empty doc; set_field null value stores null', async () => {
    const s = open();
    await s.applyRemoteOp(remote({ op: 'create', value: null }));
    expect(await s.get('todo', '1')).toEqual({});
    await s.applyRemoteOp(remote({ op: 'set_field', field: 'x', value: null, hlc: hlcAt(2) }));
    expect(await s.get('todo', '1')).toEqual({ x: null });
  });

  it('local writes after a remote win compete correctly', async () => {
    const s = open(undefined, () => 1000);
    await s.set('todo', '1', { a: 1 });
    // Remote device with a clock far ahead edits `a`.
    await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 2, hlc: hlcAt(9e12) }));
    // A remote op newer than the local create but older than the remote edit loses.
    expect(await s.applyRemoteOp(remote({ op: 'set_field', field: 'a', value: 3, hlc: hlcAt(5000) }))).toBeNull();
    expect(await s.get('todo', '1')).toEqual({ a: 2 });
  });

  it('validation: bad namespace/id always throw; bad field or unknown op only when they would win', async () => {
    const s = open();
    await expect(s.applyRemoteOp(remote({ namespace: '../x' }))).rejects.toMatchObject({ kind: 'namespace' });
    await expect(s.applyRemoteOp(remote({ doc_id: '' }))).rejects.toMatchObject({ kind: 'id' });
    await s.applyRemoteOp(remote({ op: 'create', hlc: hlcAt(100), value: {} }));
    // Losing ops are recorded without validation (Rust parity).
    const loserField = remote({ op: 'set_field', field: 'bad field', value: 1, hlc: hlcAt(50) });
    expect(await s.applyRemoteOp(loserField)).toBeNull();
    expect(await s.isOpKnown(loserField.op_id)).toBe(true);
    const loserOp = remote({ op: 'frobnicate', hlc: hlcAt(50) });
    expect(await s.applyRemoteOp(loserOp)).toBeNull();
    // Winning invalid ops throw and leave no trace (transaction aborted).
    const badField = remote({ op: 'set_field', field: 'bad field', value: 1, hlc: hlcAt(200) });
    await expect(s.applyRemoteOp(badField)).rejects.toMatchObject({ kind: 'field' });
    expect(await s.isOpKnown(badField.op_id)).toBe(false);
    await expect(s.applyRemoteOp(remote({ op: 'set_field', field: null, hlc: hlcAt(200) }))).rejects.toMatchObject({
      kind: 'field',
    });
    const unknown = remote({ op: 'frobnicate', hlc: hlcAt(300) });
    await expect(s.applyRemoteOp(unknown)).rejects.toBeInstanceOf(ValidationError);
    expect(await s.isOpKnown(unknown.op_id)).toBe(false);
    expect(await s.get('todo', '1')).toEqual({});
  });
});

describe('query (SQLite json_extract semantics)', () => {
  async function seeded() {
    const s = open();
    await s.set('todo', '1', { p: 3, done: false, title: 'write plan' });
    await s.set('todo', '2', { p: 1, done: true, title: 'old task' });
    await s.set('todo', '3', { p: 2, done: false, title: 'Plan more' });
    await s.set('todo', '4', { done: false, title: 'no prio', tags: ['a', 'b'] });
    await s.set('todo', '5', { p: null, done: false, title: '100%_done' });
    await s.set('todo', '6', { p: 'high', title: 'text prio' });
    return s;
  }
  const ids = (rows: unknown[]) => rows.map((r) => (r as { title: string }).title);

  it('filters, orders desc, limits (Rust test)', async () => {
    const s = await seeded();
    const open_ = await s.query('todo', { where: [{ field: 'done', op: '=', value: false }], orderBy: 'p', direction: 'desc' });
    expect(ids(open_)).toEqual(['write plan', 'Plan more', 'no prio', '100%_done']);
    expect(await s.query('todo', { where: [{ field: 'title', op: 'like', value: 'plan' }], limit: 1 })).toHaveLength(1);
  });

  it('missing and null fields never match, not even !=', async () => {
    const s = await seeded();
    expect(ids(await s.query('todo', { where: [{ field: 'p', op: '!=', value: 1 }] }))).toEqual([
      'write plan', 'Plan more', 'text prio',
    ]);
    expect(await s.query('todo', { where: [{ field: 'nope', op: '!=', value: 'x' }] })).toEqual([]);
    expect(await s.query('todo', { where: [{ field: 'p', op: '=', value: null }] })).toEqual([]);
  });

  it('numbers sort before text; comparisons cross types like SQLite', async () => {
    const s = await seeded();
    expect(ids(await s.query('todo', { where: [{ field: 'p', op: '<', value: 'a' }] }))).toEqual([
      'write plan', 'old task', 'Plan more',
    ]);
    expect(ids(await s.query('todo', { where: [{ field: 'p', op: '>', value: 100 }] }))).toEqual(['text prio']);
    expect(ids(await s.query('todo', { where: [{ field: 'done', op: '=', value: 1 }] }))).toEqual(['old task']);
    // Arrays compare as their JSON text.
    expect(ids(await s.query('todo', { where: [{ field: 'tags', op: '=', value: ['a', 'b'] }] }))).toEqual(['no prio']);
  });

  it('like is ASCII case-insensitive with % and _ wildcards', async () => {
    const s = await seeded();
    expect(ids(await s.query('todo', { where: [{ field: 'title', op: 'like', value: 'PLAN' }] }))).toEqual([
      'write plan', 'Plan more',
    ]);
    expect(ids(await s.query('todo', { where: [{ field: 'title', op: 'like', value: 'o_d' }] }))).toEqual(['old task']);
    expect(ids(await s.query('todo', { where: [{ field: 'title', op: 'like', value: 'w%n' }] }))).toEqual(['write plan']);
    // '%' in the needle is a wildcard, not a literal.
    expect(ids(await s.query('todo', { where: [{ field: 'title', op: 'like', value: '0%d' }] }))).toEqual(['100%_done']);
    // Numbers are matched via their text form.
    expect(ids(await s.query('todo', { where: [{ field: 'p', op: 'like', value: 3 }] }))).toEqual(['write plan']);
    const u = open();
    await u.set('x', '1', { t: 'ÄRGER' });
    expect(await u.query('x', { where: [{ field: 't', op: 'like', value: 'ärger' }] })).toEqual([]);
    expect(await u.query('x', { where: [{ field: 't', op: 'like', value: 'Ärger' }] })).toHaveLength(1);
  });

  it('in uses json_each over the value', async () => {
    const s = await seeded();
    expect(ids(await s.query('todo', { where: [{ field: 'p', op: 'in', value: [1, 3, null, 'high'] }] }))).toEqual([
      'write plan', 'old task', 'text prio',
    ]);
    expect(ids(await s.query('todo', { where: [{ field: 'title', op: 'in', value: 'old task' }] }))).toEqual(['old task']);
    expect(ids(await s.query('todo', { where: [{ field: 'done', op: 'in', value: [true] }] }))).toEqual(['old task']);
  });

  it('orderBy asc puts missing/null first and keeps scan order for ties', async () => {
    const s = await seeded();
    expect(ids(await s.query('todo', { orderBy: 'p' }))).toEqual([
      'no prio', '100%_done', 'old task', 'Plan more', 'write plan', 'text prio',
    ]);
    expect(ids(await s.query('todo', { orderBy: 'p', direction: 'desc', limit: 2 }))).toEqual([
      'text prio', 'write plan',
    ]);
    expect(await s.query('todo', { limit: 0 })).toEqual([]);
    expect(await s.query('todo', { limit: -1 })).toHaveLength(6);
  });
});

describe('IdbStore review regressions', () => {
  it('scan order is (updatedAt, first-insert seq) like SQLite idx_docs_ns_updated + rowid', async () => {
    let t = 1_000;
    const s = open(undefined, () => t);
    for (const id of ['c', 'a', 'd', 'b']) {
      t += 3;
      await s.set('q', id, { p: 1, k: id });
    }
    t += 3;
    await s.set('q', 'c', { p: 1, k: 'c', touched: true });
    const ks = (rows: unknown[]) => rows.map((r) => (r as { k: string }).k).join('');
    // The finding's sequence, checked against SqliteStorage by the reviewer.
    expect(ks(await s.query('q', {}))).toBe('adbc');
    expect(ks(await s.query('q', { orderBy: 'p', limit: 2 }))).toBe('ad');
    expect(ks(await s.query('q', { orderBy: 'p', direction: 'desc', limit: 2 }))).toBe('ad');
    // listIds stays in id order (Rust list_ids ORDER BY id).
    expect(await s.listIds('q')).toEqual(['a', 'b', 'c', 'd']);

    // Same millisecond: the first-insert sequence breaks the tie (rowid),
    // and survives delete + re-create (an upsert keeps the rowid).
    t = 5_000;
    const u = open(undefined, () => t);
    for (const id of ['z', 'y', 'x']) await u.set('q', id, { k: id });
    expect(ks(await u.query('q', {}))).toBe('zyx');
    await u.delete('q', 'z');
    await u.set('q', 'z', { k: 'z' });
    expect(ks(await u.query('q', {}))).toBe('zyx');
    // A remote op moves its doc to the end (updated_at = now).
    t = 6_000;
    await u.applyRemoteOp(remote({ namespace: 'q', doc_id: 'y', op: 'set_field', field: 'k', value: 'y', hlc: hlcAt(9_999_999_999_999) }));
    expect(ks(await u.query('q', {}))).toBe('zxy');
  });

  it("a remote set_field '__proto__' becomes an own key (serde Map parity)", async () => {
    const s = open();
    await s.set('todo', 'a', { p: 1 });
    const notice = await s.applyRemoteOp(
      remote({ doc_id: 'a', op: 'set_field', field: '__proto__', value: { evil: 1 }, hlc: hlcAt(9_999_999_999_999) }),
    );
    expect(notice).toMatchObject({ operation: 'update' });
    const doc = (await s.get('todo', 'a')) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(['__proto__', 'p']);
    expect(Object.getOwnPropertyDescriptor(doc, '__proto__')?.value).toEqual({ evil: 1 });
    expect(Object.getPrototypeOf(doc)).toBe(Object.prototype);
    // A later local write diffs it like Rust (removing it logs delete_field).
    expect((await s.write('todo', 'a', { p: 1 })).ops_logged).toBe(1);
    expect((await s.changeLogFor('todo', 'a')).at(-1)).toMatchObject({ op: 'delete_field', field: '__proto__' });
  });

  it('write() checks the serialized value: a Date is not an object document', async () => {
    const s = open();
    await expect(s.write('todo', 'z', new Date(0) as unknown as Record<string, unknown>)).rejects.toThrow(ValidationError);
    expect(await s.get('todo', 'z')).toBeNull();
    expect(await s.unsyncedOpCount()).toBe(0);
    // Dates INSIDE a doc serialize to strings, as through the Tauri bridge.
    await s.set('todo', 'd', { at: new Date(0) });
    expect(await s.get('todo', 'd')).toEqual({ at: '1970-01-01T00:00:00.000Z' });
  });

  it('lone surrogates never reach the store, the log or the wire', async () => {
    const s = open();
    await s.set('notes', 'n', { title: 'cut \ud83d', ok: '😀', ['k\udc00']: ['\ud800'] });
    const want = { title: 'cut \ufffd', ok: '😀', ['k\ufffd']: ['\ufffd'] };
    expect(await s.get('notes', 'n')).toEqual(want);
    const [op] = await s.unsyncedOps(10, []);
    expect(op?.value).toEqual(want);
    // An id Rust cannot represent is refused instead of silently diverging.
    await expect(s.set('notes', 'x\ud83d', {})).rejects.toThrow(ValidationError);
  });

  it('documents the integral-float limitation (serde 2.0 vs JS 2)', async () => {
    // Rust keeps Float(2.0) apart from Int(2); JS cannot. A remote 2.0 is
    // stored as 2, so a later write of {x: 2} logs nothing here while the
    // desktop would log a set_field (values stay equal; only the change logs
    // differ) and `like '2.0'` matches only on the desktop. Known, accepted.
    const s = open();
    await s.applyRemoteOp(remote({ doc_id: 'f', op: 'create', value: { x: 2.0 }, hlc: hlcAt(9_999_999_999_999) }));
    expect((await s.write('todo', 'f', { x: 2 })).ops_logged).toBe(0);
    expect(await s.query('todo', { where: [{ field: 'x', op: '=', value: 2 }] })).toHaveLength(1);
    expect(await s.query('todo', { where: [{ field: 'x', op: 'like', value: '2.0' }] })).toHaveLength(0);
  });

  it('observes remote hlcs: a local edit after a remote op (clock ahead) wins', async () => {
    let t = 1_000_000;
    const s = open(undefined, () => t);
    await s.set('todo', '1', { t: 'local' });
    const remoteHlc = hlcAt(t + 60 * 60 * 1000); // remote clock one hour ahead
    await s.applyRemoteOp(remote({ op: 'set_field', field: 't', value: 'remote', hlc: remoteHlc }));
    t += 10;
    await s.set('todo', '1', { t: 'edited after' });
    const last = (await s.changeLogFor('todo', '1')).at(-1)!;
    expect(last.value).toBe('edited after');
    expect(last.hlc > remoteHlc).toBe(true);
    // Beyond the drift cap (a day) a remote clock is ignored.
    const far = hlcAt(t + 2 * 24 * 60 * 60 * 1000);
    await s.applyRemoteOp(remote({ doc_id: '2', op: 'create', value: {}, hlc: far }));
    await s.set('todo', '3', {});
    expect((await s.changeLogFor('todo', '3'))[0]!.hlc < far).toBe(true);
  });

  it('wipe() tells open views and isPristine() reports an empty store', async () => {
    const s = open();
    expect(await s.isPristine()).toBe(true);
    await s.set('todo', '1', { a: 1 });
    await s.set('todo', '2', { a: 1 });
    await s.delete('todo', '2');
    expect(await s.isPristine()).toBe(false);
    const events: string[] = [];
    s.onChange((ev) => events.push(`${ev.namespace}/${ev.docId}:${ev.operation}`));
    await s.wipe();
    expect(events).toEqual(['todo/1:delete']);
    expect(await s.isPristine()).toBe(true);
  });

  it('applyRemoteOp({emit:false}) + emitChanges batches the events', async () => {
    const s = open();
    const events: string[] = [];
    s.onChange((ev) => events.push(`${ev.docId}:${ev.operation}`));
    await s.applyRemoteOp(remote({ doc_id: 'a', op: 'create', value: {}, hlc: hlcAt(10) }), { emit: false });
    expect(events).toEqual([]);
    s.emitChanges!([{ namespace: 'todo', docId: 'a', operation: 'create', ops_logged: 1 }]);
    expect(events).toEqual(['a:create']);
  });
});
