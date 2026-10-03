import type { WorkspaceChangeRow } from '../../db/schema.ts'
import type { DiskSha } from './disk.ts'
import { describe, expect, it } from 'vitest'
import { sha256Hex } from './disk.ts'
import { beforeTarget, orderedPaths, planFile, planRewind, planUndo, restoreAction, targetSha } from './plan.ts'

const CHAT = '0199a8f0-0000-7000-8000-0000000000b1'
const PROJECT = 'prj_AAAAAAAAAAAAAAAA'
const V1 = sha256Hex('v1\n')
const V2 = sha256Hex('v2\n')
const V3 = sha256Hex('v3\n')

let nextId = 1

/** A journal row as stored (defaults: an `edit` of `a.txt` from missing to v1). */
function row(fields: Partial<WorkspaceChangeRow>): WorkspaceChangeRow {
  const id = fields.id ?? nextId++
  return {
    id,
    chatId: CHAT,
    projectId: PROJECT,
    messageSeq: 2,
    messageId: 'msg_AAAAAAAAAAAAAAAA',
    toolCallId: 'call_1',
    batchId: null,
    kind: 'edit',
    tool: 'write_file',
    path: 'a.txt',
    command: null,
    beforeState: 'missing',
    beforeSha: null,
    beforeSize: null,
    beforeMode: null,
    afterSha: V1,
    afterSize: 3,
    createdAt: 1_760_000_000_000 + id,
    ...fields,
  }
}

function stored(sha: string, mode = 0o644): Partial<WorkspaceChangeRow> {
  return { beforeState: 'stored', beforeSha: sha, beforeSize: 3, beforeMode: mode }
}

function disk(entries: Record<string, DiskSha>): Map<string, DiskSha> {
  return new Map(Object.entries(entries))
}

describe('planRewind', () => {
  it('takes the target from the earliest row and the expected state from the latest, in any input order', () => {
    const first = row({ id: 10, ...stored(V1), afterSha: V2 })
    const second = row({ id: 11, ...stored(V2), afterSha: V3 })
    const plan = planRewind([second, first], disk({ 'a.txt': V3 }))
    expect(plan.files).toHaveLength(1)
    expect(plan.files[0]).toMatchObject({
      path: 'a.txt',
      action: 'restore',
      conflict: false,
      edits: 2,
      target: { kind: 'stored', sha: V1, size: 3, mode: 0o644 },
      expectedSha: V3,
      current: V3,
      lastEditAt: second.createdAt,
    })
  })

  it('covers rows of two versions of the conversation (any message, any branch)', () => {
    const onBranchA = row({ id: 20, messageId: 'msg_BRANCHAAAAAAAAAA', messageSeq: 3, ...stored(V1), afterSha: V2 })
    const onBranchB = row({ id: 21, messageId: 'msg_BRANCHBBBBBBBBBB', messageSeq: 5, ...stored(V2), afterSha: V3 })
    const plan = planRewind([onBranchA, onBranchB], disk({ 'a.txt': V3 }))
    expect(plan.files[0]).toMatchObject({ target: { kind: 'stored', sha: V1 }, expectedSha: V3, edits: 2, action: 'restore' })
  })

  it('decides restore, delete, unchanged and unavailable', () => {
    const rows = [
      row({ id: 30, path: 'restore.txt', ...stored(V1), afterSha: V2 }),
      row({ id: 31, path: 'delete.txt', beforeState: 'missing', afterSha: V1 }),
      row({ id: 32, path: 'same.txt', ...stored(V1), afterSha: V2 }),
      row({ id: 33, path: 'big.txt', beforeState: 'too-large', beforeSize: 9_000_000, beforeMode: 0o644, afterSha: V1 }),
      row({ id: 34, path: 'gone.txt', beforeState: 'evicted', beforeSha: V1, beforeSize: 3, afterSha: V2 }),
      row({ id: 35, path: 'deleted-again.txt', beforeState: 'missing', afterSha: null }),
    ]
    const plan = planRewind(rows, disk({ 'restore.txt': V2, 'delete.txt': V1, 'same.txt': V1, 'big.txt': V1, 'gone.txt': V2, 'deleted-again.txt': null }))
    const byPath = Object.fromEntries(plan.files.map(file => [file.path, file]))
    expect(byPath['restore.txt']).toMatchObject({ action: 'restore', conflict: false })
    expect(byPath['delete.txt']).toMatchObject({ action: 'delete', conflict: false, target: { kind: 'missing' } })
    // Back at the target already (someone restored it outside the chat): nothing to write, so no conflict either.
    expect(byPath['same.txt']).toMatchObject({ action: 'unchanged', conflict: false })
    expect(byPath['big.txt']).toMatchObject({ action: 'unavailable', target: { kind: 'unavailable', reason: 'too-large' } })
    expect(byPath['gone.txt']).toMatchObject({ action: 'unavailable', target: { kind: 'unavailable', reason: 'evicted' } })
    expect(byPath['deleted-again.txt']).toMatchObject({ action: 'unchanged', expectedSha: null })
  })

  it('marks a conflict when the disk differs from the latest after-state', () => {
    const plan = planRewind([row({ id: 40, ...stored(V1), afterSha: V2 })], disk({ 'a.txt': V3 }))
    expect(plan.files[0]).toMatchObject({ action: 'restore', conflict: true })
    const missing = planRewind([row({ id: 41, ...stored(V1), afterSha: V2 })], disk({ 'a.txt': null }))
    expect(missing.files[0]).toMatchObject({ action: 'restore', conflict: true })
    const unreadable = planRewind([row({ id: 42, ...stored(V1), afterSha: V2 })], disk({ 'a.txt': 'unreadable' }))
    expect(unreadable.files[0]).toMatchObject({ action: 'restore', conflict: true, current: 'unreadable' })
  })

  it('a path without a disk entry counts as missing', () => {
    const plan = planRewind([row({ id: 45, beforeState: 'missing', afterSha: V1 })], new Map())
    expect(plan.files[0]).toMatchObject({ action: 'unchanged', current: null })
  })

  it('orders files newest-edited first (by the id of their latest row)', () => {
    const rows = [
      row({ id: 50, path: 'old.txt' }),
      row({ id: 51, path: 'new.txt' }),
      row({ id: 52, path: 'old.txt', ...stored(V1), afterSha: V2 }),
      row({ id: 53, path: 'middle.txt' }),
    ]
    expect(planRewind(rows, new Map()).files.map(file => file.path)).toEqual(['middle.txt', 'old.txt', 'new.txt'])
    expect(orderedPaths(rows)).toEqual(['middle.txt', 'old.txt', 'new.txt'])
  })

  it('ignores shell and untracked rows (no path, never restored)', () => {
    const rows = [
      row({ id: 60, kind: 'shell', tool: 'shell', path: null, command: 'rm -rf build', beforeState: null, afterSha: null }),
      row({ id: 61, kind: 'untracked', tool: 'acme_write', path: null, beforeState: null, afterSha: null }),
      row({ id: 62, path: 'a.txt' }),
    ]
    expect(planRewind(rows, new Map()).files.map(file => file.path)).toEqual(['a.txt'])
  })

  it('is idempotent: a second plan after an apply (its own rewind rows) is all unchanged', () => {
    const edits = [
      row({ id: 70, path: 'a.txt', ...stored(V1), afterSha: V2 }),
      row({ id: 71, path: 'b.txt', beforeState: 'missing', afterSha: V1 }),
    ]
    const before = planRewind(edits, disk({ 'a.txt': V2, 'b.txt': V1 }))
    expect(before.files.map(file => [file.path, file.action])).toEqual([['b.txt', 'delete'], ['a.txt', 'restore']])
    // The apply's rows: the snapshot of the current state, the target as the after-state.
    const applied = [
      row({ id: 72, kind: 'rewind', batchId: 'wcb_AAAAAAAAAAAAAAAA', path: 'b.txt', ...stored(V1), afterSha: null }),
      row({ id: 73, kind: 'rewind', batchId: 'wcb_AAAAAAAAAAAAAAAA', path: 'a.txt', ...stored(V2), afterSha: V1 }),
    ]
    const after = planRewind([...edits, ...applied], disk({ 'a.txt': V1, 'b.txt': null }))
    expect(after.files.map(file => [file.path, file.action, file.conflict])).toEqual([['a.txt', 'unchanged', false], ['b.txt', 'unchanged', false]])
  })
})

describe('planUndo', () => {
  it('targets the before-state of each batch row, expecting its after-state', () => {
    const batch = [
      row({ id: 80, kind: 'revert', batchId: 'wcb_BBBBBBBBBBBBBBBB', path: 'a.txt', ...stored(V2, 0o755), afterSha: V1 }),
      row({ id: 81, kind: 'revert', batchId: 'wcb_BBBBBBBBBBBBBBBB', path: 'b.txt', beforeState: 'missing', afterSha: V1 }),
    ]
    const plan = planUndo(batch, disk({ 'a.txt': V1, 'b.txt': V3 }))
    expect(plan.files.map(file => [file.path, file.action, file.conflict, file.expectedSha])).toEqual([
      ['b.txt', 'delete', true, V1],
      ['a.txt', 'restore', false, V1],
    ])
    expect(plan.files[1]!.target).toEqual({ kind: 'stored', sha: V2, size: 3, mode: 0o755 })
  })
})

describe('helpers', () => {
  it('beforeTarget treats a stored row without its sha as evicted', () => {
    expect(beforeTarget(row({ beforeState: 'stored', beforeSha: null, beforeSize: null }))).toEqual({ kind: 'unavailable', reason: 'evicted' })
    expect(beforeTarget(row({ beforeState: null }))).toEqual({ kind: 'unavailable', reason: 'evicted' })
  })

  it('targetSha and restoreAction of a bytes target (a git revert)', () => {
    const target = { kind: 'bytes', bytes: new TextEncoder().encode('v1\n'), mode: 0o644 } as const
    expect(targetSha(target)).toBe(V1)
    expect(restoreAction(target, V1)).toBe('unchanged')
    expect(restoreAction(target, null)).toBe('restore')
    expect(targetSha({ kind: 'unavailable', reason: 'evicted' })).toBeUndefined()
  })

  it('planFile without an expected state never marks a conflict', () => {
    const file = planFile({ path: 'a.txt', target: { kind: 'missing' }, current: V1, edits: 1, lastEditAt: 0 })
    expect(file).toMatchObject({ action: 'delete', conflict: false })
    expect('expectedSha' in file).toBe(false)
  })
})
