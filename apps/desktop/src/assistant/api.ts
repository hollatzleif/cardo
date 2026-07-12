import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '../host/backend';

/**
 * Typed bridge to the Rust assistant commands. Every call is guarded for
 * non-Tauri (plain Vite dev in a browser): hardware/model calls degrade to
 * "nothing installed", docs fall back to an in-memory store so the UI stays
 * explorable, generation fails cleanly.
 */

export interface AssistantHwInfo {
  totalRamMb: number;
  cpuCores: number;
  arch: string;
  os: string;
  appleSilicon: boolean;
}

export interface InstalledModel {
  id: string;
  sizeBytes: number;
}

export interface DownloadProgress {
  id: string;
  downloadedBytes: number;
  totalBytes: number;
}

export type AssistantDocKind = 'instructions' | 'personality' | 'memory';

/** Context window used for every load – plenty for braindump + catalog. */
export const CTX_TOKENS = 4096;

/** Browser-dev fallback store for the three docs. */
const devDocs = new Map<AssistantDocKind, string>();

export async function fetchHwInfo(): Promise<AssistantHwInfo> {
  if (!isTauri()) {
    return { totalRamMb: 8192, cpuCores: 4, arch: 'dev', os: 'browser', appleSilicon: false };
  }
  return invoke('assistant_hw_info');
}

export async function listModels(): Promise<InstalledModel[]> {
  if (!isTauri()) return [];
  return invoke('assistant_list_models');
}

/** Resolves when the download finished; progress arrives via onDownloadProgress. */
export async function downloadModel(id: string, url: string): Promise<void> {
  await invoke('assistant_download_model', { id, url });
}

export async function cancelDownload(id: string): Promise<void> {
  await invoke('assistant_cancel_download', { id });
}

export async function deleteModel(id: string): Promise<void> {
  await invoke('assistant_delete_model', { id });
}

export async function loadModel(id: string, ctxTokens: number = CTX_TOKENS): Promise<void> {
  await invoke('assistant_load_model', { id, ctxTokens });
}

export async function loadedModel(): Promise<string | null> {
  if (!isTauri()) return null;
  return invoke('assistant_loaded_model');
}

export async function unloadModel(): Promise<void> {
  if (!isTauri()) return;
  await invoke('assistant_unload_model');
}

export async function generate(opts: {
  system: string;
  user: string;
  maxTokens: number;
  jsonOnly: boolean;
}): Promise<string> {
  if (!isTauri()) throw new Error('assistant unavailable outside Tauri');
  return invoke('assistant_generate', {
    system: opts.system,
    user: opts.user,
    maxTokens: opts.maxTokens,
    jsonOnly: opts.jsonOnly,
  });
}

export async function readDoc(kind: AssistantDocKind): Promise<string> {
  if (!isTauri()) return devDocs.get(kind) ?? '';
  return (await invoke<string | null>('assistant_read_doc', { kind })) ?? '';
}

export async function writeDoc(kind: AssistantDocKind, content: string): Promise<void> {
  if (!isTauri()) {
    devDocs.set(kind, content);
    return;
  }
  await invoke('assistant_write_doc', { kind, content });
}

/** Subscribes to download progress events; returns an unsubscribe function. */
export function onDownloadProgress(cb: (p: DownloadProgress) => void): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void listen<DownloadProgress>('assistant:download-progress', (e) => cb(e.payload)).then((fn) => {
    if (disposed) fn();
    else unlisten = fn;
  });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
