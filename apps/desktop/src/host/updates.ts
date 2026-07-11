import { getHost } from './index';

/**
 * Auto-update flow (transparency principle: the ONLY thing sent to the
 * update endpoint is the current version, and settings say so in plain
 * language).
 *
 * Modes: 'auto' (default) – download & install in the background, take
 * effect on next launch, unobtrusive "what's new" note afterwards.
 * 'notify' – only tell the user; installing happens from settings.
 */
export type UpdateMode = 'auto' | 'notify';

export interface UpdateStatus {
  state: 'idle' | 'checking' | 'available' | 'downloading' | 'installed' | 'upToDate' | 'error';
  version?: string;
  notes?: string;
}

type Listener = (status: UpdateStatus) => void;

let status: UpdateStatus = { state: 'idle' };
const listeners = new Set<Listener>();
let pendingInstall: (() => Promise<void>) | null = null;

function setStatus(next: UpdateStatus): void {
  status = next;
  for (const cb of listeners) cb(status);
}

export function getUpdateStatus(): UpdateStatus {
  return status;
}

export function onUpdateStatus(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export async function getUpdateMode(): Promise<UpdateMode> {
  const doc = (await getHost().backend.get('core.settings', 'core.updateMode')) as {
    value?: UpdateMode;
  } | null;
  return doc?.value === 'notify' ? 'notify' : 'auto';
}

export async function setUpdateMode(mode: UpdateMode): Promise<void> {
  await getHost().backend.set('core.settings', 'core.updateMode', { value: mode });
}

async function toast(titleKey: string, vars?: Record<string, unknown>, bodyKey?: string) {
  await getHost().services.notifications.notify({ titleKey, bodyKey, vars });
}

/** Install a previously found update (notify mode). */
export async function installPendingUpdate(): Promise<void> {
  if (!pendingInstall) return;
  const install = pendingInstall;
  pendingInstall = null;
  await install();
}

/**
 * Check for updates; apply according to the mode. Silent when everything
 * is current, silent on errors during background checks (dev builds and
 * offline machines must never see scary popups).
 */
export async function checkForUpdates(opts: { background: boolean }): Promise<void> {
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    setStatus({ state: 'checking' });
    const update = await check();
    if (!update) {
      setStatus({ state: 'upToDate' });
      return;
    }

    const version = update.version;
    const notes = update.body ?? '';
    const doInstall = async () => {
      setStatus({ state: 'downloading', version, notes });
      await update.downloadAndInstall();
      setStatus({ state: 'installed', version, notes });
      await toast('settings.updateInstalledTitle', { version }, 'settings.updateInstalledBody');
    };

    if ((await getUpdateMode()) === 'auto') {
      await doInstall();
    } else {
      pendingInstall = doInstall;
      setStatus({ state: 'available', version, notes });
      await toast('settings.updateAvailableTitle', { version }, 'settings.updateAvailableBody');
    }
  } catch {
    setStatus(opts.background ? { state: 'idle' } : { state: 'error' });
  }
}

/** Relaunch so an installed update takes effect immediately. */
export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
