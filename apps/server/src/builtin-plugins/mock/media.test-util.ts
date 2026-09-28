// Test helpers (imported by `*.test.ts` only): decode the PNG images and WAV files of the mock media models, so tests
// can check the signature, the size, the color, the CRCs and the duration without an image or audio library.
import { Buffer } from 'node:buffer'
import { crc32, inflateSync } from 'node:zlib'

/** What `readPng` found in a PNG file. */
export interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
  /** Chunk types in file order, e.g. `['IHDR', 'IDAT', 'IEND']`. */
  chunks: string[]
  /** Every chunk CRC matched its type + data. */
  crcOk: boolean
  /** The decompressed scanlines (each: a filter byte, then the pixels). */
  raw: Uint8Array
}

const PNG_MAGIC = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

/** True when `bytes` starts with the PNG signature. */
export function hasPngSignature(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((byte, index) => bytes[index] === byte)
}

/** Parses a PNG file (throws on a bad signature or a truncated chunk). */
export function readPng(bytes: Uint8Array): PngInfo {
  if (!hasPngSignature(bytes))
    throw new Error('not a PNG file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const chunks: string[] = []
  const idat: Uint8Array[] = []
  let crcOk = true
  let header: Uint8Array | null = null
  let offset = 8
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset)
    const type = Buffer.from(bytes.subarray(offset + 4, offset + 8)).toString('ascii')
    const end = offset + 8 + length
    if (end + 4 > bytes.byteLength)
      throw new Error(`truncated ${type} chunk`)
    const data = bytes.subarray(offset + 8, end)
    if (crc32(bytes.subarray(offset + 4, end)) !== view.getUint32(end))
      crcOk = false
    chunks.push(type)
    if (type === 'IHDR')
      header = data
    else if (type === 'IDAT')
      idat.push(data)
    offset = end + 4
  }
  if (header === null)
    throw new Error('no IHDR chunk')
  const headerView = new DataView(header.buffer, header.byteOffset, header.byteLength)
  return {
    width: headerView.getUint32(0),
    height: headerView.getUint32(4),
    bitDepth: header[8]!,
    colorType: header[9]!,
    chunks,
    crcOk,
    raw: new Uint8Array(inflateSync(Buffer.concat(idat))),
  }
}

/** The RGB color of the first pixel of an 8-bit RGB PNG. */
export function firstPixel(info: PngInfo): [number, number, number] {
  return [info.raw[1]!, info.raw[2]!, info.raw[3]!]
}

/** What `readWav` found in a canonical 44-byte-header WAV file. */
export interface WavInfo {
  riff: string
  wave: string
  format: number
  channels: number
  sampleRate: number
  byteRate: number
  blockAlign: number
  bitsPerSample: number
  dataBytes: number
  /** `dataBytes / byteRate` in milliseconds. */
  durationMs: number
  /** Every sample is zero. */
  silent: boolean
}

/** Parses the canonical header of a PCM WAV file. */
export function readWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const ascii = (start: number): string => Buffer.from(bytes.subarray(start, start + 4)).toString('ascii')
  const byteRate = view.getUint32(28, true)
  const dataBytes = view.getUint32(40, true)
  return {
    riff: ascii(0),
    wave: ascii(8),
    format: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate,
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    dataBytes,
    durationMs: (dataBytes / byteRate) * 1000,
    silent: bytes.subarray(44).every(byte => byte === 0),
  }
}
