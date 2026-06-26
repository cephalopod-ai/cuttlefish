import { describe, expect, it } from 'vitest'
import {
  consumeChunkReloadRetry,
  isRecoverableDynamicImportError,
} from '../lazy-route'

describe('isRecoverableDynamicImportError', () => {
  it('recognizes dynamic import and stale chunk failures', () => {
    expect(isRecoverableDynamicImportError(new TypeError('Failed to fetch dynamically imported module'))).toBe(true)
    expect(isRecoverableDynamicImportError(new Error('error loading dynamically imported module'))).toBe(true)
    expect(isRecoverableDynamicImportError(new Error('ChunkLoadError: Loading chunk 123 failed'))).toBe(true)
    expect(
      isRecoverableDynamicImportError(
        new Error('Expected a JavaScript module script but the server responded with a MIME type of text/html'),
      ),
    ).toBe(true)
  })

  it('does not classify ordinary render errors as chunk failures', () => {
    expect(isRecoverableDynamicImportError(new Error('Cannot read properties of undefined'))).toBe(false)
    expect(isRecoverableDynamicImportError('plain failure')).toBe(false)
  })
})

describe('consumeChunkReloadRetry', () => {
  it('allows one retry per key', () => {
    const storage = new Map<string, string>()
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
      removeItem: (key: string) => { storage.delete(key) },
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() { return storage.size },
    } as Storage

    expect(consumeChunkReloadRetry(adapter, 'cuttlefish:chunk-retry:/limits')).toBe(true)
    expect(consumeChunkReloadRetry(adapter, 'cuttlefish:chunk-retry:/limits')).toBe(false)
  })
})
