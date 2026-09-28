// Minimal zip writer for the plugin e2e fixtures (W3.6-T1): plugin sources are zipped at test time, including
// hostile archives (`../evil.txt`) that a real zip tool would refuse to produce. Node built-ins only: entries are
// deflated (`deflateRawSync`) or stored, names are UTF-8 (flag bit 11), the local and central headers always agree
// (the server rejects inconsistent headers), and there is no zip64, encryption or data descriptor.
import { Buffer } from 'node:buffer'
import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** Archive path, written as given (no normalization), e.g. `plugin.json`, `my-plugin/index.mjs`, `../evil.txt`. */
  name: string
  data: string | Uint8Array
  /** Store instead of deflate. */
  store?: boolean
}

const LOCAL_HEADER = 0x04034B50
const CENTRAL_HEADER = 0x02014B50
const END_OF_CENTRAL_DIRECTORY = 0x06054B50
const UTF8_NAMES = 0x0800
const VERSION = 20
/** 2026-01-01 00:00:00 in MS-DOS format. */
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1
const DOS_TIME = 0

/** The bytes of a zip archive holding `entries` in order. */
export function createZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = typeof entry.data === 'string' ? Buffer.from(entry.data, 'utf8') : Buffer.from(entry.data)
    const method = entry.store ? 0 : 8
    const data = entry.store ? raw : deflateRawSync(raw)
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER, 0)
    local.writeUInt16LE(VERSION, 4)
    local.writeUInt16LE(UTF8_NAMES, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER, 0)
    central.writeUInt16LE(VERSION, 4)
    central.writeUInt16LE(VERSION, 6)
    central.writeUInt16LE(UTF8_NAMES, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(DOS_TIME, 12)
    central.writeUInt16LE(DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, directory, end])
}
