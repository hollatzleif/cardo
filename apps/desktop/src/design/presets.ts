import type { DesignOverrides } from './design';

/**
 * One-click design directions: each bundles an existing theme with a matching
 * font, density, corner radius and widget style (shadow/border). Pure
 * configuration over the existing design engine — the "five directions" from
 * the assistant's UI proposal, offered as a starting point the user then
 * tweaks freely. Nothing here is forced; it just sets several knobs at once.
 */
export interface DesignPreset {
  id: string;
  nameKey: string;
  descKey: string;
  themeId: string;
  /** Preview swatch source: the theme id's palette is used in the UI. */
  design: DesignOverrides;
}

export const DESIGN_PRESETS: DesignPreset[] = [
  {
    id: 'calm-nord',
    nameKey: 'design.preset.calmNord.name',
    descKey: 'design.preset.calmNord.desc',
    themeId: 'nord',
    design: { fontPreset: 'humanist', density: 'normal', radius: 12, shadow: false, border: true },
  },
  {
    id: 'warm-notebook',
    nameKey: 'design.preset.warmNotebook.name',
    descKey: 'design.preset.warmNotebook.desc',
    themeId: 'gruvbox-light',
    design: { fontPreset: 'serif', density: 'airy', radius: 16, shadow: true, border: false },
  },
  {
    id: 'terminal',
    nameKey: 'design.preset.terminal.name',
    descKey: 'design.preset.terminal.desc',
    themeId: 'gruvbox-dark',
    design: { fontPreset: 'monospace', density: 'compact', radius: 6, shadow: false, border: true },
  },
  {
    id: 'soft-pastel',
    nameKey: 'design.preset.softPastel.name',
    descKey: 'design.preset.softPastel.desc',
    themeId: 'catppuccin-latte',
    design: { fontPreset: 'rounded', density: 'normal', radius: 18, shadow: true, border: false },
  },
  {
    id: 'editorial',
    nameKey: 'design.preset.editorial.name',
    descKey: 'design.preset.editorial.desc',
    themeId: 'github-light',
    design: { fontPreset: 'humanist', density: 'normal', radius: 8, shadow: false, border: true },
  },
];
