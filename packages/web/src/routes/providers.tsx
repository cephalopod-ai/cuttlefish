
import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react'
import { ALL_THEME_IDS, type ThemeId } from '@/lib/themes'

interface ThemeContextValue {
  theme: ThemeId
  setTheme: (t: ThemeId) => void
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'reef-light', setTheme: () => {} })

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeId>('reef-light')

  const apply = useCallback((t: ThemeId) => {
    setThemeState(t)
    localStorage.setItem('cuttlefish-theme', t)
    const el = document.documentElement
    el.removeAttribute('data-theme')
    if (t === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
      el.setAttribute('data-theme', prefersDark ? 'dark' : 'light')
    } else {
      el.setAttribute('data-theme', t)
    }
  }, [])

  useEffect(() => {
    const saved = localStorage.getItem('cuttlefish-theme')
    // Coerce stale ids from removed themes (glass/atelier/…) to a valid one.
    const valid = saved && ALL_THEME_IDS.includes(saved as ThemeId) ? (saved as ThemeId) : 'reef-light'
    apply(valid)
  }, [apply])

  // React to OS color scheme changes when theme is "system"
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    function handleChange() {
      const current = localStorage.getItem('cuttlefish-theme') as ThemeId | null
      if (current === 'system') {
        const el = document.documentElement
        el.setAttribute('data-theme', mq.matches ? 'dark' : 'light')
      }
    }
    mq.addEventListener('change', handleChange)
    return () => mq.removeEventListener('change', handleChange)
  }, [])

  return (
    <ThemeContext.Provider value={{ theme, setTheme: apply }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
