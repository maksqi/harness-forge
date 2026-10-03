// Workspace tool registry (docs/UI.md 7.19, 11.4; W7.11): views, approval previews, row arguments, row summaries and
// icons of the core-workspace tools; null (the generic blocks) for other tools and for values that fail the shared
// schemas, such as a share value cut to a `[truncated]` string.
import type { ShellOutput } from '@harness-forge/shared'
import { FilePenLineIcon, FilePlusIcon, FileSearchIcon, FileTextIcon, ListTreeIcon, SquareTerminalIcon, TextSearchIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import {
  countDiffLines,
  isWorkspaceToolName,
  workspaceApprovalKind,
  workspaceApprovalView,
  workspaceRowArgument,
  workspaceRowSummary,
  workspaceToolIcon,
  workspaceToolView,
} from './workspace-tools'

const diff = {
  hunks: [{ oldStart: 12, oldLines: 3, newStart: 12, newLines: 4, lines: [' a', '-b', '+c', '+d', ' e'] }],
  added: 12,
  removed: 3,
  truncated: false,
}

function shell(overrides: Partial<ShellOutput> = {}): ShellOutput {
  return {
    command: 'pnpm test',
    cwd: '.',
    exitCode: 0,
    signal: null,
    timedOut: false,
    durationMs: 3200,
    stdout: '42 tests passed\n',
    stderr: '',
    stdoutBytes: 16,
    stderrBytes: 0,
    ...overrides,
  }
}

describe('workspace tool registry: guards', () => {
  it('returns null for a tool outside WORKSPACE_TOOL_NAMES', () => {
    expect(isWorkspaceToolName('get_weather')).toBe(false)
    expect(isWorkspaceToolName('shell')).toBe(true)
    expect(workspaceToolView('get_weather', { city: 'Paris' }, { temp: 20 })).toBeNull()
    expect(workspaceApprovalView('get_weather', { city: 'Paris' })).toBeNull()
    expect(workspaceRowArgument('get_weather', { city: 'Paris' })).toBeNull()
    expect(workspaceRowSummary('get_weather', { temp: 20 })).toBeNull()
    expect(workspaceToolIcon('get_weather')).toBeNull()
  })

  it('returns null for values that fail the shared schemas', () => {
    expect(workspaceToolView('read_file', { path: 'a.txt' }, '[truncated]')).toBeNull()
    expect(workspaceApprovalView('edit_file', 42)).toBeNull()
    expect(workspaceRowArgument('shell', null)).toBeNull()
    expect(workspaceRowSummary('shell', '[truncated]')).toBeNull()
  })

  it('falls back for a share value cut to a string and for a plugin tool with the same name', () => {
    const cut = `{"path": "src/app.ts", "created": false, "diff": {"hunks": [${'x'.repeat(40)}\n[truncated]`
    expect(workspaceToolView('edit_file', { path: 'src/app.ts' }, cut)).toBeNull()
    expect(workspaceRowSummary('edit_file', cut)).toBeNull()
    // A plugin tool named read_file that returns plain text.
    expect(workspaceToolView('read_file', { file: 'a' }, 'hello')).toBeNull()
    expect(workspaceRowSummary('read_file', { text: 'hello' })).toBeNull()
    expect(workspaceRowArgument('read_file', { file: 'a.txt' })).toBeNull()
    // Missing or extra-strict fields.
    expect(workspaceToolView('shell', { command: 'ls' }, { ...shell(), exitCode: 'zero' })).toBeNull()
    expect(workspaceToolView('list_directory', {}, { path: '.', entries: [{ name: 'a', type: 'socket' }], truncated: false })).toBeNull()
  })
})

describe('workspaceToolView', () => {
  it('turns write_file and edit_file outputs into diffs', () => {
    expect(workspaceToolView('edit_file', {}, { path: 'src/app.ts', replacements: 1, diff })).toEqual({
      kind: 'diff',
      path: 'src/app.ts',
      created: false,
      additions: 12,
      deletions: 3,
      hunks: diff.hunks,
      truncated: false,
    })
    expect(workspaceToolView('write_file', {}, { path: 'new.txt', created: true, bytes: 6, lines: 2, diff: { ...diff, truncated: true } }))
      .toMatchObject({ kind: 'diff', path: 'new.txt', created: true, truncated: true })
  })

  it('shows a null diff (the server timed out) as an empty, truncated diff', () => {
    expect(workspaceToolView('edit_file', {}, { path: 'big.json', replacements: 2, diff: null })).toEqual({
      kind: 'diff',
      path: 'big.json',
      created: false,
      additions: 0,
      deletions: 0,
      hunks: [],
      truncated: true,
    })
    expect(workspaceToolView('write_file', {}, { path: 'big.json', created: true, bytes: 900, lines: 40, diff: null }))
      .toMatchObject({ additions: 40, deletions: 0, hunks: [], truncated: true })
  })

  it('turns a shell output into a terminal, and the input of a running call into a terminal without output', () => {
    const output = shell()
    expect(workspaceToolView('shell', { command: 'pnpm test' }, output)).toEqual({ kind: 'terminal', command: 'pnpm test', output })
    expect(workspaceToolView('shell', { command: 'pnpm test' }, undefined)).toEqual({ kind: 'terminal', command: 'pnpm test', output: null })
    expect(workspaceToolView('shell', { command: '' }, null)).toBeNull()
  })

  it('turns read_file into file content', () => {
    const output = { path: 'README.md', content: '# Title\n', startLine: 1, endLine: 1, totalLines: 1, truncated: false }
    expect(workspaceToolView('read_file', { path: 'README.md' }, output)).toEqual({ kind: 'file', ...output })
  })

  it('turns the listing tools into lists with project-relative paths', () => {
    expect(workspaceToolView('list_directory', {}, { path: '.', entries: [{ name: 'src', type: 'dir' }, { name: 'a.ts', type: 'file' }], truncated: false }))
      .toEqual({ kind: 'list', items: [{ path: 'src', type: 'dir' }, { path: 'a.ts', type: 'file' }], noun: 'entries', truncated: false })
    expect(workspaceToolView('list_directory', {}, { path: 'src/', entries: [{ name: 'lib', type: 'dir' }], truncated: true }))
      .toEqual({ kind: 'list', items: [{ path: 'src/lib', type: 'dir' }], noun: 'entries', truncated: true })
    expect(workspaceToolView('find_files', {}, { pattern: '*.ts', paths: ['a.ts', 'src/b.ts'], truncated: false }))
      .toEqual({ kind: 'list', items: [{ path: 'a.ts' }, { path: 'src/b.ts' }], noun: 'files', truncated: false })
    expect(workspaceToolView('search_files', {}, { pattern: 'token', matches: [{ path: 'a.ts', line: 3, text: 'token' }], filesSearched: 4, truncated: false }))
      .toEqual({ kind: 'list', items: [{ path: 'a.ts', line: 3, text: 'token' }], noun: 'matches', truncated: false })
  })
})

describe('workspaceApprovalView', () => {
  it('diffs the strings of an edit', () => {
    const view = workspaceApprovalView('edit_file', { path: 'src/parser.ts', old_string: 'if (!tokens) return null', new_string: 'if (tokens.length === 0)\n  return null' })
    expect(view).toEqual({
      kind: 'diff',
      path: 'src/parser.ts',
      created: false,
      additions: 2,
      deletions: 1,
      hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-if (!tokens) return null', '+if (tokens.length === 0)', '+  return null'] }],
      truncated: false,
    })
  })

  it('previews the content of a write and the command of a shell call', () => {
    expect(workspaceApprovalView('write_file', { path: 'a.md', content: 'one\ntwo\n' })).toEqual({
      kind: 'file',
      path: 'a.md',
      content: 'one\ntwo\n',
      startLine: 1,
      endLine: 2,
      totalLines: 2,
      truncated: false,
    })
    expect(workspaceApprovalView('shell', { command: 'ls -la', timeout_ms: 5000 })).toEqual({ kind: 'terminal', command: 'ls -la', output: null })
  })

  it('names the kind of a preview without building it', () => {
    expect(workspaceApprovalKind('edit_file', { path: 'a', old_string: 'x', new_string: 'y' })).toBe('diff')
    expect(workspaceApprovalKind('write_file', { path: 'a', content: '' })).toBe('file')
    expect(workspaceApprovalKind('shell', { command: 'ls' })).toBe('terminal')
    expect(workspaceApprovalKind('shell', { command: '' })).toBeNull()
    expect(workspaceApprovalKind('read_file', { path: 'a' })).toBeNull()
  })

  it('has no preview for read tools or malformed inputs', () => {
    expect(workspaceApprovalView('read_file', { path: '.env' })).toBeNull()
    expect(workspaceApprovalView('shell', { command: 'ls', timeout_ms: 10 })).toBeNull()
    expect(workspaceApprovalView('write_file', { path: '', content: 'x' })).toBeNull()
  })
})

describe('workspaceRowArgument', () => {
  it('reads the path, the pattern or the first line of the command', () => {
    expect(workspaceRowArgument('read_file', { offset: 10, path: 'src/app.ts' })).toBe('src/app.ts')
    expect(workspaceRowArgument('write_file', { content: 'x', path: 'a.md' })).toBe('a.md')
    expect(workspaceRowArgument('edit_file', { old_string: 'a', path: 'b.ts' })).toBe('b.ts')
    expect(workspaceRowArgument('list_directory', {})).toBe('.')
    expect(workspaceRowArgument('list_directory', { path: 'src' })).toBe('src')
    expect(workspaceRowArgument('find_files', { path: 'src', pattern: '*.ts' })).toBe('*.ts')
    expect(workspaceRowArgument('search_files', { glob: '*.ts', pattern: 'TODO' })).toBe('TODO')
    expect(workspaceRowArgument('shell', { description: 'Install', command: '\npnpm install\npnpm test' })).toBe('pnpm install')
  })

  it('works on streaming inputs and caps the argument at 60 characters', () => {
    expect(workspaceRowArgument('write_file', { path: 'src/a' })).toBe('src/a')
    expect(workspaceRowArgument('shell', { command: `echo ${'x'.repeat(100)}` })).toHaveLength(60)
    expect(workspaceRowArgument('read_file', {})).toBeNull()
    expect(workspaceRowArgument('read_file', [])).toBeNull()
  })
})

describe('workspaceRowSummary', () => {
  it('summarizes edits and writes as +a −d, a new file by its lines', () => {
    expect(workspaceRowSummary('edit_file', { path: 'a', replacements: 1, diff })).toEqual({ text: '+12 −3', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: false, bytes: 1, lines: 1, diff })).toEqual({ text: '+12 −3', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: true, bytes: 1, lines: 40, diff })).toEqual({ text: 'New · 40 lines', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: true, bytes: 1, lines: 1, diff: null })).toEqual({ text: 'New · 1 line', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: false, bytes: 1, lines: 2, diff: { hunks: [], added: 0, removed: 0, truncated: false } }))
      .toEqual({ text: 'No changes', tone: 'muted' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: false, bytes: 1, lines: 7, diff: null })).toEqual({ text: 'Updated · 7 lines', tone: 'muted' })
    expect(workspaceRowSummary('edit_file', { path: 'a', replacements: 3, diff: null })).toEqual({ text: '3 replacements', tone: 'muted' })
  })

  it('summarizes shell runs by exit code, timeout and signal', () => {
    expect(workspaceRowSummary('shell', shell())).toEqual({ text: 'exit 0', tone: 'muted' })
    expect(workspaceRowSummary('shell', shell({ exitCode: 1 }))).toEqual({ text: 'exit 1', tone: 'destructive' })
    expect(workspaceRowSummary('shell', shell({ exitCode: null, signal: 'SIGTERM', timedOut: true }))).toEqual({ text: 'timed out', tone: 'warning' })
    expect(workspaceRowSummary('shell', shell({ exitCode: null, signal: 'SIGTERM' }))).toEqual({ text: 'killed SIGTERM', tone: 'warning' })
  })

  it('summarizes reads and listings', () => {
    const read = { path: 'a', content: '', startLine: 1, endLine: 120, totalLines: 340, truncated: true }
    expect(workspaceRowSummary('read_file', read)).toEqual({ text: 'lines 1–120 of 340', tone: 'muted' })
    expect(workspaceRowSummary('read_file', { ...read, totalLines: null })).toEqual({ text: 'lines 1–120', tone: 'muted' })
    expect(workspaceRowSummary('read_file', { ...read, endLine: 0, totalLines: 0 })).toEqual({ text: 'empty file', tone: 'muted' })
    expect(workspaceRowSummary('read_file', { ...read, startLine: 500, endLine: 499 })).toEqual({ text: 'no lines of 340', tone: 'muted' })
    expect(workspaceRowSummary('list_directory', { path: '.', entries: Array.from({ length: 24 }, (_, i) => ({ name: `f${i}`, type: 'file' })), truncated: false }))
      .toEqual({ text: '24 entries', tone: 'muted' })
    expect(workspaceRowSummary('list_directory', { path: '.', entries: [{ name: 'a', type: 'file' }], truncated: false })).toEqual({ text: '1 entry', tone: 'muted' })
    expect(workspaceRowSummary('find_files', { pattern: '*', paths: Array.from({ length: 17 }, (_, i) => `f${i}`), truncated: false }))
      .toEqual({ text: '17 files', tone: 'muted' })
    expect(workspaceRowSummary('search_files', { pattern: 'x', matches: [{ path: 'a', line: 1, text: 'x' }], filesSearched: 1, truncated: false }))
      .toEqual({ text: '1 match', tone: 'muted' })
  })
})

describe('workspaceToolIcon and countDiffLines', () => {
  it('gives every workspace tool its icon', () => {
    expect(workspaceToolIcon('read_file')).toBe(FileTextIcon)
    expect(workspaceToolIcon('list_directory')).toBe(ListTreeIcon)
    expect(workspaceToolIcon('find_files')).toBe(FileSearchIcon)
    expect(workspaceToolIcon('search_files')).toBe(TextSearchIcon)
    expect(workspaceToolIcon('write_file')).toBe(FilePlusIcon)
    expect(workspaceToolIcon('edit_file')).toBe(FilePenLineIcon)
    expect(workspaceToolIcon('shell')).toBe(SquareTerminalIcon)
  })

  it('counts added and removed lines of hunks', () => {
    expect(countDiffLines(diff.hunks)).toEqual({ additions: 2, deletions: 1 })
    expect(countDiffLines([])).toEqual({ additions: 0, deletions: 0 })
  })
})
