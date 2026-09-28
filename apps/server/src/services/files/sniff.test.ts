import { describe, expect, it } from 'vitest'
import { AVIF, BMP, GIF, HEIC, ICO, INVALID_UTF8, JPEG, MP4, PDF, PNG, SVG, TEXT, TIFF, WEBP, WITH_NUL } from './fixtures.test-util.ts'
import { canonicalMime, isUtf8Text, resolveUploadType, sniffBinaryType } from './sniff.ts'

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('sniffBinaryType', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['GIF', GIF, 'image/gif'],
    ['WebP', WEBP, 'image/webp'],
    ['AVIF', AVIF, 'image/avif'],
    ['HEIC', HEIC, 'image/heic'],
    ['BMP', BMP, 'image/bmp'],
    ['ICO', ICO, 'image/vnd.microsoft.icon'],
    ['TIFF', TIFF, 'image/tiff'],
    ['PDF', PDF, 'application/pdf'],
    ['MP4 (other ftyp brands)', MP4, null],
    ['text', TEXT, null],
    ['text starting with "BM"', encode('BMW is a car brand and more text'), null],
    ['empty', new Uint8Array(0), null],
  ])('%s', (_label, bytes, expected) => {
    expect(sniffBinaryType(bytes)).toBe(expected)
  })

  it('finds a PDF header after leading bytes only when lenient', () => {
    const late = new Uint8Array([...encode('junk\n'), ...PDF])
    expect(sniffBinaryType(late)).toBeNull()
    expect(sniffBinaryType(late, { lenientPdf: true })).toBe('application/pdf')
  })
})

describe('text checks', () => {
  it('accepts UTF-8 text without NUL bytes only', () => {
    expect(isUtf8Text(TEXT)).toBe(true)
    expect(isUtf8Text(encode('café \u{1F600}'))).toBe(true)
    expect(isUtf8Text(INVALID_UTF8)).toBe(false)
    expect(isUtf8Text(WITH_NUL)).toBe(false)
    expect(isUtf8Text(PNG)).toBe(false)
  })

  it('canonicalizes declared types', () => {
    expect(canonicalMime('IMAGE/JPG; name=x')).toBe('image/jpeg')
    expect(canonicalMime('text/plain;charset=utf-8')).toBe('text/plain')
    expect(canonicalMime('image/x-icon')).toBe('image/vnd.microsoft.icon')
    expect(canonicalMime('nonsense')).toBe('')
    expect(canonicalMime(undefined)).toBe('')
  })
})

describe('resolveUploadType', () => {
  it.each([
    ['image/png', 'a.png', PNG, 'image/png'],
    ['image/jpg', 'a.jpg', JPEG, 'image/jpeg'],
    ['image/heif', 'a.heic', HEIC, 'image/heif'],
    ['image/avif', 'a.avif', AVIF, 'image/avif'],
    ['application/pdf', 'a.pdf', PDF, 'application/pdf'],
    ['application/pdf', 'late.pdf', new Uint8Array([...encode('junk\n'), ...PDF]), 'application/pdf'],
    ['text/plain', 'a.txt', TEXT, 'text/plain'],
    ['text/html', 'page.html', encode('<p>hi</p>'), 'text/html'],
    ['image/svg+xml', 'a.svg', SVG, 'image/svg+xml'],
    ['', 'photo', PNG, 'image/png'],
    ['application/octet-stream', 'notes.md', TEXT, 'text/markdown'],
    ['', 'drawing.svg', SVG, 'image/svg+xml'],
    ['', 'fake.svg', TEXT, 'text/plain'],
    ['', 'README', TEXT, 'text/plain'],
  ])('accepts %s (%s)', (declared, name, bytes, expected) => {
    expect(resolveUploadType(declared, name, bytes)).toEqual({ ok: true, mime: expected })
  })

  it.each([
    ['a PNG declared as JPEG', 'image/jpeg', PNG],
    ['text declared as PNG', 'image/png', TEXT],
    ['text declared as PDF', 'application/pdf', TEXT],
    ['binary declared as text', 'text/plain', PNG],
    ['invalid UTF-8 text', 'text/markdown', INVALID_UTF8],
    ['text with NUL bytes', 'text/plain', WITH_NUL],
    ['a PNG declared as SVG', 'image/svg+xml', PNG],
    ['text declared as SVG', 'image/svg+xml', TEXT],
    ['a disallowed type', 'application/zip', PNG],
    ['an unverifiable image type', 'image/x-portable-pixmap', encode('P6 1 1 255')],
    ['untyped binary', '', MP4],
  ])('rejects %s', (_label, declared, bytes) => {
    const result = resolveUploadType(declared, 'file.bin', bytes)
    expect(result.ok).toBe(false)
  })
})

describe('text-like application types', () => {
  it('stores application/json uploads as UTF-8 text', () => {
    const bytes = new TextEncoder().encode('{"a":1}')
    expect(resolveUploadType('application/json', 'data.json', bytes)).toEqual({ ok: true, mime: 'text/plain' })
    expect(resolveUploadType('application/json', 'data.json', new Uint8Array([0, 1, 2])).ok).toBe(false)
  })
})
