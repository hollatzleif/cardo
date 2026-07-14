import { z } from 'zod';
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './backend';
import type { Host } from './services';

/**
 * Workspace file commands: EVERY assistant (local or Claude) can propose
 * creating/reading/appending user files – always via the Ja/Bearbeiten/
 * Nein cards, never silently. Scope: the user's notes/workspace folder
 * only (Rust validates names and extensions: .md .txt .csv .json).
 * App data (database, assistant files, models) lives elsewhere and is
 * unreachable by design.
 */

const NAME = z
  .string()
  .min(1)
  .max(255)
  .regex(/\.(md|txt|csv|json)$/i, 'allowed: .md .txt .csv .json');

/** In-memory fallback so commands stay executable outside Tauri (dev/tests). */
const memoryFiles = new Map<string, string>();

async function ensureFolder(host: Host): Promise<void> {
  if (!isTauri()) return;
  const files = host.services.files;
  if (files && (await files.getFolder()) === null) await files.ensureDefaultFolder();
}

async function wsWrite(host: Host, name: string, content: string): Promise<void> {
  await ensureFolder(host);
  if (!isTauri()) {
    memoryFiles.set(name, content);
    return;
  }
  await invoke('workspace_write', { name, content });
}

async function wsAppend(host: Host, name: string, content: string): Promise<void> {
  await ensureFolder(host);
  if (!isTauri()) {
    memoryFiles.set(name, (memoryFiles.get(name) ?? '') + content);
    return;
  }
  await invoke('workspace_append', { name, content });
}

async function wsRead(host: Host, name: string): Promise<string> {
  await ensureFolder(host);
  if (!isTauri()) {
    const c = memoryFiles.get(name);
    if (c === undefined) throw new Error('not found');
    return c;
  }
  return invoke('workspace_read', { name });
}

async function wsList(host: Host): Promise<Array<{ name: string }>> {
  await ensureFolder(host);
  if (!isTauri()) return [...memoryFiles.keys()].map((name) => ({ name }));
  return invoke('workspace_list');
}

async function wsDelete(host: Host, name: string): Promise<void> {
  if (!isTauri()) {
    memoryFiles.delete(name);
    return;
  }
  await invoke('workspace_delete', { name });
}

let registered = false;

/** Registered once at startup; also used by diagnose via selfTestParams. */
export function registerWorkspaceCommands(host: Host): void {
  if (registered) return;
  registered = true;

  host.commands.register({
    id: 'workspace.create-file',
    titleKey: 'workspace.command.createFile',
    params: z.object({ name: NAME, content: z.string().max(512_000).default('') }),
    selfTestParams: { name: 'cardo-selftest-probe.txt', content: 'probe' },
    async run({ name, content }) {
      try {
        await wsWrite(host, name, content ?? '');
        // Self-test probes clean themselves up.
        if (name.startsWith('cardo-selftest-')) await wsDelete(host, name);
        return { ok: true, messageKey: 'workspace.msg.created', data: { name } };
      } catch (e) {
        return { ok: false, messageKey: 'workspace.msg.failed', data: String(e) };
      }
    },
  });

  host.commands.register({
    id: 'workspace.append',
    titleKey: 'workspace.command.append',
    params: z.object({ name: NAME, content: z.string().min(1).max(512_000) }),
    selfTestParams: { name: 'cardo-selftest-probe.txt', content: 'probe' },
    async run({ name, content }) {
      try {
        await wsAppend(host, name, content);
        if (name.startsWith('cardo-selftest-')) await wsDelete(host, name);
        return { ok: true, messageKey: 'workspace.msg.appended', data: { name } };
      } catch (e) {
        return { ok: false, messageKey: 'workspace.msg.failed', data: String(e) };
      }
    },
  });

  host.commands.register({
    id: 'workspace.read',
    titleKey: 'workspace.command.read',
    params: z.object({ name: NAME }),
    selfTestParams: { name: 'cardo-selftest-missing.txt' },
    async run({ name }) {
      try {
        const content = await wsRead(host, name);
        return { ok: true, data: { name, content } };
      } catch {
        // A missing file is a normal outcome for a read attempt.
        return { ok: true, messageKey: 'workspace.msg.notFound', data: { name } };
      }
    },
  });

  host.commands.register({
    id: 'workspace.list',
    titleKey: 'workspace.command.list',
    params: z.object({}),
    selfTestParams: {},
    async run() {
      try {
        const files = await wsList(host);
        return { ok: true, data: { files: files.map((f) => f.name) } };
      } catch (e) {
        return { ok: false, messageKey: 'workspace.msg.failed', data: String(e) };
      }
    },
  });
}
