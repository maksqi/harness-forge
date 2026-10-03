// Plugin data scan (W8.7-T3, ADR-039): ids anywhere under `plugins/.data` (nested, binary, split across chunks), links
// never followed, FIFOs skipped without blocking, the byte / entry / depth budget, the abort signal.
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PLUGIN_DATA_CARRY_BYTES, PLUGIN_DATA_CHUNK_BYTES, PLUGIN_DATA_SCAN_BUDGET, scanPluginData } from './plugin-data-scan.ts'

const posix = process.platform !== 'win32'
const ID_A = 'file_AAAAAAAAAAAAAAA1'
const ID_B = 'file_BBBBBBBBBBBBBBB2'
const ID_C = 'file_CCCCCCCCCCCCCCC3'

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-plugin-data-')))
  root = join(base, 'plugins', '.data')
  await mkdir(root, { recursive: true })
})

afterEach(async () => {
  await chmod(base, 0o700).catch(() => {})
  await rm(base, { recursive: true, force: true })
})

async function put(rel: string, content: string | Uint8Array): Promise<string> {
  const path = join(root, rel)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content)
  return path
}

async function scan(options: Parameters<typeof scanPluginData>[2] = {}) {
  const ids = new Set<string>()
  const result = await scanPluginData(root, ids, options)
  return { ids, result }
}

describe('scanPluginData', () => {
  it('finds ids in every plugin folder (disabled ones and keepData leftovers too), nested and in binary content', async () => {
    await put('gallery/state.json', JSON.stringify({ last: ID_A }))
    await put('old-plugin/cache/deep/notes.txt', `kept ${ID_B} here`)
    // Bytes that are not valid UTF-8 around the id: latin1 reads every byte as one character.
    await put('binary/blob.bin', Uint8Array.from([0xFF, 0xFE, 0x00, ...Buffer.from(ID_C), 0xC3, 0x28]))
    // A longer token still yields its first 16 characters (a loose scan may keep an extra file, never miss one).
    await put('gallery/other.txt', 'file_DDDDDDDDDDDDDDDD4extra')
    const { ids, result } = await scan()
    expect([...ids].sort()).toEqual([ID_A, ID_B, ID_C, 'file_DDDDDDDDDDDDDDDD'].sort())
    expect(result).toMatchObject({ scan: 'complete', files: 4, limit: null })
    expect(result.bytes).toBeGreaterThan(0)
  })

  it('is complete for a missing or empty root', async () => {
    expect((await scan()).result).toEqual({ scan: 'complete', files: 0, bytes: 0, limit: null })
    const ids = new Set<string>()
    expect(await scanPluginData(join(base, 'missing'), ids)).toEqual({ scan: 'complete', files: 0, bytes: 0, limit: null })
    expect(ids.size).toBe(0)
  })

  it('finds an id split across the default 1 MiB chunk boundary', async () => {
    // The id starts 10 bytes before the end of the first chunk.
    const padding = Buffer.alloc(PLUGIN_DATA_CHUNK_BYTES - 10, 0x20)
    await put('big/data.txt', Buffer.concat([padding, Buffer.from(ID_A), Buffer.alloc(100, 0x20)]))
    const { ids, result } = await scan()
    expect([...ids]).toEqual([ID_A])
    expect(result).toMatchObject({ scan: 'complete', files: 1, bytes: PLUGIN_DATA_CHUNK_BYTES + ID_A.length - 10 + 100 })
  })

  it('finds an id at every offset across small chunks (the carry-over covers the 21-byte id)', async () => {
    const chunkBytes = PLUGIN_DATA_CARRY_BYTES + 5
    for (let offset = 0; offset < 2 * chunkBytes; offset++) {
      await put('p/split.txt', `${'x'.repeat(offset)}${ID_B}${'y'.repeat(7)}`)
      const { ids } = await scan({ chunkBytes })
      expect([...ids], `offset ${offset}`).toEqual([ID_B])
    }
  })

  it.runIf(posix)('never follows a link to a file or a folder (inside or outside the root)', async () => {
    const outside = join(base, 'outside')
    await mkdir(outside)
    await writeFile(join(outside, 'secret.txt'), ID_A)
    await put('p/real.txt', ID_B)
    await symlink(join(outside, 'secret.txt'), join(root, 'p', 'file-link.txt'))
    await symlink(outside, join(root, 'p', 'dir-link'))
    await symlink(join(root, 'p'), join(root, 'loop'))
    const { ids, result } = await scan()
    expect([...ids]).toEqual([ID_B])
    expect(result).toMatchObject({ scan: 'complete', files: 1 })
  })

  it.runIf(posix)('skips a FIFO without blocking on it', async () => {
    await put('p/a.txt', ID_A)
    execFileSync('mkfifo', [join(root, 'p', 'pipe')])
    const { ids, result } = await scan()
    expect([...ids]).toEqual([ID_A])
    expect(result).toMatchObject({ scan: 'complete', files: 1 })
  })

  it('a file over the bytes left is skipped: partial; a manual scan goes on, stopWhenPartial ends it', async () => {
    await put('a/big.txt', `${ID_A}${'z'.repeat(200)}`)
    await put('b/small.txt', ID_B)
    const manual = await scan({ budget: { maxBytes: 100 } })
    expect([...manual.ids]).toEqual([ID_B])
    expect(manual.result).toEqual({ scan: 'partial', files: 1, bytes: ID_B.length, limit: 'bytes' })

    // The automatic sweep ends the scan at the first limit (the folder order decides whether `small.txt` came first).
    const auto = await scan({ budget: { maxBytes: 100 }, stopWhenPartial: true })
    expect(auto.result).toMatchObject({ scan: 'partial', limit: 'bytes' })
    expect(auto.result.files).toBeLessThanOrEqual(1)

    // Exactly the budget is still complete.
    const exact = await scan({ budget: { maxBytes: ID_A.length + 200 + ID_B.length } })
    expect(exact.result).toMatchObject({ scan: 'complete', limit: null })
  })

  it('stops at the entry limit (files and folders count) and at the depth limit', async () => {
    await put('a/1.txt', ID_A)
    await put('b/2.txt', ID_B)
    await put('c/3.txt', ID_C)
    // a, a/1.txt, b, b/2.txt: the fifth entry is over the limit.
    const entries = await scan({ budget: { maxEntries: 4 } })
    expect(entries.result).toMatchObject({ scan: 'partial', limit: 'entries' })
    expect(entries.ids.size).toBeLessThan(3)
    expect((await scan({ budget: { maxEntries: 6 } })).result.scan).toBe('complete')

    await rm(root, { recursive: true, force: true })
    await put('l1/top.txt', ID_A)
    await put('l1/l2/l3/deep.txt', ID_B)
    // The root's entries are level 1: `l1` (1), `l2` (2), `l3` (3).
    const shallow = await scan({ budget: { maxDepth: 2 } })
    expect([...shallow.ids]).toEqual([ID_A])
    expect(shallow.result).toMatchObject({ scan: 'partial', limit: 'depth' })
    const deep = await scan({ budget: { maxDepth: 3 } })
    expect([...deep.ids].sort()).toEqual([ID_A, ID_B])
    expect(deep.result.scan).toBe('complete')
    expect(PLUGIN_DATA_SCAN_BUDGET).toEqual({ maxBytes: 256 * 1024 * 1024, maxEntries: 50_000, maxDepth: 32 })
  })

  it.runIf(posix && process.getuid?.() !== 0)('an unreadable file or folder makes the scan partial', async () => {
    await put('p/locked.txt', ID_A)
    await put('q/readable.txt', ID_B)
    await chmod(join(root, 'p', 'locked.txt'), 0o000)
    const file = await scan()
    expect([...file.ids]).toEqual([ID_B])
    expect(file.result).toMatchObject({ scan: 'partial', limit: 'unreadable' })
    await chmod(join(root, 'p', 'locked.txt'), 0o600)
    await chmod(join(root, 'p'), 0o000)
    const folder = await scan()
    expect(folder.result).toMatchObject({ scan: 'partial', limit: 'unreadable' })
    await chmod(join(root, 'p'), 0o700)
  })

  it('rejects with the reason of an aborted signal', async () => {
    await put('p/a.txt', ID_A)
    const controller = new AbortController()
    const reason = new Error('stopped')
    controller.abort(reason)
    await expect(scanPluginData(root, new Set(), { signal: controller.signal })).rejects.toBe(reason)
  })
})
