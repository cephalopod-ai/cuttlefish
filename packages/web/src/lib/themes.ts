export type ThemeId =
  | 'dark'
  | 'light'
  | 'cuttlefish'
  | 'signal-dark'
  | 'signal-light'
  | 'reef-light'
  | 'reef-dark'
  | 'system'

export const LIGHT_THEME_IDS: ThemeId[] = ['light', 'signal-light', 'reef-light']
export const DARK_THEME_IDS: ThemeId[] = ['dark', 'cuttlefish', 'signal-dark', 'reef-dark']
export const ALL_THEME_IDS: ThemeId[] = [...DARK_THEME_IDS, ...LIGHT_THEME_IDS, 'system']

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'signal-dark',  label: 'Deep Signal',       emoji: '📡' },
  { id: 'signal-light', label: 'Deep Signal Light', emoji: '💡' },
  { id: 'reef-light',   label: 'Reef',              emoji: '🌊' },
  { id: 'reef-dark',    label: 'Reef Dark',         emoji: '🌌' },
  { id: 'cuttlefish',   label: 'Cuttlefish',        emoji: '🦑' },
  { id: 'dark',         label: 'Ledger Dark',       emoji: '🌑' },
  { id: 'light',        label: 'Ledger Light',      emoji: '☀️' },
  { id: 'system',       label: 'System',            emoji: '⚙️' },
]

export function isLightTheme(theme: ThemeId | string | null | undefined): boolean {
  return typeof theme === 'string' && LIGHT_THEME_IDS.includes(theme as ThemeId)
}

export function isDarkTheme(theme: ThemeId | string | null | undefined): boolean {
  return typeof theme === 'string' && DARK_THEME_IDS.includes(theme as ThemeId)
}
