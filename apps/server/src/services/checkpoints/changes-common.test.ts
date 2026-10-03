import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffSide, diskSide, EMPTY_SIDE, fileDiffOf, projectRelPath, readDiskFile, SNIFF_BYTES } from './changes-common.ts'
import { sha256Hex } from './disk.ts'

let base: string
let root: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

describe('readDiskFile', () => {
  it('reads the sha, the size, the head and the content up to the limit', async () => {
    await writeFile(join(root, 'empty.txt'), '')
    await writeFile(join(root, 'small.txt'), 'hello\n')
    const large = Buffer.alloc(3 * 1024 * 1024 + 5, 0x61)
    await writeFile(join(root, 'large.txt'), large)
    expect(await readDiskFile(root, 'empty.txt', 10)).toEqual({ state: 'present', sha: sha256Hex(''), size: 0, bytes: Buffer.alloc(0), head: Buffer.alloc(0) })
    expect(await readDiskFile(root, 'small.txt', 6)).toEqual({ state: 'present', sha: sha256Hex('hello\n'), size: 6, bytes: Buffer.from('hello\n'), head: Buffer.from('hello\n') })
    expect(await readDiskFile(root, 'small.txt', 5)).toMatchObject({ size: 6, bytes: null, head: Buffer.from('hello\n') })
    const read = await readDiskFile(root, 'large.txt', 1024)
    expect(read).toMatchObject({ state: 'present', sha: sha256Hex(large), size: large.length, bytes: null })
    expect(read.state === 'present' && read.head.length).toBe(SNIFF_BYTES)
    const whole = await readDiskFile(root, 'large.txt', large.length)
    expect(whole.state === 'present' && whole.bytes?.equals(large)).toBe(true)
  })

  it('answers missing for a missing file and rejects paths the guard refuses', async () => {
    expect(await readDiskFile(root, 'missing/file.txt', 10)).toEqual({ state: 'missing' })
    await mkdir(join(root, 'folder'))
    await expect(readDiskFile(root, 'folder', 10)).rejects.toMatchObject({ code: 'validation_error' })
    await writeFile(join(base, 'outside.txt'), 'secret')
    if (process.platform !== 'win32') {
      await symlink(join(base, 'outside.txt'), join(root, 'link.txt'))
      await expect(readDiskFile(root, 'link.txt', 10)).rejects.toMatchObject({ code: 'validation_error' })
    }
    await expect(readDiskFile(root, 'small.txt', 10, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('diff sides', () => {
  it('applies the binary and the size rules', () => {
    expect(diffSide(Buffer.from('text\n'))).toEqual({ text: 'text\n', binary: false, tooLarge: false })
    expect(diffSide(Buffer.from([0x61, 0]))).toEqual({ text: null, binary: true, tooLarge: false })
    expect(diffSide(Buffer.from([0xC3, 0x28]))).toEqual({ text: null, binary: true, tooLarge: false })
    // A NUL byte after the sniffed head still fails the decode.
    const late = Buffer.alloc(SNIFF_BYTES + 10, 0x61)
    late[SNIFF_BYTES + 5] = 0
    expect(diffSide(late)).toMatchObject({ binary: true })
    expect(diffSide(null, Buffer.from([0x61, 0]))).toEqual({ text: null, binary: true, tooLarge: true })
    expect(diffSide(null, late)).toEqual({ text: null, binary: false, tooLarge: true })
    expect(diskSide({ state: 'missing' })).toBe(EMPTY_SIDE)
  })

  it('builds a FileDiff only from two text sides', async () => {
    const current = { state: 'present' as const, sha: sha256Hex('b\n'), size: 2, bytes: Buffer.from('b\n'), head: Buffer.from('b\n') }
    const parts = { source: 'chat' as const, path: 'x.txt', origPath: null, status: 'modified' as const, current }
    expect(await fileDiffOf({ ...parts, base: diffSide(Buffer.from('a\n')) })).toMatchObject({ diff: { added: 1, removed: 1 }, baseAvailable: true, currentSha: sha256Hex('b\n') })
    expect(await fileDiffOf({ ...parts, base: null })).toMatchObject({ diff: null, baseAvailable: false, binary: false, tooLarge: false })
    expect(await fileDiffOf({ ...parts, base: diffSide(null, Buffer.from('a')) })).toMatchObject({ diff: null, tooLarge: true, binary: false })
    expect(await fileDiffOf({ ...parts, base: EMPTY_SIDE, current: { state: 'missing' } })).toMatchObject({ diff: { hunks: [] }, currentSha: null })
  })
})

describe('projectRelPath', () => {
  it('normalizes lexically and refuses paths outside the folder', () => {
    expect(projectRelPath(root, './a/../b/c.txt')).toBe('b/c.txt')
    for (const path of ['../x', '.', '', 'a\u0000b'])
      expect(() => projectRelPath(root, path), path).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })
})
