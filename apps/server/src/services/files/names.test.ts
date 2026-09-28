import { describe, expect, it } from 'vitest'
import { contentDisposition, FILE_NAME_MAX_LENGTH, sanitizeFileName } from './names.ts'

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\report.pdf', 'report.pdf'],
    ['  spaced name.txt  ', 'spaced name.txt'],
    ['a\u0000b\u202Ec\r\n.txt', 'abc.txt'],
    ['Cafe\u0301.txt', 'Caf\u00E9.txt'],
  ])('%j -> %j', (raw, expected) => {
    expect(sanitizeFileName(raw, 'text/plain')).toBe(expected)
  })

  it('replaces empty and dot-only names with a typed default', () => {
    expect(sanitizeFileName('', 'image/png')).toBe('file.png')
    expect(sanitizeFileName('..', 'text/plain')).toBe('file.txt')
    expect(sanitizeFileName('dir/', 'application/pdf')).toBe('file.pdf')
    expect(sanitizeFileName('\u0007', 'image/x-unknown')).toBe('file')
  })

  it('shortens long names to 255 characters, keeping the extension', () => {
    const name = sanitizeFileName(`${'n'.repeat(400)}.markdown`, 'text/markdown')
    expect(name).toHaveLength(FILE_NAME_MAX_LENGTH)
    expect(name.endsWith('.markdown')).toBe(true)
    const emoji = sanitizeFileName('\u{1F600}'.repeat(300), 'text/plain')
    expect(Array.from(emoji)).toHaveLength(FILE_NAME_MAX_LENGTH)
  })
})

describe('contentDisposition', () => {
  it('sends an ASCII fallback and the UTF-8 name', () => {
    expect(contentDisposition('inline', 'report.pdf')).toBe('inline; filename="report.pdf"; filename*=UTF-8\'\'report.pdf')
    expect(contentDisposition('attachment', 'na\u00EFve "quote" 100%.txt')).toBe(
      'attachment; filename="na_ve _quote_ 100_.txt"; filename*=UTF-8\'\'na%C3%AFve%20%22quote%22%20100%25.txt',
    )
  })

  it('cannot be used to inject header parameters or lines', () => {
    const header = contentDisposition('attachment', 'a\r\nSet-Cookie: x=1; filename="evil.html"(*)\'')
    expect(header).not.toMatch(/[\r\n]/)
    expect(header.split('filename=')).toHaveLength(2)
    expect(header).toContain('filename*=UTF-8\'\'aSet-Cookie%3A%20x%3D1%3B%20filename%3D%22evil.html%22%28%2A%29%27')
  })

  it('falls back to "download" for names without printable ASCII', () => {
    expect(contentDisposition('attachment', '\u00E9\u00E9.txt')).toContain('filename="__.txt"')
    expect(contentDisposition('attachment', '\u00E9\u00E9')).toContain('filename="download"')
    expect(contentDisposition('attachment', '\u00E9\u00E9')).toContain('filename*=UTF-8\'\'%C3%A9%C3%A9')
  })
})
