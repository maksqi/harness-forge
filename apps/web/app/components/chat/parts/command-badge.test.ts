import { describe, expect, it } from 'vitest'
import { commandBadgeLines, commandInlinedLines, commandSourceText, commandToolsText } from './command-badge'

describe('command badge helpers', () => {
  it('words the source of a command', () => {
    expect(commandSourceText('project')).toBe('Project command')
    expect(commandSourceText('user')).toBe('Personal command')
    expect(commandSourceText('plugin', 'Summaries')).toBe('From Summaries')
    expect(commandSourceText('plugin')).toBe('From a plugin')
    expect(commandSourceText('harness')).toBe('Built-in command')
  })

  it('words the source of a skill (Phase 11)', () => {
    expect(commandSourceText('project', null, 'skill')).toBe('Project skill')
    expect(commandSourceText('user', null, 'skill')).toBe('Personal skill')
    expect(commandSourceText('plugin', 'Docs', 'skill')).toBe('From Docs')
    expect(commandSourceText('harness', null, 'skill')).toBe('Built-in skill')
  })

  it('lists what a command inlined: its shell commands and at most 5 files (Phase 11)', () => {
    expect(commandInlinedLines(undefined)).toEqual([])
    expect(commandInlinedLines({ shell: 0, files: [] })).toEqual([])
    expect(commandInlinedLines({ shell: 1, files: [] })).toEqual(['Ran 1 shell command'])
    expect(commandInlinedLines({ shell: 3, files: ['README.md'] })).toEqual(['Ran 3 shell commands', 'Included README.md'])
    const files = Array.from({ length: 7 }, (_, index) => `docs/${index + 1}.md`)
    expect(commandInlinedLines({ shell: 0, files })).toEqual(['Included docs/1.md, docs/2.md, docs/3.md, docs/4.md, docs/5.md and 2 more'])
  })

  it('lists at most 8 tools, then "and {n} more"', () => {
    expect(commandToolsText([])).toBe('')
    expect(commandToolsText(['read_file', 'search_files'])).toBe('Tools limited to read_file, search_files')
    const tools = Array.from({ length: 10 }, (_, index) => `tool_${index + 1}`)
    expect(commandToolsText(tools)).toBe('Tools limited to tool_1, tool_2, tool_3, tool_4, tool_5, tool_6, tool_7, tool_8 and 2 more')
  })

  it('builds the tooltip lines from what the command carries', () => {
    expect(commandBadgeLines({ source: 'project', modelRef: 'openai:gpt-6', allowedTools: ['read_file'] }, { plugin: null, model: 'GPT-6' }))
      .toEqual({ source: 'Project command', model: 'Runs on GPT-6', tools: 'Tools limited to read_file', inlined: [] })
    expect(commandBadgeLines({ modelRef: 'openai:gpt-6' }, { plugin: null, model: null }))
      .toEqual({ source: null, model: 'Runs on openai:gpt-6', tools: null, inlined: [] })
    expect(commandBadgeLines({ allowedTools: [] }, { plugin: null, model: null })).toEqual({ source: null, model: null, tools: null, inlined: [] })
    // + Phase 11: a skill invocation and what a command inlined.
    expect(commandBadgeLines({ source: 'user', kind: 'skill' }, { plugin: null, model: null }))
      .toEqual({ source: 'Personal skill', model: null, tools: null, inlined: [] })
    expect(commandBadgeLines({ source: 'user' }, { plugin: null, model: null }, 'skill').source).toBe('Personal skill')
    expect(commandBadgeLines({ source: 'project', inlined: { shell: 2, files: ['README.md'] } }, { plugin: null, model: null }))
      .toEqual({ source: 'Project command', model: null, tools: null, inlined: ['Ran 2 shell commands', 'Included README.md'] })
  })
})
