import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { AVIF, BMP, GIF, JPEG, PDF, PNG, SVG, TEXT, WEBP } from './fixtures.test-util.ts'
import { checkGeneratedFile, generatedFileName, isGeneratedImageMime } from './generated.ts'

function refusal(fn: () => unknown): HarnessError {
  try {
    fn()
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    return error as HarnessError
  }
  throw new Error('expected a refusal')
}

describe('generated files: type check', () => {
  it('accepts PNG, JPEG, WebP and GIF whose bytes match, with parameters and aliases', () => {
    expect(checkGeneratedFile(PNG, 'image/png')).toBe('image/png')
    expect(checkGeneratedFile(JPEG, 'image/jpeg')).toBe('image/jpeg')
    expect(checkGeneratedFile(WEBP, 'image/webp')).toBe('image/webp')
    expect(checkGeneratedFile(GIF, 'image/gif')).toBe('image/gif')
    expect(checkGeneratedFile(PNG, 'IMAGE/PNG; charset=binary')).toBe('image/png')
    expect(checkGeneratedFile(JPEG, 'image/jpg')).toBe('image/jpeg')
    expect(isGeneratedImageMime('image/png')).toBe(true)
    expect(isGeneratedImageMime('image/svg+xml')).toBe(false)
  })

  it('refuses SVG and every other type on mediaType', () => {
    for (const [data, type] of [[SVG, 'image/svg+xml'], [BMP, 'image/bmp'], [AVIF, 'image/avif'], [PDF, 'application/pdf'], [TEXT, 'text/plain']] as const) {
      const error = refusal(() => checkGeneratedFile(data, type))
      expect(error.toJSON().error, type).toMatchObject({ code: 'validation_error', message: `Generated files are stored only as PNG, JPEG, WebP or GIF images, not "${type}".`, details: { issues: [{ path: ['mediaType'] }] } })
    }
    expect(refusal(() => checkGeneratedFile(PNG, '')).message).toBe('Generated files are stored only as PNG, JPEG, WebP or GIF images, not a file without a valid type.')
    expect(refusal(() => checkGeneratedFile(PNG, undefined)).code).toBe('validation_error')
  })

  it('refuses bytes that do not match the type, and missing bytes, on data', () => {
    expect(refusal(() => checkGeneratedFile(PNG, 'image/jpeg')).toJSON().error).toMatchObject({
      code: 'validation_error',
      message: 'The generated image does not match its type (image/jpeg).',
      details: { issues: [{ path: ['data'] }] },
    })
    expect(refusal(() => checkGeneratedFile(SVG, 'image/png')).code).toBe('validation_error')
    expect(refusal(() => checkGeneratedFile(new Uint8Array(0), 'image/png')).code).toBe('validation_error')
    expect(refusal(() => checkGeneratedFile('iVBORw0KGgo=', 'image/png')).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['data'] }] } })
  })

  it('refuses images above LIMITS.generatedImageBytes with payload_too_large', () => {
    const big = new Uint8Array(LIMITS.generatedImageBytes + 1)
    big.set(PNG)
    expect(refusal(() => checkGeneratedFile(big, 'image/png')).toJSON().error).toEqual({
      code: 'payload_too_large',
      message: 'Generated images are limited to 20 MB.',
      details: { limitBytes: LIMITS.generatedImageBytes },
    })
    const limit = new Uint8Array(LIMITS.generatedImageBytes)
    limit.set(PNG)
    expect(checkGeneratedFile(limit, 'image/png')).toBe('image/png')
  })
})

describe('generated files: names', () => {
  it('sanitizes like an upload and adds the extension of the type when the name has none', () => {
    expect(generatedFileName('image-1.png', 'image/png')).toBe('image-1.png')
    expect(generatedFileName('image-1', 'image/png')).toBe('image-1.png')
    expect(generatedFileName('image-2.', 'image/jpeg')).toBe('image-2.jpg')
    expect(generatedFileName('dir/../shot', 'image/webp')).toBe('shot.webp')
    expect(generatedFileName('x\u0000y.gif', 'image/gif')).toBe('xy.gif')
    expect(generatedFileName('', 'image/png')).toBe('file.png')
    expect(generatedFileName(undefined, 'image/gif')).toBe('file.gif')
    expect(generatedFileName('picture.jpeg', 'image/png')).toBe('picture.jpeg')
    const long = generatedFileName('a'.repeat(300), 'image/png')
    expect(long).toHaveLength(255)
    expect(long.endsWith('.png')).toBe(true)
  })
})
