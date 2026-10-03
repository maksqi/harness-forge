import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from './disk.ts'
import { checkpointBlobPath, createCheckpointStore } from './store.ts'

const POSIX = process.platform !== 'win32'

let base: string
let dir: string

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  dir = join(base, 'checkpoints')
})

afterEach(async () => {
  await rm(base, { recursive: true, force: true })
})

/** Every file under the store, relative, sorted. */
async function files(): Promise<string[]> {
  const found: string[] = []
  for (const shard of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(shard))
      continue
    for (const name of await readdir(join(dir, shard)))
      found.push(`${shard}/${name}`)
  }
  return found.sort()
}

describe('checkpointBlobPath', () => {
  it('maps a sha to <dir>/<aa>/<sha> and refuses anything else', () => {
    const sha = sha256Hex('x')
    expect(checkpointBlobPath(dir, sha)).toBe(join(dir, sha.slice(0, 2), sha))
    for (const name of ['../../etc/passwd', 'A'.repeat(64), 'a'.repeat(63), `${'a'.repeat(64)}/x`, ''])
      expect(() => checkpointBlobPath(dir, name), name).toThrow(expect.objectContaining({ code: 'validation_error' }))
  })
})

describe('createCheckpointStore', () => {
  it('stores raw bytes under their sha256 (binary round trip) and reads them back', async () => {
    const store = createCheckpointStore(dir)
    const bytes = Buffer.from([0, 255, 10, 13, 0x89, 0x50, 0])
    const sha = await store.put(bytes)
    expect(sha).toBe(sha256Hex(bytes))
    expect(await files()).toEqual([`${sha.slice(0, 2)}/${sha}`])
    expect((await store.read(sha))!.equals(bytes)).toBe(true)
    expect(await store.has(sha)).toBe(true)
    // An empty before-state is a blob too.
    const empty = await store.put(new Uint8Array())
    expect(empty).toBe(sha256Hex(''))
    expect((await store.read(empty))!.byteLength).toBe(0)
  })

  it('deduplicates: an existing blob is kept and its mtime refreshed', async () => {
    const store = createCheckpointStore(dir)
    const sha = await store.put(Buffer.from('same'))
    const path = checkpointBlobPath(dir, sha)
    const old = new Date(Date.now() - 86_400_000)
    await utimes(path, old, old)
    const inode = (await stat(path)).ino
    expect(await store.put(Buffer.from('same'))).toBe(sha)
    const after = await stat(path)
    expect(after.ino).toBe(inode)
    expect(after.mtimeMs).toBeGreaterThan(old.getTime() + 3_600_000)
    expect(await files()).toHaveLength(1)
  })

  it.skipIf(!POSIX)('folders 0700, files 0600', async () => {
    const store = createCheckpointStore(dir)
    const sha = await store.put(Buffer.from('mode'))
    expect((await stat(dir)).mode & 0o777).toBe(0o700)
    expect((await stat(join(dir, sha.slice(0, 2)))).mode & 0o777).toBe(0o700)
    expect((await stat(checkpointBlobPath(dir, sha))).mode & 0o777).toBe(0o600)
  })

  it('an interrupted write leaves only a temp file, never a blob under its final name', async () => {
    const crashed = createCheckpointStore(dir, { beforeRename: () => new Promise<void>(() => {}) })
    const bytes = Buffer.from('interrupted')
    const sha = sha256Hex(bytes)
    void crashed.put(bytes)
    await expect.poll(files).toHaveLength(1)
    const [temp] = await files()
    expect(temp).toMatch(new RegExp(`^${sha.slice(0, 2)}/\\.${sha}\\.[0-9a-f]{16}\\.tmp$`))
    expect(await readFile(join(dir, temp!), 'utf8')).toBe('interrupted')
    const store = createCheckpointStore(dir)
    expect(await store.has(sha)).toBe(false)
    expect(await store.read(sha)).toBeNull()
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
    expect((await store.list()).map(entry => entry.kind)).toEqual(['temp'])
    // A later put of the same bytes stores the blob; the stale temp file waits for prune.
    expect(await store.put(bytes)).toBe(sha)
    expect((await store.list()).map(entry => entry.kind).sort()).toEqual(['blob', 'temp'])
  })

  it('a failed write removes its temp file and rejects', async () => {
    const failing = createCheckpointStore(dir, { beforeRename: async () => {
      throw new Error('disk full')
    } })
    await expect(failing.put(Buffer.from('nope'))).rejects.toThrow('disk full')
    expect((await files()).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('refuses bad names on read, has and remove (never a path outside the store)', async () => {
    const store = createCheckpointStore(dir)
    await mkdir(dir, { recursive: true })
    await writeFile(join(base, 'outside'), 'secret')
    for (const name of ['../outside', '..', 'A'.repeat(64), ''] as const) {
      await expect(store.read(name), name).rejects.toMatchObject({ code: 'validation_error' })
      await expect(store.has(name), name).rejects.toMatchObject({ code: 'validation_error' })
      await expect(store.remove(name), name).rejects.toMatchObject({ code: 'validation_error' })
    }
    expect(await readFile(join(base, 'outside'), 'utf8')).toBe('secret')
  })

  it('read of a missing blob is null; remove reports whether it existed', async () => {
    const store = createCheckpointStore(dir)
    const sha = await store.put(Buffer.from('gone'))
    expect(await store.remove(sha)).toBe(true)
    expect(await store.remove(sha)).toBe(false)
    expect(await store.read(sha)).toBeNull()
    expect(await store.has(sha)).toBe(false)
    expect(await store.read(sha256Hex('never'))).toBeNull()
  })

  it.skipIf(!POSIX)('never follows a link planted under a blob name', async () => {
    const store = createCheckpointStore(dir)
    const sha = sha256Hex('linked')
    await mkdir(join(dir, sha.slice(0, 2)), { recursive: true })
    await writeFile(join(base, 'target'), 'linked')
    await symlink(join(base, 'target'), checkpointBlobPath(dir, sha))
    expect(await store.read(sha)).toBeNull()
    expect(await store.has(sha)).toBe(false)
    expect(await store.list()).toEqual([])
  })

  it('summary counts the blobs; purge removes every blob and temp file and reports the blobs', async () => {
    const store = createCheckpointStore(dir)
    await store.put(Buffer.from('one'))
    await store.put(Buffer.from('three'))
    const sha = sha256Hex('temp')
    await mkdir(join(dir, sha.slice(0, 2)), { recursive: true })
    await writeFile(join(dir, sha.slice(0, 2), `.${sha}.0123456789abcdef.tmp`), 'temp')
    await writeFile(join(dir, 'README'), 'not a store file')
    expect(await store.summary()).toEqual({ bytes: 8, blobs: 2 })
    expect(await store.purge()).toEqual({ bytes: 8, blobs: 2 })
    expect(await store.summary()).toEqual({ bytes: 0, blobs: 0 })
    expect(await files()).toEqual([])
    // Foreign files are left alone; the store folder stays.
    expect(await readdir(dir)).toEqual(['README'])
    // An empty or missing store is fine.
    expect(await createCheckpointStore(join(base, 'none')).purge()).toEqual({ bytes: 0, blobs: 0 })
    expect(await createCheckpointStore(join(base, 'none')).summary()).toEqual({ bytes: 0, blobs: 0 })
  })

  it('purge holds the gate exclusively: it waits for a shared holder', async () => {
    const store = createCheckpointStore(dir)
    await store.put(Buffer.from('held'))
    let release!: () => void
    const order: string[] = []
    const holder = store.withSharedGate(async () => {
      order.push('shared:start')
      await new Promise<void>(resolve => (release = resolve))
      order.push('shared:end')
    })
    const purge = store.purge().then((result) => {
      order.push('purge')
      return result
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(order).toEqual(['shared:start'])
    release()
    await holder
    expect(await purge).toEqual({ bytes: 4, blobs: 1 })
    expect(order).toEqual(['shared:start', 'shared:end', 'purge'])
  })
})
