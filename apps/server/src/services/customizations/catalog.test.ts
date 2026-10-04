// The catalog merge (W10.1-T2, T4): five sources with one name (the `.harness` file wins, four shadowed with
// `shadowed`), `duplicate-name` within one folder, the same name in two kinds, `invalid` / `off` entries that shadow
// nothing, the live checks (`unknown-tool`, `invalid-model`), the plugin entries of the registry (safe mode) and the
// fingerprint of the project part.
import type { CustomizationEntry, CustomizationKind } from '@harness-forge/shared'
import type { Registry } from '../../registry/types.ts'
import type { CatalogCheckContext } from './entries.ts'
import { customizationListSchema, parseDefinition } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { builtinCatalogEntries } from './builtins.ts'
import { mergeCatalog, projectFingerprint } from './catalog.ts'
import { checkEntry, entryFromParse } from './entries.ts'
import { pluginCatalogEntries, pluginDefinition, pluginListed } from './plugins.ts'
import { catalogList } from './snapshot.ts'

const NO_CHECKS: CatalogCheckContext = { tools: new Set(), providers: null }

function entry(kind: CustomizationKind, name: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  return { kind, name, description: `${name} ${kind}`, source: 'project', enabled: true, state: 'active', diagnostics: [], ...fields }
}

function merge(entries: readonly CustomizationEntry[], checks = NO_CHECKS) {
  return mergeCatalog({ projectId: 'prj_AAAAAAAAAAAAAAAA', global: [], project: { scan: { id: 'prj_AAAAAAAAAAAAAAAA', available: true, folders: [], scannedAt: 1 }, entries, diagnostics: [] }, checks, builtAt: 1 })
}

describe('mergeCatalog', () => {
  it('five sources with one name: the .harness file wins, the four others are shadowed by it (with a `shadowed` info)', () => {
    const catalog = merge([
      entry('agent', 'general', { source: 'builtin' }),
      entry('agent', 'general', { source: 'plugin', pluginId: 'acme' }),
      entry('agent', 'general', { source: 'user', id: 'cus_AAAAAAAAAAAAAAAA' }),
      entry('agent', 'general', { path: '.claude/agents/general.md' }),
      entry('agent', 'general', { path: '.harness/agents/general.md' }),
    ])
    expect(catalog.entries.map(item => [item.source, item.path ?? item.pluginId ?? item.id ?? null, item.state])).toEqual([
      ['project', '.harness/agents/general.md', 'active'],
      ['project', '.claude/agents/general.md', 'shadowed'],
      ['user', 'cus_AAAAAAAAAAAAAAAA', 'shadowed'],
      ['plugin', 'acme', 'shadowed'],
      ['builtin', null, 'shadowed'],
    ])
    for (const loser of catalog.entries.slice(1)) {
      expect(loser.shadowedBy).toEqual({ source: 'project', path: '.harness/agents/general.md' })
      expect(loser.diagnostics.map(item => [item.level, item.code])).toEqual([['info', 'shadowed']])
      expect(loser.diagnostics[0]!.message).toBe('Not used: the project\'s .harness/agents/general.md wins.')
    }
    expect(catalog.agent('general')?.path).toBe('.harness/agents/general.md')
    expect(catalog.agent('general-purpose')?.path).toBe('.harness/agents/general.md')
    expect(customizationListSchema.safeParse(catalogList(catalog)).success).toBe(true)
  })

  it('within one folder the first sorted path wins (`duplicate-name`); another folder is `shadowed`', () => {
    const catalog = merge([
      entry('command', 'review', { path: '.harness/commands/z/review.md' }),
      entry('command', 'review', { path: '.harness/commands/a/review.md' }),
      entry('command', 'review', { path: '.claude/commands/review.md' }),
      entry('command', 'review', { source: 'user', id: 'cus_AAAAAAAAAAAAAAAA' }),
    ])
    const states = catalog.entries.map(item => [item.path ?? item.source, item.state, item.diagnostics.map(diagnostic => diagnostic.code)])
    expect(states).toEqual([
      ['.harness/commands/a/review.md', 'active', []],
      ['.harness/commands/z/review.md', 'shadowed', ['duplicate-name']],
      ['.claude/commands/review.md', 'shadowed', ['shadowed']],
      ['user', 'shadowed', ['shadowed']],
    ])
    expect(catalog.entries[1]!.diagnostics[0]).toMatchObject({ level: 'warning', path: '.harness/commands/z/review.md' })
    expect(catalog.entries[3]!.diagnostics[0]!.message).toBe('Not used: the project\'s .harness/commands/a/review.md wins.')
  })

  it('the same name in two kinds never shadows; invalid and off entries shadow nothing', () => {
    const catalog = merge([
      entry('agent', 'docs', { source: 'user', id: 'cus_AAAAAAAAAAAAAAAA' }),
      entry('skill', 'docs', { path: '.harness/skills/docs/SKILL.md' }),
      entry('command', 'docs', { path: '.harness/commands/docs.md' }),
      entry('agent', 'tester', { source: 'user', id: 'cus_BBBBBBBBBBBBBBBB' }),
      entry('agent', 'tester', { path: '.harness/agents/tester.md', state: 'invalid', description: '' }),
      entry('agent', 'helper', { source: 'plugin', pluginId: 'acme' }),
      entry('agent', 'helper', { source: 'user', id: 'cus_CCCCCCCCCCCCCCCC', enabled: false, state: 'off' }),
    ])
    expect(catalog.agents().map(item => [item.name, item.source])).toEqual([['docs', 'user'], ['helper', 'plugin'], ['tester', 'user']])
    expect(catalog.skill('docs')?.source).toBe('project')
    expect(catalog.command('/docs')?.source).toBe('project')
    expect(catalog.entries.filter(item => item.state === 'shadowed')).toEqual([])
    expect(catalog.entries.map(item => item.state).sort()).toEqual(['active', 'active', 'active', 'active', 'active', 'invalid', 'off'])
  })

  it('adds the builtins as the lowest source (a project file named explore is invalid, never a winner)', () => {
    const explore = entryFromParse('agent', 'project', parseDefinition('agent', '---\nname: explore\ndescription: Mine.\n---\nBody', { fileName: 'explore.md' }), {
      path: '.harness/agents/explore.md',
      fallbackName: 'explore',
    })
    expect(explore).toMatchObject({ name: 'explore', state: 'invalid', description: '' })
    expect(explore.diagnostics.map(item => [item.code, item.path])).toEqual([['reserved-name', '.harness/agents/explore.md']])
    const catalog = mergeCatalog({ projectId: null, global: builtinCatalogEntries(), project: null, checks: NO_CHECKS, builtAt: 1 })
    expect(catalog.agents().map(item => item.name)).toEqual(['explore', 'general'])
    const withProject = merge([...builtinCatalogEntries(), explore])
    expect(withProject.agent('explore')?.source).toBe('builtin')
  })
})

describe('checkEntry', () => {
  const checks: CatalogCheckContext = { tools: new Set(['read_file', 'shell']), providers: new Set(['mock']) }

  it('warns about unknown tools (never mcp__ entries) and unconfigured model providers; the state stays', () => {
    const checked = checkEntry(entry('agent', 'a', { path: '.harness/agents/a.md', tools: ['read_file', 'Task', 'mcp__github__*', 'mcp__x__y'], modelRef: 'openai:gpt-5' }), checks)
    expect(checked.state).toBe('active')
    expect(checked.diagnostics.map(item => [item.level, item.code, item.message, item.path])).toEqual([
      ['warning', 'unknown-tool', 'Unknown tool: Task; it matches nothing.', '.harness/agents/a.md'],
      ['warning', 'invalid-model', 'The provider "openai" is not configured; the default sub-agent model is used.', '.harness/agents/a.md'],
    ])
    const command = checkEntry(entry('command', 'c', { source: 'user', modelRef: 'anthropic:claude' }), checks)
    expect(command.diagnostics.map(item => item.message)).toEqual(['The provider "anthropic" is not configured; the chat\'s model is used.'])
    // Known tools, a configured provider, `inherit` and an unknown provider list: no warning (the same object).
    const fine = entry('agent', 'b', { tools: ['shell'], modelRef: 'mock:echo' })
    expect(checkEntry(fine, checks)).toBe(fine)
    const inherit = entry('agent', 'i', { modelRef: 'inherit' })
    expect(checkEntry(inherit, checks)).toBe(inherit)
    expect(checkEntry(entry('agent', 'x', { modelRef: 'openai:gpt-5' }), NO_CHECKS).diagnostics).toEqual([])
  })

  it('counts unknown tools beyond ten in one more warning', () => {
    const tools = Array.from({ length: 13 }, (_, index) => `tool_${index}`)
    const checked = checkEntry(entry('agent', 'a', { tools }), checks)
    expect(checked.diagnostics).toHaveLength(11)
    expect(checked.diagnostics.at(-1)?.message).toBe('3 more unknown tools match nothing.')
  })
})

/** A registry with agents, skills and commands only (the members the catalog reads). */
function stubRegistry(options: {
  agents?: Array<{ pluginId: string, definition: Record<string, unknown> }>
  skills?: Array<{ pluginId: string, definition: Record<string, unknown> }>
  commands?: Array<{ pluginId: string, definition: Record<string, unknown> }>
}): Registry {
  const lookup = (list: Array<{ pluginId: string, definition: Record<string, unknown> }> | undefined) => ({
    list: () => list ?? [],
    get: (name: string) => (list ?? []).find(item => item.definition.name === name),
  })
  return { agents: lookup(options.agents), skills: lookup(options.skills), commands: lookup(options.commands) } as unknown as Registry
}

describe('plugin entries', () => {
  const registry = stubRegistry({
    agents: [{ pluginId: 'acme', definition: { name: 'reviewer', description: 'Reviews.', instructions: 'Review it.', tools: ['read_file'], model: 'inherit' } }],
    skills: [{ pluginId: 'acme', definition: { name: 'pdf', description: 'PDFs.', content: 'Read PDFs.' } }],
    commands: [
      { pluginId: 'core-commands', definition: { name: 'review', description: 'Review the code.', template: 'Review {{input}}' } },
      { pluginId: 'acme', definition: { name: 'hello', description: 'Says hello.', run: () => {} } },
    ],
  })

  it('lists the agents, skills and commands of the registry as plugin entries', () => {
    expect(pluginCatalogEntries(registry, false).map(item => [item.kind, item.name, item.source, item.pluginId, item.state, item.tools ?? null, item.modelRef ?? null])).toEqual([
      ['agent', 'reviewer', 'plugin', 'acme', 'active', ['read_file'], 'inherit'],
      ['skill', 'pdf', 'plugin', 'acme', 'active', null, null],
      ['command', 'review', 'plugin', 'core-commands', 'active', null, null],
      ['command', 'hello', 'plugin', 'acme', 'active', null, null],
    ])
  })

  it('in safe mode lists the builtin plugins only', () => {
    expect(pluginListed('acme', true)).toBe(false)
    expect(pluginListed('core-commands', true)).toBe(true)
    expect(pluginCatalogEntries(registry, true).map(item => item.name)).toEqual(['review'])
    expect(pluginDefinition(registry, 'agent', 'reviewer', 'acme', true)).toBeNull()
  })

  it('gives the definition of a registration (null for another plugin or an unknown name)', () => {
    expect(pluginDefinition(registry, 'agent', 'reviewer', 'acme', false)?.definition).toEqual({
      kind: 'agent',
      fields: { name: 'reviewer', description: 'Reviews.', tools: ['read_file'], model: 'inherit', instructions: 'Review it.' },
    })
    expect(pluginDefinition(registry, 'command', 'review', undefined, false)?.definition.fields).toMatchObject({ body: 'Review {{input}}', allowedTools: null })
    expect(pluginDefinition(registry, 'skill', 'pdf', 'other', false)).toBeNull()
    expect(pluginDefinition(registry, 'skill', 'missing', undefined, false)).toBeNull()
  })

  it('a plugin command shadowed by a personal and a project command shows the winner', () => {
    const catalog = merge([...pluginCatalogEntries(registry, false), entry('command', 'review', { path: '.harness/commands/review.md' })])
    const review = catalog.entries.filter(item => item.kind === 'command' && item.name === 'review')
    expect(review.map(item => [item.source, item.state])).toEqual([['project', 'active'], ['plugin', 'shadowed']])
    expect(review[1]!.shadowedBy).toEqual({ source: 'project', path: '.harness/commands/review.md' })
  })
})

describe('projectFingerprint', () => {
  it('changes with the project entries and folders, not with the build time', () => {
    const one = merge([entry('agent', 'a', { path: '.harness/agents/a.md' })])
    const same = mergeCatalog({ projectId: 'prj_AAAAAAAAAAAAAAAA', global: [], project: { scan: { id: 'prj_AAAAAAAAAAAAAAAA', available: true, folders: [], scannedAt: 1 }, entries: [entry('agent', 'a', { path: '.harness/agents/a.md' })], diagnostics: [] }, checks: NO_CHECKS, builtAt: 99 })
    const other = merge([entry('agent', 'b', { path: '.harness/agents/b.md' })])
    expect(projectFingerprint(one)).toBe(projectFingerprint(same))
    expect(projectFingerprint(one)).not.toBe(projectFingerprint(other))
  })
})
