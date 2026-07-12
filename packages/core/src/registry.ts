import {
  ToolManifestSchema,
  type CardoTool,
  type EventBus,
  type FilesApi,
  type I18nApi,
  type NotificationsApi,
  type SchedulerApi,
  type ThemeTokensApi,
  type ToolContext,
} from '@cardo/plugin-api';
import { CommandRegistry } from './commands';
import { SearchRegistry } from './search';
import { createNamespacedStorage, type StorageBackend } from './storage';

export interface HostServices {
  backend: StorageBackend;
  events: EventBus;
  commands: CommandRegistry;
  notifications: NotificationsApi;
  scheduler: SchedulerApi;
  i18n: I18nApi;
  /** File backend for tools with file permissions. Absent in scratch/diagnose contexts. */
  files?: FilesApi;
  /** Global content search. Optional: scratch contexts use a throwaway one. */
  search?: SearchRegistry;
}

const themeApi: ThemeTokensApi = {
  token: (name) => `var(--${name})`,
};

export interface RegisteredTool {
  tool: CardoTool;
  active: boolean;
}

/**
 * Tool registry & lifecycle. Validates the manifest on registration
 * (privacy declaration + self-tests are mandatory), wires a namespaced
 * context on activation and verifies that every command declared in the
 * manifest was actually registered.
 */
export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();

  constructor(private services: HostServices) {}

  register(tool: CardoTool): void {
    const result = ToolManifestSchema.safeParse(tool.manifest);
    if (!result.success) {
      throw new Error(
        `Tool manifest invalid for "${tool.manifest?.id ?? '?'}": ${result.error.message}`,
      );
    }
    if (this.tools.has(tool.manifest.id)) {
      throw new Error(`Tool "${tool.manifest.id}" is already registered`);
    }
    this.tools.set(tool.manifest.id, { tool, active: false });
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get(id: string): RegisteredTool | undefined {
    return this.tools.get(id);
  }

  createContext(toolId: string, backend?: StorageBackend): ToolContext {
    const s = this.services;
    const search = s.search ?? new SearchRegistry();
    return {
      storage: createNamespacedStorage(backend ?? s.backend, toolId),
      events: s.events,
      commands: {
        register: (spec) => {
          if (!spec.id.startsWith(`${toolId}.`)) {
            throw new Error(
              `Tool "${toolId}" tried to register foreign command "${spec.id}"`,
            );
          }
          s.commands.register(spec);
        },
        // Cross-tool automation runs through the same dispatch as the
        // palette – commands are the only sanctioned tool-to-tool call.
        execute: (id, params) => s.commands.execute(id, params),
        has: (id) => s.commands.has(id),
      },
      search: {
        register: (provider) => search.register(toolId, provider),
      },
      settings: {
        get: async <T>(key: string) => {
          const doc = await s.backend.get('core.settings', `${toolId}.${key}`);
          return doc ? ((doc as { value: T }).value ?? null) : null;
        },
        set: async (key, value) => {
          await s.backend.set('core.settings', `${toolId}.${key}`, { value: value as never });
        },
        subscribe: (cb) =>
          s.backend.onChange((ev) => {
            if (ev.namespace === 'core.settings' && ev.docId.startsWith(`${toolId}.`)) cb();
          }),
      },
      notifications: s.notifications,
      scheduler: s.scheduler,
      i18n: s.i18n,
      theme: themeApi,
      // Only the live context gets file access; the diagnose scratch
      // context passes its own backend but no files (tools must degrade).
      ...(backend === undefined && s.files ? { files: s.files } : {}),
    };
  }

  async activate(toolId: string): Promise<void> {
    const entry = this.tools.get(toolId);
    if (!entry) throw new Error(`Unknown tool "${toolId}"`);
    if (entry.active) return;

    await entry.tool.activate(this.createContext(toolId));

    // Contract check: every command declared in the manifest must exist now.
    const missing = entry.tool.manifest.commands.filter((id) => !this.services.commands.has(id));
    if (missing.length) {
      this.services.commands.unregisterTool(toolId);
      throw new Error(
        `Tool "${toolId}" declares commands it did not register: ${missing.join(', ')}`,
      );
    }
    entry.active = true;
  }

  async deactivate(toolId: string): Promise<void> {
    const entry = this.tools.get(toolId);
    if (!entry || !entry.active) return;
    await entry.tool.deactivate();
    this.services.commands.unregisterTool(toolId);
    this.services.search?.unregisterTool(toolId);
    entry.active = false;
  }
}
