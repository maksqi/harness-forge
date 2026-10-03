import { describe, expect, it } from 'vitest'
import { workspaceAccessSchema } from '../enums.ts'
import { LIMITS } from '../limits.ts'
import { toolSummarySchema } from './tools.ts'
import {
  editFileToolInputSchema,
  editFileToolOutputSchema,
  findFilesToolInputSchema,
  findFilesToolOutputSchema,
  listDirectoryToolInputSchema,
  listDirectoryToolOutputSchema,
  readFileToolInputSchema,
  readFileToolOutputSchema,
  searchFilesToolInputSchema,
  searchFilesToolOutputSchema,
  shellToolInputSchema,
  shellToolOutputSchema,
  WORKSPACE_LIMITS,
  WORKSPACE_TOOL_ACCESS,
  WORKSPACE_TOOL_NAMES,
  WORKSPACE_TOOL_SCHEMAS,
  workspaceDiffSchema,
  writeFileToolInputSchema,
  writeFileToolOutputSchema,
} from './workspace.ts'

const diff = {
  hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-Hello from the mock agent.', '+Hello from the workspace agent.', '\\ No newline at end of file'] }],
  added: 1,
  removed: 1,
  truncated: false,
}

describe('workspace tools (ADR-032)', () => {
  it('names the seven tools with their access and schemas', () => {
    expect(WORKSPACE_TOOL_NAMES).toEqual(['read_file', 'list_directory', 'find_files', 'search_files', 'write_file', 'edit_file', 'shell'])
    expect(Object.keys(WORKSPACE_TOOL_SCHEMAS)).toEqual([...WORKSPACE_TOOL_NAMES])
    expect(WORKSPACE_TOOL_ACCESS).toEqual({ read_file: 'read', list_directory: 'read', find_files: 'read', search_files: 'read', write_file: 'write', edit_file: 'write', shell: 'execute' })
    expect(workspaceAccessSchema.options).toEqual(['read', 'write', 'execute'])
  })

  it('keeps the limits of the design', () => {
    expect(WORKSPACE_LIMITS).toMatchObject({
      readMaxLines: 2000,
      readMaxBytes: 49_152,
      lineMaxChars: 2000,
      editFileMaxBytes: 1_048_576,
      writeContentMaxBytes: 262_144,
      editStringMaxBytes: 65_536,
      listMaxEntries: 1000,
      findMaxResults: 1000,
      findDefaultResults: 200,
      searchMaxResults: 500,
      searchDefaultResults: 100,
      searchFileMaxBytes: 1_048_576,
      commandMaxBytes: 16_384,
      shellTimeoutDefaultMs: 120_000,
      shellTimeoutMinMs: 1000,
      shellTimeoutMaxMs: 590_000,
      shellStreamHeadBytes: 4096,
      shellStreamTailBytes: 16_384,
      outputMaxBytes: 61_440,
      diffMaxBytes: 24_576,
      diffLineMaxChars: 500,
      descriptionMaxChars: 200,
    })
    // Stored outputs stay under the host cap of every tool output.
    expect(WORKSPACE_LIMITS.outputMaxBytes).toBeLessThan(LIMITS.toolOutputBytes)
    expect(WORKSPACE_LIMITS.diffMaxBytes).toBeLessThan(WORKSPACE_LIMITS.outputMaxBytes)
  })

  it('validates read_file and list_directory', () => {
    expect(readFileToolInputSchema.parse({ path: 'src/index.ts', offset: 10, limit: 50 })).toEqual({ path: 'src/index.ts', offset: 10, limit: 50 })
    for (const input of [{}, { path: '' }, { path: 'a\0b' }, { path: 'a', offset: 0 }, { path: 'a', limit: 0 }, { path: 'a', limit: 2001 }, { path: 'a', offset: 1.5 }])
      expect(readFileToolInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false)
    const read = { path: 'src/index.ts', content: 'a\nb\n', startLine: 1, endLine: 2, totalLines: 2, truncated: false }
    expect(readFileToolOutputSchema.parse(read)).toEqual(read)
    expect(readFileToolOutputSchema.parse({ ...read, totalLines: null, truncated: true }).totalLines).toBeNull()
    expect(readFileToolOutputSchema.safeParse({ ...read, startLine: 0 }).success).toBe(false)

    expect(listDirectoryToolInputSchema.parse({})).toEqual({})
    const listing = { path: '.', entries: [{ name: 'src', type: 'dir' }, { name: 'README.md', type: 'file' }, { name: 'link', type: 'symlink' }], truncated: false }
    expect(listDirectoryToolOutputSchema.parse(listing)).toEqual(listing)
    expect(listDirectoryToolOutputSchema.safeParse({ ...listing, entries: [{ name: 'x', type: 'socket' }] }).success).toBe(false)
  })

  it('validates find_files and search_files (snake_case inputs)', () => {
    const find = { pattern: '*.ts', path: 'src', include_ignored: true, max_results: 1000 }
    expect(findFilesToolInputSchema.parse(find)).toEqual(find)
    for (const input of [{}, { pattern: '' }, { pattern: 'x'.repeat(WORKSPACE_LIMITS.patternMaxChars + 1) }, { pattern: '*', max_results: 1001 }, { pattern: '*', max_results: 0 }])
      expect(findFilesToolInputSchema.safeParse(input).success, JSON.stringify(input).slice(0, 60)).toBe(false)
    expect(findFilesToolOutputSchema.parse({ pattern: '*.ts', paths: ['src/a.ts'], truncated: false })).toMatchObject({ paths: ['src/a.ts'] })

    const search = { pattern: 'TODO\\(', literal: false, case_sensitive: false, glob: '*.ts', path: '.', include_ignored: false, max_results: 500 }
    expect(searchFilesToolInputSchema.parse(search)).toEqual(search)
    for (const input of [{ pattern: '' }, { pattern: 'x', max_results: 501 }, { pattern: 'x', glob: '' }, { pattern: 'x', case_sensitive: 'no' }])
      expect(searchFilesToolInputSchema.safeParse(input).success, JSON.stringify(input)).toBe(false)
    const result = { pattern: 'TODO', matches: [{ path: 'src/a.ts', line: 3, text: '// TODO: x' }], filesSearched: 12, truncated: false }
    expect(searchFilesToolOutputSchema.parse(result)).toEqual(result)
    expect(searchFilesToolOutputSchema.safeParse({ ...result, matches: [{ path: 'a', line: 0, text: '' }] }).success).toBe(false)
  })

  it('validates write_file and edit_file (byte limits, diffs)', () => {
    expect(writeFileToolInputSchema.parse({ path: 'mock-workspace.txt', content: '' })).toEqual({ path: 'mock-workspace.txt', content: '' })
    expect(writeFileToolInputSchema.safeParse({ path: 'a', content: 'x'.repeat(WORKSPACE_LIMITS.writeContentMaxBytes) }).success).toBe(true)
    // Bytes, not characters: 'é' is 2 bytes in UTF-8.
    expect(writeFileToolInputSchema.safeParse({ path: 'a', content: 'é'.repeat(WORKSPACE_LIMITS.writeContentMaxBytes / 2 + 1) }).success).toBe(false)
    expect(writeFileToolInputSchema.safeParse({ path: 'a' }).success).toBe(false)
    const written = { path: 'mock-workspace.txt', created: true, bytes: 27, lines: 1, diff }
    expect(writeFileToolOutputSchema.parse(written)).toEqual(written)
    expect(writeFileToolOutputSchema.parse({ ...written, diff: null }).diff).toBeNull()

    const edit = { path: 'mock-workspace.txt', old_string: 'mock agent', new_string: 'workspace agent', replace_all: true }
    expect(editFileToolInputSchema.parse(edit)).toEqual(edit)
    expect(editFileToolInputSchema.parse({ ...edit, new_string: '' }).new_string).toBe('')
    for (const change of [{ old_string: '' }, { old_string: 'é'.repeat(WORKSPACE_LIMITS.editStringMaxBytes / 2 + 1) }, { new_string: 'x'.repeat(WORKSPACE_LIMITS.editStringMaxBytes + 1) }, { replace_all: 1 }])
      expect(editFileToolInputSchema.safeParse({ ...edit, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    expect(editFileToolOutputSchema.parse({ path: 'a', replacements: 2, diff })).toMatchObject({ replacements: 2 })
    expect(editFileToolOutputSchema.safeParse({ path: 'a', replacements: 0, diff }).success).toBe(false)
  })

  it('validates diffs', () => {
    expect(workspaceDiffSchema.parse(diff)).toEqual(diff)
    expect(workspaceDiffSchema.parse({ hunks: [], added: 0, removed: 0, truncated: true }).truncated).toBe(true)
    for (const change of [{ added: -1 }, { hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] }, { truncated: undefined }])
      expect(workspaceDiffSchema.safeParse({ ...diff, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('validates shell input and output (ADR-033)', () => {
    const input = { command: 'cat mock-workspace.txt', cwd: '.', timeout_ms: 300_000, description: 'Show the file' }
    expect(shellToolInputSchema.parse(input)).toEqual(input)
    expect(shellToolInputSchema.parse({ command: 'ls' })).toEqual({ command: 'ls' })
    for (const change of [
      { command: '' },
      { command: 'x'.repeat(WORKSPACE_LIMITS.commandMaxBytes + 1) },
      { timeout_ms: 999 },
      { timeout_ms: 590_001 },
      { timeout_ms: 1500.5 },
      { description: 'x'.repeat(201) },
      { cwd: '' },
    ])
      expect(shellToolInputSchema.safeParse({ ...input, ...change }).success, JSON.stringify(change).slice(0, 60)).toBe(false)
    const output = { command: 'cat x', cwd: '.', exitCode: 0, signal: null, timedOut: false, durationMs: 12, stdout: 'Hello\n', stderr: '', stdoutBytes: 6, stderrBytes: 0 }
    expect(shellToolOutputSchema.parse(output)).toEqual(output)
    expect(shellToolOutputSchema.parse({ ...output, exitCode: null, signal: 'SIGKILL', timedOut: true }).timedOut).toBe(true)
    for (const change of [{ exitCode: undefined }, { stdoutBytes: -1 }, { timedOut: null }])
      expect(shellToolOutputSchema.safeParse({ ...output, ...change }).success, JSON.stringify(change)).toBe(false)
  })

  it('adds the workspace access to tool summaries', () => {
    const tool = { name: 'edit_file', title: null, description: 'Edit a file', pluginId: 'core-workspace', mcpServerId: null, policy: null, enabled: true, override: null, available: true, inputSchema: {}, workspace: 'write' }
    expect(toolSummarySchema.parse(tool)).toEqual(tool)
    expect(toolSummarySchema.parse({ ...tool, workspace: null }).workspace).toBeNull()
    expect(toolSummarySchema.safeParse({ ...tool, workspace: 'admin' }).success).toBe(false)
    const { workspace: _workspace, ...withoutAccess } = tool
    expect(toolSummarySchema.safeParse(withoutAccess).success).toBe(false)
  })
})
