import { describe, expect, it } from 'vitest';
import { parseLayout, serializeLayout, type LayoutFile } from './layout';
import type { Page } from '../state/appStore';

const pages: Page[] = [
  {
    id: 'page-original',
    name: 'Arbeit',
    order: 0,
    widgets: [
      {
        instanceId: 'w-original',
        toolId: 'todo',
        widgetId: 'main',
        x: 0,
        y: 0,
        w: 4,
        h: 3,
        variant: 'list',
      },
      { instanceId: 'w-2', toolId: 'clock', widgetId: 'main', x: 4, y: 0, w: 2, h: 2 },
    ],
  },
];

const known = new Set(['todo', 'clock']);

describe('layout export/import', () => {
  it('serialize strips ids and keeps geometry + variant', () => {
    const file = serializeLayout(pages);
    expect(file.kind).toBe('cardo-layout');
    expect(file.pages[0]?.widgets[0]).toEqual({
      toolId: 'todo',
      widgetId: 'main',
      x: 0,
      y: 0,
      w: 4,
      h: 3,
      variant: 'list',
    });
    expect(JSON.stringify(file)).not.toContain('w-original');
    expect(JSON.stringify(file)).not.toContain('page-original');
  });

  it('roundtrip mints fresh ids and preserves structure', () => {
    const file = serializeLayout(pages);
    let n = 0;
    const parsed = parseLayout(file, known, 3, () => `fresh-${n++}`);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.pages).toHaveLength(1);
    expect(parsed.pages[0]?.id).toBe('page-fresh-0');
    expect(parsed.pages[0]?.order).toBe(3); // appended after existing pages
    expect(parsed.pages[0]?.widgets[0]?.instanceId).toBe('w-fresh-1');
    expect(parsed.pages[0]?.widgets[0]?.toolId).toBe('todo');
    expect(parsed.missingTools).toEqual([]);
  });

  it('drops widgets of unknown tools and reports them', () => {
    const file = serializeLayout(pages);
    const parsed = parseLayout(file, new Set(['todo']), 0);
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.pages[0]?.widgets).toHaveLength(1);
    expect(parsed.missingTools).toEqual(['clock']);
  });

  it('rejects foreign or broken files with a readable error', () => {
    expect('error' in (parseLayout({ hello: 'world' }, known, 0) as object)).toBe(true);
    expect('error' in (parseLayout(null, known, 0) as object)).toBe(true);
    const wrongKind = { ...serializeLayout(pages), kind: 'other' };
    expect('error' in (parseLayout(wrongKind, known, 0) as object)).toBe(true);
  });

  it('design travels only when present', () => {
    expect('design' in serializeLayout(pages)).toBe(false);
    expect('design' in serializeLayout(pages, {})).toBe(false);
    const file: LayoutFile = serializeLayout(pages, { density: 'compact' });
    expect(file.design).toEqual({ density: 'compact' });
  });
});
