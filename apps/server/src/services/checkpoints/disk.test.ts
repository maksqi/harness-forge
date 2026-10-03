import { Buffer } from 'node:buffer'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { heldFileLocks, withFileLock } from '../../workspace/file-lock.ts'
import { resolveWorkspacePath } from '../../workspace/paths.ts'
import { diskSha, diskShas, readCheckpointBefore, sha256Hex, writeWithoutRecording } from './disk.ts'

const POSIX = process.platform !== 'win32'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function resolved(path: string) {
  return resolveWorkspacePath(root, path, { allowMissing: true })
}

describe('readCheckpointBefore', () => {
  it('missing: no file yet (also a deeper missing path)', async () => {
    expect(await readCheckpointBefore(root, await resolved('new.txt'))).toEqual({ state: 'missing' })
    expect(await readCheckpointBefore(root, await resolved('a/b/new.txt'))).toEqual({ state: 'missing' })
  })

  it('missing: the file disappeared after it was resolved', async () => {
    await writeFile(join(root, 'gone.txt'), 'x')
    const target = await resolved('gone.txt')
    await rm(join(root, 'gone.txt'))
    expect(await readCheckpointBefore(root, target)).toEqual({ state: 'missing' })
  })

  it('present: the bytes (binary round trip), their sha256, the size and the mode', async () => {
    const bytes = Buffer.from([0, 255, 10, 13, 0x89, 0x50])
    await writeFile(join(root, 'blob.bin'), bytes)
    if (POSIX)
      await chmod(join(root, 'blob.bin'), 0o750)
    const before = await readCheckpointBefore(root, await resolved('blob.bin'))
    expect(before).toMatchObject({ state: 'present', sha: sha256Hex(bytes), size: 6 })
    if (before.state !== 'present')
      throw new Error('expected present')
    expect(before.bytes.equals(bytes)).toBe(true)
    if (POSIX)
      expect(before.mode).toBe(0o750)
  })

  it('too-large above the cap (size and mode only); exactly the cap is present', async () => {
    await writeFile(join(root, 'big.txt'), 'x'.repeat(11))
    await writeFile(join(root, 'fits.txt'), 'x'.repeat(10))
    expect(await readCheckpointBefore(root, await resolved('big.txt'), { maxBytes: 10 })).toMatchObject({ state: 'too-large', size: 11 })
    expect(await readCheckpointBefore(root, await resolved('fits.txt'), { maxBytes: 10 })).toMatchObject({ state: 'present', size: 10 })
    expect(await readCheckpointBefore(root, await resolved('fits.txt'))).toMatchObject({ state: 'present', size: 10 })
  })

  it('an empty file is present with no bytes', async () => {
    await writeFile(join(root, 'empty.txt'), '')
    expect(await readCheckpointBefore(root, await resolved('empty.txt'))).toMatchObject({ state: 'present', size: 0, sha: sha256Hex('') })
  })

  it('a folder is refused like the write would refuse it', async () => {
    await mkdir(join(root, 'dir'))
    await expect(readCheckpointBefore(root, await resolved('dir'))).rejects.toMatchObject({ code: 'validation_error' })
  })
})

describe('diskSha / diskShas', () => {
  it('the sha256 of a file, null when missing, unreadable for a folder or a link out of the project', async () => {
    await writeFile(join(root, 'a.txt'), 'hello\n')
    await mkdir(join(root, 'dir'))
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    try {
      await writeFile(join(outside, 'secret.txt'), 'secret')
      if (POSIX)
        await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
      expect(await diskSha(root, 'a.txt')).toBe(sha256Hex('hello\n'))
      expect(await diskSha(root, 'missing.txt')).toBeNull()
      expect(await diskSha(root, 'dir/missing.txt')).toBeNull()
      expect(await diskSha(root, 'dir')).toBe('unreadable')
      if (POSIX)
        expect(await diskSha(root, 'link.txt')).toBe('unreadable')
      const shas = await diskShas(root, ['a.txt', 'missing.txt', 'a.txt', 'dir'])
      expect([...shas.entries()]).toEqual([['a.txt', sha256Hex('hello\n')], ['missing.txt', null], ['dir', 'unreadable']])
    }
    finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('streams files larger than one chunk', async () => {
    const big = Buffer.alloc(2_500_000, 7)
    await writeFile(join(root, 'big.bin'), big)
    expect(await diskSha(root, 'big.bin')).toBe(sha256Hex(big))
  })

  it('stops on an aborted signal', async () => {
    await writeFile(join(root, 'a.txt'), 'x')
    const controller = new AbortController()
    controller.abort(new Error('client went away'))
    await expect(diskSha(root, 'a.txt', controller.signal)).rejects.toThrow('client went away')
  })
})

describe('writeWithoutRecording', () => {
  const signal = new AbortController().signal

  it('passes the before-state to produce and writes its result (string or bytes) under the lock', async () => {
    await writeFile(join(root, 'notes.txt'), 'one\n')
    const target = await resolved('notes.txt')
    let lockedDuringProduce = 0
    const result = await writeWithoutRecording({
      toolCallId: 'call_1',
      tool: 'edit_file',
      root,
      resolved: target,
      produce: (before) => {
        lockedDuringProduce = heldFileLocks()
        return before.state === 'present' ? Buffer.concat([before.bytes, Buffer.from('two\n')]) : 'unexpected'
      },
      signal,
    })
    expect(lockedDuringProduce).toBe(1)
    expect(heldFileLocks()).toBe(0)
    expect(result).toMatchObject({ recorded: false, before: { state: 'present', size: 4 }, written: { rel: 'notes.txt', created: false, bytes: 8 } })
    expect(await readFile(join(root, 'notes.txt'), 'utf8')).toBe('one\ntwo\n')
  })

  it('two parallel read-modify-write calls on one file serialize: both edits land', async () => {
    await writeFile(join(root, 'list.txt'), '')
    const append = async (line: string) => writeWithoutRecording({
      toolCallId: line,
      tool: 'edit_file',
      root,
      resolved: await resolved('list.txt'),
      produce: async (before) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        return `${before.state === 'present' ? before.bytes.toString('utf8') : ''}${line}\n`
      },
      signal,
    })
    await Promise.all([append('a'), append('b'), append('c')])
    // The order depends on which path resolution finishes first; no line is lost.
    expect((await readFile(join(root, 'list.txt'), 'utf8')).split('\n').filter(Boolean).sort()).toEqual(['a', 'b', 'c'])
  })

  it('a throwing produce or an abort writes nothing and releases the lock', async () => {
    await writeFile(join(root, 'keep.txt'), 'keep\n')
    await expect(writeWithoutRecording({
      toolCallId: 'call_1',
      tool: 'edit_file',
      root,
      resolved: await resolved('keep.txt'),
      produce: () => {
        throw new Error('old_string was not found')
      },
      signal,
    })).rejects.toThrow('old_string was not found')
    const controller = new AbortController()
    await expect(writeWithoutRecording({
      toolCallId: 'call_2',
      tool: 'write_file',
      root,
      resolved: await resolved('keep.txt'),
      produce: () => {
        controller.abort(new Error('stopped'))
        return 'replaced'
      },
      signal: controller.signal,
    })).rejects.toThrow('stopped')
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('keep\n')
    expect(heldFileLocks()).toBe(0)
    // The lock is the shared per-file lock: a held lock delays the write.
    const order: string[] = []
    const target = await resolved('keep.txt')
    let release!: () => void
    const holder = withFileLock(target.absolute, async () => {
      order.push('holder')
      await new Promise<void>(resolve => (release = resolve))
    })
    const write = writeWithoutRecording({ toolCallId: 'call_3', tool: 'write_file', root, resolved: target, produce: () => {
      order.push('produce')
      return 'later'
    }, signal })
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(order).toEqual(['holder'])
    release()
    await holder
    await write
    expect(order).toEqual(['holder', 'produce'])
  })
})
