export type ThemeId = 'dark' | 'light' | 'system'

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'dark',   label: 'Dark',   emoji: '🌑' },
  { id: 'light',  label: 'Light',  emoji: '☀️' },
  { id: 'system', label: 'System', emoji: '⚙️' },
]
