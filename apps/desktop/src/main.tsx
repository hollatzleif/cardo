import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@cardo/ui/tokens.css';
import '@cardo/ui/base.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
// KaTeX styles for rendered LaTeX in note/file previews. Fonts are bundled
// same-origin by Vite, so the app's CSP (default-src 'self') serves them.
import 'katex/dist/katex.min.css';
import './app.css';
import './design/terminal-chrome.css';
import './mobile/mobile.css';
import { initHost, type Host } from './host';
import { platformKind, webSupport } from './host/platform';
import { instantiateTools, liveTools } from './host/tools';
import { initGlobalShortcuts } from './host/shortcuts';
import { initI18n } from './i18n';
import { useAppStore } from './state/appStore';
import { App } from './App';

/**
 * iPhone web app only: open the IndexedDB store, finish a pending Google
 * sign-in, and – on first start or on request – show the join screen BEFORE
 * any tool runs (a fresh phone must not write anything synced before it has
 * downloaded the desktop's data).
 */
async function prepareWeb(): Promise<{ host: Host; store: import('@cardo/sync').IdbStore } | null> {
  const [{ createIdbStore }, { createIdbFilesApi }, { consumePendingResult }, webSync] = await Promise.all([
    import('@cardo/sync'),
    import('./host/web/idbFiles'),
    import('./sync/web/googleAuth'),
    import('./sync/web/webSync'),
  ]);
  const store = createIdbStore('cardo');
  await store.ready;
  consumePendingResult();
  const host = initHost({ backend: store, files: createIdbFilesApi(store) });

  const config = await webSync.loadConfig(store);
  const askJoin =
    localStorage.getItem('cardo-web-show-join') === '1' ||
    (!config?.joined && localStorage.getItem('cardo-web-onboarded') !== '1');
  if (askJoin) {
    const langDoc = (await store.get('core.settings', 'core.language')) as { value?: string } | null;
    await initI18n(langDoc?.value ?? null);
    const { JoinFlow } = await import('./sync/web/JoinFlow');
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <JoinFlow
          store={store}
          onDone={() => {
            localStorage.setItem('cardo-web-onboarded', '1');
            localStorage.removeItem('cardo-web-show-join');
            window.location.reload();
          }}
        />
      </StrictMode>,
    );
    return null;
  }
  return { host, store };
}

async function bootstrap(): Promise<void> {
  const kind = platformKind();
  let webStore: import('@cardo/sync').IdbStore | null = null;
  let host: Host;
  if (kind === 'web') {
    const prepared = await prepareWeb();
    if (!prepared) return;
    host = prepared.host;
    webStore = prepared.store;
  } else {
    host = initHost();
  }

  const langDoc = (await host.backend.get('core.settings', 'core.language')) as {
    value?: string;
  } | null;
  await initI18n(langDoc?.value ?? null);

  // Phase 1: all first-party tools are registered; "installing" in the
  // tool market = activating. Default: everything active (zero setup),
  // the market persists deactivations.
  instantiateTools();
  for (const tool of liveTools.values()) host.registry.register(tool);

  // Deactivation list semantics: tools shipped in FUTURE updates are
  // active by default (an allowlist froze out newly added tools – found
  // by Leif when the assistant widget was missing). The legacy
  // core.activeTools doc is intentionally ignored.
  const inactiveDoc = (await host.backend.get('core.settings', 'core.inactiveTools')) as {
    value?: string[];
  } | null;
  const inactive = new Set(inactiveDoc?.value ?? []);
  inactive.delete('assistant'); // the assistant is a core feature, always on
  for (const id of liveTools.keys()) {
    // Runtime-only on the phone: the synced deactivation list stays untouched.
    if (kind === 'web' && webSupport(id) === 'none') continue;
    if (!inactive.has(id)) await host.registry.activate(id);
  }

  // Workspace file commands – every assistant can propose file work.
  const { registerWorkspaceCommands } = await import('./host/workspaceCommands');
  registerWorkspaceCommands(host);
  const { registerSyncCommands } = await import('./host/syncCommands');
  registerSyncCommands(host);
  // Start listening to the background sync lane. Without this its errors go
  // nowhere: Rust emits sync:error/done/revoked/join-denied and, until now,
  // nothing in the webview was listening at all.
  const { initSyncStatus } = await import('./sync/syncStatus');
  initSyncStatus();
  const { registerLayoutCommands } = await import('./host/layoutCommands');
  registerLayoutCommands(host);

  await useAppStore.getState().init();
  void initGlobalShortcuts(host);
  // Re-arm persisted schedules; overdue ones (missed while closed) fire now.
  void (host.services.scheduler as { init?: () => Promise<void> }).init?.();
  // Inbox feed check – only ever runs when the user opted in.
  void import('./inbox/feed').then((m) => m.initInbox());
  if (kind === 'web' && webStore) {
    // Phone: service worker updates instead of the desktop updater, sync
    // over Drive from the browser, no assistant (it needs the local engine).
    const [{ registerServiceWorker, setSyncBusyProbe }, { startWebSync, isWebSyncBusy }] = await Promise.all([
      import('./web/pwa'),
      import('./sync/web/webClient'),
    ]);
    setSyncBusyProbe(isWebSyncBusy);
    void registerServiceWorker(host);
    startWebSync(webStore);
  } else {
    // Assistant profiles (incl. one-time v0.3 → v0.4 migration).
    void import('./assistant').then((m) => m.initProfiles());
    // Background update check ~10s after launch (never blocks startup).
    window.setTimeout(() => {
      void import('./host/updates').then((u) => u.checkForUpdates({ background: true }));
    }, 10_000);
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
