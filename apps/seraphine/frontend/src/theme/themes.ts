export type ThemeId = 'midnight' | 'aurora' | 'sakura';

export interface ThemePreview {
  bg: string;
  accent: string;
  user: string;
}

export interface ThemeDef {
  id: ThemeId;
  name: string;
  preview: ThemePreview;
}

export const THEMES: ThemeDef[] = [
  {
    id: 'midnight',
    name: 'Midnight',
    preview: { bg: '#08080d', accent: '#a78bfa', user: '#4ade80' },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    preview: { bg: '#0f2a25', accent: '#14b8a6', user: '#4ade80' },
  },
  {
    id: 'sakura',
    name: 'Sakura',
    preview: { bg: '#2a1024', accent: '#ec4899', user: '#f9a8d4' },
  },
];

export const DEFAULT_THEME: ThemeId = 'midnight';
export const THEME_STORAGE_KEY = 'seraphine.theme';

export function isThemeId(value: string | null | undefined): value is ThemeId {
  return value === 'midnight' || value === 'aurora' || value === 'sakura';
}
