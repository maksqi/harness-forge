import { describe, expect, it } from 'vitest'
import {
  changeSourceSchema,
  conflictHandlingSchema,
  fileSweepModeSchema,
  workspaceChangedSourceSchema,
  workspaceChangeKindSchema,
} from '../enums.ts'
import { createServerEvent, serverEventSchema } from '../events.ts'
import { LIMITS } from '../limits.ts'
import {
  changeDiffQuerySchema,
  changeRevertBodySchema,
  changesUnavailableReasonSchema,
  changeUndoBodySchema,
  chatChangeFileSchema,
  chatChangesSchema,
  fileDiffSchema,
  fileDiffStatusSchema,
  gitFileStatusSchema,
  gitStatusSchema,
  gitUnavailableReasonSchema,
  restoreResultSchema,
  restoreSkipReasonSchema,
  rewindActionSchema,
  rewindBodySchema,
  rewindPreviewSchema,
  rewindQuerySchema,
  workspaceChangedDataSchema,
} from './changes.ts'

const PROJECT_ID = 'prj_ABCdef0123456789'
const CHAT_ID = '0199a8f0-0000-7000-8000-000000000001'
const MESSAGE_ID = 'msg_A000000000000001'
const BATCH_ID = 'wcb_ABCdef0123456789'
const SHA = 'a'.repeat(64)
const diff = { hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-Turn 1', '+Turn 2'] }], added: 1, removed: 1, truncated: false }

describe('enums (Phase 8)', () => {
  it('lists the values of DECISIONS.md "Enumerations"', () => {
    expect(workspaceChangeKindSchema.options).toEqual(['edit', 'revert', 'rewind', 'undo', 'shell', 'untracked'])
    expect(changeSourceSchema.options).toEqual(['chat', 'git'])
    expect(conflictHandlingSchema.options).toEqual(['skip', 'force'])
    expect(workspaceChangedSourceSchema.options).toEqual(['tool', 'rewind', 'revert', 'undo'])
    expect(fileSweepModeSchema.options).toEqual(['off', 'daily', 'weekly'])
    expect(changesUnavailableReasonSchema.options).toEqual(['no-project', 'folder-unavailable'])
    expect(gitUnavailableReasonSchema.options).toEqual(['no-project', 'folder-unavailable', 'git-missing', 'not-a-repo', 'refused', 'timeout', 'failed'])
    expect(gitFileStatusSchema.options).toEqual(['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'typechange'])
    expect(fileDiffStatusSchema.options).toEqual(['added', 'modified', 'deleted', 'unchanged', 'renamed', 'untracked'])
    expect(rewindActionSchema.options).toEqual(['restore', 'delete', 'unchanged', 'unavailable'])
    expect(restoreSkipReasonSchema.options).toEqual(['conflict', 'unavailable', 'refused', 'failed'])
  })

  it('has the limits of ADR-036 … ADR-038', () => {
    expect(LIMITS).toMatchObject({
      checkpointFileMaxBytes: 8 * 1024 * 1024,
      checkpointProjectMaxBytes: 512 * 1024 * 1024,
      checkpointMaxAgeMs: 30 * 24 * 60 * 60 * 1000,
      changesFilesMax: 500,
      changesLineCountFiles: 200,
      changesLineCountMaxBytes: 256 * 1024,
      changeDiffSideMaxBytes: 1024 * 1024,
      gitStatusFilesMax: 2000,
      gitTimeoutMs: 15_000,
      gitOutputMaxBytes: 8 * 1024 * 1024,
      rewindUntrackedListMax: 50,
      workspaceEventPathsMax: 200,
      shellRulesPerScopeMax: 200,
      shellRulePrefixMaxChars: 200,
      shellCommandSegmentsMax: 32,
      journalCommandMaxChars: 1000,
    })
  })
})

describe('chat changes (ADR-036, ADR-037)', () => {
  const file = { path: 'checkpoint.txt', status: 'modified', edits: 2, changedOutside: false, revertible: true, added: 1, removed: 1, lastEditAt: 5 }
  const changes = { available: true, reason: null, projectId: PROJECT_ID, files: [file], truncated: false, untracked: { shellCommands: 2, toolCalls: 0 } }

  it('parses the list of a project chat and of a chat without a project', () => {
    expect(chatChangesSchema.parse(changes)).toEqual(changes)
    const none = { available: false, reason: 'no-project', projectId: null, files: [], truncated: false, untracked: { shellCommands: 0, toolCalls: 0 } }
    expect(chatChangesSchema.parse(none)).toEqual(none)
    expect(chatChangesSchema.parse({ ...none, reason: 'folder-unavailable', projectId: PROJECT_ID }).reason).toBe('folder-unavailable')
    expect(chatChangeFileSchema.parse({ ...file, added: null, removed: null, revertible: false, changedOutside: true })).toMatchObject({ added: null })
    for (const status of ['added', 'deleted', 'unchanged'])
      expect(chatChangeFileSchema.parse({ ...file, status }).status).toBe(status)
  })

  it('rejects invalid lists', () => {
    for (const change of [
      { reason: 'git-missing' },
      { reason: undefined },
      { projectId: 'prj_short' },
      { files: Array.from({ length: LIMITS.changesFilesMax + 1 }).fill(file) },
      { untracked: { shellCommands: -1, toolCalls: 0 } },
      { truncated: undefined },
    ])
      expect(chatChangesSchema.safeParse({ ...changes, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    for (const change of [{ status: 'renamed' }, { edits: -1 }, { added: 1.5 }, { lastEditAt: null }, { revertible: undefined }])
      expect(chatChangeFileSchema.safeParse({ ...file, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('validates the diff query and parses diffs', () => {
    expect(changeDiffQuerySchema.parse({ source: 'chat', path: 'src/index.ts', extra: '1' })).toEqual({ source: 'chat', path: 'src/index.ts' })
    for (const query of [{ source: 'svn', path: 'a' }, { source: 'git' }, { source: 'git', path: '' }, { source: 'git', path: 'a\u0000b' }, { source: 'git', path: 'x'.repeat(LIMITS.workspacePathMaxChars + 1) }])
      expect(changeDiffQuerySchema.safeParse(query).success, JSON.stringify(query).slice(0, 60)).toBe(false)
    const fileDiff = { source: 'git', path: 'src/new.ts', origPath: 'src/old.ts', status: 'renamed', binary: false, tooLarge: false, diff, currentSha: SHA, baseAvailable: true }
    expect(fileDiffSchema.parse(fileDiff)).toEqual(fileDiff)
    const binary = { ...fileDiff, source: 'chat', origPath: null, status: 'deleted', binary: true, diff: null, currentSha: null }
    expect(fileDiffSchema.parse(binary)).toEqual(binary)
    for (const change of [{ currentSha: 'A'.repeat(64) }, { status: 'conflicted' }, { diff: { hunks: [] } }, { baseAvailable: undefined }, { origPath: undefined }])
      expect(fileDiffSchema.safeParse({ ...fileDiff, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('parses the git view', () => {
    const status = {
      available: true,
      reason: null,
      branch: 'main',
      head: 'b'.repeat(40),
      prefix: 'packages/web',
      files: [
        { path: 'a.txt', origPath: null, status: 'modified', staged: false, unstaged: true },
        { path: 'b.txt', origPath: 'old-b.txt', status: 'renamed', staged: true, unstaged: false },
        { path: 'new.txt', origPath: null, status: 'untracked', staged: false, unstaged: false },
      ],
      truncated: false,
    }
    expect(gitStatusSchema.parse(status)).toEqual(status)
    const unborn = { ...status, branch: 'main', head: null, prefix: '', files: [] }
    expect(gitStatusSchema.parse(unborn)).toEqual(unborn)
    for (const reason of gitUnavailableReasonSchema.options)
      expect(gitStatusSchema.parse({ ...status, available: false, reason, branch: null, head: null, files: [] }).reason).toBe(reason)
    for (const change of [{ reason: 'busy' }, { prefix: null }, { files: Array.from({ length: LIMITS.gitStatusFilesMax + 1 }).fill(status.files[0]) }, { files: [{ ...status.files[0], status: 'ignored' }] }])
      expect(gitStatusSchema.safeParse({ ...status, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })
})

describe('revert, undo and rewind (ADR-036, ADR-037)', () => {
  it('validates revert bodies strictly', () => {
    for (const body of [
      { source: 'chat', path: 'src/a.ts' },
      { source: 'git', path: 'src/a.ts', expectedSha: SHA },
      { source: 'git', path: 'src/a.ts', expectedSha: null },
    ])
      expect(changeRevertBodySchema.parse(body)).toEqual(body)
    for (const body of [
      {},
      { source: 'chat' },
      { source: 'svn', path: 'a' },
      { source: 'chat', path: '' },
      { source: 'chat', path: 'a', expectedSha: 'abc' },
      { source: 'chat', path: 'a', force: true },
    ])
      expect(changeRevertBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })

  it('validates undo and rewind bodies strictly', () => {
    expect(changeUndoBodySchema.parse({ batchId: BATCH_ID, conflicts: 'skip' })).toEqual({ batchId: BATCH_ID, conflicts: 'skip' })
    for (const body of [{ batchId: BATCH_ID }, { batchId: 'srl_ABCdef0123456789', conflicts: 'skip' }, { batchId: BATCH_ID, conflicts: 'overwrite' }, { batchId: BATCH_ID, conflicts: 'force', path: 'a' }])
      expect(changeUndoBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
    expect(rewindQuerySchema.parse({ messageId: MESSAGE_ID, other: 'x' })).toEqual({ messageId: MESSAGE_ID })
    expect(rewindQuerySchema.safeParse({ messageId: 'msg_short' }).success).toBe(false)
    expect(rewindQuerySchema.safeParse({}).success).toBe(false)
    expect(rewindBodySchema.parse({ messageId: MESSAGE_ID, conflicts: 'force' })).toEqual({ messageId: MESSAGE_ID, conflicts: 'force' })
    for (const body of [{ messageId: MESSAGE_ID }, { messageId: 'x', conflicts: 'skip' }, { messageId: MESSAGE_ID, conflicts: 'skip', edit: true }])
      expect(rewindBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })

  it('parses rewind previews with the untracked changes of the range', () => {
    const preview = {
      messageId: MESSAGE_ID,
      files: [
        { path: 'checkpoint.txt', action: 'restore', conflict: false, edits: 1 },
        { path: 'new.txt', action: 'delete', conflict: true, edits: 2 },
        { path: 'big.bin', action: 'unavailable', conflict: false, edits: 1 },
      ],
      untracked: {
        shellCount: 2,
        shell: [{ command: 'mkdir -p mock-dir && cd mock-dir', at: 3, messageId: 'msg_B000000000000001' }],
        tools: [{ tool: 'mcp__srv__write', at: 4, messageId: null }],
      },
      truncated: false,
    }
    expect(rewindPreviewSchema.parse(preview)).toEqual(preview)
    const shell = preview.untracked.shell[0]!
    for (const change of [
      { files: [{ ...preview.files[0], action: 'skip' }] },
      { files: Array.from({ length: LIMITS.changesFilesMax + 1 }).fill(preview.files[0]) },
      { untracked: { ...preview.untracked, shell: Array.from({ length: LIMITS.rewindUntrackedListMax + 1 }).fill(shell) } },
      { untracked: { ...preview.untracked, shell: [{ ...shell, command: 'x'.repeat(LIMITS.journalCommandMaxChars + 1) }] } },
      { untracked: { ...preview.untracked, tools: [{ tool: 'bad name', at: 1, messageId: null }] } },
      { untracked: { shell: [], tools: [] } },
      { messageId: null },
    ])
      expect(rewindPreviewSchema.safeParse({ ...preview, ...change }).success, JSON.stringify(change).slice(0, 80)).toBe(false)
  })

  it('parses restore results', () => {
    const result = {
      batchId: BATCH_ID,
      restored: ['checkpoint.txt'],
      deleted: ['new.txt'],
      unchanged: ['same.txt'],
      skipped: [{ path: 'notes.md', reason: 'conflict', message: 'notes.md changed after the chat last edited it.' }],
    }
    expect(restoreResultSchema.parse(result)).toEqual(result)
    const nothing = { batchId: null, restored: [], deleted: [], unchanged: ['a.txt'], skipped: [] }
    expect(restoreResultSchema.parse(nothing)).toEqual(nothing)
    for (const change of [{ batchId: 'wcb_short' }, { skipped: [{ path: 'a', reason: 'stale', message: 'x' }] }, { restored: undefined }])
      expect(restoreResultSchema.safeParse({ ...result, ...change }).success, JSON.stringify(change)).toBe(false)
  })
})

describe('workspace.changed (ADR-036)', () => {
  const data = { projectId: PROJECT_ID, chatId: CHAT_ID, batchId: BATCH_ID, source: 'rewind' as const, paths: ['checkpoint.txt'] }

  it('parses the event of a batch and of agent tool edits', () => {
    expect(serverEventSchema.parse(createServerEvent('workspace.changed', data, 9))).toEqual({ type: 'workspace.changed', data, at: 9 })
    const tool = { ...data, batchId: null, source: 'tool' }
    expect(workspaceChangedDataSchema.parse(tool)).toEqual(tool)
    expect(workspaceChangedDataSchema.parse({ ...data, chatId: null }).chatId).toBeNull()
  })

  it('rejects invalid data', () => {
    for (const change of [
      { projectId: null },
      { chatId: 'x' },
      { batchId: undefined },
      { source: 'shell' },
      { paths: Array.from({ length: LIMITS.workspaceEventPathsMax + 1 }).fill('a') },
    ])
      expect(serverEventSchema.safeParse({ type: 'workspace.changed', data: { ...data, ...change }, at: 1 }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
  })
})
