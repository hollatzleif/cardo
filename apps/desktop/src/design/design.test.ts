// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { applyDesign, clampGutter, getDesignChrome, getGridGutter, DEFAULT_GUTTER } from './design';
import { gridPitch } from '../canvas/WidgetFrame';
import { DESIGN_PRESETS } from './presets';
import { themes } from '@cardo/themes';

const root = () => document.documentElement;

afterEach(() => applyDesign({}));

describe('terminal chrome and gutter', () => {
  it('sets and clears the chrome attribute and runtime value', () => {
    applyDesign({ chrome: 'terminal' });
    expect(root().dataset.designChrome).toBe('terminal');
    expect(getDesignChrome()).toBe('terminal');
    applyDesign({});
    expect(root().dataset.designChrome).toBeUndefined();
    expect(getDesignChrome()).toBe('default');
  });

  it('ignores an unknown chrome value from a corrupt document', () => {
    applyDesign({ chrome: 'neon' as never });
    expect(root().dataset.designChrome).toBeUndefined();
    expect(getDesignChrome()).toBe('default');
  });

  it('publishes the gutter and its CSS variable, defaulting to 12', () => {
    applyDesign({ gutter: 2 });
    expect(getGridGutter()).toBe(2);
    expect(root().style.getPropertyValue('--grid-gutter')).toBe('2px');
    applyDesign({});
    expect(getGridGutter()).toBe(DEFAULT_GUTTER);
    expect(root().style.getPropertyValue('--grid-gutter')).toBe('');
  });

  it('clamps the gutter to 0–24', () => {
    expect(clampGutter(-5)).toBe(0);
    expect(clampGutter(99)).toBe(24);
    expect(clampGutter(3.6)).toBe(4);
    expect(clampGutter(undefined)).toBe(DEFAULT_GUTTER);
    expect(clampGutter(Number.NaN)).toBe(DEFAULT_GUTTER);
  });
});

describe('gridPitch', () => {
  it('derives column/row pitch from a rendered item and the gutter', () => {
    // 3 columns of 100px with 2px gaps: 3*100 + 2*2 = 304px wide.
    expect(gridPitch(304, 56, 3, 1, 2)).toEqual({ x: 102, y: 58 });
    expect(gridPitch(100, 56, 1, 1, 0)).toEqual({ x: 100, y: 56 });
  });
});

describe('design presets', () => {
  it('have unique ids and reference existing themes', () => {
    const ids = DESIGN_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const preset of DESIGN_PRESETS) {
      expect(themes.some((t) => t.id === preset.themeId)).toBe(true);
    }
  });

  it('market terminal preset uses the terminal chrome, square corners and a tight gutter', () => {
    const preset = DESIGN_PRESETS.find((p) => p.id === 'market-terminal');
    expect(preset?.design).toMatchObject({ chrome: 'terminal', radius: 0, gutter: 2 });
  });
});
