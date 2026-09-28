// Strict zip reader for plugin uploads and URL installs (PLUGINS.md 12 "Archive rules").
//
// The central directory is parsed here (fflate's `unzipSync` does not expose the external attributes needed to refuse
// symbolic links and special files); file data is decompressed with fflate's streaming `Inflate` in small chunks so a
// deflate stream that expands beyond its declared size is stopped after at most one chunk of output, and every file is
// checked against its CRC-32. Refused: encrypted entries, compression methods other than store / deflate, multi-disk
// archives, non-UTF-8 names, symbolic links, devices / FIFOs / sockets, local headers that disagree with the central
// directory, overlapping entries (zip bombs that reuse data), and everything `EntryCollector` refuses (names, count,
// expanded size, duplicates).
import type { ArchiveEntry, EntryCollector } from './archive.ts'
import { crc32 } from 'node:zlib'
import { Inflate } from 'fflate'
import { invalid, quoteName } from './errors.ts'

const EOCD_SIGNATURE = 0x06054B50
const ZIP64_LOCATOR_SIGNATURE = 0x07064B50
const ZIP64_EOCD_SIGNATURE = 0x06064B50
const CENTRAL_SIGNATURE = 0x02014B50
const LOCAL_SIGNATURE = 0x04034B50
const EOCD_SIZE = 22
const CENTRAL_HEADER_SIZE = 46
const LOCAL_HEADER_SIZE = 30
const MAX_COMMENT_SIZE = 0xFFFF
const ZIP64_EXTRA_ID = 0x0001

const METHOD_STORE = 0
const METHOD_DEFLATE = 8

/** General purpose flags: bit 0 encrypted, bit 6 strong encryption. */
const FLAG_ENCRYPTED = 0x0001
const FLAG_STRONG_ENCRYPTION = 0x0040

/** "Version made by" hosts whose external attributes carry a Unix mode in the upper 16 bits. */
const UNIX_HOSTS = new Set([3, 19])
const S_IFMT = 0o170000
const S_IFDIR = 0o040000
const S_IFLNK = 0o120000
const SPECIAL_TYPES = new Set([0o010000, 0o020000, 0o060000, 0o140000])
/** MS-DOS directory attribute. */
const DOS_DIRECTORY = 0x10

/** Compressed bytes pushed into the inflater at a time: bounds the output produced before a size check. */
const INFLATE_CHUNK_BYTES = 8 * 1024
/** Decompressed bytes after which the reader yields to the event loop. */
const YIELD_EVERY_BYTES = 4 * 1024 * 1024

const utf8 = new TextDecoder('utf-8', { fatal: true })

class ZipFormatError extends Error {}

interface CentralEntry {
  path: string
  rawName: string
  nameBytes: Uint8Array
  dir: boolean
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

class Reader {
  readonly #view: DataView
  readonly length: number

  constructor(readonly data: Uint8Array) {
    this.#view = new DataView(data.buffer, data.byteOffset, data.byteLength)
    this.length = data.byteLength
  }

  #check(offset: number, size: number): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + size > this.length)
      throw new ZipFormatError('truncated')
  }

  u16(offset: number): number {
    this.#check(offset, 2)
    return this.#view.getUint16(offset, true)
  }

  u32(offset: number): number {
    this.#check(offset, 4)
    return this.#view.getUint32(offset, true)
  }

  u64(offset: number): number {
    this.#check(offset, 8)
    const value = this.#view.getBigUint64(offset, true)
    if (value > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ZipFormatError('size out of range')
    return Number(value)
  }

  bytes(offset: number, size: number): Uint8Array {
    this.#check(offset, size)
    return this.data.subarray(offset, offset + size)
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length)
    return false
  for (let index = 0; index < a.length; index++) {
    if (a[index] !== b[index])
      return false
  }
  return true
}

/**
 * Entry names must be UTF-8 (flag bit 11, or plain ASCII). Legacy code-page names that are not valid UTF-8 are refused
 * instead of guessed, so the name that is checked is the name that is written.
 */
function decodeName(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes)
  }
  catch {
    return null
  }
}

/** The end of central directory record: the last signature whose comment fits in the file. */
function findEndOfCentralDirectory(reader: Reader): number {
  const lowest = Math.max(0, reader.length - EOCD_SIZE - MAX_COMMENT_SIZE)
  for (let offset = reader.length - EOCD_SIZE; offset >= lowest; offset--) {
    if (reader.u32(offset) === EOCD_SIGNATURE && offset + EOCD_SIZE + reader.u16(offset + 20) <= reader.length)
      return offset
  }
  throw new ZipFormatError('not a zip')
}

interface Directory {
  entries: number
  size: number
  offset: number
  /** Where the central directory must end (the zip64 or classic end record). */
  end: number
}

function readDirectory(reader: Reader, eocd: number): Directory {
  const disk = reader.u16(eocd + 4)
  const directoryDisk = reader.u16(eocd + 6)
  const diskEntries = reader.u16(eocd + 8)
  let entries = reader.u16(eocd + 10)
  let size = reader.u32(eocd + 12)
  let offset = reader.u32(eocd + 16)
  let end = eocd
  const zip64 = entries === 0xFFFF || size === 0xFFFFFFFF || offset === 0xFFFFFFFF
  if (zip64) {
    const locator = eocd - 20
    if (locator < 0 || reader.u32(locator) !== ZIP64_LOCATOR_SIGNATURE)
      throw new ZipFormatError('zip64 locator missing')
    const record = reader.u64(locator + 8)
    if (reader.u32(record) !== ZIP64_EOCD_SIGNATURE)
      throw new ZipFormatError('zip64 end record missing')
    if (reader.u32(record + 16) !== 0 || reader.u32(record + 20) !== 0)
      throw invalid('Multi-part zip archives are not supported.', ['file'])
    entries = reader.u64(record + 32)
    size = reader.u64(record + 40)
    offset = reader.u64(record + 48)
    end = record
  }
  else if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entries) {
    throw invalid('Multi-part zip archives are not supported.', ['file'])
  }
  if (offset + size > end)
    throw new ZipFormatError('central directory out of range')
  return { entries, size, offset, end }
}

/** Sizes and offset from the zip64 extended information extra field, for the values stored as 0xFFFF(FFFF). */
function applyZip64Extra(reader: Reader, extraOffset: number, extraLength: number, entry: { size: number, compressedSize: number, localOffset: number, disk: number }): void {
  const needed = entry.size === 0xFFFFFFFF || entry.compressedSize === 0xFFFFFFFF || entry.localOffset === 0xFFFFFFFF || entry.disk === 0xFFFF
  if (!needed)
    return
  let cursor = extraOffset
  const limit = extraOffset + extraLength
  while (cursor + 4 <= limit) {
    const id = reader.u16(cursor)
    const length = reader.u16(cursor + 2)
    const body = cursor + 4
    if (body + length > limit)
      break
    if (id === ZIP64_EXTRA_ID) {
      let field = body
      const next = (): number => {
        if (field + 8 > body + length)
          throw new ZipFormatError('zip64 extra field too short')
        const value = reader.u64(field)
        field += 8
        return value
      }
      if (entry.size === 0xFFFFFFFF)
        entry.size = next()
      if (entry.compressedSize === 0xFFFFFFFF)
        entry.compressedSize = next()
      if (entry.localOffset === 0xFFFFFFFF)
        entry.localOffset = next()
      if (entry.disk === 0xFFFF) {
        if (field + 4 > body + length)
          throw new ZipFormatError('zip64 extra field too short')
        entry.disk = reader.u32(field)
      }
      return
    }
    cursor = body + length
  }
  throw new ZipFormatError('zip64 extra field missing')
}

function readCentralDirectory(reader: Reader, directory: Directory, collector: EntryCollector): CentralEntry[] {
  const entries: CentralEntry[] = []
  let cursor = directory.offset
  const end = directory.offset + directory.size
  for (let index = 0; index < directory.entries; index++) {
    if (cursor + CENTRAL_HEADER_SIZE > end || reader.u32(cursor) !== CENTRAL_SIGNATURE)
      throw new ZipFormatError('bad central header')
    const versionMadeBy = reader.u16(cursor + 4)
    const flags = reader.u16(cursor + 8)
    const method = reader.u16(cursor + 10)
    const crc = reader.u32(cursor + 16)
    const nameLength = reader.u16(cursor + 28)
    const extraLength = reader.u16(cursor + 30)
    const commentLength = reader.u16(cursor + 32)
    const externalAttributes = reader.u32(cursor + 38)
    const sizes = {
      compressedSize: reader.u32(cursor + 20),
      size: reader.u32(cursor + 24),
      localOffset: reader.u32(cursor + 42),
      disk: reader.u16(cursor + 34),
    }
    const nameBytes = reader.bytes(cursor + CENTRAL_HEADER_SIZE, nameLength)
    applyZip64Extra(reader, cursor + CENTRAL_HEADER_SIZE + nameLength, extraLength, sizes)
    const next = cursor + CENTRAL_HEADER_SIZE + nameLength + extraLength + commentLength
    if (next > end)
      throw new ZipFormatError('central header out of range')
    cursor = next

    const rawName = decodeName(nameBytes)
    if (rawName === null)
      throw invalid('The zip contains a file name that is not valid UTF-8.', ['file'])
    if ((flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) !== 0)
      throw invalid(`The entry ${quoteName(rawName)} is encrypted; encrypted zips are not supported.`, ['file'])
    if (sizes.disk !== 0)
      throw invalid('Multi-part zip archives are not supported.', ['file'])
    let dir = rawName.endsWith('/')
    if (UNIX_HOSTS.has(versionMadeBy >>> 8)) {
      const fileType = (externalAttributes >>> 16) & S_IFMT
      if (fileType === S_IFLNK)
        throw invalid(`The entry ${quoteName(rawName)} is a symbolic link; links are not allowed.`, ['file'])
      if (SPECIAL_TYPES.has(fileType))
        throw invalid(`The entry ${quoteName(rawName)} is a device, FIFO or socket; only files and folders are allowed.`, ['file'])
      if (fileType === S_IFDIR)
        dir = true
    }
    else if ((externalAttributes & DOS_DIRECTORY) !== 0) {
      dir = true
    }
    if (!dir && method !== METHOD_STORE && method !== METHOD_DEFLATE)
      throw invalid(`The entry ${quoteName(rawName)} uses an unsupported compression method (${method}); use deflate or store.`, ['file'])
    if (dir && sizes.size > 0)
      throw invalid(`The folder entry ${quoteName(rawName)} carries data.`, ['file'])
    const path = collector.admit(rawName, dir ? 'dir' : 'file', dir ? 0 : sizes.size)
    if (path === null)
      continue
    entries.push({ path, rawName, nameBytes, dir, method, crc, compressedSize: sizes.compressedSize, size: sizes.size, localOffset: sizes.localOffset })
  }
  return entries
}

/** Start and end of an entry's compressed data after its local header (which must match the central record). */
function dataRange(reader: Reader, entry: CentralEntry, directoryOffset: number): { start: number, end: number } {
  const local = entry.localOffset
  if (reader.u32(local) !== LOCAL_SIGNATURE)
    throw new ZipFormatError('bad local header')
  const nameLength = reader.u16(local + 26)
  const extraLength = reader.u16(local + 28)
  const localName = reader.bytes(local + LOCAL_HEADER_SIZE, nameLength)
  if (!sameBytes(localName, entry.nameBytes))
    throw invalid(`The entry ${quoteName(entry.rawName)} has inconsistent headers.`, ['file'])
  const start = local + LOCAL_HEADER_SIZE + nameLength + extraLength
  const end = start + entry.compressedSize
  if (end > directoryOffset)
    throw new ZipFormatError('entry data out of range')
  return { start, end }
}

/** Inflates `input` into exactly `size` bytes; stops as soon as the output would exceed `size`. */
function inflateExact(input: Uint8Array, size: number, name: string): Uint8Array {
  const output = new Uint8Array(size)
  let written = 0
  let overflow = false
  const inflater = new Inflate((chunk) => {
    if (written + chunk.length > size) {
      overflow = true
      throw new ZipFormatError('overflow')
    }
    output.set(chunk, written)
    written += chunk.length
  })
  try {
    if (input.length === 0)
      inflater.push(new Uint8Array(0), true)
    for (let offset = 0; offset < input.length; offset += INFLATE_CHUNK_BYTES) {
      const end = Math.min(input.length, offset + INFLATE_CHUNK_BYTES)
      inflater.push(input.subarray(offset, end), end === input.length)
    }
  }
  catch {
    if (overflow)
      throw invalid(`The entry ${quoteName(name)} expands beyond its declared size.`, ['file'])
    throw invalid(`The entry ${quoteName(name)} cannot be decompressed (damaged zip).`, ['file'])
  }
  if (written !== size)
    throw invalid(`The entry ${quoteName(name)} does not match its declared size (damaged zip).`, ['file'])
  return output
}

/** Lets other requests run between large entries (decompression is synchronous). */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve))
}

/** Reads a zip: every entry is admitted by `collector` before any data is decompressed. */
export async function readZip(data: Uint8Array, collector: EntryCollector): Promise<ArchiveEntry[]> {
  const reader = new Reader(data)
  try {
    const directory = readDirectory(reader, findEndOfCentralDirectory(reader))
    const central = readCentralDirectory(reader, directory, collector)

    const ranges = central
      .filter(entry => !entry.dir)
      .map(entry => ({ entry, ...dataRange(reader, entry, directory.offset) }))
    const sorted = [...ranges].sort((a, b) => a.entry.localOffset - b.entry.localOffset)
    for (let index = 1; index < sorted.length; index++) {
      const previous = sorted[index - 1]!
      const current = sorted[index]!
      if (current.entry.localOffset < previous.end)
        throw invalid('The zip contains overlapping entries.', ['file'])
    }

    const files = new Map<CentralEntry, Uint8Array>()
    let sinceYield = 0
    for (const { entry, start, end } of ranges) {
      if (sinceYield > YIELD_EVERY_BYTES) {
        sinceYield = 0
        await yieldToEventLoop()
      }
      sinceYield += entry.size
      const compressed = data.subarray(start, end)
      let content: Uint8Array
      if (entry.method === METHOD_STORE) {
        if (entry.compressedSize !== entry.size)
          throw invalid(`The entry ${quoteName(entry.rawName)} does not match its declared size (damaged zip).`, ['file'])
        content = compressed.slice()
      }
      else {
        content = inflateExact(compressed, entry.size, entry.rawName)
      }
      if ((crc32(content) >>> 0) !== (entry.crc >>> 0))
        throw invalid(`The entry ${quoteName(entry.rawName)} fails its CRC check (damaged zip).`, ['file'])
      files.set(entry, content)
    }
    return central.map(entry => ({ path: entry.path, type: entry.dir ? 'dir' : 'file', data: entry.dir ? null : files.get(entry) ?? new Uint8Array(0) }))
  }
  catch (error) {
    if (error instanceof ZipFormatError)
      throw invalid(error.message === 'not a zip' ? 'The file is not a zip archive.' : 'The zip archive is damaged or truncated.', ['file'])
    throw error
  }
}

/** True when `data` starts like a zip archive (local header, or the end record of an empty archive). */
export function looksLikeZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4B
    && ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06))
}
