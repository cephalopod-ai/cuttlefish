export type ThemeId = 'dark' | 'light' | 'cuttlefish' | 'system'

export const THEMES: { id: ThemeId; label: string; emoji: string }[] = [
  { id: 'dark',       label: 'Dark',       emoji: '🌑' },
  { id: 'light',      label: 'Light',      emoji: '☀️' },
  { id: 'cuttlefish', label: 'Cuttlefish', emoji: '🦑' },
  { id: 'system',     label: 'System',     emoji: '⚙️' },
]
