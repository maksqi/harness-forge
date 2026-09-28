// The PNG encoder of the mock image models (C11-T3): a valid PNG (signature, IHDR, IDAT, IEND, CRCs) of the requested
// size, filled with one color, byte-for-byte deterministic.
import { describe, expect, it } from 'vitest'
import { firstPixel, hasPngSignature, readPng } from './media.test-util.ts'
import { encodeSolidPng, PNG_MAX_EDGE, PNG_SIGNATURE } from './png.ts'

describe('encodeSolidPng', () => {
  it('writes the signature, an 8-bit RGB IHDR of the size, one IDAT and IEND with valid CRCs', () => {
    const png = encodeSolidPng(320, 180, [12, 200, 255])
    expect([...png.subarray(0, 8)]).toEqual([...PNG_SIGNATURE])
    expect(hasPngSignature(png)).toBe(true)
    const info = readPng(png)
    expect(info).toMatchObject({ width: 320, height: 180, bitDepth: 8, colorType: 2, chunks: ['IHDR', 'IDAT', 'IEND'], crcOk: true })
    expect(info.raw.byteLength).toBe(180 * (1 + 320 * 3))
  })

  it('fills every pixel with the color (filter type 0 on every scanline)', () => {
    const info = readPng(encodeSolidPng(3, 2, [1, 2, 3]))
    expect([...info.raw]).toEqual([0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 0, 1, 2, 3, 1, 2, 3, 1, 2, 3])
    expect(firstPixel(readPng(encodeSolidPng(8, 8, [300, -5, 127.6])))).toEqual([255, 0, 128])
  })

  it('is deterministic and small for solid colors', () => {
    const first = encodeSolidPng(320, 320, [9, 8, 7])
    expect(encodeSolidPng(320, 320, [9, 8, 7])).toEqual(first)
    expect(encodeSolidPng(320, 320, [9, 8, 8])).not.toEqual(first)
    expect(first.byteLength).toBeLessThan(4096)
  })

  it('refuses sizes outside 1..PNG_MAX_EDGE', () => {
    for (const [width, height] of [[0, 1], [1, 0], [1.5, 1], [PNG_MAX_EDGE + 1, 1], [Number.NaN, 1]])
      expect(() => encodeSolidPng(width!, height!, [0, 0, 0]), `${width}x${height}`).toThrow(RangeError)
    expect(readPng(encodeSolidPng(1, 1, [0, 0, 0]))).toMatchObject({ width: 1, height: 1 })
  })
})
