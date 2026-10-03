import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCheckpointBlobStore } from '../../testing/fake-checkpoints.ts'
import type { WorkspaceWriteResult } from '../../workspace/paths.ts'
import type { RestorePlan, RestorePlanFile, RestoreTarget } from './plan.ts'
import type { RestoreDeps } from './restore.ts'
import { Buffer } from 'node:buffer'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { restoreResultSchema } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, projects, workspaceChanges } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeCheckpointBlobStore, createTestChangeRowWriter } from '../../testing/fake-checkpoints.ts'
import { heldFileLocks, withFileLock } from '../../workspace/file-lock.ts'
import { writeWorkspaceFile } from '../../workspace/paths.ts'
import { sha256Hex } from './disk.ts'
import { planFile, planUndo } from './plan.ts'
import { applyRestore } from './restore.ts'

const CHAT = '0199a8f0-0000-7000-8000-0000000000c1'
const PROJECT = 'prj_RESTORE000000001'
const BATCH = 'wcb_RESTORE000000001'
const UNIX = process.platform !== 'win32'

let t: TestApp
let base: string
let root: string
let blobs: FakeCheckpointBlobStore

beforeEach(async () => {
  t = await createTestApp({ start: false })
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  await mkdir(root)
  blobs = createFakeCheckpointBlobStore()
  await t.db.insert(projects).values({ id: PROJECT, name: 'Demo', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })
})

afterEach(async () => {
  await t.close()
  await rm(base, { recursive: true, force: true })
})

function restoreDeps(extra: Partial<RestoreDeps> = {}): RestoreDeps {
  return { deps: t.deps, blobs, rows: createTestChangeRowWriter(t.db), now: Date.now, chatId: CHAT, projectId: PROJECT, root, ...extra }
}

async function storedTarget(content: string, mode: number | null = 0o644): Promise<RestoreTarget> {
  const sha = await blobs.put(Buffer.from(content))
  return { kind: 'stored', sha, size: Buffer.byteLength(content), mode }
}

/** A plan file: `expected` = the content the latest recorded change left (null = removed; undefined = no check). */
function file(path: string, target: RestoreTarget, expected?: string | null): RestorePlanFile {
  const expectedSha = expected === undefined ? undefined : expected === null ? null : sha256Hex(expected)
  return planFile({ path, target, expectedSha, current: null, edits: 1, lastEditAt: 0 })
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(root, path, '..'), { recursive: true })
  await writeFile(join(root, path), content)
}

async function read(path: string): Promise<string | null> {
  return existsSync(join(root, path)) ? readFile(join(root, path), 'utf8') : null
}

async function rows() {
  return t.db.select().from(workspaceChanges).where(eq(workspaceChanges.batchId, BATCH)).orderBy(workspaceChanges.id)
}

describe('applyRestore', () => {
  it('restores, deletes and reports unchanged files, journaling every write under the batch id', async () => {
    await write('a.txt', 'agent\n')
    await write('created.txt', 'new\n')
    await write('same.txt', 'old\n')
    const plan: RestorePlan = {
      files: [
        file('a.txt', await storedTarget('old\n'), 'agent\n'),
        file('created.txt', { kind: 'missing' }, 'new\n'),
        file('same.txt', await storedTarget('old\n'), 'new\n'),
      ],
    }
    const result = restoreResultSchema.parse(await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' }))
    expect(result).toEqual({ batchId: BATCH, restored: ['a.txt'], deleted: ['created.txt'], unchanged: ['same.txt'], skipped: [] })
    expect(await read('a.txt')).toBe('old\n')
    expect(await read('created.txt')).toBeNull()

    const journal = await rows()
    expect(journal.map(row => [row.kind, row.path, row.beforeState, row.beforeSha, row.afterSha, row.messageId, row.toolCallId, row.tool])).toEqual([
      ['rewind', 'a.txt', 'stored', sha256Hex('agent\n'), sha256Hex('old\n'), null, null, null],
      ['rewind', 'created.txt', 'stored', sha256Hex('new\n'), null, null, null, null],
    ])
    expect(journal[0]).toMatchObject({ chatId: CHAT, projectId: PROJECT, beforeSize: 6, afterSize: 4 })
    // The snapshots are in the store, so the batch can be undone.
    expect(blobs.blobs.has(sha256Hex('agent\n'))).toBe(true)
    expect(blobs.blobs.has(sha256Hex('new\n'))).toBe(true)
    expect(heldFileLocks()).toBe(0)
    expect(blobs.gateState()).toEqual({ shared: 0, exclusive: false, waiting: 0 })
  })

  it('skips a conflict unless forced', async () => {
    await write('a.txt', 'edited outside\n')
    const plan: RestorePlan = { files: [file('a.txt', await storedTarget('old\n'), 'agent\n')] }
    const skipped = await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(skipped).toEqual({ batchId: null, restored: [], deleted: [], unchanged: [], skipped: [{ path: 'a.txt', reason: 'conflict', message: expect.stringContaining('a.txt') }] })
    expect(await read('a.txt')).toBe('edited outside\n')
    expect(await rows()).toEqual([])

    const forced = await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'force' })
    expect(forced).toMatchObject({ batchId: BATCH, restored: ['a.txt'], skipped: [] })
    expect(await read('a.txt')).toBe('old\n')
    expect((await rows())[0]).toMatchObject({ beforeState: 'stored', beforeSha: sha256Hex('edited outside\n') })
  })

  it('a file deleted outside is a conflict for an expected content, and a missing expected state matches it', async () => {
    const plan: RestorePlan = { files: [file('a.txt', await storedTarget('old\n'), 'agent\n'), file('b.txt', await storedTarget('b\n'), null)] }
    const result = await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(result.skipped.map(skip => [skip.path, skip.reason])).toEqual([['a.txt', 'conflict']])
    expect(result.restored).toEqual(['b.txt'])
    expect((await rows())[0]).toMatchObject({ path: 'b.txt', beforeState: 'missing', beforeSha: null, beforeMode: null })
  })

  it.skipIf(!UNIX)('re-creates a deleted file with its old mode, and keeps the mode of an existing one', async () => {
    const plan: RestorePlan = { files: [file('bin/run.sh', await storedTarget('#!/bin/sh\n', 0o750), null)] }
    expect((await applyRestore(restoreDeps(), plan, { kind: 'undo', batchId: BATCH, conflicts: 'skip' })).restored).toEqual(['bin/run.sh'])
    expect((await stat(join(root, 'bin/run.sh'))).mode & 0o777).toBe(0o750)

    await write('keep.txt', 'agent\n')
    await chmod(join(root, 'keep.txt'), 0o600)
    const keep: RestorePlan = { files: [file('keep.txt', await storedTarget('old\n', 0o755), 'agent\n')] }
    await applyRestore(restoreDeps(), keep, { kind: 'undo', batchId: BATCH, conflicts: 'skip' })
    expect(await read('keep.txt')).toBe('old\n')
    expect((await stat(join(root, 'keep.txt'))).mode & 0o777).toBe(0o600)
    expect((await rows()).map(row => row.beforeMode)).toEqual([null, 0o600])
  })

  it.skipIf(!UNIX)('a git target sets the executable bits like a checkout (also when only the mode differs)', async () => {
    const script = '#!/bin/sh\necho hi\n'
    const plan: RestorePlan = { files: [file('run.sh', { kind: 'bytes', bytes: Buffer.from(script), mode: 0o755 })] }
    await write('run.sh', 'changed\n')
    await chmod(join(root, 'run.sh'), 0o644)
    expect((await applyRestore(restoreDeps(), plan, { kind: 'revert', batchId: BATCH, conflicts: 'skip' })).restored).toEqual(['run.sh'])
    expect(await read('run.sh')).toBe(script)
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755)

    await chmod(join(root, 'run.sh'), 0o644)
    const modeOnly = await applyRestore(restoreDeps(), plan, { kind: 'revert', batchId: BATCH, conflicts: 'skip' })
    expect(modeOnly.restored).toEqual(['run.sh'])
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755)
    expect((await applyRestore(restoreDeps(), plan, { kind: 'revert', batchId: BATCH, conflicts: 'skip' })).unchanged).toEqual(['run.sh'])

    const plain: RestorePlan = { files: [file('run.sh', { kind: 'bytes', bytes: Buffer.from(script), mode: 0o644 })] }
    await applyRestore(restoreDeps(), plain, { kind: 'revert', batchId: BATCH, conflicts: 'skip' })
    expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o644)
  })

  it('skips an unavailable target and a stored blob that is gone or damaged', async () => {
    await write('a.txt', 'agent\n')
    await write('b.txt', 'agent\n')
    await write('c.txt', 'agent\n')
    const gone = await storedTarget('gone\n')
    blobs.blobs.delete((gone as { sha: string }).sha)
    const damaged = await storedTarget('damaged\n')
    blobs.blobs.set((damaged as { sha: string }).sha, Buffer.from('other bytes'))
    const plan: RestorePlan = {
      files: [
        file('a.txt', { kind: 'unavailable', reason: 'too-large' }, 'agent\n'),
        file('b.txt', gone, 'agent\n'),
        file('c.txt', damaged, 'agent\n'),
      ],
    }
    const result = await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'force' })
    expect(result.batchId).toBeNull()
    expect(result.skipped.map(skip => [skip.path, skip.reason])).toEqual([['a.txt', 'unavailable'], ['b.txt', 'unavailable'], ['c.txt', 'unavailable']])
    expect(result.skipped[0]!.message).toContain('8 MiB')
    expect(await read('b.txt')).toBe('agent\n')
    expect(await read('c.txt')).toBe('agent\n')
    expect(await rows()).toEqual([])
  })

  it('refuses .git paths, a folder and paths that now lead through a link', async () => {
    await mkdir(join(root, '.git'))
    await writeFile(join(root, '.git', 'config'), 'git')
    await mkdir(join(root, 'dir'))
    const targets = [file('.git/config', await storedTarget('x\n')), file('dir', await storedTarget('x\n')), file('../out.txt', await storedTarget('x\n'))]
    if (UNIX) {
      await write('real.txt', 'real\n')
      await symlink('real.txt', join(root, 'link.txt'))
      targets.push(file('link.txt', await storedTarget('x\n')))
    }
    const result = await applyRestore(restoreDeps(), { files: targets }, { kind: 'rewind', batchId: BATCH, conflicts: 'force' })
    expect(result.batchId).toBeNull()
    expect(result.skipped.every(skip => skip.reason === 'refused')).toBe(true)
    expect(result.skipped.map(skip => skip.path)).toEqual(targets.map(target => target.path))
    expect(await readFile(join(root, '.git', 'config'), 'utf8')).toBe('git')
    if (UNIX)
      expect(await read('real.txt')).toBe('real\n')
  })

  it('a writer that fails after file N: the batch continues, a rerun resumes, and the partial batch can be undone', async () => {
    const names = ['a.txt', 'b.txt', 'c.txt']
    for (const name of names)
      await write(name, `agent ${name}\n`)
    const plan: RestorePlan = { files: await Promise.all(names.map(async name => file(name, await storedTarget(`old ${name}\n`), `agent ${name}\n`))) }
    let writes = 0
    const failAfterFirst = async (folder: string, path: string, data: Uint8Array): Promise<WorkspaceWriteResult> => {
      writes += 1
      if (writes > 1)
        throw Object.assign(new Error(`EIO: i/o error, open '${join(folder, path)}'`), { code: 'EIO' })
      return writeWorkspaceFile(folder, path, data)
    }
    const partial = await applyRestore(restoreDeps({ writeFile: failAfterFirst }), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(partial).toMatchObject({ batchId: BATCH, restored: ['a.txt'] })
    expect(partial.skipped).toEqual([
      { path: 'b.txt', reason: 'failed', message: '"b.txt" could not be written (EIO).' },
      { path: 'c.txt', reason: 'failed', message: '"c.txt" could not be written (EIO).' },
    ])
    // The safe message names no absolute path; the warning carries the code only.
    expect(JSON.stringify(partial)).not.toContain(root)
    const warnings = t.logs.records.filter(record => record.msg === 'restore write failed')
    expect(warnings.map(record => [record.level, record.code])).toEqual([['warn', 'EIO'], ['warn', 'EIO']])
    expect(JSON.stringify(warnings)).not.toContain('b.txt')
    expect(t.logs.records.filter(record => record.msg === 'restore write failed: path').map(record => [record.level, record.path])).toEqual([['debug', 'b.txt'], ['debug', 'c.txt']])
    expect(await read('b.txt')).toBe('agent b.txt\n')

    // Undo of the partial batch: only the written file goes back.
    const undone = await applyRestore(restoreDeps(), planUndo(await rows(), new Map()), { kind: 'undo', batchId: 'wcb_UNDO000000000001', conflicts: 'skip' })
    expect(undone).toMatchObject({ restored: ['a.txt'], skipped: [] })
    expect(await read('a.txt')).toBe('agent a.txt\n')

    // A rerun of the original plan resumes it: every file is written once.
    const resumed = await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(resumed).toMatchObject({ restored: ['a.txt', 'b.txt', 'c.txt'], skipped: [] })
    const again = await applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(again).toEqual({ batchId: null, restored: [], deleted: [], unchanged: names, skipped: [] })
  })

  it('a snapshot that cannot be stored stops the write of that file', async () => {
    await write('a.txt', 'agent\n')
    const plan: RestorePlan = { files: [file('a.txt', await storedTarget('old\n'), 'agent\n')] }
    const failing: FakeCheckpointBlobStore = { ...blobs, put: async () => Promise.reject(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })) }
    const result = await applyRestore(restoreDeps({ blobs: failing }), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(result.skipped).toEqual([{ path: 'a.txt', reason: 'failed', message: '"a.txt" could not be written (ENOSPC).' }])
    expect(await read('a.txt')).toBe('agent\n')
  })

  it('a row that cannot be inserted leaves the file written and logs a warning without the path', async () => {
    await write('a.txt', 'agent\n')
    const plan: RestorePlan = { files: [file('a.txt', await storedTarget('old\n'), 'agent\n')] }
    const result = await applyRestore(restoreDeps({ rows: { insert: async () => Promise.reject(new Error('SQLITE_BUSY')) } }), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    expect(result.restored).toEqual(['a.txt'])
    expect(await read('a.txt')).toBe('old\n')
    const warning = t.logs.records.find(record => record.msg === 'restore not recorded')
    expect(warning?.level).toBe('warn')
    expect(JSON.stringify(warning)).not.toContain('a.txt')
  })

  it('works under the file lock shared with the agent tools', async () => {
    await write('a.txt', 'agent\n')
    const plan: RestorePlan = { files: [file('a.txt', await storedTarget('old\n'), 'agent\n')] }
    let release!: () => void
    const held = withFileLock(join(root, 'a.txt'), () => new Promise<void>(resolve => (release = resolve)))
    const restoring = applyRestore(restoreDeps(), plan, { kind: 'rewind', batchId: BATCH, conflicts: 'skip' })
    await new Promise(resolve => setTimeout(resolve, 20))
    // The agent's write (inside the lock) lands first; the restore then sees a conflict.
    await writeFile(join(root, 'a.txt'), 'agent again\n')
    expect(await read('a.txt')).toBe('agent again\n')
    release()
    await held
    expect((await restoring).skipped.map(skip => skip.reason)).toEqual(['conflict'])
  })
})
