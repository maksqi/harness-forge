import { describe, expect, it } from 'vitest'
import { formatBytes, formatTokenCount, safeAssetUrl } from './format'
import { formatRelativeTime } from './relative-time'

describe('formatBytes', () => {
  it('uses binary units with one decimal below 10', () => {
    expect(formatBytes(812)).toBe('812 B')
    expect(formatBytes(12 * 1024)).toBe('12 KB')
    expect(formatBytes(1.4 * 1024 * 1024)).toBe('1.4 MB')
    expect(formatBytes(-1)).toBe('')
  })
})

describe('formatTokenCount', () => {
  it('formats context windows', () => {
    expect(formatTokenCount(200_000)).toBe('200K')
    expect(formatTokenCount(128_000)).toBe('128K')
    expect(formatTokenCount(32_768)).toBe('32K')
    expect(formatTokenCount(1_000_000)).toBe('1M')
    expect(formatTokenCount(1_048_576)).toBe('1M')
    expect(formatTokenCount(1_500_000)).toBe('1.5M')
    expect(formatTokenCount(131_072)).toBe('128K')
    expect(formatTokenCount(163_840)).toBe('160K')
    expect(formatTokenCount(4096)).toBe('4K')
    expect(formatTokenCount(2_097_152)).toBe('2M')
    expect(formatTokenCount(999_999)).toBe('1M')
    expect(formatTokenCount(512)).toBe('512')
  })
})

describe('safeAssetUrl', () => {
  it('allows same-origin paths, http(s), blob: and data:image/', () => {
    expect(safeAssetUrl('/api/icons/lobe/openai')).toBe('/api/icons/lobe/openai')
    expect(safeAssetUrl('https://example.com/a.png')).toBe('https://example.com/a.png')
    expect(safeAssetUrl('blob:http://localhost/1')).toBe('blob:http://localhost/1')
    expect(safeAssetUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA')
  })

  it('rejects scripts, protocol-relative URLs and control characters', () => {
    expect(safeAssetUrl('javascript:alert(1)')).toBeNull()
    expect(safeAssetUrl('//evil.example/x.svg')).toBeNull()
    expect(safeAssetUrl('/\\evil.example/x.svg')).toBeNull()
    expect(safeAssetUrl('data:text/html,<b>x</b>')).toBeNull()
    expect(safeAssetUrl('/api/x\nnext')).toBeNull()
    expect(safeAssetUrl('')).toBeNull()
    expect(safeAssetUrl(undefined)).toBeNull()
  })
})

describe('formatRelativeTime', () => {
  const now = new Date('2026-09-28T12:00:00Z').getTime()
  const ago = (ms: number) => new Date(now - ms)

  it('uses short relative units within a week', () => {
    expect(formatRelativeTime(ago(10_000), now)).toBe('just now')
    expect(formatRelativeTime(ago(5 * 60_000), now)).toBe('5m ago')
    expect(formatRelativeTime(ago(3 * 3_600_000), now)).toBe('3h ago')
    expect(formatRelativeTime(ago(2 * 86_400_000), now)).toBe('2d ago')
    expect(formatRelativeTime(new Date(now + 10 * 60_000), now)).toBe('in 10m')
  })

  it('falls back to a date after a week', () => {
    const older = formatRelativeTime(ago(30 * 86_400_000), now)
    expect(older).not.toContain('ago')
    expect(older.length).toBeGreaterThan(0)
  })
})
