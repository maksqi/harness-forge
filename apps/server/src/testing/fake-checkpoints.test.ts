import type { TestApp } from './create-test-app.ts'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatChangesSchema, gitStatusSchema, LIMITS, restoreResultSchema, rewindPreviewSchema } from '@harness-forge/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chats, messages, projects } from '../db/schema.ts'
import { sha256Hex } from '../services/checkpoints/disk.ts'
import { resolveWorkspacePath } from '../workspace/paths.ts'
import { createTestApp } from './create-test-app.ts'
import { createFakeCheckpointBlobStore, createFakeCheckpointService, createTestChangeRowWriter, editRowFields, FAKE_RESTORE_RESULT, insertChangeRows } from './fake-checkpoints.ts'

const CHAT = '0199a8f0-0000-7000-8000-000000000091'
const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
const T0 = 1_760_000_000_000

let t: TestApp
let root: string

beforeEach(async () => {
  t = await createTestApp({ start: false })
  root = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
  await t.db.insert(projects).values({ id: PROJECT, name: 'Demo', path: root, createdAt: 1, updatedAt: 1 })
  await t.db.insert(chats).values({ id: CHAT, projectId: PROJECT })
})

afterEach(async () => {
  await t.close()
  await rm(root, { recursive: true, force: true })
})

describe('createFakeCheckpointBlobStore', () => {
  it('stores copies deduplicated by sha256 and reads copies back', async () => {
    const blobs = createFakeCheckpointBlobStore()
    const bytes = new Uint8Array([1, 2, 3])
    const sha = await blobs.put(bytes)
    expect(sha).toBe(sha256Hex(bytes))
    bytes[0] = 9
    expect(await blobs.put(new Uint8Array([1, 2, 3]))).toBe(sha)
    expect(blobs.blobs.size).toBe(1)
    expect(blobs.puts()).toBe(2)
    const read = await blobs.read(sha)
    expect([...read!]).toEqual([1, 2, 3])
    read![0] = 7
    expect([...(await blobs.read(sha))!]).toEqual([1, 2, 3])
    expect(await blobs.has(sha)).toBe(true)
    expect(await blobs.remove(sha)).toBe(true)
    expect(await blobs.remove(sha)).toBe(false)
    expect(await blobs.read(sha)).toBeNull()
    expect(await blobs.has(sha)).toBe(false)
  })

  it('refuses names that are not 64 lowercase hex characters', async () => {
    const blobs = createFakeCheckpointBlobStore()
    for (const name of ['../secret', 'A'.repeat(64), 'a'.repeat(63), ''])
      await expect(blobs.read(name), name).rejects.toMatchObject({ code: 'validation_error' })
    await expect(blobs.has('x')).rejects.toMatchObject({ code: 'validation_error' })
    await expect(blobs.remove('x')).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('has a real store gate: a shared holder waits for an exclusive one', async () => {
    const blobs = createFakeCheckpointBlobStore()
    const order: string[] = []
    let release!: () => void
    const exclusive = blobs.withExclusiveGate(async () => {
      order.push('exclusive:start')
      await new Promise<void>(resolve => (release = resolve))
      order.push('exclusive:end')
    })
    const shared = blobs.withSharedGate(async () => {
      order.push('shared')
      return 'done'
    })
    await Promise.resolve()
    expect(blobs.gateState()).toMatchObject({ exclusive: true, waiting: 1 })
    release()
    expect(await shared).toBe('done')
    await exclusive
    expect(order).toEqual(['exclusive:start', 'exclusive:end', 'shared'])
  })
})

describe('journal rows in the test database', () => {
  it('insertChangeRows stores the real writer\'s values: the seq watermark, nulls, the command cut', async () => {
    await t.db.insert(messages).values([
      { id: 'msg_AAAAAAAAAAAAAAA0', chatId: CHAT, seq: 0, role: 'user', parts: [] },
      { id: 'msg_AAAAAAAAAAAAAAA1', chatId: CHAT, seq: 1, role: 'assistant', parts: [] },
    ])
    const [edit, shell, explicit] = await insertChangeRows(t.db, [
      { chatId: CHAT, projectId: PROJECT, kind: 'edit', messageId: 'msg_AAAAAAAAAAAAAAA1', toolCallId: 'call_1', tool: 'write_file', path: 'a.txt', ...editRowFields(null, 'one\n') },
      { chatId: CHAT, projectId: PROJECT, kind: 'shell', toolCallId: 'call_2', tool: 'shell', command: 'x'.repeat(LIMITS.journalCommandMaxChars + 50) },
      { chatId: CHAT, projectId: PROJECT, kind: 'rewind', batchId: 'wcb_AAAAAAAAAAAAAAAA', path: 'a.txt', messageSeq: 7, createdAt: T0 + 5, ...editRowFields('one\n', null) },
    ], () => T0)
    expect(edit).toMatchObject({ messageSeq: 1, kind: 'edit', path: 'a.txt', beforeState: 'missing', beforeSha: null, afterSha: sha256Hex('one\n'), afterSize: 4, createdAt: T0, batchId: null, command: null })
    expect(shell?.command).toHaveLength(LIMITS.journalCommandMaxChars)
    expect(shell).toMatchObject({ path: null, beforeState: null, afterSha: null, messageId: null })
    expect(explicit).toMatchObject({ messageSeq: 7, createdAt: T0 + 5, beforeState: 'stored', beforeSha: sha256Hex('one\n'), beforeSize: 4, beforeMode: 0o644, afterSha: null, afterSize: null })
    expect(edit!.id).toBeLessThan(shell!.id)
    // A chat without messages has the watermark 0; the foreign keys are real.
    await t.db.insert(chats).values({ id: '0199a8f0-0000-7000-8000-000000000092', projectId: PROJECT })
    const [empty] = await insertChangeRows(t.db, [{ chatId: '0199a8f0-0000-7000-8000-000000000092', projectId: PROJECT, kind: 'untracked', tool: 'plugin_tool' }])
    expect(empty?.messageSeq).toBe(0)
    await expect(insertChangeRows(t.db, [{ chatId: 'missing', projectId: PROJECT, kind: 'edit' }])).rejects.toThrow()
  })

  it('createTestChangeRowWriter inserts with its clock and keeps what it inserted', async () => {
    let now = T0
    const rows = createTestChangeRowWriter(t.db, () => now)
    const first = await rows.insert({ chatId: CHAT, projectId: PROJECT, kind: 'revert', batchId: 'wcb_AAAAAAAAAAAAAAAA', path: 'b.txt', ...editRowFields('a', 'b') })
    now += 10
    const second = await rows.insert({ chatId: CHAT, projectId: PROJECT, kind: 'undo', batchId: 'wcb_BBBBBBBBBBBBBBBB', path: 'b.txt', ...editRowFields('b', 'a') })
    expect([first.createdAt, second.createdAt]).toEqual([T0, T0 + 10])
    expect(rows.inserted.map(row => row.kind)).toEqual(['revert', 'undo'])
  })
})

describe('createFakeCheckpointService', () => {
  it('journals write through the unrecorded writer and record every call with the scope', async () => {
    const fake = createFakeCheckpointService()
    const scope = { chatId: CHAT, messageId: 'msg_AAAAAAAAAAAAAAAA', projectId: PROJECT }
    const journal = fake.journal(scope)
    const result = await journal.write({
      toolCallId: 'call_1',
      tool: 'write_file',
      root,
      resolved: await resolveWorkspacePath(root, 'dir/a.txt', { allowMissing: true }),
      produce: before => (before.state === 'missing' ? 'hello\n' : 'unexpected'),
      signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ recorded: false, before: { state: 'missing' }, written: { rel: 'dir/a.txt', created: true } })
    expect(await readFile(join(root, 'dir', 'a.txt'), 'utf8')).toBe('hello\n')
    await journal.recordShell({ toolCallId: 'call_2', command: 'pnpm test' })
    await journal.recordUntracked({ toolCallId: 'call_3', tool: 'plugin_tool' })
    expect(fake.journals).toEqual([scope])
    expect(fake.records).toEqual([
      { kind: 'write', scope, toolCallId: 'call_1', tool: 'write_file', path: 'dir/a.txt' },
      { kind: 'shell', scope, toolCallId: 'call_2', command: 'pnpm test' },
      { kind: 'untracked', scope, toolCallId: 'call_3', tool: 'plugin_tool' },
    ])
    expect(fake.calls.map(call => call.member)).toEqual(['journal'])
  })

  it('answers valid canned DTOs, records calls, and takes overrides', async () => {
    const fake = createFakeCheckpointService({ gitStatus: async () => ({ available: true, reason: null, branch: 'main', head: 'a'.repeat(40), prefix: '', files: [], truncated: false }) })
    expect(chatChangesSchema.parse(await fake.listChanges(CHAT))).toMatchObject({ available: false, reason: 'no-project' })
    expect(gitStatusSchema.parse(await fake.gitStatus(CHAT))).toMatchObject({ available: true, branch: 'main' })
    expect(rewindPreviewSchema.parse(await fake.rewindPreview(CHAT, 'msg_AAAAAAAAAAAAAAAA'))).toMatchObject({ messageId: 'msg_AAAAAAAAAAAAAAAA', files: [] })
    for (const result of [await fake.revert(CHAT, { source: 'chat', path: 'a.txt' }), await fake.undo(CHAT, { batchId: 'wcb_AAAAAAAAAAAAAAAA', conflicts: 'skip' }), await fake.rewind(CHAT, { messageId: 'msg_AAAAAAAAAAAAAAAA', conflicts: 'force' })])
      expect(restoreResultSchema.parse(result)).toEqual(FAKE_RESTORE_RESULT)
    await expect(fake.fileDiff(CHAT, { source: 'chat', path: 'a.txt' })).rejects.toMatchObject({ code: 'not_found' })
    expect(await fake.summary()).toEqual({ bytes: 0, blobs: 0 })
    expect(await fake.purge()).toEqual({ bytes: 0, blobs: 0 })
    expect(await fake.prune({ now: T0 })).toMatchObject({ evictedByAge: 0, bytesFreed: 0 })
    expect(fake.started()).toBe(false)
    await fake.start()
    expect(fake.started()).toBe(true)
    await fake.stop()
    expect(fake.started()).toBe(false)
    expect(fake.calls.map(call => call.member)).toEqual(['listChanges', 'gitStatus', 'rewindPreview', 'revert', 'undo', 'rewind', 'fileDiff', 'summary', 'purge', 'prune', 'start', 'stop'])
    expect(fake.calls.find(call => call.member === 'undo')?.args).toEqual([CHAT, { batchId: 'wcb_AAAAAAAAAAAAAAAA', conflicts: 'skip' }])
  })
})
