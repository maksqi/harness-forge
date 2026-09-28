import type { ArchiveEntry } from './archive.ts'
import { Buffer } from 'node:buffer'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { EntryCollector } from './archive.ts'
import { INSTALL_LIMITS } from './errors.ts'
import { readTarGz } from './tar.ts'
import { tarOf, tgzOf } from './testing.ts'

function read(tgz: Uint8Array, limits: Partial<typeof INSTALL_LIMITS> = {}): Promise<ArchiveEntry[]> {
  const merged = { ...INSTALL_LIMITS, ...limits }
  return readTarGz(tgz, new EntryCollector(merged, ['spec']), merged, ['spec'])
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

describe('readTarGz', () => {
  it('reads an npm-style tarball with folders, empty files and long names', async () => {
    const long = `package/${'x'.repeat(120)}/file.txt`
    const entries = await read(tgzOf([
      { name: 'package/', type: '5' },
      { name: 'package/plugin.json', data: '{"id":"x"}' },
      { name: 'package/empty.txt', data: '' },
      { name: long, data: 'deep', pax: true },
    ]))
    expect(entries.map(entry => [entry.path, entry.type])).toEqual([
      ['package', 'dir'],
      ['package/plugin.json', 'file'],
      ['package/empty.txt', 'file'],
      [long, 'file'],
    ])
    expect(new TextDecoder().decode(entries[1]!.data!)).toBe('{"id":"x"}')
    expect(entries[2]!.data!.byteLength).toBe(0)
  })

  it.each([
    [{ name: 'package/link', type: '2', linkname: '/etc/passwd' }, 'symbolic link'],
    [{ name: 'package/hard', type: '1', linkname: 'package/plugin.json' }, 'hard link'],
    [{ name: 'package/dev', type: '3' }, 'a device'],
    [{ name: 'package/fifo', type: '6' }, 'a FIFO'],
    [{ name: 'package/sparse', type: 'S', data: 'xx' }, 'unsupported entry'],
    [{ name: '../evil', data: 'x' }, '".." segment'],
    [{ name: '/abs', data: 'x' }, 'absolute path'],
    [{ name: 'package\\evil', data: 'x' }, 'backslash'],
    [{ name: 'C:/evil', data: 'x' }, 'drive letter'],
  ])('refuses %j', async (entry, reason) => {
    const error = await rejection(read(tgzOf([{ name: 'package/plugin.json', data: '{}' }, entry])))
    expect(error.code).toBe('validation_error')
    expect(error.message).toContain(reason)
  })

  it('refuses duplicate paths', async () => {
    const error = await rejection(read(tgzOf([
      { name: 'package/plugin.json', data: '{}' },
      { name: 'package/plugin.json', data: '{"x":1}' },
    ])))
    expect(error.message).toContain('more than once')
  })

  it('enforces the entry count and the declared expanded size', async () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ name: `package/f${index}`, data: 'x' }))
    expect((await rejection(read(tgzOf(many), { entries: 5 }))).message).toContain('more than 5 entries')
    const big = await rejection(read(tgzOf([{ name: 'package/big.bin', data: new Uint8Array(4096) }]), { expandedBytes: 1024 }))
    expect(big).toMatchObject({ code: 'payload_too_large' })
  })

  it('stops a gzip bomb at the output cap', async () => {
    const bomb = new Uint8Array(gzipSync(Buffer.alloc(64 * 1024 * 1024)))
    const error = await rejection(read(bomb, { expandedBytes: 1024 * 1024, entries: 10 }))
    expect(error).toMatchObject({ code: 'payload_too_large' })
  })

  it('refuses truncated archives, bad checksums, nested gzip and non-gzip data', async () => {
    const tar = tarOf([{ name: 'package/plugin.json', data: 'x'.repeat(2000) }])
    expect((await rejection(read(new Uint8Array(gzipSync(tar.subarray(0, 1024)))))).message).toMatch(/not a valid tar|truncated/i)
    const corrupted = Buffer.from(tar)
    corrupted[0] = 0x41
    expect((await rejection(read(new Uint8Array(gzipSync(corrupted))))).message).toContain('not a valid tar')
    const nested = new Uint8Array(gzipSync(gzipSync(tar)))
    expect((await rejection(read(nested))).message).toContain('Nested compression')
    expect((await rejection(read(new Uint8Array(tar)))).message).toContain('not a gzip-compressed tar')
    expect((await rejection(read(new Uint8Array([0x1F, 0x8B, 1, 2, 3])))).message).toContain('not a valid gzip file')
  })
})
