import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import i18next from 'i18next';
import { isTauri } from './backend';
import { getSyncStatus } from '../sync/syncStatus';
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

  const base = t('sync.context.active', {
    transport: status.transport || '–',
    pending: status.unsyncedOps,
    devices: status.devices.length,
    last: status.lastSyncMs ? new Date(status.lastSyncMs).toLocaleString() : t('settings.sync.never'),
  });

  // `sync_status` reports CONFIGURATION. It says nothing about whether the
  // 5-minute background loop is actually succeeding — which is precisely how
  // sync could be dead for days while everything looked configured and fine.
  const health = getSyncStatus();
  if (health.health === 'error') {
    return `${base} ${t('sync.context.failing', {
      count: health.consecutiveErrors,
      message: health.message ?? '',
    })}`;
  }
  if (health.health === 'revoked') return `${base} ${t('sync.context.revoked')}`;
  if (health.health === 'join-denied') return `${base} ${t('sync.context.joinDenied')}`;
  return base;
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
      } catch (e) {
        // Previously this reported "no key configured" for ANY failure, so a
        // broken sync told the assistant it was simply not set up — and the
        // user was told the same. Report what actually went wrong.
        return {
          ok: true,
          data: {
            contextText: String(i18next.t('sync.context.unavailable', { error: String(e) })),
          },
        };
      }
    },
  });
}
