import { getTheme, type Theme, REQUIRED_PALETTE_TOKENS } from '@cardo/themes';

/**
 * Theme engine: applies a theme's primitive palette as CSS custom properties
 * on <html>. Semantic tokens (tokens.css) pick them up automatically.
 * User overrides are applied AFTER the palette so they survive theme changes.
 */

export interface UserThemeOverrides {
  /** Global accent override, e.g. "--palette-accent-3" reference or a palette token name. */
  accentToken?: string;
}

export function applyTheme(themeId: string, overrides: UserThemeOverrides = {}): Theme {
  const theme = getTheme(themeId);
  const root = document.documentElement;
  for (const token of REQUIRED_PALETTE_TOKENS) {
    root.style.setProperty(`--palette-${token}`, theme.palette[token]);
  }
  root.dataset.theme = theme.id;
  root.dataset.appearance = theme.appearance;

  // Layer 3: user overrides – re-applied on every theme switch.
  if (overrides.accentToken) {
    root.style.setProperty('--accent', `var(--palette-${overrides.accentToken})`);
  } else {
    root.style.removeProperty('--accent');
  }
  return theme;
}

/** Per-widget accent override: returns inline style for a widget container. */
export function widgetAccentStyle(accentToken?: string): Record<string, string> {
  if (!accentToken) return {};
  return { '--accent': `var(--palette-${accentToken})` };
}
