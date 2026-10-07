// The plugin entries of the catalog (W12.1-T8, plugin API 1.6.0): registrations keep their 1.6.0 fields in the catalog
// (commands `argumentHint` / `model` / `allowedTools`, skills `argumentHint` / `userInvocable` / `modelInvocable`,
// agents `disallowedTools` / `maxTurns` / `color` / `skills`, Claude model names as `modelAlias`), under qualified names;
// a skill's `baseDir` stays on the registration (`pluginSkillFolder`).
import { describe, expect, it } from 'vitest'
import { createRegistryCore } from '../../registry/index.ts'
import { pluginCatalogEntries, pluginDefinition, pluginSkillFolder } from './plugins.ts'

function reviewKitRegistry() {
  const registry = createRegistryCore(() => ({
    logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
    guard: async (_id, fn) => fn(new AbortController().signal),
    log: () => {},
    isRunnable: () => true,
  }))
  registry.commands.register('review-kit', {
    name: 'review-kit:review',
    description: 'Review the changed files',
    template: 'Review $ARGUMENTS.',
    syntax: 'markdown',
    argumentHint: '[focus]',
    model: 'sonnet',
    allowedTools: ['read_file', 'search_files'],
  })
  registry.commands.register('review-kit', { name: 'review-kit:db:migrate', description: 'Plan a migration', template: 'Plan $0.', syntax: 'markdown', model: 'anthropic:claude-sonnet-5' })
  registry.agents.register('review-kit', {
    name: 'review-kit:code-reviewer',
    description: 'Reviews code.',
    instructions: 'Review.',
    tools: ['read_file'],
    model: 'sonnet',
    disallowedTools: ['shell'],
    maxTurns: 8,
    color: 'purple',
    skills: ['review-kit:pdf'],
  })
  registry.skills.register('review-kit', { name: 'review-kit:pdf', description: 'PDF forms.', content: 'Fill forms.', baseDir: 'skills/pdf', argumentHint: '[form]', userInvocable: false })
  registry.styles.register('review-kit', { name: 'review-kit:terse', description: 'Terse.', content: 'Be terse.', keepCodingInstructions: true })
  return registry
}

describe('plugin catalog entries (1.6.0)', () => {
  it('list the qualified entries of a Claude Code plugin with their fields', () => {
    const entries = pluginCatalogEntries(reviewKitRegistry(), false)
    const byName = Object.fromEntries(entries.map(entry => [`${entry.kind}:${entry.name}`, entry]))
    expect(Object.keys(byName).sort()).toEqual([
      'agent:review-kit:code-reviewer',
      'command:review-kit:db:migrate',
      'command:review-kit:review',
      'skill:review-kit:pdf',
      'style:review-kit:terse',
    ])
    expect(byName['command:review-kit:review']).toMatchObject({ source: 'plugin', pluginId: 'review-kit', state: 'active', argumentHint: '[focus]', tools: ['read_file', 'search_files'] })
    expect(byName['command:review-kit:db:migrate']).toMatchObject({ modelRef: 'anthropic:claude-sonnet-5' })
    expect(byName['skill:review-kit:pdf']).toMatchObject({ argumentHint: '[form]', userInvocable: false })
    expect(byName['agent:review-kit:code-reviewer']).toMatchObject({ tools: ['read_file'], state: 'active' })
    expect(byName['style:review-kit:terse']).toMatchObject({ keepCodingInstructions: true, label: 'review-kit:terse' })
  })

  it('load the definitions with every 1.6.0 field (a Claude model name as modelAlias)', () => {
    const registry = reviewKitRegistry()
    expect(pluginDefinition(registry, 'command', 'review-kit:review', 'review-kit', false)?.definition).toEqual({
      kind: 'command',
      fields: { name: 'review-kit:review', description: 'Review the changed files', argumentHint: '[focus]', model: null, modelAlias: 'sonnet', allowedTools: ['read_file', 'search_files'], body: 'Review $ARGUMENTS.' },
    })
    expect(pluginDefinition(registry, 'agent', 'review-kit:code-reviewer', undefined, false)?.definition).toEqual({
      kind: 'agent',
      fields: {
        name: 'review-kit:code-reviewer',
        description: 'Reviews code.',
        tools: ['read_file'],
        model: null,
        modelAlias: 'sonnet',
        instructions: 'Review.',
        disallowedTools: ['shell'],
        maxTurns: 8,
        color: 'purple',
        skills: ['review-kit:pdf'],
      },
    })
    expect(pluginDefinition(registry, 'skill', 'review-kit:pdf', 'review-kit', false)?.definition).toEqual({
      kind: 'skill',
      fields: { name: 'review-kit:pdf', description: 'PDF forms.', content: 'Fill forms.', userInvocable: false, argumentHint: '[form]' },
    })
    expect(pluginDefinition(registry, 'skill', 'review-kit:pdf', 'other', false)).toBeNull()
  })

  it('carry the ADR-058 keys: a fork skill with allowed-tools and a model, a command with named arguments', () => {
    const registry = reviewKitRegistry()
    registry.skills.register('review-kit', {
      name: 'review-kit:audit',
      description: 'Audits.',
      content: 'Audit $scope.',
      baseDir: 'skills/audit',
      allowedTools: ['read_file'],
      disallowedTools: ['shell'],
      model: 'haiku',
      arguments: ['scope'],
      whenToUse: 'Before a release.',
      context: 'fork',
      agent: 'explore',
    })
    registry.commands.register('review-kit', { name: 'review-kit:ship', description: 'Ship.', template: 'Ship $version.', syntax: 'markdown', arguments: ['version'], disallowedTools: ['web_fetch'], whenToUse: 'When ready.', context: 'fork', agent: 'general' })
    expect(pluginDefinition(registry, 'skill', 'review-kit:audit', 'review-kit', false)?.definition).toEqual({
      kind: 'skill',
      fields: {
        name: 'review-kit:audit',
        description: 'Audits.',
        content: 'Audit $scope.',
        allowedTools: ['read_file'],
        modelAlias: 'haiku',
        disallowedTools: ['shell'],
        arguments: ['scope'],
        whenToUse: 'Before a release.',
        context: 'fork',
        agent: 'explore',
      },
    })
    expect(pluginDefinition(registry, 'command', 'review-kit:ship', 'review-kit', false)?.definition.fields).toMatchObject({ arguments: ['version'], disallowedTools: ['web_fetch'], whenToUse: 'When ready.', context: 'fork', agent: 'general' })
    const entries = pluginCatalogEntries(registry, false)
    expect(entries.find(entry => entry.name === 'review-kit:audit')).toMatchObject({ kind: 'skill', state: 'active' })
  })

  it('a harness command keeps its v1.7 shape (no hint, model or tools)', () => {
    const registry = reviewKitRegistry()
    registry.commands.register('acme', { name: 'acme', description: 'Ask Acme.', template: 'Ask {{input}}' })
    expect(pluginDefinition(registry, 'command', 'acme', 'acme', false)?.definition).toEqual({
      kind: 'command',
      fields: { name: 'acme', description: 'Ask Acme.', argumentHint: null, model: null, allowedTools: null, body: 'Ask {{input}}' },
    })
  })

  it('pluginSkillFolder: the owner and baseDir of a plugin skill (null without one, for another owner or in safe mode)', () => {
    const registry = reviewKitRegistry()
    registry.skills.register('acme', { name: 'plain', description: 'Plain.', content: 'x' })
    expect(pluginSkillFolder(registry, 'review-kit:pdf', undefined, false)).toEqual({ pluginId: 'review-kit', baseDir: 'skills/pdf' })
    expect(pluginSkillFolder(registry, 'review-kit:pdf', 'acme', false)).toBeNull()
    expect(pluginSkillFolder(registry, 'review-kit:pdf', undefined, true)).toBeNull()
    expect(pluginSkillFolder(registry, 'plain', undefined, false)).toBeNull()
    expect(pluginSkillFolder(registry, 'missing', undefined, false)).toBeNull()
  })
})
