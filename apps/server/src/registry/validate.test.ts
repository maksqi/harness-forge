import type { AgentDefinition, OutputStyleDefinition, ProviderDefinition, SkillDefinition, ToolDefinition } from '@harness-forge/plugin-sdk'
import type { ToolRegisterOptions } from './types.ts'
import { BUILTIN_OUTPUT_STYLE_NAMES, CLIENT_COMMANDS, HARNESS_COMMANDS, HarnessError, WORKSPACE_TOOL_ACCESS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { PROVIDER_DEFINITIONS } from '../builtin-plugins/core-providers/index.ts'
import { createWorkspaceTools } from '../builtin-plugins/core-workspace/index.ts'
import { createMemoryLogger } from '../logger.ts'
import { validateAgentDefinition, validateCommandDefinition, validateOutputStyleDefinition, validateProviderDefinition, validateSkillDefinition, validateToolDefinition } from './validate.ts'

function unused(): never {
  throw new Error('unused')
}

function provider(extra: Partial<ProviderDefinition> = {}): ProviderDefinition {
  return { id: 'acme', name: 'Acme', credentials: [], createLanguageModel: unused, ...extra }
}

function thrown(run: () => void): HarnessError {
  try {
    run()
  }
  catch (error) {
    if (error instanceof HarnessError)
      return error
    throw error
  }
  throw new Error('expected a validation error')
}

function failure(definition: ProviderDefinition): HarnessError {
  return thrown(() => validateProviderDefinition('acme', definition))
}

function tool(extra: Record<string, unknown> = {}): ToolDefinition {
  return {
    name: 'read_notes',
    description: 'Reads the notes.',
    inputSchema: z.object({ path: z.string() }),
    execute: async () => 'ok',
    ...extra,
  } as ToolDefinition
}

function toolFailure(definition: ToolDefinition, options?: ToolRegisterOptions): HarnessError {
  return thrown(() => validateToolDefinition(definition, options))
}

describe('validateProviderDefinition: plugin API 1.1.0 members (ADR-028, ADR-029)', () => {
  const MEDIA_MEMBERS = ['createImageModel', 'imageParams', 'createTranscriptionModel', 'createSpeechModel', 'transcriptionOptions'] as const

  it('accepts the media members as functions, and definitions without them', () => {
    expect(() => validateProviderDefinition('acme', provider())).not.toThrow()
    expect(() => validateProviderDefinition('acme', provider({
      createImageModel: unused,
      imageParams: () => undefined,
      createTranscriptionModel: unused,
      createSpeechModel: unused,
      transcriptionOptions: () => undefined,
    }))).not.toThrow()
    // An explicit undefined is the same as an absent member.
    expect(() => validateProviderDefinition('acme', provider({ createImageModel: undefined }))).not.toThrow()
  })

  it.each(MEDIA_MEMBERS)('rejects a %s that is not a function with validation_error naming the member', (member) => {
    for (const value of ['nope', 42, null, {}, true]) {
      const error = failure({ ...provider(), [member]: value } as unknown as ProviderDefinition)
      expect(error.code).toBe('validation_error')
      expect(error.message).toBe(`Provider "acme": "${member}" must be a function.`)
      expect(error.details).toEqual({ issues: [{ path: [member], message: error.message, code: 'custom' }] })
    }
  })

  it('still checks the members of plugin API 1.0', () => {
    for (const member of ['listModels', 'validate', 'reasoning', 'mapError'])
      expect(failure({ ...provider(), [member]: 'nope' } as unknown as ProviderDefinition).message).toBe(`Provider "acme": "${member}" must be a function.`)
    expect(failure({ ...provider(), createLanguageModel: undefined } as unknown as ProviderDefinition).message).toBe('Provider "acme": "createLanguageModel" must be a function.')
  })

  it('accepts every builtin provider definition', () => {
    for (const definition of PROVIDER_DEFINITIONS)
      expect(() => validateProviderDefinition('core-providers', definition), definition.id).not.toThrow()
  })

  it('validates the voices of seed models (unique, at most 100)', () => {
    expect(() => validateProviderDefinition('acme', provider({ seedModels: [{ id: 'say', kind: 'speech', voices: ['a', 'b'] }] }))).not.toThrow()
    expect(failure(provider({ seedModels: [{ id: 'say', kind: 'speech', voices: ['a', 'a'] }] })).code).toBe('validation_error')
    const many = Array.from({ length: 101 }, (_, index) => `voice-${index}`)
    expect(failure(provider({ seedModels: [{ id: 'say', kind: 'speech', voices: many }] })).code).toBe('validation_error')
  })
})

describe('validateToolDefinition: workspace access (plugin API 1.2.0, ADR-032)', () => {
  it.each(['read', 'write', 'execute'] as const)('accepts workspace "%s"', (workspace) => {
    expect(() => validateToolDefinition(tool({ workspace }))).not.toThrow()
  })

  it('accepts a tool without workspace access (absent or explicitly undefined)', () => {
    expect(() => validateToolDefinition(tool())).not.toThrow()
    expect(() => validateToolDefinition(tool({ workspace: undefined }))).not.toThrow()
  })

  it.each([
    ['"admin"', 'admin'],
    ['"Read"', 'Read'],
    ['""', ''],
    ['number', 1],
    ['object', null],
    ['object', ['read']],
    ['boolean', true],
  ])('rejects workspace %s with validation_error naming the tool', (shown, workspace) => {
    const error = toolFailure(tool({ workspace }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe(`Tool "read_notes": "workspace" must be "read", "write" or "execute" (got ${shown}).`)
    expect(error.details).toEqual({ issues: [{ path: ['workspace'], message: error.message, code: 'custom' }] })
  })

  it('accepts every core-workspace tool with its documented access', () => {
    const tools = createWorkspaceTools({ logger: createMemoryLogger().logger, platform: 'linux' })
    expect(tools.map(definition => definition.name)).toEqual(Object.keys(WORKSPACE_TOOL_ACCESS))
    for (const definition of tools) {
      expect(() => validateToolDefinition(definition), definition.name).not.toThrow()
      expect(definition.workspace).toBe(WORKSPACE_TOOL_ACCESS[definition.name as keyof typeof WORKSPACE_TOOL_ACCESS])
    }
  })
})

describe('validateCommandDefinition: reserved names', () => {
  it.each([...CLIENT_COMMANDS, ...HARNESS_COMMANDS])('refuses a plugin command named "/%s" (client-only or harness command)', (name) => {
    for (const definition of [{ name, description: 'Mine.', template: '{{input}}' }, { name, description: 'Mine.', run: async () => ({ type: 'reply' as const, markdown: 'x' }) }]) {
      const error = thrown(() => validateCommandDefinition(definition))
      expect(error.code).toBe('validation_error')
      expect(error.message).toBe(`The command "/${name}" is reserved by the app.`)
      expect(error.details).toEqual({ issues: [{ path: ['name'], message: error.message, code: 'custom' }] })
    }
  })

  it('refuses /remember (Phase 10, ADR-047: the client command of the Remember dialog, through CLIENT_COMMANDS)', () => {
    expect(CLIENT_COMMANDS).toContain('remember')
    const error = thrown(() => validateCommandDefinition({ name: 'remember', description: 'Mine.', template: '{{input}}' }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe('The command "/remember" is reserved by the app.')
  })

  it('refuses /output-style (Phase 11, ADR-051: the client command of the style picker, through CLIENT_COMMANDS)', () => {
    expect(CLIENT_COMMANDS).toContain('output-style')
    for (const definition of [{ name: 'output-style', description: 'Mine.', template: '{{input}}' }, { name: 'output-style', description: 'Mine.', run: async () => ({ type: 'reply' as const, markdown: 'x' }) }]) {
      const error = thrown(() => validateCommandDefinition(definition))
      expect(error.code).toBe('validation_error')
      expect(error.message).toBe('The command "/output-style" is reserved by the app.')
      expect(error.details).toEqual({ issues: [{ path: ['name'], message: error.message, code: 'custom' }] })
    }
  })

  it('accepts names that only start like a reserved one', () => {
    for (const name of ['compact-x', 'compactor', 'news', 'helper', 'remember-me', 'remembered', 'output-styles', 'output', 'style'])
      expect(() => validateCommandDefinition({ name, description: 'Mine.', template: '{{input}}' }), name).not.toThrow()
  })
})

describe('validateAgentDefinition (plugin API 1.4.0, ADR-045)', () => {
  const agent = (extra: Record<string, unknown> = {}): AgentDefinition =>
    ({ name: 'code-reviewer', description: 'Reviews diffs.', instructions: 'Review the diff.', ...extra }) as AgentDefinition
  const agentFailure = (definition: unknown): HarnessError => thrown(() => validateAgentDefinition(definition as AgentDefinition))

  it('accepts the documented shapes and returns a frozen copy with the description trimmed', () => {
    const tools = ['read_file', 'mcp__github__*', 'mcp__github__create_issue', 'shell']
    const input = agent({ description: '  Reviews diffs.  ', tools, model: 'openrouter:anthropic/claude-sonnet-5' })
    const result = validateAgentDefinition(input)
    expect(result).toEqual({ name: 'code-reviewer', description: 'Reviews diffs.', instructions: 'Review the diff.', tools, model: 'openrouter:anthropic/claude-sonnet-5' })
    expect(result).not.toBe(input)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.tools)).toBe(true)
    tools.push('write_file')
    expect(result.tools).toHaveLength(4)
    expect(validateAgentDefinition(agent({ model: 'inherit' })).model).toBe('inherit')
    expect(validateAgentDefinition(agent({ model: 'ollama:llama3:8b' })).model).toBe('ollama:llama3:8b')
    expect(validateAgentDefinition(agent({ tools: [] })).tools).toEqual([])
    expect(validateAgentDefinition(agent())).not.toHaveProperty('tools')
    expect(Object.keys(validateAgentDefinition(agent({ tools: undefined, model: undefined })))).toEqual(['name', 'description', 'instructions'])
  })

  it.each([
    ['a', true],
    ['a1-b2', true],
    [`a${'b'.repeat(63)}`, true],
    [`a${'b'.repeat(64)}`, false],
    ['Reviewer', false],
    ['1reviewer', false],
    ['-reviewer', false],
    ['code_reviewer', false],
    ['code reviewer', false],
    ['', false],
  ])('name %j valid: %s', (name, valid) => {
    if (valid) {
      expect(validateAgentDefinition(agent({ name })).name).toBe(name)
      return
    }
    const error = agentFailure(agent({ name }))
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: ['name'] })] })
  })

  it.each(['explore', 'general', 'general-purpose'])('refuses the reserved name "%s" with validation_error naming the field', (name) => {
    const error = agentFailure(agent({ name }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe(`Agent "${name}": name: Reserved agent type (explore, general, general-purpose).`)
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: ['name'] })] })
  })

  it('accepts names that only start like a reserved one', () => {
    for (const name of ['explorer', 'general-x', 'explore-docs', 'generalist'])
      expect(() => validateAgentDefinition(agent({ name })), name).not.toThrow()
  })

  it.each([
    ['description', { description: '' }],
    ['description', { description: '   ' }],
    ['description', { description: 'x'.repeat(1025) }],
    ['description', { description: 42 }],
    ['instructions', { instructions: '' }],
    ['instructions', { instructions: 'x'.repeat(65_537) }],
    ['instructions', { instructions: 'é'.repeat(32_769) }],
    ['instructions', { instructions: undefined }],
    ['tools', { tools: 'read_file' }],
    ['tools', { tools: ['read_file', 'read_file'] }],
    ['tools', { tools: Array.from({ length: 65 }, (_, index) => `tool_${index}`) }],
    ['tools.0', { tools: ['Bash(git:*)'] }],
    ['tools.0', { tools: ['read file'] }],
    ['tools.0', { tools: ['x'.repeat(65)] }],
    ['tools.0', { tools: ['mcp__*'] }],
    ['tools.0', { tools: ['*'] }],
    ['tools.0', { tools: [42] }],
    ['model', { model: 'my model' }],
    ['model', { model: '' }],
    ['model', { model: ':model' }],
    ['model', { model: 'provider:' }],
    ['model', { model: 7 }],
  ])('refuses an invalid %s with validation_error naming the field', (path, extra) => {
    const error = agentFailure(agent(extra))
    expect(error.code).toBe('validation_error')
    expect(error.message).toMatch(new RegExp(`^Agent "code-reviewer": ${path.replace('.', '\\.')}: `))
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part) })] })
  })

  it('accepts the size limits exactly: 1024 description characters, 64 KiB of instructions, 64 tools', () => {
    expect(() => validateAgentDefinition(agent({
      description: 'd'.repeat(1024),
      instructions: 'x'.repeat(65_536),
      tools: Array.from({ length: 64 }, (_, index) => `tool_${index}`),
    }))).not.toThrow()
    // 64 KiB is counted in UTF-8 bytes: 32 768 two-byte characters fit.
    expect(() => validateAgentDefinition(agent({ instructions: 'é'.repeat(32_768) }))).not.toThrow()
  })

  it('refuses unknown keys and non-objects', () => {
    expect(agentFailure(agent({ colour: 'blue' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('colour') })
    for (const value of [null, 'reviewer', 42, ['reviewer']])
      expect(agentFailure(value)).toMatchObject({ code: 'validation_error', message: 'An agent definition must be an object.' })
  })
})

describe('validateSkillDefinition (plugin API 1.4.0, ADR-045)', () => {
  const skill = (extra: Record<string, unknown> = {}): SkillDefinition =>
    ({ name: 'commit-message', description: 'How to write commit messages.', content: '# Commit messages', ...extra }) as SkillDefinition
  const skillFailure = (definition: unknown): HarnessError => thrown(() => validateSkillDefinition(definition as SkillDefinition))

  it('accepts a skill and returns a frozen copy with the description trimmed', () => {
    const input = skill({ description: ' How to write commit messages. ' })
    const result = validateSkillDefinition(input)
    expect(result).toEqual({ name: 'commit-message', description: 'How to write commit messages.', content: '# Commit messages' })
    expect(result).not.toBe(input)
    expect(Object.isFrozen(result)).toBe(true)
    expect(() => validateSkillDefinition(skill({ description: 'd'.repeat(1024), content: 'x'.repeat(65_536) }))).not.toThrow()
  })

  it('has no reserved names (only agents reserve the builtin types)', () => {
    for (const name of ['explore', 'general', 'general-purpose'])
      expect(validateSkillDefinition(skill({ name })).name).toBe(name)
  })

  it.each([
    ['name', { name: 'Commit' }],
    ['name', { name: `a${'b'.repeat(64)}` }],
    ['name', { name: undefined }],
    ['description', { description: '' }],
    ['description', { description: 'x'.repeat(1025) }],
    ['content', { content: '' }],
    ['content', { content: 'x'.repeat(65_537) }],
    ['content', { content: null }],
  ])('refuses an invalid %s with validation_error naming the field', (path, extra) => {
    const error = skillFailure(skill(extra))
    expect(error.code).toBe('validation_error')
    expect(error.message).toMatch(new RegExp(`^Skill .+: ${path}: `))
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: [path] })] })
  })

  it('refuses unknown keys (an agent shape is not a skill) and non-objects', () => {
    expect(skillFailure(skill({ instructions: 'x' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('instructions') })
    for (const value of [undefined, 'skill', [skill()]])
      expect(skillFailure(value)).toMatchObject({ code: 'validation_error', message: 'A skill definition must be an object.' })
  })
})

describe('validateOutputStyleDefinition (plugin API 1.5.0, ADR-051)', () => {
  const style = (extra: Record<string, unknown> = {}): OutputStyleDefinition =>
    ({ name: 'terse', description: 'Short answers.', content: 'Answer in at most three sentences.', ...extra }) as OutputStyleDefinition
  const styleFailure = (definition: unknown): HarnessError => thrown(() => validateOutputStyleDefinition(definition as OutputStyleDefinition))

  it('accepts a style and returns a frozen copy (description trimmed, keepCodingInstructions filled in)', () => {
    const input = style({ description: ' Short answers. ' })
    const result = validateOutputStyleDefinition(input)
    expect(result).toEqual({ name: 'terse', description: 'Short answers.', content: 'Answer in at most three sentences.', keepCodingInstructions: false })
    expect(result).not.toBe(input)
    expect(Object.isFrozen(result)).toBe(true)
    expect(validateOutputStyleDefinition(style({ keepCodingInstructions: true })).keepCodingInstructions).toBe(true)
    expect(() => validateOutputStyleDefinition(style({ description: 'd'.repeat(1024), content: 'x'.repeat(65_536) }))).not.toThrow()
  })

  it.each([...BUILTIN_OUTPUT_STYLE_NAMES])('refuses the builtin style name "%s" with validation_error naming the field', (name) => {
    const error = styleFailure(style({ name }))
    expect(error.code).toBe('validation_error')
    expect(error.message).toBe(`The output style "${name}" is a builtin style (default, explanatory, learning); choose another name.`)
    expect(error.details).toEqual({ issues: [{ path: ['name'], message: error.message, code: 'custom' }] })
  })

  it('accepts names that only start like a builtin one', () => {
    for (const name of ['default-2', 'learning-mode', 'explanatory-short', 'teach'])
      expect(validateOutputStyleDefinition(style({ name })).name, name).toBe(name)
  })

  it.each([
    ['name', { name: 'Terse' }],
    ['name', { name: `a${'b'.repeat(64)}` }],
    ['name', { name: undefined }],
    ['description', { description: '' }],
    ['description', { description: 'x'.repeat(1025) }],
    ['content', { content: '' }],
    ['content', { content: 'x'.repeat(65_537) }],
    ['keepCodingInstructions', { keepCodingInstructions: 'yes' }],
  ])('refuses an invalid %s with validation_error naming the field', (path, extra) => {
    const error = styleFailure(style(extra))
    expect(error.code).toBe('validation_error')
    expect(error.message).toMatch(new RegExp(`^Output style .+: ${path}: `))
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: [path] })] })
  })

  it('refuses unknown keys (a skill shape is not a style) and non-objects', () => {
    expect(styleFailure(style({ label: 'Terse' }))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('label') })
    for (const value of [undefined, 'style', [style()]])
      expect(styleFailure(value)).toMatchObject({ code: 'validation_error', message: 'An output style definition must be an object.' })
  })
})
