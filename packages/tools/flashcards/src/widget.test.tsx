// @vitest-environment jsdom
//
// The widget must expose every view — decks/manage, study, stats — through a
// visible in-widget tab bar, and open on the deck-management view (like Anki's
// home screen) so Import / Add / Options are reachable without hunting for the
// frame's variant picker. This is the regression guard for the "empty widget
// with no buttons" report.
import { afterEach, describe, expect, it } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createTestContext } from '@cardo/plugin-api/testing';
import type { WidgetProps } from '@cardo/plugin-api';
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

const widgetProps: WidgetProps = {
  instanceId: 'test',
  widgetId: 'flashcards',
  size: { w: 4, h: 4 },
  editing: false,
} as unknown as WidgetProps;

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function mountWidget() {
  const ctx = createTestContext();
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
  return container!;
}

function buttons(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll('button')] as HTMLButtonElement[];
}

describe('flashcards widget tab bar', () => {
  it('renders all three tab buttons', async () => {
    const el = await mountWidget();
    const labels = buttons(el).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('tool.flashcards.tab.manage'))).toBe(true);
    expect(labels.some((l) => l.includes('tool.flashcards.tab.study'))).toBe(true);
    expect(labels.some((l) => l.includes('tool.flashcards.tab.stats'))).toBe(true);
  });

  it('opens on the manage view so add/options are visible', async () => {
    const el = await mountWidget();
    const labels = buttons(el).map((b) => b.textContent ?? '');
    // ManagePane's toolbar: the add-card and options buttons.
    expect(labels.some((l) => l.includes('tool.flashcards.toolbar.add'))).toBe(true);
    expect(labels.some((l) => l.includes('tool.flashcards.toolbar.options'))).toBe(true);
  });

  it('switches to the study view when the study tab is clicked', async () => {
    const el = await mountWidget();
    const studyTab = buttons(el).find((b) => (b.textContent ?? '').includes('tool.flashcards.tab.study'));
    expect(studyTab, 'study tab button must exist').toBeDefined();
    await act(async () => {
      studyTab!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    // The study empty-state string is unique to the study view.
    expect(el.textContent).toContain('tool.flashcards.widget.empty');
    // The manage-only add-card button is gone.
    const labels = buttons(el).map((b) => b.textContent ?? '');
    expect(labels.some((l) => l.includes('tool.flashcards.toolbar.add'))).toBe(false);
  });
});
