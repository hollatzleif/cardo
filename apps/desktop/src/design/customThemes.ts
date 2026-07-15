import { REQUIRED_PALETTE_TOKENS, validateTheme, type Theme } from '@cardo/themes';
import { resolveTheme, setCustomThemes } from '@cardo/ui';
import { getHost } from '../host';

/**
 * Theme editor storage: user themes live as ONE document (they sync with
 * everything else) and are registered with the ui theme engine so they
 * resolve by id exactly like built-ins.
 */

export const CUSTOM_THEMES_DOC = ['core.design', 'custom-themes'] as const;

export async function loadCustomThemes(): Promise<Theme[]> {
  const [namespace, id] = CUSTOM_THEMES_DOC;
  try {
    const doc = await getHost().backend.get(namespace, id);
    const list = (doc as { themes?: unknown } | null)?.themes;
    if (!Array.isArray(list)) return [];
    // Only structurally complete themes make it into the registry.
    return list.filter(
      (theme): theme is Theme =>
        typeof theme === 'object' &&
        theme !== null &&
        validateTheme(theme as Theme).length === 0,
    );
  } catch {
    return [];
  }
}

/** Startup + after every edit: (re)register with the ui engine. */
export async function registerCustomThemes(): Promise<Theme[]> {
  const themes = await loadCustomThemes();
  setCustomThemes(themes);
  return themes;
}

async function persist(themes: Theme[]): Promise<void> {
  const [namespace, id] = CUSTOM_THEMES_DOC;
  await getHost().backend.set(namespace, id, { themes: themes as unknown as Record<string, unknown>[] });
  setCustomThemes(themes);
}

/** kebab-case id from the display name, prefixed to never clash with built-ins. */
export function customThemeId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `custom-${slug || 'theme'}`;
}

/** Derives an editable copy of the given theme (starting point for the editor). */
export function deriveFrom(base: Theme, name: string): Theme {
  return {
    id: customThemeId(name),
    nameKey: name, // custom themes carry their display name directly (no i18n key)
    appearance: base.appearance,
    license: { spdx: 'CC0-1.0', source: 'cardo-theme-editor' },
    palette: { ...base.palette },
  };
}

/** The display label: custom themes store the raw name in nameKey. */
export function customThemeLabel(theme: Theme): string {
  return theme.nameKey;
}

export async function saveCustomTheme(theme: Theme): Promise<string | null> {
  const problems = validateTheme(theme);
  if (problems.length > 0) return problems.join(', ');
  const themes = await loadCustomThemes();
  const next = [...themes.filter((t) => t.id !== theme.id), theme];
  await persist(next);
  return null;
}

export async function deleteCustomTheme(id: string): Promise<void> {
  const themes = await loadCustomThemes();
  await persist(themes.filter((t) => t.id !== id));
}

export function exportCustomTheme(theme: Theme): string {
  return JSON.stringify(theme, null, 2);
}

/** Import: validates and normalizes an editor/exported theme JSON. */
export function parseImportedTheme(raw: string): Theme | { error: string } {
  try {
    const parsed = JSON.parse(raw) as Partial<Theme>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.nameKey !== 'string') {
      return { error: 'not a theme file' };
    }
    const theme: Theme = {
      id: parsed.id?.startsWith('custom-') ? parsed.id : customThemeId(parsed.nameKey),
      nameKey: parsed.nameKey,
      appearance: parsed.appearance === 'light' ? 'light' : 'dark',
      license: parsed.license ?? { spdx: 'CC0-1.0', source: 'cardo-theme-editor' },
      palette: parsed.palette as Theme['palette'],
    };
    const problems = validateTheme(theme);
    return problems.length > 0 ? { error: problems.join(', ') } : theme;
  } catch {
    return { error: 'not valid JSON' };
  }
}

/** All 18 tokens with the CURRENT values of a theme id (editor seeding). */
export function paletteOf(themeId: string): Array<{ token: string; value: string }> {
  const theme = resolveTheme(themeId);
  return REQUIRED_PALETTE_TOKENS.map((token) => ({ token, value: theme.palette[token] }));
}
