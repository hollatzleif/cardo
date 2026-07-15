import { create } from 'zustand';
import i18next from 'i18next';
import { applyTheme } from '@cardo/ui';
import { defaultThemeId } from '@cardo/themes';
import { getHost } from '../host';
import { loadAndApplyStoredDesign } from '../design/design';

export interface WidgetInstance {
  instanceId: string;
  toolId: string;
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  accentToken?: string;
  /** Manifest-declared view variant of this widget instance. */
  variant?: string;
}

export interface Page {
  id: string;
  name: string;
  order: number;
  widgets: WidgetInstance[];
}

interface ThemeDoc extends Record<string, unknown> {
  themeId: string;
  accentToken?: string;
}

export interface Profile {
  name: string;
  email?: string;
  birthday?: string;
  country?: string;
}

interface AppState {
  ready: boolean;
  editing: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  marketOpen: boolean;
  designOpen: boolean;
  focusOpen: boolean;
  themeId: string;
  accentToken?: string;
  pages: Page[];
  currentPageId: string;
  activeToolIds: string[];
  profile: Profile | null;
  onboardingDone: boolean;
  tourActive: boolean;

  init(): Promise<void>;
  setEditing(editing: boolean): void;
  setPaletteOpen(open: boolean): void;
  /** One-shot prefill consumed by the palette on open (assistant "Bearbeiten"). */
  paletteSeed: { commandId: string; params: Record<string, unknown> } | null;
  openPaletteWithCommand(commandId: string, params: Record<string, unknown>): void;
  consumePaletteSeed(): { commandId: string; params: Record<string, unknown> } | null;
  setSettingsOpen(open: boolean): void;
  setMarketOpen(open: boolean): void;
  setDesignOpen(open: boolean): void;
  setFocusOpen(open: boolean): void;
  setToolActive(toolId: string, active: boolean): Promise<void>;
  saveProfile(profile: Profile): Promise<void>;
  startTour(): void;
  endTour(): Promise<void>;
  setTheme(themeId: string): Promise<void>;
  setAccent(token: string | undefined): Promise<void>;
  setLanguage(lang: string): Promise<void>;
  selectPage(id: string): void;
  addPage(): Promise<void>;
  renamePage(id: string, name: string): Promise<void>;
  removePage(id: string): Promise<void>;
  addWidget(toolId: string, widgetId: string, size: { w: number; h: number }): Promise<void>;
  /** Fill the CURRENT page with a starter layout (onboarding templates). */
  applyTemplate(widgets: Array<Omit<WidgetInstance, 'instanceId'>>): Promise<void>;
  /** Appends already-id-minted pages (layout import). */
  importPages(pages: Page[]): Promise<void>;
  setWidgetVariant(instanceId: string, variant: string | undefined): Promise<void>;
  removeWidget(instanceId: string): Promise<void>;
  updateWidgetPositions(
    updates: Array<{ instanceId: string; x: number; y: number; w: number; h: number }>,
  ): Promise<void>;
}

function pageDoc(page: Page): Record<string, unknown> {
  // The id is stored IN the doc as well: query() returns doc bodies only.
  return { id: page.id, name: page.name, order: page.order, widgets: page.widgets };
}

export const useAppStore = create<AppState>((set, get) => {
  async function persistPage(page: Page): Promise<void> {
    await getHost().backend.set('core.layout', page.id, pageDoc(page));
  }

  async function persistTheme(): Promise<void> {
    const { themeId, accentToken } = get();
    const doc: ThemeDoc = { themeId, ...(accentToken ? { accentToken } : {}) };
    await getHost().backend.set('core.theme', 'current', doc);
  }

  return {
    ready: false,
    editing: false,
    paletteOpen: false,
    settingsOpen: false,
    marketOpen: false,
    designOpen: false,
    focusOpen: false,
    themeId: defaultThemeId,
    accentToken: undefined,
    pages: [],
    currentPageId: '',
    activeToolIds: [],
    profile: null,
    onboardingDone: false,
    tourActive: false,

    async init() {
      const { backend } = getHost();

      // Custom themes must be registered before the first applyTheme so a
      // stored custom theme id resolves at startup.
      const { registerCustomThemes } = await import('../design/customThemes');
      await registerCustomThemes();

      const themeDoc = (await backend.get('core.theme', 'current')) as ThemeDoc | null;
      const themeId = themeDoc?.themeId ?? defaultThemeId;
      const accentToken = themeDoc?.accentToken;
      applyTheme(themeId, { accentToken });
      // Layer 3: user design overrides go on top of the fresh palette.
      await loadAndApplyStoredDesign();

      const rawPages = (await backend.query('core.layout', { orderBy: 'order' })) as Array<
        Record<string, unknown>
      >;
      let pages: Page[];
      if (rawPages.length === 0) {
        const first: Page = {
          id: `page-${crypto.randomUUID()}`,
          name: i18next.t('canvas.defaultPageName'),
          order: 0,
          widgets: [],
        };
        await backend.set('core.layout', first.id, pageDoc(first));
        pages = [first];
      } else {
        // query() returns doc data without ids – reread each doc keyed by a stored id field.
        pages = rawPages
          .map((doc) => doc as unknown as Page & { id?: string })
          .filter((d): d is Page => typeof d.id === 'string')
          .sort((a, b) => a.order - b.order);
        if (pages.length === 0) {
          // Legacy/invalid docs: start fresh.
          const first: Page = {
            id: `page-${crypto.randomUUID()}`,
            name: i18next.t('canvas.defaultPageName'),
            order: 0,
            widgets: [],
          };
          await backend.set('core.layout', first.id, pageDoc(first));
          pages = [first];
        }
      }

      const profileDoc = (await backend.get('core.settings', 'core.profile')) as {
        value?: Profile;
      } | null;
      const onboardingDoc = (await backend.get('core.settings', 'core.onboarding')) as {
        value?: { done?: boolean };
      } | null;
      const { registry } = getHost();
      const activeToolIds = registry
        .list()
        .filter((t) => t.active)
        .map((t) => t.tool.manifest.id);

      set({
        ready: true,
        themeId,
        accentToken,
        pages,
        currentPageId: pages[0]!.id,
        activeToolIds,
        profile: profileDoc?.value?.name ? profileDoc.value : null,
        onboardingDone: onboardingDoc?.value?.done ?? false,
      });
    },

    setEditing(editing) {
      set({ editing });
      getHost().services.events.emit('core:edit-mode-changed', { editing });
    },
    setPaletteOpen(paletteOpen) {
      set({ paletteOpen });
    },
    paletteSeed: null,
    openPaletteWithCommand(commandId, params) {
      set({ paletteSeed: { commandId, params }, paletteOpen: true });
    },
    consumePaletteSeed() {
      const seed = get().paletteSeed;
      if (seed) set({ paletteSeed: null });
      return seed;
    },
    setSettingsOpen(settingsOpen) {
      set({ settingsOpen });
    },
    setMarketOpen(marketOpen) {
      set({ marketOpen });
    },
    setDesignOpen(designOpen) {
      set({ designOpen });
    },
    setFocusOpen(focusOpen) {
      set({ focusOpen });
    },

    async setToolActive(toolId, active) {
      const { registry, backend } = getHost();
      if (active) await registry.activate(toolId);
      else await registry.deactivate(toolId);
      const ids = new Set(get().activeToolIds);
      if (active) ids.add(toolId);
      else ids.delete(toolId);
      set({ activeToolIds: [...ids] });
      // Persist DEACTIVATIONS – tools from future updates stay on by default.
      const inactiveDoc = (await backend.get('core.settings', 'core.inactiveTools')) as {
        value?: string[];
      } | null;
      const inactive = new Set(inactiveDoc?.value ?? []);
      if (active) inactive.delete(toolId);
      else inactive.add(toolId);
      await backend.set('core.settings', 'core.inactiveTools', { value: [...inactive] });
    },

    async saveProfile(profile) {
      set({ profile });
      await getHost().backend.set('core.settings', 'core.profile', {
        value: profile as unknown as Record<string, unknown>,
      });
    },

    startTour() {
      set({ tourActive: true });
    },

    async endTour() {
      set({ tourActive: false, onboardingDone: true });
      await getHost().backend.set('core.settings', 'core.onboarding', {
        value: { done: true },
      });
    },

    async setTheme(themeId) {
      set({ themeId });
      applyTheme(themeId, { accentToken: get().accentToken });
      await loadAndApplyStoredDesign();
      await persistTheme();
      getHost().services.events.emit('core:theme-changed', { themeId });
    },

    async setAccent(accentToken) {
      set({ accentToken });
      applyTheme(get().themeId, { accentToken });
      await loadAndApplyStoredDesign();
      await persistTheme();
    },

    async setLanguage(lang) {
      await i18next.changeLanguage(lang);
      await getHost().backend.set('core.settings', 'core.language', { value: lang });
      getHost().services.events.emit('core:language-changed', { language: lang });
    },

    selectPage(id) {
      set({ currentPageId: id });
    },

    async addPage() {
      const pages = get().pages;
      const page: Page = {
        id: `page-${crypto.randomUUID()}`,
        name: `${i18next.t('canvas.page')} ${pages.length + 1}`,
        order: pages.length,
        widgets: [],
      };
      await persistPage(page);
      set({ pages: [...pages, page], currentPageId: page.id });
    },

    async renamePage(id, name) {
      const pages = get().pages.map((p) => (p.id === id ? { ...p, name } : p));
      set({ pages });
      const page = pages.find((p) => p.id === id);
      if (page) await persistPage(page);
    },

    async removePage(id) {
      const removed = get().pages.find((p) => p.id === id);
      const remaining = get().pages.filter((p) => p.id !== id);
      if (!removed || remaining.length === 0) return; // never delete the last page
      await getHost().backend.delete('core.layout', id);
      set({
        pages: remaining,
        currentPageId:
          get().currentPageId === id ? remaining[0]!.id : get().currentPageId,
      });
      getHost().services.events.emit('core:toast', {
        title: i18next.t('canvas.pageRemoved', { name: removed.name }),
        actionLabel: i18next.t('common.undo'),
        onAction: async () => {
          await persistPage(removed);
          set({ pages: [...get().pages, removed].sort((a, b) => a.order - b.order) });
        },
      } as never);
    },

    async addWidget(toolId, widgetId, size) {
      const { pages, currentPageId } = get();
      const page = pages.find((p) => p.id === currentPageId);
      if (!page) return;
      const widget: WidgetInstance = {
        instanceId: `w-${crypto.randomUUID()}`,
        toolId,
        widgetId,
        x: 0,
        y: 1000, // grid compaction pulls it to the lowest free spot
        ...size,
      };
      const updated = { ...page, widgets: [...page.widgets, widget] };
      set({ pages: pages.map((p) => (p.id === page.id ? updated : p)) });
      await persistPage(updated);
    },

    async importPages(imported) {
      for (const page of imported) {
        await persistPage(page);
      }
      const pages = [...get().pages, ...imported].sort((a, b) => a.order - b.order);
      set({ pages, currentPageId: imported[0]?.id ?? get().currentPageId });
    },

    async applyTemplate(widgets) {
      const { pages, currentPageId } = get();
      const page = pages.find((p) => p.id === currentPageId);
      if (!page) return;
      const filled: Page = {
        ...page,
        widgets: [
          ...page.widgets,
          ...widgets.map((w) => ({ ...w, instanceId: `w-${crypto.randomUUID()}` })),
        ],
      };
      set({ pages: pages.map((p) => (p.id === page.id ? filled : p)) });
      await persistPage(filled);
    },

    async setWidgetVariant(instanceId, variant) {
      const { pages, currentPageId } = get();
      const page = pages.find((p) => p.id === currentPageId);
      if (!page) return;
      const widgets = page.widgets.map((w) =>
        w.instanceId === instanceId ? { ...w, variant: variant || undefined } : w,
      );
      const updated = { ...page, widgets };
      set({ pages: pages.map((p) => (p.id === page.id ? updated : p)) });
      await persistPage(updated);
    },

    async removeWidget(instanceId) {
      const { pages, currentPageId } = get();
      const page = pages.find((p) => p.id === currentPageId);
      if (!page) return;
      const removed = page.widgets.find((w) => w.instanceId === instanceId);
      const updated = { ...page, widgets: page.widgets.filter((w) => w.instanceId !== instanceId) };
      set({ pages: pages.map((p) => (p.id === page.id ? updated : p)) });
      await persistPage(updated);
      if (!removed) return;
      getHost().services.events.emit('core:toast', {
        title: i18next.t('canvas.widgetRemoved'),
        actionLabel: i18next.t('common.undo'),
        onAction: async () => {
          const current = get().pages.find((p) => p.id === page.id);
          if (!current) return;
          const restored = { ...current, widgets: [...current.widgets, removed] };
          set({ pages: get().pages.map((p) => (p.id === page.id ? restored : p)) });
          await persistPage(restored);
        },
      } as never);
    },

    async updateWidgetPositions(updates) {
      const { pages, currentPageId } = get();
      const page = pages.find((p) => p.id === currentPageId);
      if (!page) return;
      const byId = new Map(updates.map((u) => [u.instanceId, u]));
      const widgets = page.widgets.map((w) => {
        const u = byId.get(w.instanceId);
        return u ? { ...w, x: u.x, y: u.y, w: u.w, h: u.h } : w;
      });
      const updated = { ...page, widgets };
      set({ pages: pages.map((p) => (p.id === page.id ? updated : p)) });
      await persistPage(updated);
    },
  };
});
