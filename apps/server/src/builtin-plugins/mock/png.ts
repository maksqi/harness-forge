// A minimal PNG encoder for the mock image models (PROVIDERS.md 8): one solid-color 8-bit RGB image, the pixel rows
// compressed with `zlib.deflateSync`, every chunk CRC from `zlib.crc32`. Deterministic: the same size and color always
// give the same bytes. Not a general-purpose encoder (no alpha, no palette, no interlacing).
import { Buffer } from 'node:buffer'
import { crc32, deflateSync } from 'node:zlib'

/** The 8 bytes every PNG file starts with. */
export const PNG_SIGNATURE: readonly number[] = Object.freeze([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])

/** Largest width or height the encoder accepts (bounds the memory of the raw rows). */
export const PNG_MAX_EDGE = 4096

/** A color as red, green and blue channels (0-255). */
export type Rgb = readonly [number, number, number]

/** One PNG chunk: length (big-endian), type, data, CRC-32 of type + data. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.byteLength)
  out.set(Buffer.from(type, 'ascii'), 4)
  out.set(data, 8)
  view.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)))
  return out
}

function checkEdge(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > PNG_MAX_EDGE)
    throw new RangeError(`The PNG ${name} must be an integer from 1 to ${PNG_MAX_EDGE}, got ${value}.`)
}

function channel(value: number): number {
  return Math.min(255, Math.max(0, Math.round(value)))
}

/** A `width` x `height` PNG filled with `color` (8-bit RGB, color type 2). */
export function encodeSolidPng(width: number, height: number, color: Rgb): Uint8Array {
  checkEdge('width', width)
  checkEdge('height', height)
  const [red, green, blue] = color.map(channel) as [number, number, number]

  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header.set([8, 2, 0, 0, 0], 8) // bit depth 8, RGB, deflate, filter method 0, no interlace

  // Every scanline: filter type 0 (none), then the pixels.
  const row = new Uint8Array(1 + width * 3)
  for (let x = 0; x < width; x++)
    row.set([red, green, blue], 1 + x * 3)
  const raw = new Uint8Array(row.byteLength * height)
  for (let y = 0; y < height; y++)
    raw.set(row, y * row.byteLength)

  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}
