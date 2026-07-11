import catppuccinLatte from '../catppuccin-latte.json';
import catppuccinMocha from '../catppuccin-mocha.json';
import nord from '../nord.json';
import dracula from '../dracula.json';
import githubLight from '../github-light.json';
import gruvboxDark from '../gruvbox-dark.json';
import gruvboxLight from '../gruvbox-light.json';
import tokyoNight from '../tokyo-night.json';
import solarizedLight from '../solarized-light.json';
import rosePine from '../rose-pine.json';

/** Every primitive token a theme MUST define. Checked in CI and by the self-test. */
export const REQUIRED_PALETTE_TOKENS = [
  'base',
  'surface-0',
  'surface-1',
  'surface-2',
  'text',
  'text-muted',
  'accent-1',
  'accent-2',
  'accent-3',
  'accent-4',
  'accent-5',
  'accent-6',
  'accent-7',
  'accent-8',
  'success',
  'warning',
  'danger',
  'info',
] as const;

export type PaletteToken = (typeof REQUIRED_PALETTE_TOKENS)[number];

export interface Theme {
  id: string;
  nameKey: string;
  appearance: 'light' | 'dark';
  license: { spdx: string; source: string };
  palette: Record<PaletteToken, string>;
}

export const themes: Theme[] = [
  catppuccinLatte,
  catppuccinMocha,
  nord,
  dracula,
  githubLight,
  gruvboxDark,
  gruvboxLight,
  tokyoNight,
  solarizedLight,
  rosePine,
] as Theme[];

export const defaultThemeId = 'catppuccin-mocha';

export function getTheme(id: string): Theme {
  return themes.find((t) => t.id === id) ?? themes.find((t) => t.id === defaultThemeId)!;
}

/** Returns the list of missing tokens (empty = complete). Used by CI check and DiagnoseService. */
export function validateTheme(theme: Theme): PaletteToken[] {
  return REQUIRED_PALETTE_TOKENS.filter((t) => !theme.palette[t]);
}
