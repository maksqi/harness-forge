import { describe, expect, it } from 'vitest'
import { fileNameFromDisposition } from './download'

describe('fileNameFromDisposition', () => {
  it('prefers the UTF-8 extended parameter', () => {
    expect(fileNameFromDisposition('attachment; filename="plain.md"; filename*=UTF-8\'\'caf%C3%A9-2026.md')).toBe('café-2026.md')
  })

  it('reads quoted and bare names', () => {
    expect(fileNameFromDisposition('attachment; filename="refactor-auth-2026-09-28.json"')).toBe('refactor-auth-2026-09-28.json')
    expect(fileNameFromDisposition('attachment; filename=dice-roller-1.0.0.zip')).toBe('dice-roller-1.0.0.zip')
  })

  it('strips path separators, control characters and leading dots', () => {
    expect(fileNameFromDisposition('attachment; filename="../../etc/passwd"')).toBe('etcpasswd')
    expect(fileNameFromDisposition('attachment; filename*=UTF-8\'\'..%2F..%2Fx.md')).toBe('x.md')
    expect(fileNameFromDisposition('attachment; filename="a\u0007b.md"')).toBe('ab.md')
  })

  it('returns null without a usable name', () => {
    expect(fileNameFromDisposition(null)).toBeNull()
    expect(fileNameFromDisposition('inline')).toBeNull()
    expect(fileNameFromDisposition('attachment; filename="/"')).toBeNull()
  })
})
