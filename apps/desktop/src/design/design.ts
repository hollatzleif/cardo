import { getHost } from '../host';

/**
 * Design engine: user-level visual overrides on top of the active theme.
 *
 * Everything is applied as inline CSS custom properties / data attributes on
 * <html> (Layer 3 in tokens.css), so overrides win by specificity and survive
 * theme switches – the host re-applies them via loadAndApplyStoredDesign()
 * after every applyTheme() call and once at startup.
 *
 * No color literals live in this file: user-picked colors arrive at runtime
 * from <input type="color">, everything else references design tokens.
 */

export const FONT_PRESETS = ['system', 'humanist', 'serif', 'rounded', 'monospace'] as const;
export type FontPreset = (typeof FONT_PRESETS)[number];

export const BACKGROUND_FITS = ['cover', 'contain', 'tile'] as const;
export type BackgroundFit = (typeof BACKGROUND_FITS)[number];

export const DENSITIES = ['compact', 'normal', 'airy'] as const;
export type Density = (typeof DENSITIES)[number];

export interface DesignOverrides {
  /* Typography */
  fontPreset?: FontPreset;
  /** Custom font family – wins over the preset. */
  fontFamily?: string;
  /** Font size in percent, 80–125. */
  fontScale?: number;

  /* Colors (values come from color inputs at runtime) */
  accent?: string;
  bgCanvas?: string;
  bgWidget?: string;
  textPrimary?: string;
  borderSubtle?: string;

  /* Background image */
  /** data: URL of the picked image. */
  bgImage?: string;
  bgFit?: BackgroundFit;
  /** Dim overlay strength in percent, 0–60. */
  bgDim?: number;
  /** Blur in px, 0–12. */
  bgBlur?: number;

  /* Widgets */
  /** Corner radius in px (maps to --radius-md; sm/lg scale proportionally), 0–24. */
  radius?: number;
  /** Widget background transparency in percent, 0–40. */
  widgetAlpha?: number;
  /** Drop shadow on widgets – default true. */
  shadow?: boolean;
  /** Border on widgets – default true. */
  border?: boolean;

  /* Layout */
  density?: Density;
}

/** Storage location: namespace + document id. */
export const DESIGN_DOC = ['core.design', 'current'] as const;

const FONT_STACKS: Record<FontPreset, string> = {
  system:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  humanist:
    "Seravek, 'Gill Sans Nova', Ubuntu, Calibri, 'DejaVu Sans', 'Trebuchet MS', sans-serif",
  serif: "'Iowan Old Style', 'Palatino Linotype', Palatino, P052, Georgia, 'Times New Roman', serif",
  rounded:
    "ui-rounded, 'Hiragino Maru Gothic ProN', Quicksand, Comfortaa, 'Arial Rounded MT Bold', 'Segoe UI', sans-serif",
  monospace: "ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, monospace",
};

/** Default --space-1 … --space-8 values from tokens.css (px). */
const SPACE_BASE = [4, 8, 12, 16, 24, 32, 48, 64] as const;
const DENSITY_FACTOR: Record<Density, number> = { compact: 0.75, normal: 1, airy: 1.3 };

/** Default --radius-md and the sm/lg ratios derived from tokens.css (6/10/16). */
const RADIUS_SM_RATIO = 0.6;
const RADIUS_LG_RATIO = 1.6;

/**
 * Properties / dataset keys this module set during the previous applyDesign
 * call. Anything managed before but absent now gets removed, which makes
 * applyDesign idempotent AND keeps it from clobbering inline properties other
 * engines own (e.g. --accent set by applyTheme's accent-token override).
 */
const managedProps = new Set<string>();
const managedData = new Set<string>();

/** Applies (or clears) all overrides on document.documentElement. Idempotent. */
export function applyDesign(d: DesignOverrides): void {
  const root = document.documentElement;
  const props = new Map<string, string>();
  const data = new Map<string, string>();

  /* Typography */
  if (d.fontFamily && d.fontFamily.trim() !== '') {
    props.set('--font-ui', `${d.fontFamily.trim()}, ${FONT_STACKS.system}`);
  } else if (d.fontPreset && d.fontPreset !== 'system') {
    props.set('--font-ui', FONT_STACKS[d.fontPreset]);
  }
  if (typeof d.fontScale === 'number' && d.fontScale !== 100) {
    props.set('--font-scale', String(d.fontScale / 100));
  }

  /* Colors */
  if (d.accent) props.set('--accent', d.accent);
  if (d.bgCanvas) props.set('--bg-canvas', d.bgCanvas);
  if (d.textPrimary) props.set('--text-primary', d.textPrimary);
  if (d.borderSubtle) props.set('--border-subtle', d.borderSubtle);

  /* Widget background: color override and/or transparency via color-mix. */
  const widgetBase = d.bgWidget ?? 'var(--palette-surface-0)';
  if (typeof d.widgetAlpha === 'number' && d.widgetAlpha > 0) {
    props.set(
      '--bg-widget',
      `color-mix(in srgb, ${widgetBase} ${Math.round(100 - d.widgetAlpha)}%, transparent)`,
    );
  } else if (d.bgWidget) {
    props.set('--bg-widget', d.bgWidget);
  }

  /* Background image (consumed by design.css on the .app element). */
  if (d.bgImage) {
    props.set('--canvas-bg-image', `url("${d.bgImage}")`);
    props.set('--design-bg-dim', `${d.bgDim ?? 0}%`);
    props.set('--design-bg-blur', `${d.bgBlur ?? 0}px`);
    data.set('designBg', 'on');
    data.set('designBgFit', d.bgFit ?? 'cover');
  }

  /* Widgets */
  if (typeof d.radius === 'number') {
    props.set('--radius-sm', `${Math.round(d.radius * RADIUS_SM_RATIO)}px`);
    props.set('--radius-md', `${Math.round(d.radius)}px`);
    props.set('--radius-lg', `${Math.round(d.radius * RADIUS_LG_RATIO)}px`);
  }
  if (d.shadow === false) props.set('--shadow-widget', 'none');
  if (d.border === false) data.set('designWidgetBorder', 'off');

  /* Layout density */
  if (d.density && d.density !== 'normal') {
    const factor = DENSITY_FACTOR[d.density];
    SPACE_BASE.forEach((px, i) => {
      props.set(`--space-${i + 1}`, `${Math.round(px * factor)}px`);
    });
  }

  /* Reconcile: remove what we managed before but no longer set. */
  for (const name of managedProps) {
    if (!props.has(name)) root.style.removeProperty(name);
  }
  managedProps.clear();
  for (const [name, value] of props) {
    root.style.setProperty(name, value);
    managedProps.add(name);
  }

  for (const key of managedData) {
    if (!data.has(key)) delete root.dataset[key];
  }
  managedData.clear();
  for (const [key, value] of data) {
    root.dataset[key] = value;
    managedData.add(key);
  }

  /* Font scale as a font-size on :root, in percent (rem-based text scales). */
  root.style.fontSize =
    typeof d.fontScale === 'number' && d.fontScale !== 100 ? `${d.fontScale}%` : '';
}

/** Persists the given overrides (whole document, replace semantics). */
export async function saveDesign(d: DesignOverrides): Promise<void> {
  const [namespace, id] = DESIGN_DOC;
  await getHost().backend.set(namespace, id, { value: d as Record<string, unknown> });
}

/**
 * Loads the stored overrides, applies them and returns them.
 * The host calls this once at startup and again after every theme switch
 * (AFTER applyTheme), so user design survives theme changes.
 */
export async function loadAndApplyStoredDesign(): Promise<DesignOverrides> {
  const [namespace, id] = DESIGN_DOC;
  let overrides: DesignOverrides = {};
  try {
    const raw = await getHost().backend.get(namespace, id);
    if (raw && typeof raw === 'object' && 'value' in raw) {
      const value = (raw as { value?: unknown }).value;
      if (value && typeof value === 'object') overrides = value as DesignOverrides;
    }
  } catch {
    // Corrupt/missing document – fall back to theme defaults.
    overrides = {};
  }
  applyDesign(overrides);
  return overrides;
}

/**
 * Normalizes any CSS color string to #rrggbb via a canvas 2d context, so it
 * can feed an <input type="color">. Returns the input unchanged if it cannot
 * be normalized. No color literals involved – values come from the live theme.
 */
export function cssColorToHex(cssColor: string): string {
  const color = cssColor.trim();
  if (color === '') return color;
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return color;
  ctx.fillStyle = color;
  const normalized = ctx.fillStyle;
  return typeof normalized === 'string' && /^#[0-9a-f]{6}$/i.test(normalized)
    ? normalized
    : color;
}

/** Reads the current (theme-resolved) value of a CSS variable as #rrggbb. */
export function currentTokenHex(varName: string): string {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName);
  return cssColorToHex(raw);
}
