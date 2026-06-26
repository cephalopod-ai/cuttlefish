
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

interface BreadcrumbItem {
  label: string
  href?: string
}

interface BreadcrumbContextValue {
  items: BreadcrumbItem[]
  setItems: (items: BreadcrumbItem[]) => void
}

const BreadcrumbContext = createContext<BreadcrumbContextValue>({
  items: [],
  setItems: () => {},
})

export function BreadcrumbProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<BreadcrumbItem[]>([])

  // NOTE: document.title is owned solely by <DocumentTitle /> in settings-provider.tsx.
  // Breadcrumbs no longer touch the title (was racing the title MutationObserver).

  return (
    <BreadcrumbContext.Provider value={{ items, setItems }}>
      {children}
    </BreadcrumbContext.Provider>
  )
}

export function useBreadcrumbs(items?: BreadcrumbItem[]) {
  const ctx = useContext(BreadcrumbContext)
  const { setItems } = ctx

  // Serialize items for stable dependency comparison
  const itemsKey = items ? JSON.stringify(items) : ''

  useEffect(() => {
    if (!items) return
    setItems(items)
    // Clear on unmount (or when this page's items change) so a previous page's
    // title (e.g. "Organization") never persists into a route that sets no
    // breadcrumbs of its own. setItems is a stable useState setter.
    return () => setItems([])
  }, [itemsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  return ctx
}
