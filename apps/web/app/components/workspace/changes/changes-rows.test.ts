// Pure helpers of the changes panel (docs/UI.md 7.21, 11.5): the rows of both views, the status tiles, the summary
// line, the empty reasons and the footer notes.
import { describe, expect, it } from 'vitest'
import { chatChangeFile, chatChanges, gitStatus, gitStatusFile } from '~/utils/testing/fixtures'
import {
  changesEmptyReason,
  changesSummary,
  changesTruncatedNote,
  chatChangeRows,
  fileName,
  gitChangeRows,
  rowLabel,
  statusTile,
  untrackedNote,
} from './changes-rows'

describe('chatChangeRows', () => {
  it('maps the journal files, leaves out unchanged ones and keeps the server order', () => {
    const changes = chatChanges({
      files: [
        chatChangeFile({ path: 'b.ts', status: 'added', added: 10, removed: 0, edits: 2 }),
        chatChangeFile({ path: 'a.ts', status: 'unchanged' }),
        chatChangeFile({ path: 'c.ts', status: 'deleted', added: null, removed: null, changedOutside: true, revertible: false }),
      ],
    })
    expect(chatChangeRows(changes)).toEqual([
      { path: 'b.ts', origPath: null, status: 'added', additions: 10, deletions: 0, changedOutside: false, revertible: true, edits: 2, staged: null, unstaged: null },
      { path: 'c.ts', origPath: null, status: 'deleted', additions: null, deletions: null, changedOutside: true, revertible: false, edits: 1, staged: null, unstaged: null },
    ])
  })
})

describe('gitChangeRows', () => {
  it('maps git status files; a conflicted file is not revertible', () => {
    const status = gitStatus({
      files: [
        gitStatusFile({ path: 'src/lexer.ts', origPath: 'src/lex.ts', status: 'renamed', staged: true, unstaged: false }),
        gitStatusFile({ path: 'src/merge.ts', status: 'conflicted' }),
        gitStatusFile({ path: 'notes.txt', status: 'untracked', unstaged: false }),
      ],
    })
    expect(gitChangeRows(status)).toEqual([
      { path: 'src/lexer.ts', origPath: 'src/lex.ts', status: 'renamed', additions: null, deletions: null, changedOutside: false, revertible: true, edits: null, staged: true, unstaged: false },
      { path: 'src/merge.ts', origPath: null, status: 'conflicted', additions: null, deletions: null, changedOutside: false, revertible: false, edits: null, staged: false, unstaged: true },
      { path: 'notes.txt', origPath: null, status: 'untracked', additions: null, deletions: null, changedOutside: false, revertible: true, edits: null, staged: false, unstaged: false },
    ])
  })
})

describe('statusTile', () => {
  it.each([
    ['added', 'A', 'Added'],
    ['modified', 'M', 'Modified'],
    ['deleted', 'D', 'Deleted'],
    ['untracked', 'U', 'Untracked'],
    ['renamed', 'R', 'Renamed'],
    ['conflicted', '!', 'Conflicted'],
    ['typechange', 'T', 'Type changed'],
  ] as const)('%s -> %s %s', (status, letter, label) => {
    expect(statusTile(status)).toEqual({ letter, label })
  })
})

describe('changesSummary', () => {
  it('this chat: the file count and the totals of the known line counts', () => {
    const files = [
      chatChangeFile({ path: 'a.ts', added: 12, removed: 3 }),
      chatChangeFile({ path: 'b.ts', status: 'added', added: 10, removed: 0 }),
      chatChangeFile({ path: 'c.ts', added: null, removed: null }),
      chatChangeFile({ path: 'd.ts', status: 'unchanged', added: 99, removed: 99 }),
    ]
    expect(changesSummary('chat', chatChanges({ files }))).toBe('3 files changed · +22 −3')
    expect(changesSummary('chat', chatChanges({ files: [chatChangeFile({ added: 1, removed: 0 })] }))).toBe('1 file changed · +1 −0')
    expect(changesSummary('chat', chatChanges({ files: [chatChangeFile({ added: null, removed: null })] }))).toBe('1 file changed')
    expect(changesSummary('chat', chatChanges({ files: [] }))).toBe('')
    expect(changesSummary('chat', chatChanges({ available: false, reason: 'folder-unavailable', files: [] }))).toBe('')
  })

  it('git: the branch, a detached HEAD or no commits, then the file count', () => {
    expect(changesSummary('git', gitStatus())).toBe('On main · 1 file changed')
    expect(changesSummary('git', gitStatus({ files: [] }))).toBe('On main')
    expect(changesSummary('git', gitStatus({ branch: null, head: 'abcdef0123456789' }))).toBe('Detached at abcdef0 · 1 file changed')
    expect(changesSummary('git', gitStatus({ head: null, files: [gitStatusFile(), gitStatusFile({ path: 'b' })] }))).toBe('No commits yet · 2 files changed')
    expect(changesSummary('git', gitStatus({ available: false, reason: 'not-a-repo', branch: null, head: null, files: [] }))).toBe('')
    expect(changesSummary('git', gitStatus({ files: Array.from({ length: 1234 }, (_, n) => gitStatusFile({ path: `f${n}` })) }))).toBe('On main · 1,234 files changed')
  })
})

describe('changesEmptyReason', () => {
  it('none / clean when nothing is listed, the unavailable reason, else null', () => {
    expect(changesEmptyReason('chat', chatChanges())).toBeNull()
    expect(changesEmptyReason('chat', chatChanges({ files: [chatChangeFile({ status: 'unchanged' })] }))).toBe('none')
    expect(changesEmptyReason('chat', chatChanges({ available: false, reason: 'folder-unavailable', files: [] }))).toBe('folder-unavailable')
    expect(changesEmptyReason('chat', chatChanges({ available: false, reason: null, files: [] }))).toBe('no-project')
    expect(changesEmptyReason('git', gitStatus())).toBeNull()
    expect(changesEmptyReason('git', gitStatus({ files: [] }))).toBe('clean')
    for (const reason of ['git-missing', 'not-a-repo', 'refused', 'timeout', 'failed', 'no-project', 'folder-unavailable'] as const)
      expect(changesEmptyReason('git', gitStatus({ available: false, reason, files: [] }))).toBe(reason)
    expect(changesEmptyReason('git', gitStatus({ available: false, reason: null, files: [] }))).toBe('failed')
  })
})

describe('footer notes and labels', () => {
  it('names the caps of both lists', () => {
    expect(changesTruncatedNote('chat')).toBe('Showing the first 500 files.')
    expect(changesTruncatedNote('git')).toBe('Showing the first 2,000 files.')
  })

  it('counts the untracked changes, leaving out a zero part', () => {
    expect(untrackedNote({ shellCommands: 3, toolCalls: 1 })).toBe('3 shell commands and 1 other tool call in this chat may have changed files too. They aren\'t listed here.')
    expect(untrackedNote({ shellCommands: 1, toolCalls: 0 })).toBe('1 shell command in this chat may have changed files too. They aren\'t listed here.')
    expect(untrackedNote({ shellCommands: 0, toolCalls: 2 })).toBe('2 other tool calls in this chat may have changed files too. They aren\'t listed here.')
    expect(untrackedNote({ shellCommands: 0, toolCalls: 0 })).toBeNull()
  })

  it('labels renames and names files', () => {
    expect(rowLabel({ path: 'src/lexer.ts', origPath: 'src/lex.ts' })).toBe('src/lex.ts → src/lexer.ts')
    expect(rowLabel({ path: 'src/lexer.ts', origPath: null })).toBe('src/lexer.ts')
    expect(fileName('src/parser.ts')).toBe('parser.ts')
    expect(fileName('README.md')).toBe('README.md')
  })
})
