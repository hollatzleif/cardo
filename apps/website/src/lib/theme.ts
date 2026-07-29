/**
 * The website's colours, taken from the SAME theme files the desktop app uses.
 *
 * Until now `Base.astro` carried 18 hand-copied hex literals — a verbatim
 * duplicate of catppuccin-mocha.json and catppuccin-latte.json. Two sources for
 * one set of colours drift apart silently: nothing checked that they still
 * matched, and nothing would have noticed if a theme changed.
 *
 * Everything here runs in Astro frontmatter, i.e. at BUILD time. The browser
 * only ever receives the finished CSS custom properties, never this module.
 *
 * Note on lint: this is a `.ts` file, so ESLint's "no hardcoded colors" rule
 * applies to it. That is deliberate — it makes copying a hex in here
 * impossible and forces the values to come from the theme package.
 */
import { themes, type Theme } from '@cardo/themes';

/** Cardo's default dark theme — the site's primary appearance. */
const DARK_ID = 'catppuccin-mocha';
/** Its light counterpart, used under `prefers-color-scheme: light`. */
const LIGHT_ID = 'catppuccin-latte';

function byId(id: string): Theme {
  const theme = themes.find((t) => t.id === id);
  if (!theme) {
    // A renamed or removed theme must fail the build loudly rather than
    // silently ship a site with no colours at all.
    throw new Error(`theme "${id}" not found in @cardo/themes`);
  }
  return theme;
}

export const darkTheme = byId(DARK_ID);
export const lightTheme = byId(LIGHT_ID);

/**
 * Every theme the app ships, for the site's own theme picker.
 *
 * Shipping all twenty costs 2 KB gzipped — cheap enough that demonstrating
 * Cardo's theming beats describing it. Sorted dark first, then light, so the
 * picker opens on the appearances most visitors will see.
 */
export const allThemes: Theme[] = [...themes].sort((a, b) =>
  a.appearance === b.appearance ? a.id.localeCompare(b.id) : a.appearance === 'dark' ? -1 : 1,
);

/**
 * One `[data-theme="…"]` block per theme, for the whole set.
 *
 * The site's default colours still come from `prefers-color-scheme` (see
 * Base.astro); these blocks only take over once the visitor picks a theme, at
 * which point `data-theme` on `<html>` wins by specificity.
 */
export function allThemeBlocks(): string {
  return allThemes
    .map((theme) => `[data-theme="${theme.id}"] {\n        ${cssVars(theme)}\n      }`)
    .join('\n      ');
}

/** Human-readable name, derived from the id since nameKey is an i18n key. */
export function themeLabel(theme: Theme): string {
  return theme.id
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * CSS custom properties for one theme.
 *
 * Names stay as the website has always used them (`--base`, `--surface-0`, …)
 * so no existing page style breaks; only their VALUES now come from the theme
 * package. The palette is widened by tokens the site never had — `--surface-2`,
 * the eight accents and `--info` — which the redesign needs to give the board
 * mockup and feature cards distinct, on-brand colours.
 */
export function cssVars(theme: Theme): string {
  const p = theme.palette;
  const lines = [
    `--base: ${p.base};`,
    `--surface-0: ${p['surface-0']};`,
    `--surface-1: ${p['surface-1']};`,
    `--surface-2: ${p['surface-2']};`,
    `--text: ${p.text};`,
    `--text-muted: ${p['text-muted']};`,
    `--accent: ${p['accent-1']};`,
    `--success: ${p.success};`,
    `--warning: ${p.warning};`,
    `--danger: ${p.danger};`,
    `--info: ${p.info};`,
    // The app's own semantic layer (packages/ui/src/tokens.css). The decorative
    // widgets on this site are styled against these names, so they inherit the
    // real product's visual language instead of an approximation of it.
    `--bg-canvas: ${p.base};`,
    `--bg-widget: ${p['surface-0']};`,
    `--bg-widget-hover: ${p['surface-1']};`,
    `--bg-raised: ${p['surface-1']};`,
    `--text-primary: ${p.text};`,
    `--border-subtle: ${p['surface-2']};`,
    `--accent-text: ${p.base};`,
  ];
  for (let i = 1; i <= 8; i += 1) {
    lines.push(`--accent-${i}: ${p[`accent-${i}` as keyof typeof p]};`);
  }
  return lines.join('\n        ');
}

/**
 * The app's non-colour tokens, copied by name so widget decoration matches the
 * product pixel for pixel: same radii, same spacing rhythm, same shadow.
 * Identical to packages/ui/src/tokens.css.
 */
export const SHAPE_VARS = `
        --radius-sm: 6px;
        --radius-md: 10px;
        --radius-lg: 16px;
        --shadow-widget: 0 2px 8px 0 color-mix(in srgb, var(--base) 60%, transparent);
        --space-1: 4px;
        --space-2: 8px;
        --space-3: 12px;
        --space-4: 16px;
        --space-5: 24px;
        --space-6: 32px;
        --space-7: 48px;
        --space-8: 64px;
        --font-mono: ui-monospace, 'SF Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, monospace;`;

/**
 * `#rrggbb` → the same value as a number, which is what Vanta expects.
 *
 * Writing those numbers as literals in source would technically satisfy
 * ESLint's colour rule — it only inspects strings — while defeating its
 * purpose. So the conversion happens here and the input always comes from a
 * theme file.
 */
export function hexToNumber(hex: string): number {
  const clean = hex.trim().replace('#', '');
  const full =
    clean.length === 3
      ? clean
          .split('')
          .map((c) => c + c)
          .join('')
      : clean;
  // Validate the characters, not just the result: parseInt stops at the first
  // invalid digit, so a typo yields a plausible-looking number instead of an
  // error — exactly the kind of silent wrongness a build should refuse.
  if (!/^[0-9a-f]{6}$/i.test(full)) {
    throw new Error(`cannot convert "${hex}" to a colour number`);
  }
  return Number.parseInt(full, 16);
}

/**
 * Vanta FOG configuration for one theme.
 *
 * FOG rather than WAVES for two concrete reasons:
 *
 * - **Look.** WAVES is flat-shaded low-poly: hard facet edges at full accent
 *   saturation, directly behind the headline. FOG is a smooth low-frequency
 *   field — atmospheric depth rather than an object, which is what a dark,
 *   typographic layout wants behind it.
 * - **Cost.** WAVES recomputes 8181 vertices and calls computeVertexNormals()
 *   over ~16 000 triangles every frame, on the same main thread where Lenis
 *   interpolates the scroll position. FOG defines no per-frame CPU work at
 *   all; everything happens in the fragment shader.
 *
 * The palette walks base → surface → accent so it reads as the product's own
 * colours diffused, not as a stock gradient.
 */
export function heroPalette(theme: Theme): Record<string, number> {
  const p = theme.palette;
  return {
    baseColor: hexToNumber(p.base),
    lowlightColor: hexToNumber(p['surface-0']),
    midtoneColor: hexToNumber(p['surface-1']),
    highlightColor: hexToNumber(p['accent-1']),
    blurFactor: 0.62,
    zoom: 0.85,
    speed: 0.65,
  };
}
