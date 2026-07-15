import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { isTauri } from './backend';
import type { Host } from './services';

/**
 * Sync host commands: the palette can trigger a round, and the assistant can
 * both report the current sync state (via `sync.context`) and propose a
 * "sync now". Everything else (keys, transports, trust warning) is a
 * settings-UI concern on purpose – too sensitive for one-click proposals.
 */

interface SyncStatusDto {
  hasKey: boolean;
  enabled: boolean;
  transport: string;
  lastSyncMs: number | null;
  unsyncedOps: number;
  devices: Array<{ name: string }>;
}

function describeStatus(status: SyncStatusDto): string {
  const t = (key: string, vars?: Record<string, unknown>) => String(i18next.t(key, vars));
  if (!status.hasKey) return t('sync.context.noKey');
  if (!status.enabled) return t('sync.context.disabled');
  return t('sync.context.active', {
    transport: status.transport || '–',
    pending: status.unsyncedOps,
    devices: status.devices.length,
    last: status.lastSyncMs ? new Date(status.lastSyncMs).toLocaleString() : t('settings.sync.never'),
  });
}

let registered = false;

export function registerSyncCommands(host: Host): void {
  if (registered) return;
  registered = true;

  host.commands.register({
    id: 'sync.now',
    titleKey: 'sync.command.now',
    descriptionKey: 'sync.command.nowDesc',
    params: z.object({}),
    // No selfTestParams: a real sync round needs key + transport; the
    // diagnose commands-check skips commands without example params.
    async run() {
      if (!isTauri()) return { ok: false, messageKey: 'sync.msg.desktopOnly' };
      try {
        const report = await invoke('sync_now');
        return { ok: true, messageKey: 'sync.msg.done', data: report };
      } catch (e) {
        return { ok: false, messageKey: 'sync.msg.failed', data: String(e) };
      }
    },
  });

  host.commands.register({
    id: 'sync.status',
    titleKey: 'sync.command.status',
    descriptionKey: 'sync.command.statusDesc',
    params: z.object({}),
    selfTestParams: {},
    async run() {
      if (!isTauri()) {
        return { ok: true, data: { contextText: String(i18next.t('sync.context.noKey')) } };
      }
      try {
        const status = await invoke<SyncStatusDto>('sync_status');
        return { ok: true, data: { contextText: describeStatus(status) } };
      } catch (e) {
        return { ok: false, messageKey: 'sync.msg.failed', data: String(e) };
      }
    },
  });

  host.commands.register({
    id: 'sync.context',
    titleKey: 'sync.command.status',
    palette: false,
    params: z.object({}),
    selfTestParams: {},
    async run() {
      if (!isTauri()) {
        return { ok: true, data: { contextText: String(i18next.t('sync.context.noKey')) } };
      }
      try {
        const status = await invoke<SyncStatusDto>('sync_status');
        return { ok: true, data: { contextText: describeStatus(status) } };
      } catch {
        return { ok: true, data: { contextText: String(i18next.t('sync.context.noKey')) } };
      }
    },
  });
}
