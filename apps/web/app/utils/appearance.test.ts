import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { stubLocalStorage } from '~/utils/testing/storage'
import { APPEARANCE_STORAGE_KEY, applyAppearanceToDocument, cacheAppearance, readCachedAppearance } from './appearance'

let storage: Storage

beforeEach(() => {
  storage = stubLocalStorage()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('appearance', () => {
  it('sets the three attributes on <html>', () => {
    applyAppearanceToDocument({ density: 'compact', textSize: 'lg', readingFont: 'serif' })
    const root = document.documentElement
    expect(root.getAttribute('data-density')).toBe('compact')
    expect(root.getAttribute('data-text-size')).toBe('lg')
    expect(root.getAttribute('data-reading-font')).toBe('serif')
  })

  it('caches only valid appearance values', () => {
    cacheAppearance({ density: 'comfortable', textSize: 'sm', readingFont: 'sans' })
    expect(readCachedAppearance()).toEqual({ density: 'comfortable', textSize: 'sm', readingFont: 'sans' })
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ density: 'huge', textSize: 'sm', readingFont: 'sans' }))
    expect(readCachedAppearance()).toBeNull()
    storage.setItem(APPEARANCE_STORAGE_KEY, '{not json')
    expect(readCachedAppearance()).toBeNull()
  })

  it('degrades to nothing cached when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(readCachedAppearance()).toBeNull()
    expect(() => cacheAppearance({ density: 'compact', textSize: 'md', readingFont: 'sans' })).not.toThrow()
  })
})
