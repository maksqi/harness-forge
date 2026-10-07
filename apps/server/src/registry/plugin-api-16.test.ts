// Registry validation of plugin API 1.6.0 (ADR-053, ADR-058; W12.1-T7): qualified names accepted only from their owner
// (harness plugins keep bare names, the reserved bare names stay reserved), markdown commands with their fields, the
// agent fields, the skill fields (`baseDir`), and the Claude Code name of an MCP server.
import type { AgentDefinition, CommandDefinition, OutputStyleDefinition, SkillDefinition } from '@harness-forge/plugin-sdk'
import type { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createRegistryCore } from './index.ts'
import { isPluginFolderPath, validateAgentDefinition, validateCommandDefinition, validateMcpRegisterOptions, validateOutputStyleDefinition, validateSkillDefinition } from './validate.ts'

function thrown(fn: () => unknown): HarnessError {
  try {
    fn()
  }
  catch (error) {
    return error as HarnessError
  }
  throw new Error('expected a throw')
}

function registry() {
  return createRegistryCore(() => ({
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    guard: async (_id, fn) => fn(new AbortController().signal),
    log: () => {},
    isRunnable: () => true,
  }))
}

const command = (extra: Partial<CommandDefinition> = {}): CommandDefinition => ({ name: 'review-kit:review', description: 'Review.', template: 'Review $ARGUMENTS.', syntax: 'markdown', ...extra })

describe('qualified names', () => {
  it('are accepted only when the first segment is the owner id, for commands, agents, skills and styles', () => {
    expect(() => validateCommandDefinition(command(), 'review-kit')).not.toThrow()
    expect(() => validateCommandDefinition(command({ name: 'review-kit:db:migrate' }), 'review-kit')).not.toThrow()
    expect(thrown(() => validateCommandDefinition(command(), 'other'))).toMatchObject({ code: 'validation_error', message: expect.stringContaining('"other:"'), details: { issues: [expect.objectContaining({ path: ['name'] })] } })
    expect(thrown(() => validateCommandDefinition(command()))).toMatchObject({ code: 'validation_error' })
    expect(validateAgentDefinition({ name: 'kit:general', description: 'A general agent.', instructions: 'Do it.' }, 'kit').name).toBe('kit:general')
    expect(thrown(() => validateAgentDefinition({ name: 'other:x', description: 'x', instructions: 'x' }, 'kit')).code).toBe('validation_error')
    expect(validateSkillDefinition({ name: 'kit:pdf', description: 'PDF.', content: 'x' }, 'kit').name).toBe('kit:pdf')
    expect(validateOutputStyleDefinition({ name: 'kit:default', description: 'x', content: 'x' }, 'kit').name).toBe('kit:default')
  })

  it.each([
    'kit:',
    'kit:a:b:c:d',
    'kit:Review',
    'kit:1-setup',
    `kit:${'a'.repeat(125)}`,
    'Kit:review',
    ':review',
  ])('refuses the malformed qualified name %j', (name) => {
    expect(thrown(() => validateCommandDefinition(command({ name }), 'kit'))).toMatchObject({ code: 'validation_error', details: { issues: [expect.objectContaining({ path: ['name'] })] } })
  })

  it('bare reserved names stay reserved; bare names keep their patterns', () => {
    expect(thrown(() => validateCommandDefinition({ name: 'compact', description: 'x', template: 'x' }, 'kit')).message).toBe('The command "/compact" is reserved by the app.')
    expect(thrown(() => validateAgentDefinition({ name: 'general', description: 'x', instructions: 'x' }, 'kit')).code).toBe('validation_error')
    expect(thrown(() => validateOutputStyleDefinition({ name: 'default', description: 'x', content: 'x' }, 'kit')).code).toBe('validation_error')
  })

  it('the registry checks the owner and keys entries by their exact name', () => {
    const core = registry()
    core.commands.register('review-kit', command())
    core.agents.register('review-kit', { name: 'review-kit:code-reviewer', description: 'Reviews.', instructions: 'Review.' })
    expect(core.commands.get('review-kit:review')?.pluginId).toBe('review-kit')
    expect(core.commands.get('review')).toBeUndefined()
    expect(() => core.skills.register('other', { name: 'review-kit:pdf', description: 'x', content: 'x' })).toThrow(expect.objectContaining({ code: 'validation_error' }))
    expect(core.contributions('review-kit')).toMatchObject({ commands: ['review-kit:review'], agents: ['review-kit:code-reviewer'] })
  })
})

describe('commands (1.6.0)', () => {
  it('accept the markdown syntax with a 64 KiB body, argumentHint, model (a ref or a Claude name) and allowedTools', () => {
    expect(() => validateCommandDefinition(command({ template: 'x'.repeat(65_536), argumentHint: '[files]', model: 'sonnet', allowedTools: ['read_file', 'mcp__docs__*'] }), 'review-kit')).not.toThrow()
    expect(() => validateCommandDefinition(command({ model: 'anthropic:claude-sonnet-5' }), 'review-kit')).not.toThrow()
    expect(() => validateCommandDefinition({ name: 'plain', description: 'x', template: 'Hello {{input}}', syntax: 'template' })).not.toThrow()
  })

  it.each([
    ['template', { template: 'x'.repeat(65_537) }],
    ['syntax', { syntax: 'html' }],
    ['argumentHint', { argumentHint: 'x'.repeat(101) }],
    ['model', { model: 'not a model' }],
    ['allowedTools', { allowedTools: 'read_file' }],
    ['allowedTools', { allowedTools: ['read_file', 'read_file'] }],
    ['allowedTools.0', { allowedTools: ['Bash(git:*)'] }],
  ])('refuse an invalid %s', (path, extra) => {
    const error = thrown(() => validateCommandDefinition(command(extra as Partial<CommandDefinition>), 'review-kit'))
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part) })] })
  })

  it('accept and check the ADR-058 keys of commands (disallowedTools, arguments, whenToUse, context, agent)', () => {
    expect(() => validateCommandDefinition(command({ disallowedTools: ['shell'], arguments: ['version', 'channel'], whenToUse: 'When ready.', context: 'fork', agent: 'review-kit:code-reviewer' }), 'review-kit')).not.toThrow()
    for (const [path, extra] of [
      ['arguments', { arguments: ['a', 'a'] }],
      ['arguments.0', { arguments: ['Version'] }],
      ['arguments', { arguments: Array.from({ length: 10 }, (_, index) => `a${index}`) }],
      ['context', { context: 'inline' }],
      ['agent', { agent: 'Bad Agent' }],
      ['whenToUse', { whenToUse: 'x'.repeat(1025) }],
      ['disallowedTools.0', { disallowedTools: ['Bash(x)'] }],
    ] as const) {
      const error = thrown(() => validateCommandDefinition(command(extra as unknown as Partial<CommandDefinition>), 'review-kit'))
      expect(error.details, path).toMatchObject({ issues: [expect.objectContaining({ path: path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part) })] })
    }
  })

  it('a template command keeps the 16 KB limit; the syntax needs a template', () => {
    expect(thrown(() => validateCommandDefinition({ name: 'plain', description: 'x', template: 'x'.repeat(16_385) })).details).toMatchObject({ issues: [expect.objectContaining({ path: ['template'] })] })
    expect(thrown(() => validateCommandDefinition({ name: 'plain', description: 'x', syntax: 'markdown', run: async () => ({ type: 'prompt', text: 'x' }) })).details).toMatchObject({ issues: [expect.objectContaining({ path: ['syntax'] })] })
  })
})

describe('agents and skills (1.6.0)', () => {
  const agent = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({ name: 'kit:reviewer', description: 'Reviews.', instructions: 'Review.', ...extra })

  it('agents keep disallowedTools, maxTurns, color, skills and a Claude model name (normalized), frozen', () => {
    const result = validateAgentDefinition(agent({ model: 'Sonnet[1m]', disallowedTools: ['shell'], maxTurns: 12, color: 'purple', skills: ['kit:pdf', 'notes'] }), 'kit')
    expect(result).toEqual({ name: 'kit:reviewer', description: 'Reviews.', instructions: 'Review.', model: 'sonnet', disallowedTools: ['shell'], maxTurns: 12, color: 'purple', skills: ['kit:pdf', 'notes'] })
    expect(Object.isFrozen(result.skills)).toBe(true)
    expect(validateAgentDefinition(agent({ model: 'claude-opus-4-1' }), 'kit').model).toBe('claude-opus-4-1')
  })

  it.each([
    ['maxTurns', { maxTurns: 0 }],
    ['maxTurns', { maxTurns: 201 }],
    ['maxTurns', { maxTurns: 1.5 }],
    ['color', { color: 'magenta' }],
    ['skills', { skills: ['a', 'b', 'c', 'd', 'e', 'f'] }],
    ['skills.0', { skills: ['Bad Name'] }],
    ['disallowedTools.0', { disallowedTools: ['Bash(rm:*)'] }],
  ])('agents refuse an invalid %s', (path, extra) => {
    const error = thrown(() => validateAgentDefinition(agent(extra as Partial<AgentDefinition>), 'kit'))
    expect(error.code).toBe('validation_error')
    expect(error.details).toMatchObject({ issues: [expect.objectContaining({ path: path.split('.').map(part => /^\d+$/.test(part) ? Number(part) : part) })] })
  })

  it('skills keep baseDir (a folder inside the plugin, "." = its root), argumentHint and the invocation flags', () => {
    const skill: SkillDefinition = { name: 'kit:pdf', description: 'PDF.', content: 'x', baseDir: 'skills/pdf', argumentHint: '[file]', userInvocable: false, modelInvocable: true }
    expect(validateSkillDefinition(skill, 'kit')).toEqual(skill)
    expect(validateSkillDefinition({ ...skill, baseDir: '.' }, 'kit').baseDir).toBe('.')
    expect(validateSkillDefinition({ ...skill, baseDir: 'skills/my skill' }, 'kit').baseDir).toBe('skills/my skill')
    for (const baseDir of ['', '/abs', '../x', 'a/../b', 'a//b', './a', 'a\\b', 'a\u0000b'])
      expect(thrown(() => validateSkillDefinition({ ...skill, baseDir }, 'kit')).details, baseDir).toMatchObject({ issues: [expect.objectContaining({ path: ['baseDir'] })] })
    expect(isPluginFolderPath('skills/pdf')).toBe(true)
  })

  it('skills keep the ADR-058 keys (allowedTools, disallowedTools, model, arguments, whenToUse, context, agent), frozen', () => {
    const skill: SkillDefinition = { name: 'kit:audit', description: 'Audit.', content: 'x', allowedTools: ['read_file'], disallowedTools: ['shell'], model: 'Haiku', arguments: ['scope'], whenToUse: 'Before a release.', context: 'fork', agent: 'explore' }
    const result = validateSkillDefinition(skill, 'kit')
    expect(result).toEqual({ ...skill, model: 'haiku' })
    expect(Object.isFrozen(result.allowedTools)).toBe(true)
    expect(thrown(() => validateSkillDefinition({ ...skill, model: 'not a model' }, 'kit')).details).toMatchObject({ issues: [expect.objectContaining({ path: ['model'] })] })
  })

  it('styles keep their fields with a qualified name', () => {
    const style: OutputStyleDefinition = { name: 'kit:terse', description: 'Terse.', content: 'Be terse.' }
    expect(validateOutputStyleDefinition(style, 'kit')).toEqual({ ...style, keepCodingInstructions: false })
  })
})

describe('mCP servers (1.6.0)', () => {
  it('keep the Claude Code name of a server', () => {
    const core = registry()
    core.mcpServers.register('kit', { id: 'kit', name: 'docs', transport: { type: 'http', url: 'https://docs.example.com/mcp' } }, { claudeName: 'plugin_kit_docs' })
    core.mcpServers.register('kit', { id: 'kit-two', name: 'two', transport: { type: 'http', url: 'https://two.example.com/mcp' } })
    expect(core.mcpServers.get('kit')).toEqual({ pluginId: 'kit', decl: expect.objectContaining({ id: 'kit' }), claudeName: 'plugin_kit_docs' })
    expect(core.mcpServers.get('kit-two')).not.toHaveProperty('claudeName')
    expect(validateMcpRegisterOptions(undefined)).toBeUndefined()
    for (const claudeName of ['', 'has space', 'x'.repeat(129), 'a:b'])
      expect(thrown(() => validateMcpRegisterOptions({ claudeName })).code, claudeName).toBe('validation_error')
  })
})
