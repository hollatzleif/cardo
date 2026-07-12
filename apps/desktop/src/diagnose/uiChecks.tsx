import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';
import { z } from 'zod';
import { createScratchContext, type DiagnoseCheck } from '@cardo/core';
import type { CardoTool, SelfTestResult } from '@cardo/plugin-api';
import { themes } from '@cardo/themes';
import { applyTheme } from '@cardo/ui';
import { getHost } from '../host';
import { isTauri } from '../host/backend';
import { toolFactories } from '../host/tools';
import { useAppStore } from '../state/appStore';
import { DESIGN_DOC, loadAndApplyStoredDesign } from '../design/design';
import { paramFields } from '../palette/paramFields';

/**
 * UI checks (category "ui"): every widget renders, command forms build,
 * tour anchors resolve, theme/language/scheduler/design roundtrips work.
 * Everything runs against scratch contexts and cleans up after itself –
 * the live dashboard state is restored after every check.
 */

const tt = (key: string): string => String(i18next.t(key));

/**
 * The definitive list of core tour anchors – every data-tour-anchor that
 * actually exists in App.tsx / Canvas.tsx / SettingsModal.tsx. Widget
 * anchors ("widget:<tool>:<widget>") are validated against the manifest.
 */
export const CORE_TOUR_ANCHORS: ReadonlySet<string> = new Set([
  'ui:edit-toggle',
  'ui:design-button',
  'ui:focus-button',
  'ui:market-button',
  'ui:settings-button',
  'ui:inbox-button',
  'ui:theme-picker',
  'ui:add-widget',
]);

/** Command the scheduler roundtrip schedules and cancels. Does nothing. */
const NOOP_COMMAND_ID = 'diagnose.noop';

function ensureNoopCommand(): void {
  const { commands } = getHost();
  if (commands.has(NOOP_COMMAND_ID)) return;
  commands.register({
    id: NOOP_COMMAND_ID,
    titleKey: 'diagnose.check.schedulerRoundtrip',
    params: z.object({}),
    palette: false,
    run: async () => ({ ok: true }),
  });
}

/**
 * Mounts one widget into a detached hidden container with a scratch tool
 * context, waits a tick for effects, and reports any throw or console.error
 * emitted during the render window.
 */
async function renderWidgetProbe(
  factory: () => CardoTool,
  widgetId: string,
  defaultSize: { w: number; h: number },
): Promise<SelfTestResult> {
  const host = getHost();
  const { registry } = createScratchContext(host.services);
  const instance = factory();
  const toolId = instance.manifest.id;
  registry.register(instance);
  await registry.activate(toolId);

  const errors: string[] = [];
  const originalConsoleError = console.error;
  const onWindowError = (ev: ErrorEvent) => {
    errors.push(String(ev.message));
    ev.preventDefault();
  };

  const container = document.createElement('div');
  container.style.position = 'fixed';
  container.style.left = '-10000px';
  container.style.top = '0';
  container.style.width = '480px';
  container.style.height = '360px';
  container.style.visibility = 'hidden';
  container.setAttribute('aria-hidden', 'true');
  document.body.appendChild(container);
  const root = createRoot(container);

  try {
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
      originalConsoleError(...args);
    };
    window.addEventListener('error', onWindowError);
    flushSync(() => {
      root.render(
        createElement(instance.Widget, {
          instanceId: 'diag',
          widgetId,
          size: defaultSize,
          editing: false,
        }),
      );
    });
    // Let mount effects (timers, async loads) settle before unmounting.
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));
  } catch (err) {
    errors.push(String(err));
  } finally {
    window.removeEventListener('error', onWindowError);
    console.error = originalConsoleError;
    try {
      root.unmount();
    } catch (err) {
      errors.push(`unmount: ${String(err)}`);
    }
    container.remove();
    await registry.deactivate(toolId).catch((err) => errors.push(`deactivate: ${String(err)}`));
  }

  return errors.length > 0
    ? { status: 'fail', detail: errors.slice(0, 3).join('; ').slice(0, 500) }
    : { status: 'pass' };
}

function widgetRenderChecks(): DiagnoseCheck[] {
  const checks: DiagnoseCheck[] = [];
  for (const factory of Object.values(toolFactories)) {
    const manifest = factory().manifest;
    for (const widget of manifest.widgets) {
      checks.push({
        id: `ui:widget:${manifest.id}:${widget.id}`,
        titleKey: 'diagnose.check.widgetRender',
        titleVars: { tool: manifest.id, widget: widget.id },
        category: 'ui',
        run: () => renderWidgetProbe(factory, widget.id, widget.defaultSize),
      });
    }
  }
  return checks;
}

function commandFormsCheck(): DiagnoseCheck {
  return {
    id: 'ui:command-forms',
    titleKey: 'diagnose.check.commandForms',
    category: 'ui',
    async run() {
      const host = getHost();
      const problems: string[] = [];
      for (const factory of Object.values(toolFactories)) {
        const { registry, commands } = createScratchContext(host.services);
        const instance = factory();
        registry.register(instance);
        try {
          await registry.activate(instance.manifest.id);
        } catch (err) {
          problems.push(`${instance.manifest.id}: ${String(err)}`);
          continue;
        }
        for (const spec of commands.list()) {
          try {
            const fields = paramFields(spec.params as z.ZodType);
            const supported: string[] = ['string', 'number', 'boolean'];
            for (const field of fields) {
              if (!supported.includes(field.kind)) {
                problems.push(`${spec.id}: field "${field.name}" has unsupported kind`);
              }
            }
          } catch (err) {
            problems.push(`${spec.id}: ${String(err)}`);
          }
        }
        await registry.deactivate(instance.manifest.id).catch(() => {});
      }
      return problems.length > 0
        ? { status: 'fail', detail: problems.join('; ') }
        : { status: 'pass' };
    },
  };
}

function tourAnchorsCheck(): DiagnoseCheck {
  return {
    id: 'ui:tour-anchors',
    titleKey: 'diagnose.check.tourAnchors',
    category: 'ui',
    async run() {
      const problems: string[] = [];
      for (const factory of Object.values(toolFactories)) {
        const manifest = factory().manifest;
        const ownWidgetAnchors = new Set(
          manifest.widgets.map((w) => `widget:${manifest.id}:${w.id}`),
        );
        for (const step of manifest.tourSteps) {
          if (!ownWidgetAnchors.has(step.anchor) && !CORE_TOUR_ANCHORS.has(step.anchor)) {
            problems.push(`${manifest.id}: unknown anchor "${step.anchor}"`);
          }
        }
      }
      return problems.length > 0
        ? { status: 'fail', detail: problems.join('; ') }
        : { status: 'pass' };
    },
  };
}

function themeRoundtripCheck(): DiagnoseCheck {
  return {
    id: 'ui:theme-roundtrip',
    titleKey: 'diagnose.check.themeRoundtrip',
    category: 'ui',
    async run() {
      const { themeId, accentToken } = useAppStore.getState();
      const broken: string[] = [];
      try {
        for (const theme of themes) {
          applyTheme(theme.id);
          const accent = getComputedStyle(document.documentElement)
            .getPropertyValue('--accent')
            .trim();
          if (accent === '') broken.push(theme.id);
        }
      } finally {
        applyTheme(themeId, { accentToken });
        await loadAndApplyStoredDesign();
      }
      return broken.length > 0
        ? { status: 'fail', detail: `--accent empty for: ${broken.join(', ')}` }
        : { status: 'pass' };
    },
  };
}

function languageRoundtripCheck(): DiagnoseCheck {
  return {
    id: 'ui:language-roundtrip',
    titleKey: 'diagnose.check.languageRoundtrip',
    category: 'ui',
    async run() {
      const original = i18next.language;
      const other = original.startsWith('de') ? 'en' : 'de';
      const before = String(i18next.t('common.save'));
      try {
        await i18next.changeLanguage(other);
        const after = String(i18next.t('common.save'));
        if (after === before) {
          return {
            status: 'fail',
            detail: `t('common.save') did not change when switching ${original} → ${other}`,
          };
        }
      } finally {
        await i18next.changeLanguage(original);
      }
      return { status: 'pass' };
    },
  };
}

function schedulerRoundtripCheck(): DiagnoseCheck {
  return {
    id: 'ui:scheduler-roundtrip',
    titleKey: 'diagnose.check.schedulerRoundtrip',
    category: 'ui',
    async run() {
      if (!isTauri()) return { status: 'warn', detail: tt('diagnose.detail.browserSkipped') };
      ensureNoopCommand();
      const { scheduler } = getHost().services;
      const id = await scheduler.scheduleAt(
        new Date(Date.now() + 60 * 60 * 1000),
        NOOP_COMMAND_ID,
        {},
      );
      try {
        const listed = (await scheduler.list()).some((entry) => entry.id === id);
        if (!listed) return { status: 'fail', detail: 'scheduled entry missing from list()' };
      } finally {
        await scheduler.cancel(id);
      }
      const stillListed = (await scheduler.list()).some((entry) => entry.id === id);
      return stillListed
        ? { status: 'fail', detail: 'cancelled entry still in list()' }
        : { status: 'pass' };
    },
  };
}

function designDocRoundtripCheck(): DiagnoseCheck {
  return {
    id: 'ui:design-doc-roundtrip',
    titleKey: 'diagnose.check.designDocRoundtrip',
    category: 'ui',
    async run() {
      const { backend } = getHost();
      const [namespace, id] = DESIGN_DOC;
      const doc = await backend.get(namespace, id);
      if (doc === null || typeof doc !== 'object') {
        return { status: 'warn', detail: tt('diagnose.detail.noDesignDoc') };
      }
      // Write the document back unchanged: verifies the write path without
      // altering any state.
      await backend.set(namespace, id, doc as Record<string, unknown>);
      return { status: 'pass' };
    },
  };
}

export function buildUiChecks(): DiagnoseCheck[] {
  return [
    ...widgetRenderChecks(),
    commandFormsCheck(),
    tourAnchorsCheck(),
    themeRoundtripCheck(),
    languageRoundtripCheck(),
    schedulerRoundtripCheck(),
    designDocRoundtripCheck(),
  ];
}
