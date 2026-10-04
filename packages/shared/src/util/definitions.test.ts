import type {
  AgentDefinitionFields,
  CommandDefinitionFields,
  CustomizationKind,
  CustomizationSource,
  DefinitionDiagnostic,
  ParsedDefinition,
  ParseDefinitionResult,
  RankedDefinition,
  SkillDefinitionFields,
} from './definitions.ts'
import { describe, expect, it } from 'vitest'
import { AGENT_NAME_PATTERN, CLIENT_COMMANDS, COMMAND_NAME_PATTERN, HARNESS_COMMANDS } from '../ids.ts'
import {
  CUSTOMIZATION_KINDS,
  DEFINITION_DIAGNOSTIC_CODES,
  DEFINITION_DIAGNOSTIC_LEVELS,
  DEFINITION_LIMITS,
  definitionRank,
  formatDefinition,
  parseDefinition,
  resolvePrecedence,
} from './definitions.ts'

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

function codes(result: ParseDefinitionResult): string[] {
  return result.diagnostics.map(entry => `${entry.level}:${entry.code}${entry.line === undefined ? '' : `@${entry.line}`}`)
}

function agent(result: ParseDefinitionResult): AgentDefinitionFields {
  expect(result.definition?.kind).toBe('agent')
  return (result.definition as Extract<ParsedDefinition, { kind: 'agent' }>).fields
}

function command(result: ParseDefinitionResult): CommandDefinitionFields {
  expect(result.definition?.kind).toBe('command')
  return (result.definition as Extract<ParsedDefinition, { kind: 'command' }>).fields
}

function skill(result: ParseDefinitionResult): SkillDefinitionFields {
  expect(result.definition?.kind).toBe('skill')
  return (result.definition as Extract<ParsedDefinition, { kind: 'skill' }>).fields
}

function md(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`
}

/** The invariants of every result: valid levels and codes, `Line N: ` prefixes, null exactly when there is an error. */
function checkResult(result: ParseDefinitionResult, kind: CustomizationKind): void {
  expect(Array.isArray(result.diagnostics)).toBe(true)
  for (const entry of result.diagnostics) {
    expect(DEFINITION_DIAGNOSTIC_LEVELS).toContain(entry.level)
    expect(DEFINITION_DIAGNOSTIC_CODES).toContain(entry.code)
    expect(typeof entry.message).toBe('string')
    expect(entry.message.length).toBeGreaterThan(0)
    if (entry.line !== undefined) {
      expect(Number.isInteger(entry.line) && entry.line >= 1).toBe(true)
      expect(entry.message.startsWith(`Line ${entry.line}: `)).toBe(true)
    }
  }
  const hasError = result.diagnostics.some(entry => entry.level === 'error')
  expect(result.definition === null).toBe(hasError)
  const definition = result.definition
  if (definition === null)
    return
  expect(definition.kind).toBe(kind)
  const fields = definition.fields
  expect((definition.kind === 'command' ? COMMAND_NAME_PATTERN : AGENT_NAME_PATTERN).test(fields.name)).toBe(true)
  expect(fields.description.length).toBeLessThanOrEqual(DEFINITION_LIMITS.descriptionMaxChars)
  if (definition.kind === 'agent')
    expect((definition.fields.tools?.length ?? 0) <= DEFINITION_LIMITS.toolsMax).toBe(true)
  if (definition.kind === 'command') {
    expect((definition.fields.allowedTools?.length ?? 0) <= DEFINITION_LIMITS.toolsMax).toBe(true)
    expect((definition.fields.argumentHint?.length ?? 0) <= DEFINITION_LIMITS.argumentHintMaxChars).toBe(true)
    expect(definition.fields.body).not.toBe('')
  }
}

function prng(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6D2B79F5) | 0
    let value = Math.imul(state ^ (state >>> 15), state | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

function picker(random: () => number): <T>(items: readonly T[]) => T {
  return <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T
}

function shuffle<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    const swap = copy[index] as T
    copy[index] = copy[other] as T
    copy[other] = swap
  }
  return copy
}

// ---------------------------------------------------------------------------------------------------------------------
// Claude Code style files

describe('parseDefinition: agents', () => {
  it('reads a Claude Code agent (comma tools, alias model, extra keys)', () => {
    const result = parseDefinition('agent', md([
      '---',
      'name: code-reviewer',
      'description: Expert code reviewer. Use proactively after writing code.',
      'tools: Read, Grep, Glob, Bash',
      'model: sonnet',
      'color: blue',
      '---',
      '',
      'You are a senior code reviewer.',
      '',
      '1. Run git diff.',
    ]), { fileName: 'code-reviewer.md' })
    expect(agent(result)).toEqual({
      name: 'code-reviewer',
      description: 'Expert code reviewer. Use proactively after writing code.',
      tools: ['read_file', 'search_files', 'find_files', 'shell'],
      model: null,
      instructions: 'You are a senior code reviewer.\n\n1. Run git diff.',
    })
    expect(codes(result)).toEqual(['info:model-alias@5', 'info:ignored-key@6'])
    expect(result.diagnostics[1]?.message).toBe('Line 6: The key "color" is ignored.')
  })

  it('reads tools as a block list or a flow list', () => {
    const block = parseDefinition('agent', md(['---', 'name: a', 'description: d', 'tools:', '  - Read', '  - mcp__github__*', '---', 'x']))
    expect(agent(block).tools).toEqual(['read_file', 'mcp__github__*'])
    const flow = parseDefinition('agent', md(['---', 'name: a', 'description: d', 'tools: [Read, Grep]', '---', 'x']))
    expect(agent(flow).tools).toEqual(['read_file', 'search_files'])
    const empty = parseDefinition('agent', md(['---', 'name: a', 'description: d', 'tools: []', '---', 'x']))
    expect(agent(empty).tools).toEqual([])
    expect(agent(parseDefinition('agent', md(['---', 'name: a', 'description: d', 'tools:', '---']))).tools).toBeNull()
  })

  it('adds the line to tool list diagnostics', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', 'tools: Read, Bash(git:*), bad.tool', '---', 'x']))
    expect(agent(result).tools).toEqual(['read_file', 'shell'])
    expect(codes(result)).toEqual(['warning:tool-pattern@4', 'warning:unknown-tool@4'])
    expect(result.diagnostics[1]?.message).toBe('Line 4: Entry 3 of the tool list is not a tool name; it was dropped.')
  })

  it.each([
    ['inherit', 'inherit', []],
    ['Inherit', 'inherit', []],
    ['mock:echo', 'mock:echo', []],
    ['ollama:llama3:8b', 'ollama:llama3:8b', []],
    ['openrouter:anthropic/claude-sonnet-5', 'openrouter:anthropic/claude-sonnet-5', []],
    ['sonnet', null, ['info:model-alias@4']],
    ['opus', null, ['info:model-alias@4']],
    ['haiku', null, ['info:model-alias@4']],
    ['claude-3-5-sonnet-20241022', null, ['info:model-alias@4']],
    ['gpt-4o', null, ['warning:invalid-model@4']],
    ['"openai:gpt 5"', null, ['warning:invalid-model@4']],
    ['"Bad Provider:x"', null, ['warning:invalid-model@4']],
    [':x', null, ['warning:invalid-model@4']],
    ['5', null, ['warning:invalid-model@4']],
    ['""', null, []],
    ['', null, []],
  ] as const)('reads model %j', (raw, model, expected) => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', `model: ${raw}`, '---', 'x']))
    expect(agent(result).model).toBe(model)
    expect(codes(result)).toEqual(expected)
  })

  it('requires a description', () => {
    const missing = parseDefinition('agent', md(['---', 'name: a', '---', 'x']))
    expect(missing.definition).toBeNull()
    expect(missing.diagnostics).toEqual([{ level: 'error', code: 'missing-field', message: 'Add a description.' }])
    expect(codes(parseDefinition('agent', md(['---', 'name: a', 'description: "  "', '---'])))).toEqual(['error:missing-field@3'])
    expect(codes(parseDefinition('agent', md(['---', 'name: a', 'description: [a, b]', '---'])))).toEqual(['error:invalid-field@3'])
    expect(codes(parseDefinition('agent', md(['---', 'name: a', 'description: 42', '---'])))).toEqual(['error:invalid-field@3'])
  })

  it('cuts a long description with a warning (never inside a surrogate pair)', () => {
    const long = parseDefinition('agent', md(['---', 'name: a', `description: ${'x'.repeat(2000)}`, '---']))
    expect(agent(long).description).toBe('x'.repeat(DEFINITION_LIMITS.descriptionMaxChars))
    expect(codes(long)).toEqual(['warning:invalid-field@3'])
    const emoji = parseDefinition('agent', md(['---', 'name: a', `description: ${'x'.repeat(1023)}😀😀`, '---']))
    expect(agent(emoji).description).toBe('x'.repeat(1023))
  })

  it('allows empty instructions', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', '---']))
    expect(agent(result).instructions).toBe('')
    expect(result.diagnostics).toEqual([])
  })

  it.each(['explore', 'general', 'general-purpose', 'Explore', ' GENERAL '])('reserves the builtin name %j', (name) => {
    const result = parseDefinition('agent', md(['---', `name: "${name}"`, 'description: d', '---']))
    expect(result.definition).toBeNull()
    expect(codes(result)).toEqual(['error:reserved-name@2'])
    expect(result.diagnostics[0]?.message).toBe(`Line 2: ${name.trim().toLowerCase()} is a built-in name.`)
  })

  it('reserves builtin names taken from the file name too', () => {
    expect(codes(parseDefinition('agent', md(['---', 'description: d', '---']), { fileName: 'explore.md' }))).toEqual(['error:reserved-name'])
  })
})

describe('parseDefinition: names', () => {
  it.each([
    ['name: Code-Reviewer', 'code-reviewer'],
    ['name: "  spaced  "', 'spaced'],
    ['name: a', 'a'],
    [`name: a${'b'.repeat(63)}`, `a${'b'.repeat(63)}`],
  ])('normalizes %j', (line, name) => {
    expect(agent(parseDefinition('agent', md(['---', line, 'description: d', '---']))).name).toBe(name)
  })

  it.each([
    ['name: code_reviewer'],
    ['name: 1abc'],
    ['name: -abc'],
    ['name: a b'],
    [`name: a${'b'.repeat(64)}`],
    ['name: "é"'],
  ])('rejects %j', (line) => {
    const result = parseDefinition('agent', md(['---', line, 'description: d', '---']))
    expect(codes(result)).toEqual(['error:invalid-name@2'])
    expect(result.diagnostics[0]?.message).toBe('Line 2: Names use lowercase letters, digits and hyphens (a letter first, at most 64 characters).')
  })

  it('rejects a name that is not text', () => {
    expect(codes(parseDefinition('agent', md(['---', 'name: 123', 'description: d', '---'])))).toEqual(['error:invalid-field@2'])
    expect(codes(parseDefinition('agent', md(['---', 'name: [a]', 'description: d', '---'])))).toEqual(['error:invalid-field@2'])
    expect(codes(parseDefinition('agent', md(['---', 'name: true', 'description: d', '---'])))).toEqual(['error:invalid-field@2'])
  })

  it('falls back to the file stem (agents, commands) or the folder name (skills)', () => {
    expect(agent(parseDefinition('agent', md(['---', 'description: d', '---']), { fileName: 'Reviewer.md' })).name).toBe('reviewer')
    expect(agent(parseDefinition('agent', md(['---', 'name:', 'description: d', '---']), { fileName: '.harness/agents/Helper.md' })).name).toBe('helper')
    expect(codes(parseDefinition('agent', md(['---', 'description: d', '---']), { fileName: 'a.b.md' }))).toEqual(['error:invalid-name'])
    expect(command(parseDefinition('command', 'Do it.\n', { fileName: 'git/commit.md' })).name).toBe('commit')
    expect(skill(parseDefinition('skill', md(['---', 'description: d', '---', 'x']), { folderName: '.claude/skills/pdf-tools/' })).name).toBe('pdf-tools')
    expect(skill(parseDefinition('skill', md(['---', 'description: d', '---', 'x']), { fileName: 'ignored.md', folderName: 'kept' })).name).toBe('kept')
  })

  it('reports a file name that is not a valid name', () => {
    const result = parseDefinition('command', 'Do it.\n', { fileName: 'Fix Bug.md' })
    expect(result.diagnostics).toEqual([{
      level: 'error',
      code: 'invalid-name',
      message: 'The file name is not a valid name; add a name that uses lowercase letters, digits and hyphens (a letter first, at most 32 characters).',
    }])
    expect(parseDefinition('skill', md(['---', 'description: d', '---']), { folderName: 'pdf_tools' }).diagnostics[0]?.message)
      .toBe('The folder name is not a valid name; add a name that uses lowercase letters, digits and hyphens (a letter first, at most 64 characters).')
  })

  it('requires a name when there is no file or folder name', () => {
    for (const kind of CUSTOMIZATION_KINDS) {
      const result = parseDefinition(kind, md(['---', 'description: d', '---', 'x']))
      expect(result.definition).toBeNull()
      expect(result.diagnostics).toContainEqual({ level: 'error', code: 'missing-field', message: 'Add a name.' })
    }
    expect(codes(parseDefinition('skill', md(['---', 'description: d', '---', 'x']), { fileName: 'SKILL.md' }))).toEqual(['error:missing-field'])
  })
})

describe('parseDefinition: commands', () => {
  it('reads a Claude Code command with a bracket argument hint (no YAML fallback)', () => {
    const result = parseDefinition('command', md([
      '---',
      'allowed-tools: Bash(git add:*), Bash(git status:*), Bash(git commit:*)',
      'argument-hint: [pr-number] [priority] [assignee]',
      'description: Review a pull request',
      'model: mock:echo',
      '---',
      '',
      'Review PR #$1 with priority $2 and assign to $3.',
    ]), { fileName: 'review-pr.md' })
    expect(command(result)).toEqual({
      name: 'review-pr',
      description: 'Review a pull request',
      argumentHint: '[pr-number] [priority] [assignee]',
      model: 'mock:echo',
      allowedTools: ['shell'],
      body: 'Review PR #$1 with priority $2 and assign to $3.',
    })
    expect(codes(result)).toEqual(['warning:tool-pattern@2'])
  })

  it.each([
    ['argument-hint: [message]', '[message]'],
    ['argument-hint: [a, b]', '[a, b]'],
    ['argument-hint: {x}', '{x}'],
    ['argument-hint: "[pr-number] [priority]"', '[pr-number] [priority]'],
    ['argument-hint: \'<file> [focus]\'', '<file> [focus]'],
    ['argument-hint: <file> [focus]', '<file> [focus]'],
    ['argument-hint: add [tagId] | remove [tagId] | list', 'add [tagId] | remove [tagId] | list'],
    ['argument-hint: 42', '42'],
    ['argument-hint: ""', null],
    ['argument-hint:', null],
  ])('reads %j', (line, hint) => {
    const result = parseDefinition('command', md(['---', 'description: d', line, '---', 'x']), { fileName: 'c.md' })
    expect(command(result).argumentHint).toBe(hint)
    expect(result.diagnostics).toEqual([])
  })

  it('collapses whitespace in the argument hint and cuts it with a warning', () => {
    const block = parseDefinition('command', md(['---', 'argument-hint: |', '  <a>', '  <b>', '---', 'x']), { fileName: 'c.md' })
    expect(command(block).argumentHint).toBe('<a> <b>')
    const long = parseDefinition('command', md(['---', `argument-hint: ${'h'.repeat(150)}`, '---', 'x']), { fileName: 'c.md' })
    expect(command(long).argumentHint).toBe('h'.repeat(DEFINITION_LIMITS.argumentHintMaxChars))
    expect(codes(long)).toEqual(['warning:invalid-field@2'])
  })

  it('drops a non-text argument hint without a raw line', () => {
    const result = parseDefinition('command', md(['---', '"argument-hint": [a]', '---', 'x']), { fileName: 'c.md' })
    expect(command(result).argumentHint).toBeNull()
    expect(codes(result)).toEqual(['warning:invalid-field@2'])
  })

  it('reads a command file without frontmatter', () => {
    const result = parseDefinition('command', '# Fix the failing test\n\nFix $ARGUMENTS and run the suite.\n', { fileName: 'fix-test.md' })
    expect(command(result)).toEqual({
      name: 'fix-test',
      description: 'Fix the failing test',
      argumentHint: null,
      model: null,
      allowedTools: null,
      body: '# Fix the failing test\n\nFix $ARGUMENTS and run the suite.',
    })
    expect(result.diagnostics).toEqual([])
  })

  it('falls back to the first body line, cut to 120 characters', () => {
    const result = parseDefinition('command', md(['---', 'model: mock:echo', '---', '', '   ', `  ${'w'.repeat(200)}  `, 'second']), { fileName: 'c.md' })
    expect(command(result).description).toBe('w'.repeat(120))
  })

  it('needs a body', () => {
    const result = parseDefinition('command', md(['---', 'description: d', '---', '', '  ']), { fileName: 'c.md' })
    expect(result.definition).toBeNull()
    expect(result.diagnostics).toEqual([{ level: 'error', code: 'missing-field', message: 'Add the prompt below the frontmatter.' }])
    expect(codes(parseDefinition('command', '', { fileName: 'c.md' }))).toEqual(['error:missing-field'])
  })

  it('does not inherit a model and ignores agent keys', () => {
    const result = parseDefinition('command', md(['---', 'model: inherit', 'tools: Read', 'disable-model-invocation: true', '---', 'x']), { fileName: 'c.md' })
    expect(command(result)).toMatchObject({ model: null, allowedTools: null })
    expect(codes(result)).toEqual(['info:invalid-model@2', 'info:ignored-key@3', 'info:ignored-key@4'])
    expect(result.diagnostics[1]?.message).toBe('Line 3: The key "tools" is ignored; commands use "allowed-tools".')
  })

  it.each([...CLIENT_COMMANDS, ...HARNESS_COMMANDS])('reserves /%s', (name) => {
    const result = parseDefinition('command', md(['---', `name: ${name}`, '---', 'x']))
    expect(codes(result)).toEqual(['error:reserved-name@2'])
    expect(codes(parseDefinition('command', 'x\n', { fileName: `${name}.md` }))).toEqual(['error:reserved-name'])
  })

  it('limits command names to 32 characters', () => {
    expect(command(parseDefinition('command', 'x', { fileName: `a${'b'.repeat(31)}.md` })).name).toHaveLength(32)
    expect(codes(parseDefinition('command', 'x', { fileName: `a${'b'.repeat(32)}.md` }))).toEqual(['error:invalid-name'])
  })

  it('does not treat "explore" as reserved for commands or skills', () => {
    expect(command(parseDefinition('command', 'x', { fileName: 'explore.md' })).name).toBe('explore')
    expect(skill(parseDefinition('skill', md(['---', 'name: general', 'description: d', '---', 'x']))).name).toBe('general')
  })
})

describe('parseDefinition: skills', () => {
  it('reads a Claude Code SKILL.md (ignored keys, block description)', () => {
    const result = parseDefinition('skill', md([
      '---',
      'name: pdf',
      'description: |',
      '  Extract text and tables from PDF files.',
      '  Use when the user mentions PDFs.',
      'license: Complete terms in LICENSE.txt',
      'allowed-tools: Read, Bash',
      'metadata:',
      '  version: 1',
      '---',
      '# PDF processing',
      '',
      'Use pypdf.',
    ]), { folderName: 'pdf' })
    expect(skill(result)).toEqual({
      name: 'pdf',
      description: 'Extract text and tables from PDF files.\nUse when the user mentions PDFs.',
      content: '# PDF processing\n\nUse pypdf.',
    })
    expect(codes(result)).toEqual(['info:ignored-key@6', 'info:ignored-key@7', 'info:ignored-key@8'])
  })

  it('warns about an empty skill and requires a description', () => {
    const empty = parseDefinition('skill', md(['---', 'name: a', 'description: d', '---']))
    expect(skill(empty).content).toBe('')
    expect(empty.diagnostics).toEqual([{ level: 'warning', code: 'missing-field', message: 'The skill has no instructions below the frontmatter.' }])
    expect(codes(parseDefinition('skill', '# Only a body\n', { folderName: 'a' }))).toEqual(['error:missing-field'])
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Text handling

describe('parseDefinition: text handling', () => {
  const lf = md(['---', 'name: a', 'description: "Use when: asked"', 'tools: Read', '---', '', 'Line one', '', 'Line two'])

  it('strips a BOM and normalizes CRLF and CR line breaks', () => {
    const expected = parseDefinition('agent', lf)
    expect(expected.diagnostics).toEqual([])
    expect(parseDefinition('agent', `\uFEFF${lf.replace(/\n/g, '\r\n')}`)).toEqual(expected)
    expect(parseDefinition('agent', lf.replace(/\n/g, '\r'))).toEqual(expected)
    expect(agent(expected).instructions).toBe('Line one\n\nLine two')
  })

  it('reads frontmatter only at byte 0', () => {
    const late = parseDefinition('command', `\n${md(['---', 'description: d', '---', 'x'])}`, { fileName: 'c.md' })
    expect(command(late).body).toBe('---\ndescription: d\n---\nx')
    const spaced = parseDefinition('command', md(['--- ', 'description: d', '---', 'x']), { fileName: 'c.md' })
    expect(command(spaced).body.startsWith('--- ')).toBe(true)
  })

  it('ends the frontmatter at the first --- or ... line and keeps later --- lines in the body', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', '...', '---', 'name: b', '---', 'tail']))
    expect(agent(result)).toMatchObject({ name: 'a', instructions: '---\nname: b\n---\ntail' })
    const indented = parseDefinition('agent', md(['---', 'name: a', 'description: |', '  ---', '  x', '---', 'body']))
    expect(agent(indented)).toMatchObject({ description: '---\nx', instructions: 'body' })
  })

  it('reads an empty frontmatter and a frontmatter of comments', () => {
    expect(command(parseDefinition('command', md(['---', '---', 'x']), { fileName: 'c.md' })).name).toBe('c')
    expect(codes(parseDefinition('command', '---\n---', { fileName: 'c.md' }))).toEqual(['error:missing-field'])
    expect(parseDefinition('command', md(['---', '# a comment', '---', 'x']), { fileName: 'c.md' }).diagnostics).toEqual([])
  })

  it('reports an unclosed frontmatter', () => {
    for (const text of ['---\nname: a\ndescription: d\n', '---\n', '---\n--- \n']) {
      expect(parseDefinition('agent', text).diagnostics).toEqual([{
        level: 'error',
        code: 'invalid-frontmatter',
        message: 'Line 1: The frontmatter is not closed; add a line with three dashes after it.',
        line: 1,
      }])
    }
  })

  it('keeps quoted colons, block scalars and plain multi-line values', () => {
    const result = parseDefinition('agent', md([
      '---',
      'name: \'a\'',
      'description: >',
      '  Folded',
      '  text: with colon',
      'model: "mock:echo"',
      '---',
    ]))
    expect(agent(result)).toMatchObject({ description: 'Folded text: with colon', model: 'mock:echo' })
    const plain = parseDefinition('agent', md(['---', 'name: a', 'description: first', '  second', '---']))
    expect(agent(plain).description).toBe('first second')
  })

  it('removes leading blank lines and trailing whitespace of the body only', () => {
    const result = parseDefinition('agent', `---\nname: a\ndescription: d\n---\n\n \t\n    code block\n\ntext  \n\n\n`)
    expect(agent(result).instructions).toBe('    code block\n\ntext')
  })

  it('keeps YAML 1.1 tags and timestamps as plain values', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: !!binary aGVsbG8=', 'model: !!timestamp 2024-01-01', 'x: !!set {a, b}', '---']))
    expect(agent(result)).toMatchObject({ description: 'aGVsbG8=', model: null })
    expect(codes(result)).toEqual(['warning:invalid-model@4', 'info:ignored-key@5'])
  })

  it('never lets a __proto__ key reach a prototype', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', '__proto__: {polluted: true}', '---']))
    expect(agent(result).name).toBe('a')
    expect(codes(result)).toEqual(['info:ignored-key@4'])
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('caps the ignored-key diagnostics', () => {
    const keys = Array.from({ length: 30 }, (_, index) => `extra-${index}: v`)
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', ...keys, '---']))
    expect(result.diagnostics).toHaveLength(21)
    expect(result.diagnostics.at(-1)).toEqual({ level: 'info', code: 'ignored-key', message: '10 more keys are ignored.' })
  })

  it('cuts long key names in messages', () => {
    const key = `k${'x'.repeat(200)}`
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: d', `${key}: v`, '---']))
    expect(result.diagnostics[0]?.message).toBe(`Line 4: The key "${key.slice(0, 64)}" is ignored.`)
  })
})

describe('parseDefinition: invalid YAML', () => {
  it('reads a Claude Code description with an unquoted colon line by line (warning with the line)', () => {
    const result = parseDefinition('agent', md([
      '---',
      'name: test-runner',
      'description: Use this agent when tests fail. Examples: <example>Context: the user ran tests\\n</example>',
      'tools:',
      '  - Read',
      '  - "Bash"',
      'model: inherit',
      '---',
      'Run the tests.',
    ]))
    expect(agent(result)).toEqual({
      name: 'test-runner',
      description: 'Use this agent when tests fail. Examples: <example>Context: the user ran tests\\n</example>',
      tools: ['read_file', 'shell'],
      model: 'inherit',
      instructions: 'Run the tests.',
    })
    expect(result.diagnostics).toEqual([{
      level: 'warning',
      code: 'invalid-frontmatter',
      message: 'Line 3: The frontmatter is not valid YAML; it was read line by line.',
      line: 3,
    }])
  })

  it('reads block scalars, quotes and repeated keys in the line reader', () => {
    const result = parseDefinition('agent', md([
      '---',
      'name: "a"',
      'name: b',
      'description: |',
      '  first: line',
      '',
      '  second',
      'tools: \'Read, Grep\'',
      'model: mock:echo',
      '---',
    ]))
    expect(agent(result)).toMatchObject({ name: 'a', description: 'first: line\n\nsecond', tools: ['read_file', 'search_files'], model: 'mock:echo' })
    expect(codes(result)).toEqual(['warning:invalid-frontmatter@3'])
  })

  it('refuses every alias (falls back to the line reader, never expands)', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description: &d hello', 'model: *d', '---']))
    expect(agent(result)).toMatchObject({ description: '&d hello', model: null })
    expect(codes(result)).toEqual(['warning:invalid-frontmatter', 'warning:invalid-model@4'])
  })

  it('refuses merge keys', () => {
    const result = parseDefinition('agent', md(['---', 'base: &b {description: d}', 'name: a', '<<: *b', '---']))
    expect(result.definition).toBeNull()
    expect(codes(result)).toContain('error:missing-field')
  })

  it.each([
    ['a scalar', 'hello'],
    ['a list', '- a\n- b'],
    ['a null document', '~'],
  ])('reports a frontmatter that is %s and has no key lines', (_label, frontmatter) => {
    const result = parseDefinition('agent', `---\n${frontmatter}\n---\nbody`, { fileName: 'a.md' })
    expect(result.definition).toBeNull()
    expect(result.diagnostics.map(entry => entry.code)).toEqual(['invalid-frontmatter'])
    expect(result.diagnostics[0]?.level).toBe('error')
  })

  it('reads other valid YAML mappings (flow, indented)', () => {
    for (const frontmatter of ['{name: a, description: d}', '  name: a\n  description: d']) {
      const result = parseDefinition('agent', `---\n${frontmatter}\n---\nbody`)
      expect(agent(result)).toMatchObject({ name: 'a', description: 'd' })
      expect(result.diagnostics).toEqual([])
    }
  })

  it('reads a nested mapping under a known key as an invalid value', () => {
    const result = parseDefinition('agent', md(['---', 'name: a', 'description:', '  text: x', 'oops: : :', '---']))
    expect(codes(result)).toEqual(['warning:invalid-frontmatter@5', 'error:invalid-field@3', 'info:ignored-key@5'])
  })
})

describe('parseDefinition: limits', () => {
  it('refuses text over the byte cap before parsing', () => {
    const head = '---\nname: a\ndescription: d\n---\n'
    const exact = `${head}${'x'.repeat(DEFINITION_LIMITS.contentBytes - head.length)}`
    expect(exact.length).toBe(DEFINITION_LIMITS.contentBytes)
    expect(parseDefinition('agent', exact).definition).not.toBeNull()
    const over = parseDefinition('agent', `${exact}x`)
    expect(over.diagnostics).toEqual([{ level: 'error', code: 'too-large', message: 'The file is larger than 64 KiB.' }])
  })

  it('counts UTF-8 bytes', () => {
    const body = 'é'.repeat(DEFINITION_LIMITS.contentBytes / 2)
    expect(codes(parseDefinition('command', body, { fileName: 'c.md' }))).toEqual([])
    expect(codes(parseDefinition('command', `${body}é`, { fileName: 'c.md' }))).toEqual(['error:too-large'])
    expect(codes(parseDefinition('command', '😀'.repeat(DEFINITION_LIMITS.contentBytes / 4 + 1), { fileName: 'c.md' }))).toEqual(['error:too-large'])
  })

  it('applies a lower maxBytes and never a higher one', () => {
    expect(parseDefinition('command', 'x'.repeat(101), { fileName: 'c.md', maxBytes: 100 }).diagnostics)
      .toEqual([{ level: 'error', code: 'too-large', message: 'The file is larger than 100 bytes.' }])
    expect(codes(parseDefinition('command', 'x'.repeat(100), { fileName: 'c.md', maxBytes: 100 }))).toEqual([])
    expect(codes(parseDefinition('command', 'x'.repeat(70_000), { fileName: 'c.md', maxBytes: 1e9 }))).toEqual(['error:too-large'])
    expect(codes(parseDefinition('command', 'x', { fileName: 'c.md', maxBytes: Number.NaN }))).toEqual([])
    expect(codes(parseDefinition('command', 'x', { fileName: 'c.md', maxBytes: -5 }))).toEqual(['error:too-large'])
  })

  it('refuses a frontmatter over 8 KiB', () => {
    const big = `---\nname: a\ndescription: ${'d'.repeat(DEFINITION_LIMITS.frontmatterBytes)}\n---\nbody`
    expect(parseDefinition('agent', big).diagnostics).toEqual([{
      level: 'error',
      code: 'too-large',
      message: 'Line 1: The frontmatter is larger than 8 KiB.',
      line: 1,
    }])
  })

  it('refuses a NUL character in the first 8 KiB only', () => {
    expect(parseDefinition('command', 'abc\0def', { fileName: 'c.md' }).diagnostics)
      .toEqual([{ level: 'error', code: 'binary', message: 'The file is binary (it contains a NUL character).' }])
    const late = `${'x'.repeat(9000)}\0tail`
    expect(command(parseDefinition('command', late, { fileName: 'c.md' })).body).toBe(late)
  })

  it('reports an unknown kind and non-string text without throwing', () => {
    expect(codes(parseDefinition('macro' as CustomizationKind, 'x'))).toEqual(['error:invalid-field'])
    expect(codes(parseDefinition('command', 42 as unknown as string, { fileName: 'c.md' }))).toEqual(['error:missing-field'])
  })
})

describe('parseDefinition: messages', () => {
  it('never quotes values or bodies', () => {
    const secret = 'SecretToken'
    const files = [
      md(['---', `name: ${secret}_x`, `description: ${secret}: oops`, `tools: ${secret}.x, Bash(${secret})`, `model: ${secret}`, `argument-hint: [${secret}`, '---']),
      md(['---', `name: a`, `description: [${secret}]`, `model: ${secret}:${secret} x`, '---', secret]),
      md(['---', `${secret}`, '---', secret]),
      `---\n${secret}: [\n`,
      md(['---', 'name: a', `description: ${'x'.repeat(1100)}${secret}`, `argument-hint: ${secret.repeat(20)}`, '---', secret]),
    ]
    for (const kind of CUSTOMIZATION_KINDS) {
      for (const text of files) {
        for (const entry of parseDefinition(kind, text, { fileName: `${secret}.md`, folderName: secret }).diagnostics)
          expect(entry.message).not.toContain(secret)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Fuzzing

const FUZZ_UNITS = ['-', '-', '-', '\n', '\n', ':', ' ', ' ', '\t', '#', '"', '\'', '[', ']', '{', '}', ',', '&', '*', '!', '|', '>', '%', '@', '`', '?', '\\', 'a', 'b', 'n', '1', '\r', '\0', '\uFEFF', '\uD800', '\uDC00', 'é', '😀', 'name', 'description', 'tools', 'model', 'argument-hint', 'allowed-tools', '---\n', '...\n', '&a [x]', '*a', '<<: *a']

function randomText(random: () => number, maxUnits: number): string {
  const pick = picker(random)
  const count = Math.floor(random() * (maxUnits + 1))
  let text = random() < 0.6 ? '---\n' : ''
  for (let index = 0; index < count; index++)
    text += pick(FUZZ_UNITS)
  return text
}

function randomCodeUnits(random: () => number, maxLength: number): string {
  const length = Math.floor(random() * (maxLength + 1))
  let text = ''
  for (let index = 0; index < length; index++)
    text += String.fromCharCode(Math.floor(random() * (random() < 0.8 ? 128 : 0x10000)))
  return text
}

describe('parseDefinition: fuzzing', () => {
  it('never throws on random token soups and keeps its invariants', () => {
    const random = prng(0xC29)
    for (let iteration = 0; iteration < 1500; iteration++) {
      const text = randomText(random, 60)
      for (const kind of CUSTOMIZATION_KINDS)
        checkResult(parseDefinition(kind, text, { fileName: 'fuzz.md', folderName: 'fuzz' }), kind)
    }
  })

  it('never throws on random code units', () => {
    const random = prng(20261004)
    for (let iteration = 0; iteration < 500; iteration++) {
      const text = randomCodeUnits(random, 400)
      for (const kind of CUSTOMIZATION_KINDS) {
        checkResult(parseDefinition(kind, text, { fileName: 'fuzz.md', folderName: 'fuzz' }), kind)
        checkResult(parseDefinition(kind, `---\n${text}\n---\n${text}`, { fileName: 'fuzz.md', folderName: 'fuzz' }), kind)
      }
    }
  })

  it('never throws on random frontmatter lines', () => {
    const random = prng(7)
    const pick = picker(random)
    const keys = ['name', 'description', 'tools', 'model', 'argument-hint', 'allowed-tools', 'color', '  - x', '-', '"q"', '? k']
    const values = ['', 'a', 'Read, Grep', '[a] [b]', '[a, b]', '{a: 1}', '|', '>-', '&x v', '*x', '"unterminated', '\'q\'', 'x: y', 'mock:echo', 'sonnet', '!!binary aGk=', '~', 'null', 'true', '42']
    for (let iteration = 0; iteration < 1500; iteration++) {
      const lines = Array.from({ length: Math.floor(random() * 8) }, () => `${pick(keys)}: ${pick(values)}`)
      const text = `---\n${lines.join('\n')}\n---\n${pick(['', 'body', '$ARGUMENTS'])}`
      for (const kind of CUSTOMIZATION_KINDS)
        checkResult(parseDefinition(kind, text, { fileName: 'fuzz.md', folderName: 'fuzz' }), kind)
    }
  })

  it('survives alias bombs without expanding them', () => {
    const levels = ['a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]']
    for (let level = 1; level < 9; level++) {
      const previous = String.fromCharCode(96 + level)
      const current = String.fromCharCode(97 + level)
      levels.push(`${current}: &${current} [${Array.from({ length: 9 }).fill(`*${previous}`).join(',')}]`)
    }
    const text = `---\nname: bomb\ndescription: *i\n${levels.join('\n')}\n---\nbody`
    const started = Date.now()
    const result = parseDefinition('agent', text)
    expect(Date.now() - started).toBeLessThan(2000)
    checkResult(result, 'agent')
    expect(agent(result).description).toBe('*i')
    expect(JSON.stringify(result).length).toBeLessThan(10_000)
  })

  it('survives deep nesting', () => {
    for (const text of [
      `---\nname: a\ndescription: ${'['.repeat(10_000)}\n---\n`,
      `---\nname: a\ndescription: d\nx: ${'['.repeat(4000)}${']'.repeat(4000)}\n---\n`,
      `---\nname: a\ndescription: d\nx: ${'{a: '.repeat(1500)}\n---\n`,
      `---\nname: a\ndescription: d\n${Array.from({ length: 120 }, (_, depth) => `${' '.repeat(depth)}k${depth}:`).join('\n')}\n---\n`,
      `---\nname: a\ndescription: d\n---\n${'['.repeat(10_000)}`,
    ]) {
      const result = parseDefinition('agent', text)
      checkResult(result, 'agent')
    }
    expect(codes(parseDefinition('agent', `---\nname: a\ndescription: ${'['.repeat(10_000)}\n---\n`))).toEqual(['error:too-large@1'])
  })

  it('survives huge lines', () => {
    const value = 'v'.repeat(DEFINITION_LIMITS.frontmatterBytes - 40)
    checkResult(parseDefinition('agent', `---\nname: a\ndescription: d\nx: ${value}\n---\n`), 'agent')
    checkResult(parseDefinition('agent', `---\nname: a\ndescription: d\na${' '.repeat(7000)}b\n---\n`), 'agent')
    const body = 'b'.repeat(DEFINITION_LIMITS.contentBytes - 100)
    expect(command(parseDefinition('command', body, { fileName: 'c.md' })).description).toBe('b'.repeat(120))
  })

  it('handles duplicate keys and non-mapping YAML without throwing', () => {
    for (const text of ['---\nname: a\nname: a\n---\nx', '---\n- name: a\n---\nx', '---\n"just text"\n---\nx', '---\n[1, 2]\n---\nx', '---\n? [a]\n: b\n---\nx']) {
      for (const kind of CUSTOMIZATION_KINDS)
        checkResult(parseDefinition(kind, text, { fileName: 'fuzz.md', folderName: 'fuzz' }), kind)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// formatDefinition

describe('formatDefinition', () => {
  it('writes the keys in order, omits nulls and lists tools', () => {
    expect(formatDefinition({
      kind: 'agent',
      fields: { name: 'reviewer', description: 'Reviews code: carefully', tools: ['read_file', 'mcp__github__*'], model: 'inherit', instructions: '\n\nReview it.\n\n' },
    })).toBe('---\nname: reviewer\ndescription: "Reviews code: carefully"\ntools:\n  - read_file\n  - mcp__github__*\nmodel: inherit\n---\n\nReview it.\n')
    expect(formatDefinition({
      kind: 'agent',
      fields: { name: 'a', description: 'd', tools: [], model: null, instructions: '' },
    })).toBe('---\nname: a\ndescription: d\ntools: []\n---\n')
  })

  it('writes command keys with their file names', () => {
    expect(formatDefinition({
      kind: 'command',
      fields: { name: 'review-pr', description: 'Review a PR', argumentHint: '[pr-number] [priority]', model: 'mock:echo', allowedTools: ['shell'], body: 'Review #$1.' },
    })).toBe('---\nname: review-pr\ndescription: Review a PR\nargument-hint: "[pr-number] [priority]"\nmodel: mock:echo\nallowed-tools:\n  - shell\n---\n\nReview #$1.\n')
    expect(formatDefinition({
      kind: 'command',
      fields: { name: 'c', description: 'd', argumentHint: null, model: null, allowedTools: null, body: 'x' },
    })).toBe('---\nname: c\ndescription: d\n---\n\nx\n')
  })

  it('writes skills and never folds long lines', () => {
    const description = `${'word '.repeat(60)}end`
    expect(formatDefinition({ kind: 'skill', fields: { name: 'pdf', description, content: '# PDF\r\nUse it.' } }))
      .toBe(`---\nname: pdf\ndescription: ${description}\n---\n\n# PDF\nUse it.\n`)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Round trip

const DESCRIPTION_UNITS = ['a', 'b', 'Z', '1', ' ', ' ', ':', ': ', ' #', '#', '"', '\'', '[', ']', '{', '}', ',', '-', '- ', '*', '&', '!', '|', '>', '%', '@', '`', '\\', '\n', '\n\n', ' \n', '\t', 'é', '日本', '😀', '---', '\n---\n', '...', '\u0001', '\u0000', '\r', 'true', 'null', '0x1', '~', '<<']
const TOOL_POOL = ['read_file', 'write_file', 'shell', 'search_files', 'mcp__github__create_issue', 'mcp__github__*', 'mcp__slack', 'TodoWrite', 'true', '123', 'null', 'my-tool', 'a_b', 'yes', 'on']
const MODEL_POOL = ['mock:echo', 'ollama:llama3:8b', 'openrouter:anthropic/claude-sonnet-5', 'openai:gpt-5#x', 'a:b:c', 'x:-1']
const HINT_POOL = ['[pr-number]', '[priority]', '<file>', '[focus]', '#123', 'a:b', '"quoted"', '\'single\'', '{x}', '--flag', '*', '&anchor', '!tag', '|', '>', '%', '@me', '- item', 'a: b']
const BODY_LINES = ['Do the thing.', '---', '...', '# Heading', '$ARGUMENTS', '$1 and $2', '{{input}}', '  indented', '\tTabbed', '', '', '!git status', '@src/a.ts', 'key: value', '```', '- [ ] todo', 'é 😀', '<background-task>', '  ']

function randomDescription(random: () => number): string {
  const pick = picker(random)
  let text = ''
  const count = 1 + Math.floor(random() * 30)
  for (let index = 0; index < count; index++)
    text += pick(DESCRIPTION_UNITS)
  text = text.trim()
  return text === '' ? 'x' : text
}

function randomName(random: () => number, max: number, reserved: (name: string) => boolean): string {
  const pick = picker(random)
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')
  let name = pick('abcdefghijklmnopqrstuvwxyz'.split(''))
  const length = Math.floor(random() * Math.min(max, 20))
  for (let index = 0; index < length; index++)
    name += pick(alphabet)
  return reserved(name) ? `x${name}`.slice(0, max) : name
}

function randomBody(random: () => number, nonEmpty: boolean): string {
  const pick = picker(random)
  const lines = Array.from({ length: Math.floor(random() * 8) }, () => pick(BODY_LINES))
  const body = lines.join('\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd()
  return body === '' && nonEmpty ? 'Do it.' : body
}

function randomTools(random: () => number): string[] | null {
  if (random() < 0.3)
    return null
  return [...new Set(Array.from({ length: Math.floor(random() * 6) }, () => picker(random)(TOOL_POOL)))]
}

function randomHint(random: () => number): string | null {
  if (random() < 0.3)
    return null
  const pick = picker(random)
  const hint = Array.from({ length: 1 + Math.floor(random() * 4) }, () => pick(HINT_POOL)).join(' ')
  return hint.slice(0, DEFINITION_LIMITS.argumentHintMaxChars).trim()
}

function randomDefinition(random: () => number, kind: CustomizationKind): ParsedDefinition {
  const pick = picker(random)
  switch (kind) {
    case 'agent':
      return {
        kind,
        fields: {
          name: randomName(random, 64, name => ['explore', 'general', 'general-purpose'].includes(name)),
          description: randomDescription(random),
          tools: randomTools(random),
          model: random() < 0.3 ? null : random() < 0.3 ? 'inherit' : pick(MODEL_POOL),
          instructions: randomBody(random, false),
        },
      }
    case 'command':
      return {
        kind,
        fields: {
          name: randomName(random, 32, name => (CLIENT_COMMANDS as readonly string[]).includes(name) || (HARNESS_COMMANDS as readonly string[]).includes(name)),
          description: randomDescription(random),
          argumentHint: randomHint(random),
          model: random() < 0.4 ? null : pick(MODEL_POOL),
          allowedTools: randomTools(random),
          body: randomBody(random, true),
        },
      }
    case 'skill':
      return {
        kind,
        fields: { name: randomName(random, 64, () => false), description: randomDescription(random), content: randomBody(random, false) },
      }
  }
}

describe('formatDefinition → parseDefinition round trip', () => {
  it('returns equal fields for random valid definitions', () => {
    const random = prng(0xF00D)
    for (let iteration = 0; iteration < 600; iteration++) {
      for (const kind of CUSTOMIZATION_KINDS) {
        const definition = randomDefinition(random, kind)
        const text = formatDefinition(definition)
        const result = parseDefinition(kind, text)
        expect({ text, definition: result.definition }).toEqual({ text, definition })
        const errors: DefinitionDiagnostic[] = result.diagnostics.filter(entry => entry.level !== 'info' && entry.code !== 'missing-field')
        expect({ text, errors }).toEqual({ text, errors: [] })
        expect(formatDefinition(result.definition as ParsedDefinition)).toBe(text)
      }
    }
  })

  it('round-trips parsed Claude Code files', () => {
    const files: Array<[CustomizationKind, string, string]> = [
      ['agent', md(['---', 'name: r', 'description: Use when: asked', 'tools: Read, Bash(git:*)', 'model: sonnet', '---', 'Body']), 'r.md'],
      ['command', md(['---', 'argument-hint: [pr-number] [priority]', 'allowed-tools: Bash(git add:*)', '---', 'Review $1']), 'review.md'],
      ['skill', md(['---', 'name: pdf', 'description: >-', '  PDFs', '  and forms', '---', '# PDF']), 'SKILL.md'],
    ]
    for (const [kind, text, fileName] of files) {
      const first = parseDefinition(kind, text, { fileName, folderName: 'pdf' }).definition
      expect(first).not.toBeNull()
      expect(parseDefinition(kind, formatDefinition(first as ParsedDefinition)).definition).toEqual(first)
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// Precedence

interface Candidate extends RankedDefinition {
  readonly id: string
  readonly pluginId?: string
}

function candidate(id: string, kind: CustomizationKind, name: string, source: CustomizationSource, extra: Partial<Candidate> = {}): Candidate {
  return { id, kind, name, source, ...extra }
}

describe('definitionRank', () => {
  it.each([
    [{ source: 'builtin' }, 0],
    [{ source: 'plugin' }, 1],
    [{ source: 'user' }, 2],
    [{ source: 'project', path: '.claude/agents/a.md' }, 3],
    [{ source: 'project', path: '.harness/agents/a.md' }, 4],
    [{ source: 'project', path: './.harness/commands/ns/a.md' }, 4],
    [{ source: 'project', path: '.harness\\skills\\a\\SKILL.md' }, 4],
    [{ source: 'project', path: '.harnessx/agents/a.md' }, 3],
    [{ source: 'project' }, 3],
    [{ source: 'other' }, -1],
  ] as const)('ranks %j as %d', (entry, rank) => {
    expect(definitionRank({ kind: 'agent', name: 'a', ...entry } as RankedDefinition)).toBe(rank)
  })
})

describe('resolvePrecedence', () => {
  it('picks the highest source per kind and name and lists the losers with the winner', () => {
    const builtin = candidate('b', 'agent', 'explore', 'builtin')
    const plugin = candidate('p', 'agent', 'reviewer', 'plugin', { pluginId: 'agent-pack' })
    const user = candidate('u', 'agent', 'reviewer', 'user')
    const claude = candidate('c', 'agent', 'reviewer', 'project', { path: '.claude/agents/reviewer.md' })
    const harness = candidate('h', 'agent', 'reviewer', 'project', { path: '.harness/agents/reviewer.md' })
    const commandEntry = candidate('k', 'command', 'reviewer', 'user')
    const result = resolvePrecedence([claude, user, commandEntry, plugin, harness, builtin])
    expect(result.active).toEqual([builtin, harness, commandEntry])
    expect(result.shadowed).toEqual([
      { entry: claude, by: harness },
      { entry: user, by: harness },
      { entry: plugin, by: harness },
    ])
  })

  it('lets the first sorted path win inside one folder', () => {
    const a = candidate('1', 'command', 'deploy', 'project', { path: '.harness/commands/ops/deploy.md' })
    const b = candidate('2', 'command', 'deploy', 'project', { path: '.harness/commands/deploy.md' })
    const result = resolvePrecedence([a, b])
    expect(result.active).toEqual([b])
    expect(result.shadowed).toEqual([{ entry: a, by: b }])
  })

  it('breaks ties without paths by pluginId, then id', () => {
    const x = candidate('2', 'skill', 's', 'plugin', { pluginId: 'zeta' })
    const y = candidate('1', 'skill', 's', 'plugin', { pluginId: 'alpha' })
    expect(resolvePrecedence([x, y]).active).toEqual([y])
    const u1 = candidate('cus_b', 'skill', 't', 'user')
    const u2 = candidate('cus_a', 'skill', 't', 'user')
    expect(resolvePrecedence([u1, u2]).active).toEqual([u2])
  })

  it('returns empty lists for no input and tolerates malformed input', () => {
    expect(resolvePrecedence([])).toEqual({ active: [], shadowed: [] })
    expect(resolvePrecedence(null as unknown as Candidate[])).toEqual({ active: [], shadowed: [] })
  })

  it('does not depend on the input order', () => {
    const random = prng(0xBEEF)
    const pick = picker(random)
    const sources: CustomizationSource[] = ['builtin', 'plugin', 'user', 'project']
    const entries: Candidate[] = Array.from({ length: 120 }, (_, index) => {
      const source = pick(sources)
      const kind = pick(CUSTOMIZATION_KINDS)
      const name = pick(['a', 'b', 'c', 'reviewer', 'deploy'])
      const path = source === 'project' ? `${pick(['.claude', '.harness'])}/${kind}s/${pick(['', 'ns/'])}${name}-${index}.md` : undefined
      const pluginId = source === 'plugin' ? pick(['p1', 'p2', 'p3']) : undefined
      return { id: `e${String(index).padStart(3, '0')}`, kind, name, source, ...(path === undefined ? {} : { path }), ...(pluginId === undefined ? {} : { pluginId }) }
    })
    const expected = JSON.stringify(resolvePrecedence(entries))
    for (let iteration = 0; iteration < 50; iteration++)
      expect(JSON.stringify(resolvePrecedence(shuffle(entries, random)))).toBe(expected)
    const result = resolvePrecedence(entries)
    expect(result.active.length + result.shadowed.length).toBe(entries.length)
    for (const { entry, by } of result.shadowed) {
      expect(definitionRank(by)).toBeGreaterThanOrEqual(definitionRank(entry))
      expect(result.active).toContain(by)
    }
  })
})
