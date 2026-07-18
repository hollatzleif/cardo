import i18next from 'i18next';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import {
  CommandRegistry,
  SearchRegistry,
  ToolRegistry,
  createEventBus,
  type HostServices,
  type StorageBackend,
} from '@cardo/core';
import type { SchedulerApi } from '@cardo/plugin-api';
import { invoke } from '@tauri-apps/api/core';
import { createBackend, isTauri } from './backend';
import { createFilesApi } from './files';
import { createLegalApi } from './legal';
import { createAnkiApi } from './anki';

/** OS notification, best-effort. The in-app toast is always shown as well. */
async function sendOsNotification(title: string, body?: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === 'granted';
    if (granted) sendNotification({ title, body });
  } catch {
    // No notification backend (e.g. vitest/dev without Tauri) – toast covers it.
  }
}

/**
 * Persistent scheduler: entries live in SQLite (Rust), timers are armed in
 * JS while the app runs. Entries that came due while Cardo was closed fire
 * once right after startup (initScheduler). Outside Tauri (dev in a plain
 * browser) it degrades to in-memory timers.
 */
function createScheduler(commands: CommandRegistry): SchedulerApi & {
  init(): Promise<void>;
} {
  const timers = new Map<string, number>();
  const MAX_TIMEOUT = 2_147_483_000; // setTimeout caps at ~24.8 days

  async function fire(id: string, commandId: string, params: unknown): Promise<void> {
    timers.delete(id);
    if (isTauri()) {
      await invoke('schedule_cancel', { id }).catch(() => {});
    }
    await commands.execute(commandId, params);
  }

  function arm(id: string, fireAtMs: number, commandId: string, params: unknown): void {
    const delay = Math.min(Math.max(0, fireAtMs - Date.now()), MAX_TIMEOUT);
    const handle = window.setTimeout(() => void fire(id, commandId, params), delay);
    timers.set(id, handle);
  }

  return {
    async scheduleAt(when, commandId, params) {
      const id = `s-${crypto.randomUUID()}`;
      if (isTauri()) {
        await invoke('schedule_set', {
          id,
          fireAtMs: when.getTime(),
          commandId,
          params: params ?? null,
        });
      }
      arm(id, when.getTime(), commandId, params);
      return id;
    },
    async cancel(id) {
      const handle = timers.get(id);
      if (handle !== undefined) {
        clearTimeout(handle);
        timers.delete(id);
      }
      if (isTauri()) await invoke('schedule_cancel', { id }).catch(() => {});
    },
    async list() {
      if (!isTauri()) return [];
      const rows = await invoke<
        Array<{ id: string; fireAt: number; commandId: string; params: unknown }>
      >('schedule_list');
      return rows.map((r) => ({
        id: r.id,
        when: new Date(r.fireAt).toISOString(),
        commandId: r.commandId,
      }));
    },
    /** Called once after all tools are activated: re-arm and fire overdue. */
    async init() {
      if (!isTauri()) return;
      const rows = await invoke<
        Array<{ id: string; fireAt: number; commandId: string; params: unknown }>
      >('schedule_list');
      const now = Date.now();
      const overdue = rows.filter((r) => r.fireAt <= now);
      // Overdue entries fire ONCE per (command, params) – self-chaining
      // reminders (hydration, medication) can leave a stack of stale or
      // orphaned entries behind; firing every one of them spammed users
      // with dozens of identical notifications at launch. The newest entry
      // wins, the rest is silently cancelled.
      const newestPerKey = new Map<string, (typeof rows)[number]>();
      for (const r of overdue) {
        const key = `${r.commandId}\u0000${JSON.stringify(r.params ?? null)}`;
        const seen = newestPerKey.get(key);
        if (!seen || r.fireAt > seen.fireAt) newestPerKey.set(key, r);
      }
      const winners = new Set([...newestPerKey.values()].map((r) => r.id));
      for (const r of overdue) {
        if (winners.has(r.id)) void fire(r.id, r.commandId, r.params);
        else void invoke('schedule_cancel', { id: r.id }).catch(() => {});
      }
      for (const r of rows) {
        if (r.fireAt > now) arm(r.id, r.fireAt, r.commandId, r.params);
      }
    },
  };
}

export interface Host {
  backend: StorageBackend;
  services: HostServices;
  commands: CommandRegistry;
  registry: ToolRegistry;
  search: SearchRegistry;
}

export function createHost(): Host {
  const backend = createBackend();
  const events = createEventBus();
  const commands = new CommandRegistry();
  const search = new SearchRegistry();

  const services: HostServices = {
    backend,
    events,
    commands,
    notifications: {
      // In-app toast + best-effort OS notification.
      notify: async ({ titleKey, bodyKey, vars }) => {
        const title = String(i18next.t(titleKey, vars as never));
        const body = bodyKey ? String(i18next.t(bodyKey, vars as never)) : undefined;
        events.emit('core:toast', { title, body } as never);
        await sendOsNotification(title, body);
      },
    },
    files: createFilesApi(),
    // Legal adapters live in Rust; only the Tauri host can reach them.
    legal: isTauri() ? createLegalApi() : undefined,
    anki: isTauri() ? createAnkiApi() : undefined,
    search,
    scheduler: createScheduler(commands),
    i18n: {
      t: (key, vars) => String(i18next.t(key, vars as never)),
      get language() {
        return i18next.language;
      },
    },
  };

  const registry = new ToolRegistry(services);
  return { backend, services, commands, registry, search };
}
