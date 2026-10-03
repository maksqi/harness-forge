// Pure helpers of the rewind dialog and its toast (docs/UI.md 7.22, 15).
import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { chatId, messageId, restoreResult, rewindPreview } from '~/utils/testing/fixtures'
import { isRewindRefusal, REWIND_SHELL_COMMANDS_MAX, rewindResultText, rewindView, runningChatOf } from './rewind'

describe('rewindView', () => {
  it('lists the files that would change, the conflict option and the changes a rewind keeps', () => {
    const view = rewindView(rewindPreview({
      files: [
        { path: 'a.ts', action: 'restore', conflict: false, edits: 1 },
        { path: 'b.ts', action: 'unchanged', conflict: false, edits: 1 },
        { path: 'c.ts', action: 'delete', conflict: true, edits: 2 },
        { path: 'd.bin', action: 'unavailable', conflict: false, edits: 1 },
      ],
      untracked: {
        shellCount: 3,
        shell: [{ command: 'pnpm test\n--run', at: 3, messageId: null }, { command: 'ls', at: 2, messageId: null }],
        tools: [{ tool: 'patch', at: 2, messageId: null }, { tool: 'patch', at: 1, messageId: null }, { tool: 'mcp__fs__write', at: 1, messageId: null }],
      },
      truncated: true,
    }))
    expect(view.files).toEqual([
      { path: 'a.ts', action: 'restore', conflict: false },
      { path: 'c.ts', action: 'delete', conflict: true },
      { path: 'd.bin', action: 'unavailable', conflict: false },
    ])
    expect(view.moreFiles).toBe(true)
    expect(view.hasConflict).toBe(true)
    expect(view.commands).toEqual([{ command: 'pnpm test\n--run', firstLine: 'pnpm test' }, { command: 'ls', firstLine: 'ls' }])
    // Three commands ran, two are listed.
    expect(view.moreCommands).toBe(1)
    expect(view.tools).toEqual(['patch', 'mcp__fs__write'])
  })

  it('lists at most ten commands', () => {
    const shell = Array.from({ length: 50 }, (_, index) => ({ command: `echo ${index}`, at: index, messageId: messageId('a1') }))
    const view = rewindView(rewindPreview({ untracked: { shellCount: 120, shell, tools: [] } }))
    expect(view.commands).toHaveLength(REWIND_SHELL_COMMANDS_MAX)
    expect(view.moreCommands).toBe(110)
    expect(rewindView(rewindPreview({ files: [], untracked: { shellCount: 0, shell: [], tools: [] } }))).toMatchObject({
      files: [],
      hasConflict: false,
      shellCount: 0,
      commands: [],
      moreCommands: 0,
    })
  })
})

describe('rewindResultText', () => {
  it('counts restored and deleted files and offers Undo when something was written', () => {
    expect(rewindResultText(restoreResult({ restored: ['a'], deleted: [] }))).toEqual({ title: 'Restored 1 file', lines: [], undoable: true })
    expect(rewindResultText(restoreResult({
      restored: ['a', 'b'],
      deleted: ['c'],
      skipped: [
        { path: 'd', reason: 'conflict', message: 'Changed.' },
        { path: 'e', reason: 'unavailable', message: 'Not stored.' },
        { path: 'f', reason: 'refused', message: 'Refused.' },
      ],
    }))).toEqual({
      title: 'Restored 3 files',
      lines: ['Skipped 1 file changed outside this chat', 'Skipped 2 files that can\'t be restored'],
      undoable: true,
    })
  })

  it('says nothing was restored, or that the files already match', () => {
    expect(rewindResultText(restoreResult({
      batchId: null,
      restored: [],
      skipped: [{ path: 'd', reason: 'conflict', message: 'Changed.' }, { path: 'e', reason: 'conflict', message: 'Changed.' }],
    }))).toEqual({ title: 'Nothing was restored.', lines: ['Skipped 2 files changed outside this chat'], undoable: false })
    expect(rewindResultText(restoreResult({ batchId: null, restored: [], unchanged: ['a'] })))
      .toEqual({ title: 'The files already match.', lines: [], undoable: false })
  })
})

describe('refusals', () => {
  it('hands 404 and run-active conflicts to the host, nothing else', () => {
    expect(isRewindRefusal(new HarnessError({ code: 'not_found', message: 'Gone.' }))).toBe(true)
    expect(isRewindRefusal(new HarnessError({ code: 'conflict', message: 'Running.', details: { reason: 'run-active', chatId: chatId(2) } }))).toBe(true)
    expect(isRewindRefusal(new HarnessError({ code: 'conflict', message: 'Running.' }))).toBe(true)
    expect(isRewindRefusal(new HarnessError({ code: 'conflict', message: 'Busy.', details: { reason: 'busy' } }))).toBe(false)
    expect(isRewindRefusal(new HarnessError({ code: 'validation_error', message: 'Not a user message.' }))).toBe(false)
  })

  it('reads the running chat of a conflict', () => {
    expect(runningChatOf(new HarnessError({ code: 'conflict', message: 'Running.', details: { reason: 'run-active', chatId: chatId(2) } }))).toBe(chatId(2))
    expect(runningChatOf(new HarnessError({ code: 'conflict', message: 'Running.' }))).toBeNull()
  })
})
