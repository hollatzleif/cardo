// @vitest-environment jsdom
//
// Render smoke suite: every tool widget and every major surface must render
// (and take basic interaction) without crashing – with the network DEAD.
// fetch is globally stubbed to reject, so this doubles as an offline-
// resilience check for everything that mounts. Any console.error during a
// test fails that test.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import i18next from 'i18next';
import type { FilesApi } from '@cardo/plugin-api';
import { createMemoryBackend, type StorageBackend } from '@cardo/core';
import { initHost } from './host';
import { initProfiles } from './assistant/profiles';
import { createMemoryDocStore } from './assistant/api';
import { instantiateTools, liveTools, toolFactories } from './host/tools';
import { initI18n } from './i18n';
import { useAppStore } from './state/appStore';
import { SettingsPage } from './settings/SettingsPage';
import { ToolMarket } from './market/ToolMarket';
import { AddWidgetMenu } from './canvas/AddWidgetMenu';
import { TemplatePicker } from './onboarding/TemplatePicker';
import { Inbox } from './inbox/Inbox';
import { setInboxEnabled } from './inbox/feed';
import { FocusMode } from './focus/FocusMode';
import { CommandPalette } from './palette/CommandPalette';

/* ── Environment stubs (jsdom lacks these browser APIs) ─────────────────── */

function stubBrowserApis(): void {
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;

  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query: string) =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
  }

  if (typeof g.ResizeObserver !== 'function') {
    g.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  const AS = AbortSignal as unknown as { timeout?: (ms: number) => AbortSignal };
  if (typeof AS.timeout !== 'function') {
    AS.timeout = (ms: number) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    };
  }
}

/** In-memory FilesApi so the notes tool activates without Tauri. */
function createMemoryFilesApi(): FilesApi {
  const docs = new Map<string, string>();
  let folder: string | null = '/smoke/notes';
  return {
    pickFolder: async () => folder,
    getFolder: async () => folder,
    ensureDefaultFolder: async () => folder ?? '/smoke/notes',
    setFolder: async (path) => (folder = path),
    list: async () =>
      [...docs.entries()].map(([name, content]) => ({
        name,
        modifiedMs: Date.now(),
        size: content.length,
      })),
    read: async (name) => docs.get(name) ?? '',
    write: async (name, content) => {
      docs.set(name, content);
    },
    rename: async (from, to) => {
      const content = docs.get(from);
      if (content !== undefined) {
        docs.delete(from);
        docs.set(to, content);
      }
    },
    delete: async (name) => {
      docs.delete(name);
    },
    reveal: async () => {},
    browse: async () => [],
    readDataUrl: async () => '',
    openExternal: async () => {},
  };
}

/**
 * KNOWN BUG (documented, not fixable from this test):
 * AssistantWidget.refresh() calls initProfiles(), whose init() ALWAYS emits a
 * profiles-state change – and the widget re-runs refresh() on every profiles
 * change (AssistantWidget.tsx ~line 165 + profiles.ts init()/setState). That
 * is an endless refresh loop. With a purely microtask-based memory backend
 * the loop never yields, so React's act() would drain microtasks forever and
 * OOM the worker. Injecting a backend that defers every call by one macrotask
 * keeps the loop interruptible: it parks between timer ticks and dies when
 * the widget unmounts and unsubscribes.
 */
function createTickDeferredProfilesBackend(): StorageBackend {
  const mem = createMemoryBackend();
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  return {
    get: async (ns, id) => {
      await tick();
      return mem.get(ns, id);
    },
    set: async (ns, id, value) => {
      await tick();
      return mem.set(ns, id, value);
    },
    delete: async (ns, id) => {
      await tick();
      return mem.delete(ns, id);
    },
    query: async (ns, q) => {
      await tick();
      return mem.query(ns, q);
    },
    onChange: (cb) => mem.onChange(cb),
  };
}

/* ── Render helpers ─────────────────────────────────────────────────────── */

interface Rendered {
  container: HTMLElement;
  unmount(): Promise<void>;
}

async function render(node: React.ReactElement): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
  // Let mount effects (storage loads, failed fetches, …) settle.
  await settle();
  return {
    container,
    unmount: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function click(el: Element | null): Promise<void> {
  expect(el, 'expected a clickable element').not.toBeNull();
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

/** Type into a React-controlled input: native setter + bubbling input event. */
async function typeInto(input: Element | null, value: string): Promise<void> {
  expect(input, 'expected an input element').not.toBeNull();
  const el = input as HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(el, value);
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settle();
}

/* ── Suite setup ────────────────────────────────────────────────────────── */

// Manifests are needed at collection time to generate one test per widget.
const manifests = Object.entries(toolFactories).map(
  ([id, factory]) => [id, factory().manifest] as const,
);

beforeAll(async () => {
  stubBrowserApis();
  // The network is DEAD for the whole suite – nothing may crash.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('render-smoke: network is offline'))),
  );

  await initI18n('de');
  const host = initHost(); // memory backend (no Tauri marker)
  // Notes needs a files backend; outside Tauri the real one would reject.
  host.services.files = createMemoryFilesApi();

  // See createTickDeferredProfilesBackend above – contains the assistant
  // widget's refresh loop and keeps profiles fully offline/in-memory.
  await initProfiles({
    backend: createTickDeferredProfilesBackend(),
    docs: createMemoryDocStore(),
    migrateNative: async () => false,
  });

  instantiateTools();
  for (const tool of liveTools.values()) host.registry.register(tool);
  for (const id of liveTools.keys()) await host.registry.activate(id);

  await useAppStore.getState().init();
});

/* Any error-level console output fails the test that produced it. */
let errorSpy: ReturnType<typeof vi.spyOn>;
const IGNORED_ERRORS = [
  // React 18 act() bookkeeping noise – not a render failure.
  'act(...)',
  'ReactDOMTestUtils.act',
];

beforeEach(() => {
  errorSpy = vi.spyOn(console, 'error');
});

afterEach(() => {
  const messages = errorSpy.mock.calls
    .map((args) => args.map((a) => String(a)).join(' '))
    .filter((msg) => !IGNORED_ERRORS.some((ignored) => msg.includes(ignored)));
  errorSpy.mockRestore();
  expect(messages, `console.error during test:\n${messages.join('\n')}`).toEqual([]);
});

/* ── Every tool widget renders offline, in every declared variant ───────── */

/**
 * Something the user can actually operate. `:not([disabled])` is the whole
 * point: the shipped empty-wheel bug rendered a hint plus a DISABLED action
 * button, so "has a button" would have passed it.
 */
const AFFORDANCE_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[role="button"]',
  'details > summary',
  'a[href]',
].join(', ');

/**
 * Views that are read-outs by design and will never offer a control.
 * Verified: neither tool contains a single `<button>` or `onClick` anywhere.
 * Adding to this list asserts the same about a new view.
 */
const DISPLAY_ONLY: ReadonlySet<string> = new Set<string>([
  'clock:main:digital',
  'clock:main:analog',
  'clock:main:minimal',
  'clock:main:words',
  'clock:main:mono',
  'today:main:standard',
  'today:main:compact',
  'today:main:agenda',
]);

/**
 * KNOWN GAP — this list should shrink, never grow.
 *
 * These tools DO have controls, but with no data yet the view is a dead end:
 * it states there is nothing here and offers no way to create the first
 * entry. That is exactly the bug shipped in the random picker (an empty wheel
 * with no way to enter options) and in the flashcards widget — the user hits
 * it, not the developer, because the developer's install always has data.
 *
 * Each entry is a UX defect waiting to be fixed, not an accepted design.
 */
const EMPTY_STATE_NO_ACTION: ReadonlySet<string> = new Set<string>([
  'assistant:main:classic', // "set one up in Settings" — but no button that goes there
  'habits:main:week-grid',
  'habits:main:streaks',
  'stats:main:heatmap',
  'stats:main:numbers',
  'countdown:main:big',
  'countdown:main:ring',
  'decision-log:main:detail',
  'decision-log:main:compact',
  'okr:main:compact',
  'okr:main:single-focus',
  'color-tool:main:palette',
]);

function affordanceKey(toolId: string, widgetId: string, variant?: string): string {
  return `${toolId}:${widgetId}:${variant ?? '-'}`;
}

describe('tool widgets render without crashing (network down)', () => {
  for (const [toolId, manifest] of manifests) {
    for (const widget of manifest.widgets) {
      // The production frame passes `variant` (WidgetFrame.tsx), and 36 of 48
      // tools branch on it — so mounting only the default left the majority of
      // rendering paths untested.
      const variants: Array<string | undefined> = widget.variants.length
        ? [...widget.variants]
        : [undefined];

      for (const variant of variants) {
        const name = variant ? `${toolId}:${widget.id}:${variant}` : `${toolId}:${widget.id}`;
        it(name, async () => {
          const tool = liveTools.get(toolId);
          expect(tool, `tool "${toolId}" must be instantiated`).toBeDefined();
          const Widget = tool!.Widget;
          const { container, unmount } = await render(
            <Widget
              instanceId={`smoke-${toolId}-${widget.id}-${variant ?? 'default'}`}
              widgetId={widget.id}
              variant={variant}
              size={widget.defaultSize}
              editing={false}
            />,
          );
          expect(container.firstChild, 'widget rendered nothing at all').not.toBeNull();

          const key = affordanceKey(toolId, widget.id, variant);
          const affordances = container.querySelectorAll(AFFORDANCE_SELECTOR).length;

          if (DISPLAY_ONLY.has(key) || EMPTY_STATE_NO_ACTION.has(key)) {
            // Ratchet: the moment a listed view gains a control, this fails and
            // forces the entry out of the list. Without it the lists would
            // silently outlive the problems they describe.
            expect(
              affordances,
              `"${name}" is listed as having no operable control, but renders ` +
                `${affordances}. Remove it from DISPLAY_ONLY / EMPTY_STATE_NO_ACTION.`,
            ).toBe(0);
          } else {
            expect(
              affordances,
              `"${name}" rendered no operable control — the user would be stuck. ` +
                `If the view is a pure read-out, add "${key}" to DISPLAY_ONLY. ` +
                `If it is an empty state that needs a way forward, fix it (preferred) ` +
                `or add it to EMPTY_STATE_NO_ACTION.\n` +
                `Rendered: ${container.innerHTML.replace(/ style="[^"]*"/g, '').slice(0, 300)}`,
            ).toBeGreaterThan(0);
          }

          await unmount();
        });
      }
    }
  }
});

/**
 * The frame now resolves `widget.variant ?? variants[0]` and passes that to
 * the widget, so what the picker displays and what renders can no longer
 * disagree. That only holds if the FIRST declared variant really is the view a
 * widget shows when given none — otherwise the fix would silently change which
 * view opens by default.
 *
 * Structure only (tags + classes), not text: clocks and counters legitimately
 * render different characters on every tick.
 */
function structure(el: HTMLElement): string {
  return [...el.querySelectorAll('*')]
    .map((e) => `${e.tagName}.${typeof e.className === 'string' ? e.className : ''}`)
    .join('|');
}

describe('the first declared variant is the default view', () => {
  for (const [toolId, manifest] of manifests) {
    for (const widget of manifest.widgets) {
      if (widget.variants.length === 0) continue;
      const first = widget.variants[0];

      it(`${toolId}:${widget.id} → "${first}"`, async () => {
        const Widget = liveTools.get(toolId)!.Widget;
        const mount = async (variant?: string) => {
          const { container, unmount } = await render(
            <Widget
              instanceId={`order-${toolId}-${widget.id}-${variant ?? 'default'}`}
              widgetId={widget.id}
              variant={variant}
              size={widget.defaultSize}
              editing={false}
            />,
          );
          const shape = structure(container);
          await unmount();
          return shape;
        };

        const withoutVariant = await mount(undefined);
        const withFirst = await mount(first);

        expect(
          withFirst,
          `"${toolId}:${widget.id}" renders a different view for variant "${first}" than ` +
            `for no variant at all. The manifest's variant order must start with the ` +
            `widget's own default, or the picker will open a different view than before.`,
        ).toBe(withoutVariant);
      });
    }
  }
});

describe('the affordance exemption lists stay honest', () => {
  const declared = new Set<string>();
  for (const [toolId, manifest] of manifests) {
    for (const widget of manifest.widgets) {
      const variants: Array<string | undefined> = widget.variants.length
        ? [...widget.variants]
        : [undefined];
      for (const variant of variants) declared.add(affordanceKey(toolId, widget.id, variant));
    }
  }

  it('reference only variants that actually exist', () => {
    // A renamed or removed variant would otherwise leave a dead entry behind,
    // silently exempting nothing while looking like it still covers something.
    const stale = [...DISPLAY_ONLY, ...EMPTY_STATE_NO_ACTION].filter((k) => !declared.has(k));
    expect(stale, `stale entries: ${stale.join(', ')}`).toEqual([]);
  });

  it('do not overlap', () => {
    const both = [...DISPLAY_ONLY].filter((k) => EMPTY_STATE_NO_ACTION.has(k));
    expect(both, `listed twice: ${both.join(', ')}`).toEqual([]);
  });

  it('cover a minority of all variants', () => {
    // A blunt guard against the lists quietly becoming the norm: if more than
    // a third of all views are exempt, the assertion has stopped meaning much.
    const exempt = DISPLAY_ONLY.size + EMPTY_STATE_NO_ACTION.size;
    expect(exempt / declared.size).toBeLessThan(0.34);
  });
});

/* ── Surfaces ───────────────────────────────────────────────────────────── */

describe('surfaces render and take basic interaction (network down)', () => {
  it('SettingsPage: renders and every sidebar section opens', async () => {
    const { container, unmount } = await render(<SettingsPage />);
    const items = [...container.querySelectorAll('.settings-page__nav-item')];
    expect(items).toHaveLength(10);

    // Order mirrors the SECTIONS list in SettingsPage: label key that must
    // show up as the section title + one section-identifying element.
    const sections: Array<[labelKey: string, probe: string]> = [
      ['settings.general', '.settings-page__card'], // general
      ['settings.section.appearance', '.settings-page__card'], // appearance (design pointer)
      ['settings.assistant', '.assistant-settings'], // assistant
      ['settings.sync.title', '.settings-page__card'], // sync (browser: desktop-only hint card)
      ['settings.section.inboxPolls', '.settings-page__card'], // inbox & polls
      ['settings.section.data', '.settings-page__card'], // data & backup
      ['settings.updates', 'input[name="update-mode"]'], // updates
      ['settings.diagnostics', '.diagnose-panel'], // diagnostics
      ['settings.help', '.settings-page__url'], // help (docs link row)
      ['settings.about', '.settings-page__licenses'], // about
    ];
    expect(sections).toHaveLength(items.length);

    for (let i = 0; i < items.length; i++) {
      const [labelKey, probe] = sections[i]!;
      await click(items[i]!);
      expect(items[i]!.className, `item #${i} did not become active`).toContain(
        'settings-page__nav-item--active',
      );
      expect(
        container.querySelector('.settings-page__section-title')?.textContent,
        `section #${i} title`,
      ).toBe(String(i18next.t(labelKey)));
      expect(
        container.querySelector(probe),
        `section #${i} did not render its content (${probe})`,
      ).not.toBeNull();
    }
    await unmount();
  });

  it('ToolMarket: renders, search narrows, filter chip toggles', async () => {
    const { container, unmount } = await render(<ToolMarket />);
    expect(container.querySelectorAll('.market-page__item').length).toBeGreaterThan(0);

    await typeInto(container.querySelector('input.market-page__search'), 'todo');
    expect(container.querySelectorAll('.market-page__item').length).toBeGreaterThan(0);

    const chip = container.querySelector('.market-page__chip');
    await click(chip);
    expect(chip?.className).toContain('market-page__chip--active');
    await unmount();
  });

  it('AddWidgetMenu: renders every active widget and search narrows', async () => {
    const { unmount } = await render(<AddWidgetMenu onClose={() => {}} />);
    // Modal portals to <body> since the widget-help fix – query the document.
    const before = document.querySelectorAll('.add-widget__card').length;
    expect(before).toBeGreaterThan(0);

    await typeInto(document.querySelector('.c-modal input'), 'todo');
    const after = document.querySelectorAll('.add-widget__card').length;
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(before);
    await unmount();
  });

  it('TemplatePicker: three template cards plus the blank option', async () => {
    const onDone = vi.fn();
    const { unmount } = await render(<TemplatePicker onDone={onDone} />);
    expect(document.querySelectorAll('.templates__card')).toHaveLength(3);

    const blank = document.querySelector('.templates__footer button');
    await click(blank);
    expect(onDone).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('Inbox: opt-in state renders; enabling with a dead network shows the error text', async () => {
    const { container, unmount } = await render(<Inbox onClose={() => {}} />);
    expect(container.querySelector('.inbox__optin')).not.toBeNull();

    await click(container.querySelector('.inbox__optin button.c-btn--primary'));

    expect(container.querySelector('.inbox__list')).not.toBeNull();
    expect(container.textContent).toContain(i18next.t('polls.error'));
    await unmount();
    await setInboxEnabled(false); // reset shared feed state
  });

  it('FocusMode: renders the pomodoro card and Escape closes it', async () => {
    const onClose = vi.fn();
    const { container, unmount } = await render(<FocusMode onClose={onClose} />);
    expect(container.querySelector('.focus-overlay')).not.toBeNull();
    expect(container.querySelector('.focus-card')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });

  it('CommandPalette: typing "todo" lists commands and Escape closes', async () => {
    const onClose = vi.fn();
    const { unmount } = await render(<CommandPalette onClose={onClose} />);
    const input = document.querySelector<HTMLInputElement>('.c-modal input, .palette__input, .c-modal-backdrop input');
    expect(input).not.toBeNull();

    await typeInto(input, 'todo');
    expect(document.querySelectorAll('.palette__item').length).toBeGreaterThan(0);

    await act(async () => {
      input!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await unmount();
  });
});
