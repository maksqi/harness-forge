import { describe, expect, it } from 'vitest'
import { commandBadgeLines, commandSourceText, commandToolsText } from './command-badge'

describe('command badge helpers', () => {
  it('words the source of a command', () => {
    expect(commandSourceText('project')).toBe('Project command')
    expect(commandSourceText('user')).toBe('Personal command')
    expect(commandSourceText('plugin', 'Summaries')).toBe('From Summaries')
    expect(commandSourceText('plugin')).toBe('From a plugin')
    expect(commandSourceText('harness')).toBe('Built-in command')
  })

  it('lists at most 8 tools, then "and {n} more"', () => {
    expect(commandToolsText([])).toBe('')
    expect(commandToolsText(['read_file', 'search_files'])).toBe('Tools limited to read_file, search_files')
    const tools = Array.from({ length: 10 }, (_, index) => `tool_${index + 1}`)
    expect(commandToolsText(tools)).toBe('Tools limited to tool_1, tool_2, tool_3, tool_4, tool_5, tool_6, tool_7, tool_8 and 2 more')
  })

  it('builds the tooltip lines from what the command carries', () => {
    expect(commandBadgeLines({ source: 'project', modelRef: 'openai:gpt-6', allowedTools: ['read_file'] }, { plugin: null, model: 'GPT-6' }))
      .toEqual({ source: 'Project command', model: 'Runs on GPT-6', tools: 'Tools limited to read_file' })
    expect(commandBadgeLines({ modelRef: 'openai:gpt-6' }, { plugin: null, model: null }))
      .toEqual({ source: null, model: 'Runs on openai:gpt-6', tools: null })
    expect(commandBadgeLines({ allowedTools: [] }, { plugin: null, model: null })).toEqual({ source: null, model: null, tools: null })
  })
})
