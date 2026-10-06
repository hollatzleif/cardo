import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createIdbStore,
  deriveKeys,
  displaySyncKey,
  generateSyncKey,
  MemoryHub,
  parseSyncKey,
  SyncEngine,
  type IdbStore,
} from '@cardo/sync';
import {
  CONTROL_NS,
  DEVICES_DOC,
  DEVICES_NS,
  joinGroup,
  JoinDeniedError,
  loadConfig,
  RevokedError,
  runWebSyncRound,
  SlotsFullError,
  upsertOwnDevice,
} from './webSync';

let counter = 0;
const stores: IdbStore[] = [];
async function store(): Promise<IdbStore> {
  const s = createIdbStore(`websync-test-${counter++}`, { broadcast: false });
  await s.ready;
  stores.push(s);
  return s;
}
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
});

/** A stand-in for the desktop: an IDB store that syncs like the Rust engine. */
async function desktop(hub: MemoryHub, key: string) {
  const s = await store();
  const engine = new SyncEngine(s, deriveKeys(parseSyncKey(key)).dataKey, 'gdrive', {
    exclude: ['core.layout'],
  });
  return { s, sync: () => engine.syncOnce(hub) };
}

describe('web sync join and rounds', () => {
  it('a phone joining downloads everything first and never overwrites desktop data', async () => {
    const hub = new MemoryHub();
    const key = displaySyncKey(generateSyncKey());
    const pc = await desktop(hub, key);
    await pc.s.set('core.settings', 'core.language', { value: 'de' });
    await pc.s.set('todo', '1', { title: 'Milch', done: false });
    await upsertOwnDevice(pc.s, 'MacBook');
    await pc.sync();

    const phone = await store();
    // Something written on the phone before joining is wiped, not pushed.
    await phone.set('core.settings', 'core.language', { value: 'en' });
    const outcome = await joinGroup(phone, hub, key.toLowerCase(), 'iPhone');
    expect(outcome.wrongKeySuspected).toBe(false);
    expect(await phone.get('todo', '1')).toEqual({ title: 'Milch', done: false });
    expect(await phone.get('core.settings', 'core.language')).toEqual({ value: 'de' });

    await pc.sync();
    expect(await pc.s.get('core.settings', 'core.language')).toEqual({ value: 'de' });
    const devices = (await pc.s.get(DEVICES_NS, DEVICES_DOC)) as {
      devices: Array<{ name: string; kind?: string }>;
    };
    expect(devices.devices.map((d) => d.name).sort()).toEqual(['MacBook', 'iPhone']);
    expect(devices.devices.find((d) => d.name === 'iPhone')?.kind).toBe('web');
    expect((await loadConfig(phone))?.joined).toBe(true);
  });

  it('edits flow both ways after joining', async () => {
    const hub = new MemoryHub();
    const key = displaySyncKey(generateSyncKey());
    const pc = await desktop(hub, key);
    await pc.s.set('notes', 'a', { text: 'eins' });
    await pc.sync();
    const phone = await store();
    await joinGroup(phone, hub, key, 'iPhone');

    await phone.set('notes', 'a', { text: 'zwei' });
    await runWebSyncRound(phone, hub);
    await pc.sync();
    expect(await pc.s.get('notes', 'a')).toEqual({ text: 'zwei' });

    await pc.s.set('notes', 'b', { text: 'vom Mac' });
    await pc.sync();
    await runWebSyncRound(phone, hub);
    expect(await phone.get('notes', 'b')).toEqual({ text: 'vom Mac' });
  });

  it('suspects a wrong key when nothing decrypts, and leaves the phone empty', async () => {
    const hub = new MemoryHub();
    const pc = await desktop(hub, displaySyncKey(generateSyncKey()));
    await pc.s.set('todo', '1', { title: 'x' });
    await pc.sync();
    const phone = await store();
    const outcome = await joinGroup(phone, hub, displaySyncKey(generateSyncKey()), 'iPhone');
    expect(outcome.wrongKeySuspected).toBe(true);
    expect(await phone.dumpAll()).toEqual({});
    expect(await loadConfig(phone)).toBeNull();
  });

  it('refuses to join a closed group', async () => {
    const hub = new MemoryHub();
    const key = displaySyncKey(generateSyncKey());
    const pc = await desktop(hub, key);
    await pc.s.set(CONTROL_NS, 'join-policy', { type: 'join-policy', open: false });
    await pc.sync();
    const phone = await store();
    await expect(joinGroup(phone, hub, key, 'iPhone')).rejects.toBeInstanceOf(JoinDeniedError);
    expect(hub.files.size).toBe(1); // the phone uploaded nothing
  });

  it('stops syncing once revoked', async () => {
    const hub = new MemoryHub();
    const key = displaySyncKey(generateSyncKey());
    const pc = await desktop(hub, key);
    await pc.sync();
    const phone = await store();
    await joinGroup(phone, hub, key, 'iPhone');
    await pc.sync();
    await pc.s.set(CONTROL_NS, `revoke-${await phone.deviceId()}`, { at: 1 });
    await pc.sync();
    await expect(runWebSyncRound(phone, hub)).rejects.toBeInstanceOf(RevokedError);
    expect((await loadConfig(phone))?.kicked).toBe(true);
    await expect(runWebSyncRound(phone, hub)).rejects.toBeInstanceOf(RevokedError);
  });

  it('respects the ten device slots', async () => {
    const s = await store();
    await s.set(DEVICES_NS, DEVICES_DOC, {
      devices: Array.from({ length: 10 }, (_, i) => ({
        deviceId: `d${i}`,
        name: `D${i}`,
        lastSeenMs: 0,
      })),
    });
    await expect(upsertOwnDevice(s, 'iPhone')).rejects.toBeInstanceOf(SlotsFullError);
  });
});
