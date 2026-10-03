import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeCheckpointBlobStore, TestChangeRowInput } from '../../testing/fake-checkpoints.ts'
import type { CheckpointContext } from './types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { chatChangesSchema, fileDiffSchema, LIMITS } from '@harness-forge/shared'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, projects } from '../../db/schema.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeCheckpointBlobStore, createTestChangeRowWriter, editRowFields, insertChangeRows } from '../../testing/fake-checkpoints.ts'
import { NO_PROJECT_MESSAGE } from './changes-common.ts'
import { changesFileDiff, listChatChanges } from './changes.ts'
import { sha256Hex } from './disk.ts'

const CHAT = '0199a8f0-0000-7000-8000-000000000301'
const OTHER_CHAT = '0199a8f0-0000-7000-8000-000000000302'
const NO_PROJECT_CHAT = '0199a8f0-0000-7000-8000-000000000303'
const GONE_PROJECT_CHAT = '0199a8f0-0000-7000-8000-000000000304'
const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
const OTHER_PROJECT = 'prj_BBBBBBBBBBBBBBBB'
const T0 = 1_760_000_000_000

let t: TestApp
let base: string
let root: string
let otherRoot: string
let blobs: FakeCheckpointBlobStore
let ctx: CheckpointContext
let clock: number

function now(): number {
  clock += 1000
  return clock
}

beforeEach(async () => {
  clock = T0
  base = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  root = join(base, 'project')
  otherRoot = join(base, 'other')
  await mkdir(root)
  await mkdir(otherRoot)
  t = await createTestApp({ start: false, workspaceRoots: [base] })
  await t.db.insert(projects).values([
    { id: PROJECT, name: 'Demo', path: root, createdAt: 1, updatedAt: 1 },
    { id: OTHER_PROJECT, name: 'Other', path: otherRoot, createdAt: 1, updatedAt: 1 },
  ])
  await t.db.insert(chats).values([
    { id: CHAT, projectId: PROJECT },
    { id: OTHER_CHAT, projectId: PROJECT },
    { id: NO_PROJECT_CHAT, projectId: null },
    { id: GONE_PROJECT_CHAT, projectId: 'prj_GGGGGGGGGGGGGGGG' },
  ])
  blobs = createFakeCheckpointBlobStore()
  ctx = { deps: t.deps, blobs, rows: createTestChangeRowWriter(t.db), now: () => T0 }
})

afterEach(async () => {
  await t.close()
  await rm(base, { recursive: true, force: true })
})

type Content = string | Uint8Array | null

/** Writes `content` to the project folder (null removes the file). */
async function onDisk(path: string, content: Content, folder = root): Promise<void> {
  const target = join(folder, path)
  if (content === null) {
    await rm(target, { force: true })
    return
  }
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, content)
}

/** One journaled change of `path` from `before` to `after`: the before blob stored, the disk left at `after`. */
async function change(path: string, before: Content, after: Content, extra: Partial<TestChangeRowInput> = {}): Promise<void> {
  if (before !== null)
    await blobs.put(typeof before === 'string' ? Buffer.from(before) : before)
  await onDisk(path, after)
  await insertChangeRows(t.db, [{ chatId: CHAT, projectId: PROJECT, kind: 'edit', tool: 'write_file', toolCallId: 'call_1', path, ...editRowFields(before, after), ...extra }], now)
}

async function list() {
  return chatChangesSchema.parse(await listChatChanges(ctx, CHAT))
}

function fileOf(changes: Awaited<ReturnType<typeof list>>, path: string) {
  const file = changes.files.find(entry => entry.path === path)
  expect(file, path).toBeDefined()
  return file!
}

describe('listChatChanges', () => {
  it('answers 404 for an unknown chat', async () => {
    await expect(listChatChanges(ctx, '0199a8f0-0000-7000-8000-0000000003ff')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('is unavailable without a project, for a project that is gone and for a folder that cannot be opened', async () => {
    const empty = { files: [], truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } }
    expect(chatChangesSchema.parse(await listChatChanges(ctx, NO_PROJECT_CHAT))).toEqual({ available: false, reason: 'no-project', projectId: null, ...empty })
    expect(await listChatChanges(ctx, GONE_PROJECT_CHAT)).toEqual({ available: false, reason: 'no-project', projectId: null, ...empty })
    await change('a.txt', null, 'a\n')
    await rm(root, { recursive: true, force: true })
    expect(await listChatChanges(ctx, CHAT)).toEqual({ available: false, reason: 'folder-unavailable', projectId: PROJECT, ...empty })
  })

  it('lists every status from the base, the latest after-state and the disk, most recently changed first', async () => {
    await change('added.txt', null, 'new\n')
    await change('modified.txt', 'a\nb\n', 'a\nc\n')
    await change('deleted.txt', 'gone\n', null, { tool: 'shell' })
    await change('back.txt', 'x\n', 'y\n')
    await change('back.txt', 'y\n', 'x\n')
    await change('dir/temp.txt', null, 'tmp\n')
    await change('dir/temp.txt', 'tmp\n', null)
    const changes = await list()
    expect(changes).toMatchObject({ available: true, reason: null, projectId: PROJECT, truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } })
    expect(changes.files.map(file => file.path)).toEqual(['dir/temp.txt', 'back.txt', 'deleted.txt', 'modified.txt', 'added.txt'])
    expect(fileOf(changes, 'added.txt')).toEqual({ path: 'added.txt', status: 'added', edits: 1, changedOutside: false, revertible: true, added: 1, removed: 0, lastEditAt: T0 + 1000 })
    expect(fileOf(changes, 'modified.txt')).toMatchObject({ status: 'modified', edits: 1, changedOutside: false, revertible: true, added: 1, removed: 1 })
    expect(fileOf(changes, 'deleted.txt')).toMatchObject({ status: 'deleted', changedOutside: false, revertible: true, added: 0, removed: 1 })
    expect(fileOf(changes, 'back.txt')).toMatchObject({ status: 'unchanged', edits: 2, changedOutside: false, added: 0, removed: 0, lastEditAt: T0 + 5000 })
    expect(fileOf(changes, 'dir/temp.txt')).toMatchObject({ status: 'unchanged', edits: 2, changedOutside: false, revertible: true, added: 0, removed: 0 })
  })

  it('counts reverts, rewinds and undos as changes of the file and keeps the earliest base', async () => {
    await change('a.txt', 'one\n', 'two\n')
    await change('a.txt', 'two\n', 'one\n', { kind: 'revert', batchId: 'wcb_AAAAAAAAAAAAAAAA', tool: null, toolCallId: null })
    await change('a.txt', 'one\n', 'two\n', { kind: 'undo', batchId: 'wcb_BBBBBBBBBBBBBBBB', tool: null, toolCallId: null })
    expect(fileOf(await list(), 'a.txt')).toMatchObject({ status: 'modified', edits: 3, changedOutside: false, added: 1, removed: 1 })
  })

  it('flags a disk state other than the latest recorded one as changed outside', async () => {
    await change('edited.txt', 'one\n', 'two\n')
    await onDisk('edited.txt', 'three\n')
    await change('removed.txt', 'x\n', 'y\n')
    await onDisk('removed.txt', null)
    await change('restored.txt', 'x\n', 'y\n')
    await onDisk('restored.txt', 'x\n')
    const changes = await list()
    expect(fileOf(changes, 'edited.txt')).toMatchObject({ status: 'modified', changedOutside: true, added: 1, removed: 1 })
    expect(fileOf(changes, 'removed.txt')).toMatchObject({ status: 'deleted', changedOutside: true })
    expect(fileOf(changes, 'restored.txt')).toMatchObject({ status: 'unchanged', changedOutside: true, added: 0, removed: 0 })
  })

  it('is revertible only for a stored or a missing base', async () => {
    await change('big.txt', null, 'small now\n', { beforeState: 'too-large', beforeSha: null, beforeSize: LIMITS.checkpointFileMaxBytes + 1, beforeMode: 0o644 })
    await change('old.txt', 'old\n', 'new\n', { beforeState: 'evicted' })
    await change('back.txt', 'same\n', 'other\n', { beforeState: 'evicted' })
    await onDisk('back.txt', 'same\n')
    const changes = await list()
    expect(fileOf(changes, 'big.txt')).toMatchObject({ status: 'modified', revertible: false, added: null, removed: null })
    expect(fileOf(changes, 'old.txt')).toMatchObject({ status: 'modified', revertible: false, added: null, removed: null })
    // An evicted base still has its sha: the disk is back to it.
    expect(fileOf(changes, 'back.txt')).toMatchObject({ status: 'unchanged', revertible: false, changedOutside: true })
  })

  it('gives line counts only for text of at most 256 KiB, and null when the stored base is gone', async () => {
    await change('binary.bin', Buffer.from([0, 1, 2]), Buffer.from([0, 1, 3]))
    await change('invalid.txt', 'ok\n', Buffer.from([0xC3, 0x28]))
    await change('large.txt', 'x\n', 'y\n'.repeat(LIMITS.changesLineCountMaxBytes / 2 + 1))
    await change('large-base.txt', 'y\n'.repeat(LIMITS.changesLineCountMaxBytes / 2 + 1), 'x\n')
    await change('pruned.txt', 'base\n', 'after\n')
    await blobs.remove(sha256Hex('base\n'))
    await change('fits.txt', '', 'z'.repeat(LIMITS.changesLineCountMaxBytes))
    const changes = await list()
    for (const path of ['binary.bin', 'invalid.txt', 'large.txt', 'large-base.txt', 'pruned.txt'])
      expect(fileOf(changes, path), path).toMatchObject({ status: 'modified', added: null, removed: null })
    expect(fileOf(changes, 'pruned.txt').revertible).toBe(true)
    expect(fileOf(changes, 'fits.txt')).toMatchObject({ added: 1, removed: 0 })
  })

  it('gives line counts only to the first 200 files of the list', async () => {
    const total = LIMITS.changesLineCountFiles + 1
    await Promise.all(Array.from({ length: total }, (_, index) => onDisk(`f${index}.txt`, 'line\n')))
    await insertChangeRows(t.db, Array.from({ length: total }, (_, index) => ({
      chatId: CHAT,
      projectId: PROJECT,
      kind: 'edit' as const,
      tool: 'write_file',
      path: `f${index}.txt`,
      ...editRowFields(null, 'line\n'),
    })), now)
    const changes = await list()
    expect(changes.files).toHaveLength(total)
    expect(changes.files.slice(0, LIMITS.changesLineCountFiles).every(file => file.added === 1 && file.removed === 0)).toBe(true)
    expect(changes.files.at(-1)).toMatchObject({ path: 'f0.txt', status: 'added', added: null, removed: null })
  })

  it('lists at most 500 files, the most recently changed ones', async () => {
    const total = LIMITS.changesFilesMax + 1
    await insertChangeRows(t.db, Array.from({ length: total }, (_, index) => ({
      chatId: CHAT,
      projectId: PROJECT,
      kind: 'edit' as const,
      path: `gone/f${index}.txt`,
      ...editRowFields(null, `${index}\n`),
    })), now)
    const changes = await list()
    expect(changes.truncated).toBe(true)
    expect(changes.files).toHaveLength(LIMITS.changesFilesMax)
    expect(changes.files[0]).toMatchObject({ path: `gone/f${total - 1}.txt`, status: 'unchanged', changedOutside: true })
    expect(changes.files.some(file => file.path === 'gone/f0.txt')).toBe(false)
  })

  it('counts shell and untracked rows and ignores rows of other chats and other projects', async () => {
    await change('mine.txt', null, 'mine\n')
    await insertChangeRows(t.db, [
      { chatId: CHAT, projectId: PROJECT, kind: 'shell', tool: 'shell', command: 'npm test' },
      { chatId: CHAT, projectId: PROJECT, kind: 'shell', tool: 'shell', command: 'ls' },
      { chatId: CHAT, projectId: PROJECT, kind: 'untracked', tool: 'plugin_tool' },
      { chatId: CHAT, projectId: OTHER_PROJECT, kind: 'shell', tool: 'shell', command: 'ls' },
      { chatId: CHAT, projectId: OTHER_PROJECT, kind: 'edit', path: 'elsewhere.txt', ...editRowFields(null, 'x') },
      { chatId: OTHER_CHAT, projectId: PROJECT, kind: 'edit', path: 'theirs.txt', ...editRowFields(null, 'x') },
      { chatId: OTHER_CHAT, projectId: PROJECT, kind: 'untracked', tool: 'plugin_tool' },
    ], now)
    const changes = await list()
    expect(changes.files.map(file => file.path)).toEqual(['mine.txt'])
    expect(changes.untracked).toEqual({ shellCommands: 2, toolCalls: 1 })
  })

  it('lists nothing of the old project after the chat moved to another one', async () => {
    await change('a.txt', null, 'a\n')
    await insertChangeRows(t.db, [{ chatId: CHAT, projectId: PROJECT, kind: 'shell', tool: 'shell', command: 'ls' }], now)
    await t.db.update(chats).set({ projectId: OTHER_PROJECT }).where(eq(chats.id, CHAT))
    expect(await list()).toEqual({ available: true, reason: null, projectId: OTHER_PROJECT, files: [], truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } })
  })

  it('reads a path the guard refuses as changed outside, without line counts', async () => {
    await change('was-file', 'a\n', 'b\n')
    await rm(join(root, 'was-file'))
    await mkdir(join(root, 'was-file'))
    expect(fileOf(await list(), 'was-file')).toMatchObject({ status: 'modified', changedOutside: true, added: null, removed: null })
  })

  it('stops when the request is aborted', async () => {
    await change('a.txt', null, 'a\n')
    await expect(listChatChanges(ctx, CHAT, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('changesFileDiff (chat)', () => {
  async function diff(path: string) {
    return fileDiffSchema.parse(await changesFileDiff(ctx, CHAT, { source: 'chat', path }))
  }

  it('diffs the base against the disk', async () => {
    await change('a.txt', 'one\ntwo\n', 'one\nthree\n')
    await change('a.txt', 'one\nthree\n', 'one\nfour\n')
    expect(await diff('a.txt')).toEqual({
      source: 'chat',
      path: 'a.txt',
      origPath: null,
      status: 'modified',
      binary: false,
      tooLarge: false,
      diff: { hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' one', '-two', '+four'] }], added: 1, removed: 1, truncated: false },
      currentSha: sha256Hex('one\nfour\n'),
      baseAvailable: true,
    })
    expect((await diff('./x/../a.txt')).path).toBe('a.txt')
  })

  it('shows a created file as added and a deleted one as deleted', async () => {
    await change('new.txt', null, 'hello\n')
    await change('old.txt', 'bye\n', null)
    expect(await diff('new.txt')).toMatchObject({ status: 'added', baseAvailable: true, currentSha: sha256Hex('hello\n'), diff: { added: 1, removed: 0 } })
    expect(await diff('old.txt')).toMatchObject({ status: 'deleted', baseAvailable: true, currentSha: null, diff: { added: 0, removed: 1 } })
  })

  it('has no hunks for a file back at its base', async () => {
    await change('a.txt', 'same\n', 'other\n')
    await onDisk('a.txt', 'same\n')
    expect(await diff('a.txt')).toMatchObject({ status: 'unchanged', diff: { hunks: [], added: 0, removed: 0 } })
  })

  it('gives no diff for binary sides', async () => {
    await change('nul.bin', Buffer.from('text\n'), Buffer.from([0x61, 0, 0x62]))
    await change('invalid.txt', 'ok\n', Buffer.from([0xFF, 0xFE, 0x41]))
    await change('base.bin', Buffer.from([0, 1]), 'text now\n')
    for (const path of ['nul.bin', 'invalid.txt', 'base.bin'])
      expect(await diff(path), path).toMatchObject({ status: 'modified', binary: true, tooLarge: false, diff: null, baseAvailable: true })
  })

  it('gives no diff for a side over 1 MiB, and still reports the sha and the NUL rule', async () => {
    const large = 'a'.repeat(LIMITS.changeDiffSideMaxBytes + 1)
    await change('large.txt', 'small\n', large)
    await change('large-base.txt', large, 'small\n')
    const binary = Buffer.alloc(LIMITS.changeDiffSideMaxBytes + 1, 0x61)
    binary[10] = 0
    await change('large.bin', 'small\n', binary)
    expect(await diff('large.txt')).toMatchObject({ tooLarge: true, binary: false, diff: null, currentSha: sha256Hex(large), baseAvailable: true })
    expect(await diff('large-base.txt')).toMatchObject({ tooLarge: true, binary: false, diff: null, currentSha: sha256Hex('small\n') })
    expect(await diff('large.bin')).toMatchObject({ tooLarge: true, binary: true, diff: null })
  })

  it('reports a base that is not stored', async () => {
    await change('big.txt', null, 'now\n', { beforeState: 'too-large', beforeSha: null, beforeSize: LIMITS.checkpointFileMaxBytes + 1, beforeMode: 0o644 })
    await change('evicted.txt', 'old\n', 'new\n', { beforeState: 'evicted' })
    await change('pruned.txt', 'base\n', 'after\n')
    await blobs.remove(sha256Hex('base\n'))
    for (const path of ['big.txt', 'evicted.txt', 'pruned.txt'])
      expect(await diff(path), path).toMatchObject({ status: 'modified', baseAvailable: false, diff: null, binary: false, tooLarge: false })
  })

  it('answers 404 for a path the chat did not change in its current project', async () => {
    await change('a.txt', null, 'a\n')
    await insertChangeRows(t.db, [
      { chatId: OTHER_CHAT, projectId: PROJECT, kind: 'edit', path: 'theirs.txt', ...editRowFields(null, 'x') },
      { chatId: CHAT, projectId: OTHER_PROJECT, kind: 'edit', path: 'elsewhere.txt', ...editRowFields(null, 'x') },
      { chatId: CHAT, projectId: PROJECT, kind: 'shell', tool: 'shell', command: 'touch shell.txt' },
    ], now)
    for (const path of ['theirs.txt', 'elsewhere.txt', 'never.txt'])
      await expect(changesFileDiff(ctx, CHAT, { source: 'chat', path }), path).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses paths outside the project and paths the guard refuses', async () => {
    await change('was-file', 'a\n', 'b\n')
    await rm(join(root, 'was-file'))
    await mkdir(join(root, 'was-file'))
    for (const path of ['../other/x.txt', '.', 'was-file'])
      await expect(changesFileDiff(ctx, CHAT, { source: 'chat', path }), path).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('answers 400 without a usable project folder and 404 for an unknown chat', async () => {
    await expect(changesFileDiff(ctx, NO_PROJECT_CHAT, { source: 'chat', path: 'a.txt' })).rejects.toMatchObject({ code: 'validation_error', message: NO_PROJECT_MESSAGE })
    await expect(changesFileDiff(ctx, GONE_PROJECT_CHAT, { source: 'git', path: 'a.txt' })).rejects.toMatchObject({ code: 'validation_error', message: 'The project of this chat no longer exists.' })
    await rm(root, { recursive: true, force: true })
    await expect(changesFileDiff(ctx, CHAT, { source: 'chat', path: 'a.txt' })).rejects.toMatchObject({ code: 'validation_error', message: expect.stringContaining('is not available') })
    await expect(changesFileDiff(ctx, '0199a8f0-0000-7000-8000-0000000003ff', { source: 'chat', path: 'a.txt' })).rejects.toMatchObject({ code: 'not_found' })
  })

  it('logs nothing about paths or contents', async () => {
    await change('zebra-name.txt', 'zebra content\n', 'more zebra content\n')
    await list()
    await diff('zebra-name.txt')
    expect(t.logs.text()).not.toContain('zebra')
  })
})
