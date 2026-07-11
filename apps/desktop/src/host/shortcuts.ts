import { getCurrentWindow } from '@tauri-apps/api/window';
import type { Host } from './services';

/**
 * Global quick-capture shortcut: brings Cardo to the front and focuses the
 * quick-capture input (via its command). Best-effort – if another app owns
 * the shortcut, Cardo still works without it.
 */
export async function initGlobalShortcuts(host: Host): Promise<void> {
  try {
    const { register, isRegistered } = await import('@tauri-apps/plugin-global-shortcut');
    const shortcut = 'CommandOrControl+Shift+Space';
    if (await isRegistered(shortcut)) return;
    await register(shortcut, async (event) => {
      if (event.state !== 'Pressed') return;
      const win = getCurrentWindow();
      await win.show();
      await win.setFocus();
      if (host.commands.has('quickcapture.focus')) {
        await host.commands.execute('quickcapture.focus', {});
      }
    });
  } catch {
    // Not fatal: e.g. running in a plain browser or the shortcut is taken.
  }
}
