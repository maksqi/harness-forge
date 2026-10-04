import type { DefinitionDiagnostic } from './definitions.ts'
import { describe, expect, it } from 'vitest'
import { DEFINITION_LIMITS } from './definitions.ts'
import { CLAUDE_TOOL_ALIASES, matchToolAllowlist, normalizeToolList } from './tool-names.ts'

function codes(diagnostics: readonly DefinitionDiagnostic[]): string[] {
  return diagnostics.map(entry => `${entry.level}:${entry.code}`)
}

describe('cLAUDE_TOOL_ALIASES', () => {
  it('maps the Claude Code tool names to harness tools', () => {
    expect(CLAUDE_TOOL_ALIASES).toEqual({
      Read: 'read_file',
      Write: 'write_file',
      Edit: 'edit_file',
      MultiEdit: 'edit_file',
      Grep: 'search_files',
      Glob: 'find_files',
      LS: 'list_directory',
      Bash: 'shell',
      WebFetch: 'web_fetch',
    })
  })
})

describe('normalizeToolList', () => {
  it('keeps an absent value absent (no restriction)', () => {
    expect(normalizeToolList(undefined)).toEqual({ tools: null, diagnostics: [] })
    expect(normalizeToolList(null)).toEqual({ tools: null, diagnostics: [] })
  })

  it('keeps an empty list empty (no tool)', () => {
    expect(normalizeToolList([])).toEqual({ tools: [], diagnostics: [] })
    expect(normalizeToolList('')).toEqual({ tools: [], diagnostics: [] })
    expect(normalizeToolList('  ,  , ')).toEqual({ tools: [], diagnostics: [] })
  })

  it.each([
    ['Read, Grep, Glob', ['read_file', 'search_files', 'find_files']],
    ['Read,Grep,Glob', ['read_file', 'search_files', 'find_files']],
    ['Read Grep Glob', ['read_file', 'search_files', 'find_files']],
    ['Read\n  Grep\tGlob', ['read_file', 'search_files', 'find_files']],
    ['Read, Write, Edit, MultiEdit, LS, Bash, WebFetch', ['read_file', 'write_file', 'edit_file', 'list_directory', 'shell', 'web_fetch']],
    ['read_file, shell, ', ['read_file', 'shell']],
    ['TodoWrite, WebSearch, my-tool', ['TodoWrite', 'WebSearch', 'my-tool']],
    ['mcp__github__create_issue, mcp__github__*, mcp__slack', ['mcp__github__create_issue', 'mcp__github__*', 'mcp__slack']],
  ])('splits and maps the string %j', (value, tools) => {
    expect(normalizeToolList(value)).toEqual({ tools, diagnostics: [] })
  })

  it('maps lists entry by entry and trims them', () => {
    expect(normalizeToolList([' Read ', 'Grep', 'shell'])).toEqual({ tools: ['read_file', 'search_files', 'shell'], diagnostics: [] })
  })

  it('deduplicates in input order', () => {
    expect(normalizeToolList('Edit, MultiEdit, edit_file, Read, read_file').tools).toEqual(['edit_file', 'read_file'])
  })

  it('keeps the tool of a Claude Code pattern and warns once per tool', () => {
    const result = normalizeToolList('Bash(git add:*), Bash(git status:*), Read(./src/**), Grep')
    expect(result.tools).toEqual(['shell', 'read_file', 'search_files'])
    expect(codes(result.diagnostics)).toEqual(['warning:tool-pattern', 'warning:tool-pattern'])
    expect(result.diagnostics[0]?.message).toBe('Tool patterns are not supported; shell is allowed without its pattern.')
  })

  it('splits on commas outside parentheses only', () => {
    expect(normalizeToolList('Bash(npm run a, b), Read').tools).toEqual(['shell', 'read_file'])
  })

  it('does not split a single pattern with spaces on whitespace', () => {
    expect(normalizeToolList('Bash(git commit -m:*)').tools).toEqual(['shell'])
  })

  it('drops entries that are not tool names with an unknown-tool warning and their position', () => {
    const result = normalizeToolList(['Read', 'read file', 42, '*', 'foo.bar', 'Grep'])
    expect(result.tools).toEqual(['read_file', 'search_files'])
    expect(result.diagnostics.map(entry => entry.message)).toEqual([
      'Entry 2 of the tool list is not a tool name; it was dropped.',
      'Entry 3 of the tool list is not text; it was dropped.',
      'Entry 4 of the tool list is not a tool name; it was dropped.',
      'Entry 5 of the tool list is not a tool name; it was dropped.',
    ])
    expect(result.diagnostics.every(entry => entry.level === 'warning' && entry.code === 'unknown-tool')).toBe(true)
  })

  it('caps the unknown-tool diagnostics and counts the rest', () => {
    const result = normalizeToolList(Array.from({ length: 25 }, (_, index) => `bad.tool${index}`))
    expect(result.tools).toEqual([])
    expect(result.diagnostics).toHaveLength(11)
    expect(result.diagnostics.at(-1)?.message).toBe('15 more entries of the tool list were dropped.')
  })

  it('drops names longer than 64 characters (MCP prefixes may end in one more "*")', () => {
    const long = `mcp__${'a'.repeat(59)}`
    expect(normalizeToolList([long, `${long}*`, `${long}b`, 'x'.repeat(65)]).tools).toEqual([long, `${long}*`])
  })

  it('keeps at most DEFINITION_LIMITS.toolsMax entries after deduplication', () => {
    const names = Array.from({ length: 70 }, (_, index) => `tool_${index}`)
    const result = normalizeToolList([...names.slice(0, 10), ...names])
    expect(result.tools).toEqual(names.slice(0, DEFINITION_LIMITS.toolsMax))
    expect(codes(result.diagnostics)).toEqual(['warning:limit'])
    expect(normalizeToolList(names.slice(0, DEFINITION_LIMITS.toolsMax)).diagnostics).toEqual([])
  })

  it.each([[42], [true], [{ Read: true }], [Symbol('x')]])('allows no tool for the non-list value %s', (value) => {
    const result = normalizeToolList(value)
    expect(result.tools).toEqual([])
    expect(codes(result.diagnostics)).toEqual(['warning:invalid-field'])
  })

  it('never quotes an entry in a message', () => {
    const secret = 'Secret-Token-123'
    const result = normalizeToolList([`${secret}.x`, `Bash(${secret})`, `${secret} y`, 7])
    expect(result.diagnostics.length).toBeGreaterThan(0)
    for (const entry of result.diagnostics)
      expect(entry.message).not.toContain(secret)
  })
})

describe('matchToolAllowlist', () => {
  it.each([
    ['read_file', ['read_file'], true],
    ['read_file', ['write_file'], false],
    ['read_file', [], false],
    ['mcp__github__create_issue', ['mcp__github__*'], true],
    ['mcp__github__create_issue', ['mcp__github'], true],
    ['mcp__githubx__create_issue', ['mcp__github'], false],
    ['mcp__github', ['mcp__github'], true],
    ['mcp__gitlab__x', ['mcp__github__*', 'mcp__github'], false],
    ['mcp__github__a__b', ['mcp__github'], true],
    ['mcp__github__a__b', ['mcp__github__a'], false],
    ['read_file', ['read_*'], true],
    ['shell', ['*'], true],
    ['shell', ['', 'mcp__'], false],
  ] as const)('%s with %j → %s', (tool, allowlist, expected) => {
    expect(matchToolAllowlist(tool, allowlist)).toBe(expected)
  })

  it('is false for malformed input', () => {
    expect(matchToolAllowlist('', ['*'])).toBe(false)
    expect(matchToolAllowlist('shell', null as unknown as string[])).toBe(false)
    expect(matchToolAllowlist('shell', [1, null, 'shell'] as unknown as string[])).toBe(true)
  })
})
