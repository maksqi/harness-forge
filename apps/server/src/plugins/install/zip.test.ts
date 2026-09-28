import type { ArchiveEntry } from './archive.ts'
import type { OpenedZip, ZipEntry, ZipSource } from './zip.ts'
import { Buffer } from 'node:buffer'
import { crc32, deflateRawSync } from 'node:zlib'
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate'
import { describe, expect, it } from 'vitest'
import { EntryCollector } from './archive.ts'
import { INSTALL_LIMITS } from './errors.ts'
import { localRecord, patchZip, storedZip, unixMode, zipOf } from './testing.ts'
import { looksLikeZip, openZip, readZip } from './zip.ts'

function collector(limits: Partial<typeof INSTALL_LIMITS> = {}): EntryCollector {
  return new EntryCollector({ ...INSTALL_LIMITS, ...limits }, ['file'])
}

function read(zip: Uint8Array, limits: Partial<typeof INSTALL_LIMITS> = {}): Promise<ArchiveEntry[]> {
  return readZip(zip, collector(limits))
}

function text(entry: ArchiveEntry | undefined): string {
  return new TextDecoder().decode(entry?.data ?? new Uint8Array(0))
}

async function rejection(promise: Promise<unknown>): Promise<{ code: string, message: string, details?: unknown }> {
  try {
    await promise
  }
  catch (error) {
    return error as { code: string, message: string }
  }
  throw new Error('expected a rejection')
}

describe('readZip', () => {
  it('reads files and folders of a fflate zip', async () => {
    const entries = await read(zipOf({ 'plugin.json': '{"a":1}', 'src/index.mjs': 'export default {}', 'empty.txt': '' }))
    expect(entries.map(entry => [entry.path, entry.type])).toEqual([
      ['plugin.json', 'file'],
      ['src/index.mjs', 'file'],
      ['empty.txt', 'file'],
    ])
    expect(text(entries[0])).toBe('{"a":1}')
    expect(looksLikeZip(zipOf({ 'a.txt': 'x' }))).toBe(true)
    expect(looksLikeZip(new Uint8Array([0x1F, 0x8B, 8, 0]))).toBe(false)
  })

  it('skips macOS metadata entries', async () => {
    const entries = await read(zipOf({ 'p/plugin.json': '{}', '__MACOSX/p/._plugin.json': 'meta', 'p/.DS_Store': 'x' }))
    expect(entries.map(entry => entry.path)).toEqual(['p/plugin.json'])
  })

  it.each([
    ['../evil', '".." segment'],
    ['a/../../evil', '".." segment'],
    ['/abs', 'absolute path'],
    ['C:\\x', 'backslash'],
    ['C:/x', 'drive letter'],
    ['dir\\file.txt', 'backslash'],
    ['nul\u0000byte', 'control characters'],
  ])('refuses the entry name %j', async (name, reason) => {
    const error = await rejection(read(zipOf({ 'plugin.json': '{}', [name]: 'x' })))
    expect(error.code).toBe('validation_error')
    expect(error.message).toContain(reason)
    expect(error.details).toMatchObject({ issues: [{ path: ['file'] }] })
  })

  it('refuses symbolic links, devices and FIFOs', async () => {
    const link = await rejection(read(zipOf({ 'plugin.json': '{}', 'link': ['/etc/passwd', unixMode(0o120777)] })))
    expect(link.message).toContain('symbolic link')
    const device = await rejection(read(zipOf({ 'plugin.json': '{}', 'dev': ['', unixMode(0o020644)] })))
    expect(device.message).toContain('device, FIFO or socket')
    const fifo = await rejection(read(zipOf({ 'plugin.json': '{}', 'fifo': ['', unixMode(0o010644)] })))
    expect(fifo.message).toContain('device, FIFO or socket')
  })

  it('accepts regular Unix modes and folder entries', async () => {
    const entries = await read(zipOf({ 'plugin.json': ['{}', unixMode(0o100755)], 'dir/': ['', unixMode(0o040755)] }))
    expect(entries.map(entry => [entry.path, entry.type])).toEqual([['plugin.json', 'file'], ['dir', 'dir']])
  })

  it('refuses duplicates, including case-insensitive ones', async () => {
    const zip = storedZip([
      { name: 'plugin.json', data: Buffer.from('{}') },
      { name: 'PLUGIN.JSON', data: Buffer.from('{}') },
    ])
    expect((await rejection(read(zip))).message).toContain('more than once')
  })

  it('enforces the entry count and the expanded size before decompressing', async () => {
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`f${index}.txt`, 'x']))
    expect((await rejection(read(zipOf(many), { entries: 10 }))).message).toContain('more than 10 entries')
    const big = await rejection(read(zipOf({ 'a.bin': new Uint8Array(2048) }), { expandedBytes: 1024 }))
    expect(big).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 1024 } })
  })

  it('stops a deflate stream that expands beyond its declared size (zip bomb)', async () => {
    const bomb = zipOf({ 'bomb.bin': new Uint8Array(8 * 1024 * 1024) })
    // Declare 1 KB instead of 8 MB: the inflater must stop instead of expanding everything.
    const lying = patchZip(bomb, (view, central) => view.setUint32(central + 24, 1024, true))
    const error = await rejection(read(lying))
    expect(error.message).toContain('expands beyond its declared size')
  })

  it('checks the CRC, the compression method and encryption', async () => {
    const zip = zipOf({ 'plugin.json': '{"x":1}' })
    const badCrc = patchZip(zip, (view, central) => view.setUint32(central + 16, 0xDEADBEEF, true))
    expect((await rejection(read(badCrc))).message).toContain('CRC')
    const lzma = patchZip(zip, (view, central) => view.setUint16(central + 10, 14, true))
    expect((await rejection(read(lzma))).message).toContain('unsupported compression method (14)')
    const encrypted = patchZip(zip, (view, central) => view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true))
    expect((await rejection(read(encrypted))).message).toContain('encrypted')
  })

  it('refuses local headers that disagree with the central directory', async () => {
    const zip = zipOf({ 'plugin.json': '{}' })
    const renamed = patchZip(zip, (_view, _central, bytes) => {
      bytes[30] = 'P'.charCodeAt(0)
    })
    expect((await rejection(read(renamed))).message).toContain('inconsistent headers')
  })

  it('refuses overlapping entries', async () => {
    const inner = localRecord('b.txt', Buffer.from('inner'))
    const outerData = Buffer.concat([Buffer.from(inner), Buffer.from('tail')])
    const zip = storedZip([
      { name: 'a.txt', data: outerData },
      { name: 'b.txt', data: Buffer.from('inner'), localOffset: 30 + 'a.txt'.length, centralOnly: true },
    ])
    expect((await rejection(read(zip))).message).toContain('overlapping')
  })

  it('refuses non-UTF-8 names, truncated and non-zip data', async () => {
    const zip = storedZip([{ name: 'plugin.json', data: Buffer.from('{}') }])
    const latin1 = patchZip(zip, (_view, central, bytes) => {
      bytes[central + 46] = 0xE9
      bytes[30] = 0xE9
    })
    expect((await rejection(read(latin1))).message).toContain('not valid UTF-8')
    expect((await rejection(read(zip.subarray(0, zip.length - 30)))).message).toMatch(/not a zip|damaged/)
    expect((await rejection(read(new TextEncoder().encode('hello world, not a zip file at all')))).message).toContain('not a zip archive')
  })

  it('reads a hand-written deflate entry and checks its size', async () => {
    const content = Buffer.from('a'.repeat(5000))
    const compressed = deflateRawSync(content)
    const zip = storedZip([{ name: 'plugin.json', data: compressed }])
    const deflated = patchZip(zip, (view, central, bytes) => {
      view.setUint16(central + 10, 8, true)
      view.setUint32(central + 16, crc32(content) >>> 0, true)
      view.setUint32(central + 24, content.length, true)
      bytes[8] = 8
    })
    const entries = await read(deflated)
    expect(text(entries[0])).toBe(content.toString())
    const short = patchZip(deflated, (view, central) => view.setUint32(central + 24, content.length + 10, true))
    expect((await rejection(read(short))).message).toContain('does not match its declared size')
  })
})

// ---------- openZip (lazy reader of bulk data imports) ----------

/** A zip written by fflate's streaming `Zip` (local headers without sizes, data descriptors), like the data export. */
function streamedZip(files: Array<[name: string, data: Uint8Array, method: 'store' | 'deflate']>): Uint8Array {
  const chunks: Uint8Array[] = []
  const zip = new Zip((error, chunk) => {
    if (error)
      throw error
    chunks.push(chunk)
  })
  for (const [name, data, method] of files) {
    const entry = method === 'store' ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 })
    zip.add(entry)
    const half = Math.floor(data.length / 2)
    entry.push(data.subarray(0, half))
    entry.push(data.subarray(half), true)
  }
  zip.end()
  return new Uint8Array(Buffer.concat(chunks))
}

function open(source: ZipSource, limits: Partial<typeof INSTALL_LIMITS> = {}): Promise<OpenedZip> {
  return openZip(source, collector(limits))
}

function entryOf(opened: OpenedZip, path: string): ZipEntry {
  const entry = opened.entries.find(candidate => candidate.path === path)
  if (entry === undefined)
    throw new Error(`no entry ${path}`)
  return entry
}

async function readText(opened: OpenedZip, path: string): Promise<string> {
  return new TextDecoder().decode(await opened.read(entryOf(opened, path)))
}

describe('openZip', () => {
  it('opens bytes and Blobs and reads each entry on demand', async () => {
    const zip = zipOf({ 'manifest.json': '{"a":1}', 'chats/x.json': 'hello', 'dir/': ['', unixMode(0o040755)], 'empty.txt': '' })
    for (const source of [zip, new Blob([zip])]) {
      const opened = await open(source)
      expect(opened.entries).toEqual([
        { path: 'manifest.json', type: 'file', size: 7 },
        { path: 'chats/x.json', type: 'file', size: 5 },
        { path: 'dir', type: 'dir', size: 0 },
        { path: 'empty.txt', type: 'file', size: 0 },
      ])
      expect(await readText(opened, 'chats/x.json')).toBe('hello')
      expect(await readText(opened, 'manifest.json')).toBe('{"a":1}')
      expect(await readText(opened, 'empty.txt')).toBe('')
    }
    // Reading never modifies the source.
    const copy = zip.slice()
    const opened = await open(zip)
    const content = await opened.read(entryOf(opened, 'chats/x.json'))
    content.fill(0)
    expect(zip).toEqual(copy)
  })

  it('reads a zip written by the streaming fflate Zip (data descriptors, stored and deflated entries)', async () => {
    const image = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 7919) % 251)
    const text = new TextEncoder().encode('line of text\n'.repeat(5000))
    const zip = streamedZip([['files/a', image, 'store'], ['files/b', text, 'deflate'], ['manifest.json', new TextEncoder().encode('{}'), 'deflate']])
    const opened = await open(new Blob([zip]))
    expect(opened.entries.map(entry => [entry.path, entry.size])).toEqual([['files/a', image.length], ['files/b', text.length], ['manifest.json', 2]])
    expect(await opened.read(entryOf(opened, 'files/a'))).toEqual(image)
    expect(await opened.read(entryOf(opened, 'files/b'))).toEqual(text)
    expect(await readText(opened, 'manifest.json')).toBe('{}')
  })

  it('applies the readZip guards when the archive is opened', async () => {
    const traversal = await rejection(open(zipOf({ 'manifest.json': '{}', '../evil': 'x' })))
    expect(traversal).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['file'] }] } })
    expect(traversal.message).toContain('".." segment')
    expect((await rejection(open(zipOf({ 'manifest.json': '{}', 'link': ['/etc/passwd', unixMode(0o120777)] })))).message).toContain('symbolic link')
    const duplicates = storedZip([{ name: 'a.json', data: Buffer.from('{}') }, { name: 'A.JSON', data: Buffer.from('{}') }])
    expect((await rejection(open(new Blob([duplicates])))).message).toContain('more than once')
    const many = Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`f${index}.txt`, 'x']))
    expect((await rejection(open(zipOf(many), { entries: 10 }))).message).toContain('more than 10 entries')
    const encrypted = patchZip(zipOf({ 'a.txt': 'x' }), (view, central) => view.setUint16(central + 8, view.getUint16(central + 8, true) | 1, true))
    expect((await rejection(open(encrypted))).message).toContain('encrypted')
  })

  it('checks data only when an entry is read: a damaged entry fails alone', async () => {
    const zip = zipOf({ 'a.txt': 'fine', 'b.txt': 'broken' })
    const badCrc = patchZip(zip, (view, central) => view.setUint32(central + 16, 0xDEADBEEF, true), 1)
    const opened = await open(new Blob([badCrc]))
    expect(await readText(opened, 'a.txt')).toBe('fine')
    expect((await rejection(opened.read(entryOf(opened, 'b.txt')))).message).toContain('fails its CRC check')

    const renamed = patchZip(zip, (_view, _central, bytes) => {
      bytes[30] = 'x'.charCodeAt(0)
    })
    const inconsistent = await open(renamed)
    expect((await rejection(inconsistent.read(entryOf(inconsistent, 'a.txt')))).message).toContain('inconsistent headers')
  })

  it('stops a zip bomb and refuses an entry above maxBytes before reading it', async () => {
    const bomb = zipOf({ 'bomb.bin': new Uint8Array(8 * 1024 * 1024) })
    const lying = patchZip(bomb, (view, central) => view.setUint32(central + 24, 1024, true))
    const opened = await open(new Blob([lying]))
    expect((await rejection(opened.read(entryOf(opened, 'bomb.bin')))).message).toContain('expands beyond its declared size')

    const honest = await open(bomb)
    const refused = await rejection(honest.read(entryOf(honest, 'bomb.bin'), { maxBytes: 1024 * 1024 }))
    expect(refused).toMatchObject({ code: 'payload_too_large', details: { limitBytes: 1024 * 1024 } })
    expect((await honest.read(entryOf(honest, 'bomb.bin'), { maxBytes: 8 * 1024 * 1024 })).length).toBe(8 * 1024 * 1024)
  })

  it('refuses overlapping entries when opening, and data that runs into the next entry when reading', async () => {
    const inner = localRecord('b.txt', Buffer.from('inner'))
    const reused = storedZip([
      { name: 'a.txt', data: Buffer.concat([Buffer.from(inner), Buffer.from('tail')]) },
      { name: 'b.txt', data: Buffer.from('inner'), localOffset: 30 + 'a.txt'.length, centralOnly: true },
    ])
    expect((await rejection(open(reused))).message).toContain('overlapping')

    // A local extra field pushes the data of a.txt into b.txt: only visible once the local header is read.
    const zip = storedZip([{ name: 'a.txt', data: Buffer.from('aaaa') }, { name: 'b.txt', data: Buffer.from('bbbb') }])
    const shifted = patchZip(zip, (_view, _central, bytes) => {
      bytes[28] = 4
    })
    const opened = await open(new Blob([shifted]))
    expect((await rejection(opened.read(entryOf(opened, 'a.txt')))).message).toContain('overlapping')
    expect(await readText(opened, 'b.txt')).toBe('bbbb')
  })

  it('refuses non-zip and truncated sources and foreign entries', async () => {
    expect((await rejection(open(new Blob(['hello world, not a zip file at all'])))).message).toContain('not a zip archive')
    expect((await rejection(open(new Uint8Array(0)))).message).toContain('not a zip archive')
    const zip = zipOf({ 'a.txt': 'x' })
    expect((await rejection(open(zip.subarray(0, zip.length - 30)))).message).toMatch(/not a zip|damaged/)
    const opened = await open(zipOf({ 'dir/': ['', unixMode(0o040755)], 'a.txt': 'x' }))
    await expect(opened.read(entryOf(opened, 'dir'))).rejects.toThrow(TypeError)
    await expect(opened.read({ path: 'a.txt', type: 'file', size: 1 })).rejects.toThrow(TypeError)
    expect(await readText(opened, 'a.txt')).toBe('x')
  })
})
