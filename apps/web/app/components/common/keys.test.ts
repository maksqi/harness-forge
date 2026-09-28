import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatKeys, isApplePlatform } from './keys'

const labels = (keys: string, mac: boolean) => formatKeys(keys, mac).map(token => token.label)
const names = (keys: string, mac: boolean) => formatKeys(keys, mac).map(token => token.name)

describe('formatKeys', () => {
  it('uses glyphs on macOS', () => {
    expect(labels('mod+shift+o', true)).toEqual(['⌘', '⇧', 'O'])
    expect(labels('mod+k', true)).toEqual(['⌘', 'K'])
    expect(labels('alt+m', true)).toEqual(['⌥', 'M'])
    expect(names('mod+shift+o', true)).toEqual(['Command', 'Shift', 'O'])
  })

  it('uses words elsewhere', () => {
    expect(labels('mod+shift+o', false)).toEqual(['Ctrl', 'Shift', 'O'])
    expect(labels('alt+m', false)).toEqual(['Alt', 'M'])
    expect(labels('shift+escape', false)).toEqual(['Shift', 'Esc'])
  })

  it('maps event.code tokens to the printed key', () => {
    expect(labels('alt+code:KeyM', true)).toEqual(['⌥', 'M'])
    expect(labels('mod+code:Digit1', false)).toEqual(['Ctrl', '1'])
    expect(labels('mod+code:Slash', false)).toEqual(['Ctrl', '/'])
  })

  it('keeps unknown keys readable', () => {
    expect(labels('mod+/', true)).toEqual(['⌘', '/'])
    expect(labels('f5', false)).toEqual(['F5'])
    expect(labels('', false)).toEqual([])
  })
})

describe('isApplePlatform', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('detects macOS and iOS', () => {
    vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: '' })
    expect(isApplePlatform()).toBe(true)
    vi.stubGlobal('navigator', { platform: '', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' })
    expect(isApplePlatform()).toBe(true)
  })

  it('returns false on other platforms', () => {
    vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })
    expect(isApplePlatform()).toBe(false)
    vi.stubGlobal('navigator', { userAgentData: { platform: 'Linux' }, platform: '', userAgent: '' })
    expect(isApplePlatform()).toBe(false)
  })
})
