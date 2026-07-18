// @vitest-environment jsdom
//
// Regression guard for the "UK selected, German books shown → HTTP 404" report.
// Germany's book list is a slow ~6000-entry fetch; the UK list is instant. If
// the user picks Germany then switches to the UK before Germany resolves, the
// late German response must NOT clobber the UK books — otherwise the next fetch
// sends a German book id to the UK adapter and 404s.
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestContext } from '@cardo/plugin-api/testing';
import type { LegalApi, ToolContext, WidgetProps } from '@cardo/plugin-api';
import { createTool } from './index';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

const widgetProps = {
  instanceId: 'test',
  widgetId: 'legal-dictionary',
  size: { w: 4, h: 4 },
  editing: false,
} as unknown as WidgetProps;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function click(el: Element): Promise<void> {
  return act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function setSelect(sel: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    sel.value = value;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function findButtonByText(el: HTMLElement, needle: string): HTMLButtonElement | undefined {
  return [...el.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(needle)) as
    | HTMLButtonElement
    | undefined;
}

describe('legal online flow: source/book desync guard', () => {
  it('a late German book list does not overwrite the freshly-picked UK books', async () => {
    let resolveDe: (() => void) | null = null;
    const legal: LegalApi = {
      sources: async () => [
        { id: 'de', name: 'Deutschland', jurisdiction: 'DE', requiresKey: false, hosts: [] },
        { id: 'uk', name: 'United Kingdom', jurisdiction: 'UK', requiresKey: false, hosts: [] },
      ],
      listBooks: async (id: string) => {
        if (id === 'de') {
          // Simulate the slow ~6000-entry TOC: resolve only when we say so.
          return new Promise((res) => {
            resolveDe = () => res([{ id: 'bgb', name: 'BGB — Buergerliches Gesetzbuch' }]);
          });
        }
        return [{ id: 'ukpga/2018/12', name: 'Data Protection Act 2018' }];
      },
      listNorms: async () => [],
      fetchNorm: async () => ({ text: '', stand: '', sourceUrl: '' }),
    } as unknown as LegalApi;

    const ctx = createTestContext() as ToolContext;
    (ctx as { legal?: LegalApi }).legal = legal;
    const tool = createTool();
    await tool.activate(ctx);
    const Widget = tool.Widget;

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<Widget {...widgetProps} />);
    });
    await flush();

    // Open the add menu, then the online path.
    await click(findButtonByText(container, '+')!);
    await flush();
    await click(findButtonByText(container, 'tool.legal-dictionary.online.fetch')!);
    await flush();

    const sourceSelect = container.querySelector('select') as HTMLSelectElement;
    expect(sourceSelect, 'source select must be present').toBeTruthy();

    // Pick Germany (slow, still pending), then immediately switch to the UK.
    await setSelect(sourceSelect, 'de');
    await setSelect(sourceSelect, 'uk');
    await flush();

    // Now let the stale German response arrive late.
    expect(resolveDe, 'German list should have been requested').not.toBeNull();
    await act(async () => {
      resolveDe!();
    });
    await flush();

    // The guard must have discarded the late German books.
    expect(container.textContent).toContain('Data Protection Act 2018');
    expect(container.textContent).not.toContain('Buergerliches Gesetzbuch');
  });
});
