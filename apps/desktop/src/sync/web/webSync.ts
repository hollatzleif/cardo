import {
  deriveKeys,
  displaySyncKey,
  parseSyncKey,
  SyncEngine,
  type IdbStore,
  type SyncReport,
  type SyncTransport,
} from '@cardo/sync';

/**
 * The web app's sync round – a port of run_sync_round in
 * apps/desktop/src-tauri/src/sync.rs, minus what a phone cannot have
 * (folder/WebDAV transports, the file sweep, generating the group key).
 * Order matters and matches Rust: pull → join gate → device registry →
 * push → revocation check.
 */

export const DEVICES_NS = 'core';
export const DEVICES_DOC = 'sync-devices';
export const CONTROL_NS = 'core.sync-control';
/** Layouts stay per device (phone ≠ desktop screen). */
export const EXCLUDED_NAMESPACES = ['core.layout'] as const;
export const DEVICE_SLOTS = 10;
export const TRANSPORT_ID = 'gdrive';

/** Device-only sync settings, kept in the store's local (never synced) area. */
export interface WebSyncConfig {
  joined: boolean;
  /** Displayed CRD1 key (normalized). Stays on this device only. */
  key?: string;
  deviceName: string;
  lastSyncMs?: number;
  kicked?: boolean;
  joinDenied?: boolean;
  /** Google account hint for one-tap renewal. */
  loginHint?: string;
}

export const CONFIG_KEY = 'sync.web.config';

export async function loadConfig(store: IdbStore): Promise<WebSyncConfig | null> {
  return store.localGet<WebSyncConfig>(CONFIG_KEY);
}

export async function saveConfig(store: IdbStore, config: WebSyncConfig): Promise<void> {
  await store.localSet(CONFIG_KEY, config);
}

export class JoinDeniedError extends Error {
  constructor() {
    super('joining this sync group is currently disabled');
    this.name = 'JoinDeniedError';
  }
}

export class SlotsFullError extends Error {
  constructor() {
    super(`all ${DEVICE_SLOTS} device slots are in use`);
    this.name = 'SlotsFullError';
  }
}

export class RevokedError extends Error {
  constructor(public readonly all: boolean) {
    super(all ? 'sync group dissolved' : 'this device was removed from the sync group');
    this.name = 'RevokedError';
  }
}

/** Normalizes and validates a typed/pasted key; throws with Rust's messages. */
export function normalizeKey(input: string): string {
  return displaySyncKey(parseSyncKey(input));
}

function engineFor(store: IdbStore, key: string): SyncEngine {
  const { dataKey } = deriveKeys(parseSyncKey(key));
  return new SyncEngine(store, dataKey, TRANSPORT_ID, { exclude: [...EXCLUDED_NAMESPACES] });
}

async function joinOpen(store: IdbStore): Promise<boolean> {
  const doc = (await store.get(CONTROL_NS, 'join-policy')) as { open?: unknown } | null;
  // No policy record yet = open group; a non-boolean counts as open (Rust: unwrap_or(true)).
  return typeof doc?.open === 'boolean' ? doc.open : true;
}

async function isMember(store: IdbStore): Promise<boolean> {
  const own = await store.deviceId();
  const doc = (await store.get(DEVICES_NS, DEVICES_DOC)) as { devices?: unknown } | null;
  const devices = Array.isArray(doc?.devices) ? (doc.devices as Array<{ deviceId?: unknown }>) : [];
  return devices.some((d) => d?.deviceId === own);
}

/** Rust upsert_own_device, plus `kind: 'web'` so the desktop list can label phones. */
export async function upsertOwnDevice(
  store: IdbStore,
  name: string,
  nowMs = Date.now(),
): Promise<void> {
  const own = await store.deviceId();
  const doc = ((await store.get(DEVICES_NS, DEVICES_DOC)) as Record<string, unknown> | null) ?? {
    devices: [],
  };
  const all = Array.isArray(doc.devices) ? (doc.devices as Array<Record<string, unknown>>) : [];
  const others = all.filter((d) => d?.deviceId !== own);
  if (others.length >= DEVICE_SLOTS) throw new SlotsFullError();
  others.push({ deviceId: own, name, lastSeenMs: nowMs, kind: 'web' });
  await store.set(DEVICES_NS, DEVICES_DOC, { ...doc, devices: others });
}

async function revocation(store: IdbStore): Promise<{ all: boolean } | null> {
  const own = await store.deviceId();
  const all = (await store.get(CONTROL_NS, 'revoke-all')) as { issuedBy?: unknown } | null;
  if (all && typeof all.issuedBy === 'string') return { all: true };
  const me = await store.get(CONTROL_NS, `revoke-${own}`);
  return me ? { all: false } : null;
}

/**
 * One full round for an already-joined phone. Throws JoinDeniedError,
 * SlotsFullError, RevokedError, or the transport's errors (e.g. NeedsGoogleAuth).
 */
export async function runWebSyncRound(
  store: IdbStore,
  transport: SyncTransport,
  nowMs: () => number = Date.now,
): Promise<SyncReport> {
  const config = await loadConfig(store);
  if (!config?.joined || !config.key) throw new Error('sync is not set up on this device');
  if (config.kicked) throw new RevokedError(false);
  const engine = engineFor(store, config.key);

  const report = await engine.pullOnce(transport);

  if (!(await isMember(store)) && !(await joinOpen(store))) {
    await saveConfig(store, { ...config, joinDenied: true });
    throw new JoinDeniedError();
  }

  await upsertOwnDevice(store, config.deviceName, nowMs());
  const pushed = await engine.pushOnce(transport);
  report.pushed = pushed.pushed;

  const revoked = await revocation(store);
  if (revoked) {
    await saveConfig(store, { ...(await loadConfig(store))!, kicked: true });
    throw new RevokedError(revoked.all);
  }

  await saveConfig(store, {
    ...(await loadConfig(store))!,
    joinDenied: false,
    lastSyncMs: nowMs(),
  });
  return report;
}

export interface JoinProgress {
  phase: 'download' | 'check' | 'register' | 'upload';
  filesRead?: number;
  filesTotal?: number;
}

export interface JoinOutcome {
  report: SyncReport;
  /** Every blob failed to decrypt – almost certainly the wrong key. */
  wrongKeySuspected: boolean;
}

/**
 * First join: wipe the phone, download EVERYTHING, then check the gate and
 * register. Nothing synced is written before the download is complete –
 * otherwise defaults written by a fresh phone would win last-writer-wins
 * and overwrite the desktop's documents.
 */
export async function joinGroup(
  store: IdbStore,
  transport: SyncTransport,
  key: string,
  deviceName: string,
  onProgress: (p: JoinProgress) => void = () => {},
  nowMs: () => number = Date.now,
): Promise<JoinOutcome> {
  const normalized = normalizeKey(key);
  await store.wipe();
  const engine = engineFor(store, normalized);

  onProgress({ phase: 'download' });
  const report = await engine.pullOnce(transport);
  const wrongKeySuspected = report.pulled > 0 && report.undecryptable === report.pulled;
  if (wrongKeySuspected) {
    await store.wipe();
    return { report, wrongKeySuspected };
  }

  onProgress({ phase: 'check' });
  if (!(await isMember(store)) && !(await joinOpen(store))) {
    await store.wipe();
    throw new JoinDeniedError();
  }

  onProgress({ phase: 'register' });
  await upsertOwnDevice(store, deviceName, nowMs());
  onProgress({ phase: 'upload' });
  const pushed = await engine.pushOnce(transport);
  report.pushed = pushed.pushed;

  await saveConfig(store, { joined: true, key: normalized, deviceName, lastSyncMs: nowMs() });
  return { report, wrongKeySuspected: false };
}

/** Leaves sync on this phone: forgets key and config (data stays). */
export async function leaveSync(store: IdbStore): Promise<void> {
  await store.localDelete(CONFIG_KEY);
}
