import i18next from 'i18next';
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification';
import {
  CommandRegistry,
  ToolRegistry,
  createEventBus,
  type HostServices,
  type StorageBackend,
} from '@cardo/core';
import type { SchedulerApi } from '@cardo/plugin-api';
import { createBackend } from './backend';
import { createFilesApi } from './files';

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

/** MVP scheduler: in-memory timers. The persistent Rust scheduler lands in WP1.1. */
function createMvpScheduler(commands: CommandRegistry): SchedulerApi {
  const timers = new Map<string, { handle: number; when: string; commandId: string }>();
  let nextId = 1;
  return {
    async scheduleAt(when, commandId, params) {
      const id = `s${nextId++}`;
      const delay = Math.max(0, when.getTime() - Date.now());
      const handle = window.setTimeout(() => {
        timers.delete(id);
        void commands.execute(commandId, params);
      }, delay);
      timers.set(id, { handle, when: when.toISOString(), commandId });
      return id;
    },
    async cancel(id) {
      const timer = timers.get(id);
      if (timer) {
        clearTimeout(timer.handle);
        timers.delete(id);
      }
    },
    async list() {
      return [...timers.entries()].map(([id, t]) => ({
        id,
        when: t.when,
        commandId: t.commandId,
      }));
    },
  };
}

export interface Host {
  backend: StorageBackend;
  services: HostServices;
  commands: CommandRegistry;
  registry: ToolRegistry;
}

export function createHost(): Host {
  const backend = createBackend();
  const events = createEventBus();
  const commands = new CommandRegistry();

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
    scheduler: createMvpScheduler(commands),
    i18n: {
      t: (key, vars) => String(i18next.t(key, vars as never)),
      get language() {
        return i18next.language;
      },
    },
  };

  const registry = new ToolRegistry(services);
  return { backend, services, commands, registry };
}
