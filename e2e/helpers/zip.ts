// Reading a downloaded zip (the backup of Settings -> Data, docs/API.md 4.16) with Node built-ins only: the entries of
// the central directory and the text of one entry, stored or deflated. No zip64 and no encryption: the server writes
// neither. Throws on anything that is not a well-formed zip.
import { Buffer } from 'node:buffer'
import { inflateRawSync } from 'node:zlib'

const LOCAL_HEADER_SIGNATURE = 0x04034B50
const CENTRAL_HEADER_SIGNATURE = 0x02014B50
const END_SIGNATURE = 0x06054B50
/** Size of the end of central directory record without its comment (at most 65535 bytes). */
const END_RECORD_SIZE = 22
const METHOD_STORED = 0
const METHOD_DEFLATED = 8

export interface ZipEntry {
  /** Path inside the zip, e.g. `chats/<chatId>.json`. */
  name: string
  /** Compression method: 0 stored, 8 deflated. */
  method: number
  compressedSize: number
  size: number
  /** Offset of the entry's local header. */
  localHeaderOffset: number
}

/** True when `bytes` starts with a zip's local file header (`PK\x03\x04`). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && Buffer.from(bytes.subarray(0, 4)).readUInt32LE(0) === LOCAL_HEADER_SIGNATURE
}

function endRecordOffset(zip: Buffer): number {
  const lowest = Math.max(0, zip.length - END_RECORD_SIZE - 0xFFFF)
  for (let offset = zip.length - END_RECORD_SIZE; offset >= lowest; offset--) {
    if (zip.readUInt32LE(offset) === END_SIGNATURE)
      return offset
  }
  throw new Error('Not a zip: no end of central directory record.')
}

/** Every entry of the central directory, in its order. */
export function zipEntries(zip: Buffer): ZipEntry[] {
  const end = endRecordOffset(zip)
  const count = zip.readUInt16LE(end + 10)
  let offset = zip.readUInt32LE(end + 16)
  const entries: ZipEntry[] = []
  for (let index = 0; index < count; index++) {
    if (offset + 46 > zip.length || zip.readUInt32LE(offset) !== CENTRAL_HEADER_SIGNATURE)
      throw new Error(`Not a zip: central directory entry ${index} is broken.`)
    const nameLength = zip.readUInt16LE(offset + 28)
    const extraLength = zip.readUInt16LE(offset + 30)
    const commentLength = zip.readUInt16LE(offset + 32)
    entries.push({
      name: zip.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: zip.readUInt16LE(offset + 10),
      compressedSize: zip.readUInt32LE(offset + 20),
      size: zip.readUInt32LE(offset + 24),
      localHeaderOffset: zip.readUInt32LE(offset + 42),
    })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** The content of the entry `name`, decoded as UTF-8 (e.g. `manifest.json`). */
export function readZipText(zip: Buffer, name: string): string {
  const entry = zipEntries(zip).find(item => item.name === name)
  if (!entry)
    throw new Error(`The zip has no entry "${name}".`)
  const header = entry.localHeaderOffset
  if (zip.readUInt32LE(header) !== LOCAL_HEADER_SIGNATURE)
    throw new Error(`Not a zip: the local header of "${name}" is broken.`)
  const start = header + 30 + zip.readUInt16LE(header + 26) + zip.readUInt16LE(header + 28)
  const data = zip.subarray(start, start + entry.compressedSize)
  if (entry.method === METHOD_STORED)
    return data.toString('utf8')
  if (entry.method === METHOD_DEFLATED)
    return inflateRawSync(data).toString('utf8')
  throw new Error(`"${name}" uses the unsupported compression method ${entry.method}.`)
}
