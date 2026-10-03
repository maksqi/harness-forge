// Workspace tool registry (docs/UI.md 7.19, 11.4; W7.11): views, approval previews, row arguments, row summaries and
// icons of the core-workspace tools; null (the generic blocks) for other tools and for values that fail the shared
// schemas, such as a share value cut to a `[truncated]` string.
import type { HarnessUIMessage, ShellOutput } from '@harness-forge/shared'
import { FilePenLineIcon, FilePlusIcon, FileSearchIcon, FileTextIcon, ListTreeIcon, SquareTerminalIcon, TextSearchIcon } from '@lucide/vue'
import { describe, expect, it } from 'vitest'
import {
  countDiffLines,
  currentShellCwd,
  diffStatsLabel,
  isWorkspaceToolName,
  shellFolder,
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
    expect(workspaceToolView('shell', { command: 'pnpm test' }, output)).toEqual({ kind: 'terminal', command: 'pnpm test', output, cwd: '.' })
    expect(workspaceToolView('shell', { command: 'pnpm test' }, undefined)).toEqual({ kind: 'terminal', command: 'pnpm test', output: null, cwd: null })
    expect(workspaceToolView('shell', { command: '' }, null)).toBeNull()
  })

  it('gives a terminal the folder it started in: the output\'s cwd, else the input\'s (Phase 8)', () => {
    expect(workspaceToolView('shell', { command: 'ls', cwd: 'packages' }, shell({ cwd: 'packages/web' })))
      .toMatchObject({ kind: 'terminal', cwd: 'packages/web' })
    expect(workspaceToolView('shell', { command: 'ls', cwd: 'packages' }, undefined)).toMatchObject({ kind: 'terminal', cwd: 'packages' })
    expect(workspaceApprovalView('shell', { command: 'ls', cwd: 'src' })).toMatchObject({ kind: 'terminal', cwd: 'src' })
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
    expect(workspaceApprovalView('shell', { command: 'ls -la', timeout_ms: 5000 })).toEqual({ kind: 'terminal', command: 'ls -la', output: null, cwd: null })
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
    expect(workspaceRowSummary('edit_file', { path: 'a', replacements: 1, diff })).toMatchObject({ text: '+12 −3', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: false, bytes: 1, lines: 1, diff })).toMatchObject({ text: '+12 −3', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: true, bytes: 1, lines: 40, diff })).toMatchObject({ text: 'New · 40 lines', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: true, bytes: 1, lines: 1, diff: null })).toMatchObject({ text: 'New · 1 line', tone: 'success' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: false, bytes: 1, lines: 2, diff: { hunks: [], added: 0, removed: 0, truncated: false } }))
      .toMatchObject({ text: 'No changes', tone: 'muted' })
    expect(workspaceRowSummary('write_file', { path: 'a', created: false, bytes: 1, lines: 7, diff: null })).toMatchObject({ text: 'Updated · 7 lines', tone: 'muted' })
    expect(workspaceRowSummary('edit_file', { path: 'a', replacements: 3, diff: null })).toMatchObject({ text: '3 replacements', tone: 'muted' })
  })

  it('summarizes shell runs by exit code, timeout and signal', () => {
    expect(workspaceRowSummary('shell', shell())).toMatchObject({ text: 'exit 0', tone: 'muted' })
    expect(workspaceRowSummary('shell', shell({ exitCode: 1 }))).toMatchObject({ text: 'exit 1', tone: 'destructive' })
    expect(workspaceRowSummary('shell', shell({ exitCode: null, signal: 'SIGTERM', timedOut: true }))).toMatchObject({ text: 'timed out', tone: 'warning' })
    expect(workspaceRowSummary('shell', shell({ exitCode: null, signal: 'SIGTERM' }))).toMatchObject({ text: 'killed SIGTERM', tone: 'warning' })
  })

  it('summarizes reads and listings', () => {
    const read = { path: 'a', content: '', startLine: 1, endLine: 120, totalLines: 340, truncated: true }
    expect(workspaceRowSummary('read_file', read)).toMatchObject({ text: 'lines 1–120 of 340', tone: 'muted' })
    expect(workspaceRowSummary('read_file', { ...read, totalLines: null })).toMatchObject({ text: 'lines 1–120', tone: 'muted' })
    expect(workspaceRowSummary('read_file', { ...read, endLine: 0, totalLines: 0 })).toMatchObject({ text: 'empty file', tone: 'muted' })
    expect(workspaceRowSummary('read_file', { ...read, startLine: 500, endLine: 499 })).toMatchObject({ text: 'no lines of 340', tone: 'muted' })
    expect(workspaceRowSummary('list_directory', { path: '.', entries: Array.from({ length: 24 }, (_, i) => ({ name: `f${i}`, type: 'file' })), truncated: false }))
      .toMatchObject({ text: '24 entries', tone: 'muted' })
    expect(workspaceRowSummary('list_directory', { path: '.', entries: [{ name: 'a', type: 'file' }], truncated: false })).toMatchObject({ text: '1 entry', tone: 'muted' })
    expect(workspaceRowSummary('find_files', { pattern: '*', paths: Array.from({ length: 17 }, (_, i) => `f${i}`), truncated: false }))
      .toMatchObject({ text: '17 files', tone: 'muted' })
    expect(workspaceRowSummary('search_files', { pattern: 'x', matches: [{ path: 'a', line: 1, text: 'x' }], filesSearched: 1, truncated: false }))
      .toMatchObject({ text: '1 match', tone: 'muted' })
  })

  it('carries the spoken label of every summary (Phase 8, docs/UI.md 7.19)', () => {
    const one = { hunks: [], added: 1, removed: 1, truncated: false }
    const read = { path: 'a', content: '', startLine: 1, endLine: 120, totalLines: 340, truncated: true }
    const table: Array<[string, unknown, string, string]> = [
      ['edit_file', { path: 'a', replacements: 1, diff }, '+12 −3', '12 lines added, 3 removed'],
      ['edit_file', { path: 'a', replacements: 1, diff: one }, '+1 −1', '1 line added, 1 removed'],
      ['edit_file', { path: 'a', replacements: 1, diff: { ...one, removed: 0 } }, '+1 −0', '1 line added'],
      ['edit_file', { path: 'a', replacements: 1, diff: { ...one, added: 0, removed: 3 } }, '+0 −3', '3 lines removed'],
      ['edit_file', { path: 'a', replacements: 3, diff: null }, '3 replacements', '3 replacements'],
      ['edit_file', { path: 'a', replacements: 1, diff: { ...one, added: 0, removed: 0 } }, 'No changes', 'No changes'],
      ['write_file', { path: 'a', created: true, bytes: 1, lines: 40, diff }, 'New · 40 lines', 'New file, 40 lines'],
      ['write_file', { path: 'a', created: true, bytes: 1, lines: 1, diff: null }, 'New · 1 line', 'New file, 1 line'],
      ['write_file', { path: 'a', created: false, bytes: 1, lines: 40, diff: null }, 'Updated · 40 lines', 'Updated, 40 lines'],
      ['write_file', { path: 'a', created: false, bytes: 1, lines: 2, diff }, '+12 −3', '12 lines added, 3 removed'],
      ['shell', shell(), 'exit 0', 'Exit code 0'],
      ['shell', shell({ exitCode: 1 }), 'exit 1', 'Exit code 1'],
      ['shell', shell({ exitCode: null, signal: 'SIGTERM', timedOut: true }), 'timed out', 'Timed out'],
      ['shell', shell({ exitCode: null, signal: 'SIGTERM' }), 'killed SIGTERM', 'Killed by SIGTERM'],
      ['shell', shell({ exitCode: null }), 'exited', 'Exited without an exit code'],
      ['read_file', read, 'lines 1–120 of 340', 'Lines 1 to 120 of 340'],
      ['read_file', { ...read, totalLines: null }, 'lines 1–120', 'Lines 1 to 120'],
      ['read_file', { ...read, endLine: 0, totalLines: 0 }, 'empty file', 'empty file'],
      ['read_file', { ...read, startLine: 500, endLine: 499 }, 'no lines of 340', 'no lines of 340'],
      ['list_directory', { path: '.', entries: [{ name: 'a', type: 'file' }], truncated: false }, '1 entry', '1 entry'],
      ['find_files', { pattern: '*', paths: ['a', 'b'], truncated: false }, '2 files', '2 files'],
      ['search_files', { pattern: 'x', matches: [{ path: 'a', line: 1, text: 'x' }], filesSearched: 1, truncated: false }, '1 match', '1 match'],
    ]
    expect(table.map(([tool, output]) => {
      const summary = workspaceRowSummary(tool, output)
      return [tool, summary?.text, summary?.label]
    })).toEqual(table.map(([tool, , text, label]) => [tool, text, label]))
  })
})

describe('diffStatsLabel', () => {
  it('reads +a −d as words (docs/UI.md 7.19)', () => {
    expect(diffStatsLabel(12, 3)).toBe('12 lines added, 3 removed')
    expect(diffStatsLabel(1, 1)).toBe('1 line added, 1 removed')
    expect(diffStatsLabel(12, 0)).toBe('12 lines added')
    expect(diffStatsLabel(0, 3)).toBe('3 lines removed')
    expect(diffStatsLabel(0, 1)).toBe('1 line removed')
    expect(diffStatsLabel(0, 0)).toBe('No changes')
  })
})

describe('currentShellCwd', () => {
  function shellPart(output: unknown, state = 'output-available', toolCallId = 'call_1') {
    return { type: 'tool-shell', toolCallId, state, input: { command: 'cd sub' }, ...(state === 'output-available' ? { output } : { errorText: 'x' }) }
  }
  function assistant(...parts: unknown[]): HarnessUIMessage {
    return { id: `msg_${parts.length}`, role: 'assistant', parts } as HarnessUIMessage
  }
  const user: HarnessUIMessage = { id: 'msg_user', role: 'user', parts: [{ type: 'text', text: 'go' }] }

  it('is null (the project folder) without a finished shell call', () => {
    expect(currentShellCwd([])).toBeNull()
    expect(currentShellCwd([user, assistant({ type: 'text', text: 'hi', state: 'done' })])).toBeNull()
    expect(currentShellCwd([assistant(shellPart(null, 'input-available'), shellPart(null, 'output-error'))])).toBeNull()
  })

  it('takes the endCwd of the last finished shell part on the path', () => {
    const messages = [
      user,
      assistant(shellPart(shell({ endCwd: 'packages' })), shellPart(shell({ cwd: 'packages', endCwd: 'packages/web' }), 'output-available', 'call_2')),
      user,
      assistant({ type: 'text', text: 'done', state: 'done' }),
    ]
    expect(currentShellCwd(messages)).toBe('packages/web')
    // A running or failed call after it changes nothing; other tools neither.
    const later = assistant(
      shellPart(null, 'input-available', 'call_3'),
      shellPart(null, 'output-error', 'call_4'),
      { type: 'tool-read_file', toolCallId: 'call_5', state: 'output-available', input: {}, output: { endCwd: 'elsewhere' } },
    )
    expect(currentShellCwd([...messages, later])).toBe('packages/web')
    // The project folder again after a call that ended there.
    expect(currentShellCwd([...messages, assistant(shellPart(shell({ cwd: 'packages/web', endCwd: '.' })))])).toBe('.')
    // A dynamic tool part named shell counts too.
    const dynamic = { type: 'dynamic-tool', toolName: 'shell', toolCallId: 'call_6', state: 'output-available', input: {}, output: shell({ endCwd: 'lib' }) }
    expect(currentShellCwd([...messages, assistant(dynamic)])).toBe('lib')
  })

  it('skips a finished output without endCwd (exec, a kill, an output saved before v1.4): the folder stays', () => {
    const unreported = shell({ cwd: 'sub', exitCode: null, signal: 'SIGKILL', timedOut: true })
    delete unreported.endCwd
    expect(currentShellCwd([assistant(shellPart(shell({ endCwd: 'sub' })), shellPart(unreported, 'output-available', 'call_2'))])).toBe('sub')
    expect(currentShellCwd([assistant(shellPart(shell({ endCwd: 'sub' }))), user, assistant(shellPart(unreported, 'output-available', 'call_2'))])).toBe('sub')
    // Only outputs without the field (pre-v1.4): the project folder (null).
    const old = shell()
    delete old.endCwd
    expect(currentShellCwd([assistant(shellPart(old), shellPart(old, 'output-available', 'call_2'))])).toBeNull()
  })

  it('ignores an endCwd the shared path schema refuses, and shell parts outside assistant messages', () => {
    // Like the server: empty, not a string, a control character (the folder itself is re-checked at the call start).
    for (const endCwd of ['', 42, null, 'a\u0007b'])
      expect(currentShellCwd([assistant(shellPart(shell({ endCwd: 'ok' })), shellPart({ ...shell(), endCwd }, 'output-available', 'call_2'))]), String(endCwd)).toBe('ok')
    expect(currentShellCwd([{ id: 'msg_u', role: 'user', parts: [shellPart(shell({ endCwd: 'sub' }))] } as HarnessUIMessage])).toBeNull()
  })

  it('follows the shown path: another version of a message has its own folder', () => {
    const first = [user, assistant(shellPart(shell({ endCwd: 'a' })))]
    const second = [user, assistant(shellPart(shell({ endCwd: 'b' })))]
    expect([currentShellCwd(first), currentShellCwd(second)]).toEqual(['a', 'b'])
  })
})

describe('shellFolder', () => {
  it('shows a project-relative folder; nothing for the project folder', () => {
    expect([null, undefined, '', '.', './', ' . '].map(shellFolder)).toEqual([null, null, null, null, null, null])
    expect(['packages/web', './packages/web', 'packages/web/', '././sub//'].map(shellFolder))
      .toEqual(['packages/web', 'packages/web', 'packages/web', 'sub'])
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
