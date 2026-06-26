import { lazy, type ComponentType } from 'react'

const RECOVERABLE_IMPORT_PATTERNS = [
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /chunkloaderror/i,
  /loading chunk \d+ failed/i,
  /mime type of text\/html/i,
]

export function isRecoverableDynamicImportError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const message = `${error.name}: ${error.message}`
  return RECOVERABLE_IMPORT_PATTERNS.some((pattern) => pattern.test(message))
}

export function consumeChunkReloadRetry(storage: Storage, key: string): boolean {
  try {
    if (storage.getItem(key) === '1') return false
    storage.setItem(key, '1')
    return true
  } catch {
    return false
  }
}

function retryKey(routeName: string): string {
  const path = typeof window === 'undefined' ? routeName : window.location.pathname
  return `cuttlefish:chunk-retry:${routeName}:${path}`
}

export function lazyRoute<T extends ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  routeName: string,
) {
  return lazy(async () => {
    try {
      const mod = await load()
      if (typeof window !== 'undefined') {
        try { window.sessionStorage.removeItem(retryKey(routeName)) } catch { /* ignore */ }
      }
      return mod
    } catch (error) {
      if (
        typeof window !== 'undefined' &&
        isRecoverableDynamicImportError(error) &&
        consumeChunkReloadRetry(window.sessionStorage, retryKey(routeName))
      ) {
        window.location.reload()
        return new Promise<{ default: T }>(() => {})
      }
      throw error
    }
  })
}
