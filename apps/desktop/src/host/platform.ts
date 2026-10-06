import { isTauri } from './backend';

/**
 * Where Cardo is running:
 * - 'tauri': the desktop app (Rust core, everything available)
 * - 'web':   the iPhone home-screen web app (vite --mode web): IndexedDB
 *            storage, Drive sync from the browser, no Rust features
 * - 'dev':   plain `vite` in a browser (memory storage, for development)
 */
export type PlatformKind = 'tauri' | 'web' | 'dev';

export function platformKind(): PlatformKind {
  if (typeof window !== 'undefined' && isTauri()) return 'tauri';
  return import.meta.env.MODE === 'web' ? 'web' : 'dev';
}

export function isWebApp(): boolean {
  return platformKind() === 'web';
}

/** Launched from the home screen (no Safari chrome)? */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const nav = navigator as Navigator & { standalone?: boolean };
  return nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true;
}

export type WebSupport = 'full' | 'limited' | 'none';

/**
 * How each tool behaves in the web app. Default is 'full'. 'limited' tools
 * work but show a one-line note (i18n key `web.support.<toolId>`), 'none'
 * tools are not activated on the phone at all. This is runtime-only – the
 * synced list of deactivated tools is never touched, or the phone would
 * switch tools off on the desktop.
 */
export const TOOL_WEB_SUPPORT: Readonly<Record<string, WebSupport>> = {
  assistant: 'none',
  'files-explorer': 'limited',
  'legal-dictionary': 'limited',
  flashcards: 'limited',
  rss: 'limited',
  alarm: 'limited',
  medication: 'limited',
  hydration: 'limited',
  pomodoro: 'limited',
  soundscapes: 'limited',
};

export function webSupport(toolId: string): WebSupport {
  return TOOL_WEB_SUPPORT[toolId] ?? 'full';
}
