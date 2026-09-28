import { Buffer } from 'node:buffer'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { decodeIconFile, isPng } from './icon.ts'
import { TINY_PNG } from './testing.ts'

function base64(text: string | Uint8Array): string {
  return Buffer.from(text).toString('base64')
}

function issuePath(fn: () => unknown): unknown {
  try {
    fn()
  }
  catch (error) {
    expect(error).toBeInstanceOf(HarnessError)
    expect((error as HarnessError).code).toBe('validation_error')
    return ((error as HarnessError).details as { issues: Array<{ path: unknown }> }).issues[0]?.path
  }
  throw new Error('expected a validation error')
}

describe('decodeIconFile', () => {
  it('sanitizes SVG icons', () => {
    const icon = decodeIconFile({ name: 'icon.svg', base64: base64('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><path d="M0 0"/></svg>') })
    expect(icon.name).toBe('icon.svg')
    expect(Buffer.from(icon.bytes).toString('utf8')).toBe('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>\n')
  })

  it('accepts PNG icons unchanged and checks the signature', () => {
    expect(isPng(TINY_PNG)).toBe(true)
    const icon = decodeIconFile({ name: 'icon.png', base64: TINY_PNG.toString('base64') })
    expect(Buffer.from(icon.bytes).equals(TINY_PNG)).toBe(true)
    expect(issuePath(() => decodeIconFile({ name: 'icon.png', base64: base64('<svg/>') }))).toEqual(['iconFile', 'base64'])
  })

  it('rejects SVG files that are not SVG images', () => {
    expect(issuePath(() => decodeIconFile({ name: 'icon.svg', base64: base64('<html></html>') }))).toEqual(['iconFile', 'base64'])
    expect(issuePath(() => decodeIconFile({ name: 'icon.svg', base64: base64(TINY_PNG) }))).toEqual(['iconFile', 'base64'])
  })

  it('rejects icons over 256 KB', () => {
    const big = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${'a'.repeat(LIMITS.iconFileBytes)}</desc></svg>`
    expect(() => decodeIconFile({ name: 'icon.svg', base64: base64(big) })).toThrow(/256 KB/)
  })
})
