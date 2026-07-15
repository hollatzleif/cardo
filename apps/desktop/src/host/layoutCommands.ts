import { z } from 'zod';
import type { Host } from './services';
import { isTauri } from './backend';
import { parseLayout, serializeLayout, type LayoutFile } from './layout';
import { useAppStore } from '../state/appStore';
import { loadDesign, saveDesign, applyDesign, type DesignOverrides } from '../design/design';
import { toolFactories } from './tools';

/**
 * Board sharing: `layout.export` writes the current dashboard (all pages +
 * design) to a JSON file, `layout.import` appends the pages of such a file.
 * Both are palette- and assistant-visible; import asks nothing it does not
 * have to (unknown tools are dropped with a message, never an error).
 */

async function pickSavePath(defaultName: string): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save({ defaultPath: defaultName, filters: [{ name: 'Cardo Board', extensions: ['json'] }] });
}

async function pickOpenPath(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, filters: [{ name: 'Cardo Board', extensions: ['json'] }] });
  return typeof picked === 'string' ? picked : null;
}

async function writeTextFile(path: string, content: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('layout_write_file', { path, content });
}

async function readTextFile(path: string): Promise<string> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('layout_read_file', { path });
}

function browserDownload(file: LayoutFile, name: string): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

let registered = false;

export function registerLayoutCommands(host: Host): void {
  if (registered) return;
  registered = true;

  host.commands.register({
    id: 'layout.export',
    titleKey: 'layout.command.export',
    descriptionKey: 'layout.command.exportDesc',
    params: z.object({ includeDesign: z.boolean().default(true) }),
    async run({ includeDesign }) {
      const { pages } = useAppStore.getState();
      const design = includeDesign ? await loadDesign() : null;
      const file = serializeLayout(pages, design, new Date().toISOString());
      const name = `cardo-board-${new Date().toISOString().slice(0, 10)}.json`;
      try {
        if (isTauri()) {
          const path = await pickSavePath(name);
          if (path === null) return { ok: true, messageKey: 'layout.msg.cancelled' };
          await writeTextFile(path, JSON.stringify(file, null, 2));
        } else {
          browserDownload(file, name);
        }
        return { ok: true, messageKey: 'layout.msg.exported', data: { pages: file.pages.length } };
      } catch (e) {
        return { ok: false, messageKey: 'layout.msg.failed', data: String(e) };
      }
    },
  });

  host.commands.register({
    id: 'layout.import',
    titleKey: 'layout.command.import',
    descriptionKey: 'layout.command.importDesc',
    params: z.object({
      /** Inline JSON (assistant/tests); when absent a file picker opens. */
      json: z.string().optional(),
      applyDesign: z.boolean().default(false),
    }),
    async run({ json, applyDesign: withDesign }) {
      try {
        let raw = json;
        if (raw === undefined) {
          if (!isTauri()) return { ok: false, messageKey: 'layout.msg.desktopOnly' };
          const path = await pickOpenPath();
          if (path === null) return { ok: true, messageKey: 'layout.msg.cancelled' };
          raw = await readTextFile(path);
        }
        const store = useAppStore.getState();
        const parsed = parseLayout(
          JSON.parse(raw),
          new Set(Object.keys(toolFactories)),
          store.pages.length,
        );
        if ('error' in parsed) {
          return { ok: false, messageKey: 'layout.msg.invalid', data: parsed.error };
        }
        await store.importPages(parsed.pages);
        if (withDesign && parsed.design) {
          await saveDesign(parsed.design as DesignOverrides);
          applyDesign(parsed.design as DesignOverrides);
        }
        return {
          ok: true,
          messageKey:
            parsed.missingTools.length > 0 ? 'layout.msg.importedPartial' : 'layout.msg.imported',
          data: { pages: parsed.pages.length, missingTools: parsed.missingTools },
        };
      } catch (e) {
        return { ok: false, messageKey: 'layout.msg.failed', data: String(e) };
      }
    },
  });
}
