import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@cardo/ui/tokens.css';
import '@cardo/ui/base.css';
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './app.css';
import { initHost } from './host';
import { instantiateTools, liveTools } from './host/tools';
import { initGlobalShortcuts } from './host/shortcuts';
import { initI18n } from './i18n';
import { useAppStore } from './state/appStore';
import { App } from './App';

async function bootstrap(): Promise<void> {
  const host = initHost();

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
    if (!inactive.has(id)) await host.registry.activate(id);
  }

  await useAppStore.getState().init();
  void initGlobalShortcuts(host);
  // Re-arm persisted schedules; overdue ones (missed while closed) fire now.
  void (host.services.scheduler as { init?: () => Promise<void> }).init?.();
  // Inbox feed check – only ever runs when the user opted in.
  void import('./inbox/feed').then((m) => m.initInbox());
  // Assistant profiles (incl. one-time v0.3 → v0.4 migration).
  void import('./assistant').then((m) => m.initProfiles());
  // Background update check ~10s after launch (never blocks startup).
  window.setTimeout(() => {
    void import('./host/updates').then((u) => u.checkForUpdates({ background: true }));
  }, 10_000);

  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
