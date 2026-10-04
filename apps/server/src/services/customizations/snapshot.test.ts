// The catalog snapshot helpers (Phase 10, C30-T2): the catalog order, the precedence of ADR-044 over merged candidates
// (`resolvePrecedence`), the active-entry getters with the agent aliases, the route answer; the builtin entries.
import type { CustomizationEntry, CustomizationKind } from '@harness-forge/shared'
import { customizationEntrySchema, customizationListSchema } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { BUILTIN_AGENT_DEFINITIONS } from '../../builtin-plugins/core-agent/agents.ts'
import { builtinCatalogEntries, loadBuiltin } from './builtins.ts'
import { applyPrecedence, catalogList, createCatalogSnapshot, resolveAgentAlias, sortCatalogEntries } from './snapshot.ts'

function entry(kind: CustomizationKind, name: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  return { kind, name, description: `${name} ${kind}`, source: 'project', path: `.harness/${kind}s/${name}.md`, enabled: true, state: 'active', diagnostics: [], ...fields }
}

describe('builtin entries', () => {
  it('lists explore and general from core-agent as active builtin agents (schema-valid); load gives their fields', () => {
    const entries = builtinCatalogEntries()
    expect(entries.map(item => [item.kind, item.name, item.source, item.state, item.enabled])).toEqual([
      ['agent', 'explore', 'builtin', 'active', true],
      ['agent', 'general', 'builtin', 'active', true],
    ])
    expect(entries.map(item => item.description)).toEqual(BUILTIN_AGENT_DEFINITIONS.map(definition => definition.description))
    for (const item of entries)
      expect(customizationEntrySchema.safeParse(item).success, item.name).toBe(true)
    expect(loadBuiltin(entries[1]!)).toEqual({
      entry: entries[1],
      definition: { kind: 'agent', fields: { name: 'general', description: entries[1]!.description, tools: null, model: null, instructions: '' } },
      diagnostics: [],
    })
    // Only builtin agents load here.
    expect(loadBuiltin({ ...entries[0]!, source: 'user' })).toBeNull()
    expect(loadBuiltin(entry('skill', 'explore', { source: 'builtin' }))).toBeNull()
    expect(loadBuiltin(entry('agent', 'reviewer', { source: 'builtin' }))).toBeNull()
  })
})

describe('applyPrecedence', () => {
  it('builtin < plugin < user < .claude < .harness: one active winner per kind and name, the losers shadowed by it', () => {
    const merged = applyPrecedence([
      entry('agent', 'reviewer', { source: 'plugin', path: undefined, pluginId: 'acme' }),
      entry('agent', 'reviewer', { source: 'project', path: '.claude/agents/reviewer.md' }),
      entry('agent', 'reviewer', { source: 'project', path: '.harness/agents/reviewer.md' }),
      entry('agent', 'reviewer', { source: 'user', path: undefined, id: 'cus_AAAAAAAAAAAAAAAA' }),
      entry('command', 'review'),
    ])
    expect(merged.map(item => [item.kind, item.name, item.source, item.path ?? item.pluginId ?? item.id, item.state])).toEqual([
      ['agent', 'reviewer', 'project', '.harness/agents/reviewer.md', 'active'],
      ['agent', 'reviewer', 'project', '.claude/agents/reviewer.md', 'shadowed'],
      ['agent', 'reviewer', 'user', 'cus_AAAAAAAAAAAAAAAA', 'shadowed'],
      ['agent', 'reviewer', 'plugin', 'acme', 'shadowed'],
      ['command', 'review', 'project', '.harness/commands/review.md', 'active'],
    ])
    for (const item of merged.filter(candidate => candidate.state === 'shadowed'))
      expect(item.shadowedBy).toEqual({ source: 'project', path: '.harness/agents/reviewer.md' })
    expect(merged[0]?.shadowedBy).toBeUndefined()
  })

  it('invalid and off entries keep their state and shadow nothing; a plugin winner names its plugin', () => {
    const merged = applyPrecedence([
      entry('skill', 'notes', { source: 'plugin', path: undefined, pluginId: 'acme' }),
      entry('skill', 'notes', { source: 'user', path: undefined, id: 'cus_AAAAAAAAAAAAAAAA', enabled: false, state: 'off' }),
      entry('skill', 'notes', { path: '.harness/skills/notes/SKILL.md', state: 'invalid' }),
      entry('agent', 'explore', { source: 'builtin', path: undefined }),
      entry('agent', 'explore', { source: 'plugin', path: undefined, pluginId: 'zeta', state: 'shadowed', shadowedBy: { source: 'project' } }),
    ])
    const notes = merged.filter(item => item.name === 'notes')
    expect(notes.map(item => [item.source, item.state])).toEqual([['plugin', 'active'], ['user', 'off'], ['project', 'invalid']])
    const explore = merged.filter(item => item.name === 'explore')
    expect(explore.map(item => [item.source, item.state, item.shadowedBy])).toEqual([
      ['plugin', 'active', undefined],
      ['builtin', 'shadowed', { source: 'plugin', pluginId: 'zeta' }],
    ])
  })
})

describe('createCatalogSnapshot', () => {
  it('sorts by kind, then name, then the active entry first; indexes only active entries', () => {
    const catalog = createCatalogSnapshot({
      projectId: 'prj_AAAAAAAAAAAAAAAA',
      entries: [
        entry('skill', 'notes'),
        entry('command', 'review', { state: 'shadowed' }),
        entry('command', 'review', { path: '.harness/commands/team/review.md', namespace: 'team' }),
        entry('agent', 'zeta', { state: 'invalid' }),
        ...builtinCatalogEntries(),
      ],
      builtAt: 5,
    })
    expect(catalog.entries.map(item => `${item.kind}:${item.name}:${item.state}`)).toEqual([
      'agent:explore:active',
      'agent:general:active',
      'agent:zeta:invalid',
      'command:review:active',
      'command:review:shadowed',
      'skill:notes:active',
    ])
    expect(catalog.agents().map(item => item.name)).toEqual(['explore', 'general'])
    expect(catalog.agent('zeta')).toBeNull()
    expect(catalog.agent('general-purpose')?.name).toBe('general')
    expect(catalog.command('review')?.namespace).toBe('team')
    expect(catalog.command('/review')?.namespace).toBe('team')
    expect(catalog.skill('notes')?.name).toBe('notes')
    expect(catalog.skill('missing')).toBeNull()
    expect(catalog.project).toBeNull()
    expect(catalog.diagnostics).toEqual([])
    expect(catalog.builtAt).toBe(5)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.entries)).toBe(true)
  })

  it('catalogList answers the route shape, filtered by kind', () => {
    const catalog = createCatalogSnapshot({
      projectId: 'prj_AAAAAAAAAAAAAAAA',
      entries: [...builtinCatalogEntries(), entry('command', 'review')],
      diagnostics: [{ level: 'warning', code: 'link', message: 'A linked folder was skipped.', path: '.harness/agents' }],
      project: { id: 'prj_AAAAAAAAAAAAAAAA', available: true, folders: ['.harness/commands'], scannedAt: 9 },
      builtAt: 9,
    })
    const all = catalogList(catalog)
    expect(customizationListSchema.parse(all)).toEqual(all)
    expect(all.items).toHaveLength(3)
    expect(catalogList(catalog, 'command').items.map(item => item.name)).toEqual(['review'])
    expect(catalogList(catalog, 'skill')).toMatchObject({ items: [], diagnostics: [{ code: 'link' }], project: { folders: ['.harness/commands'] }, builtAt: 9 })
  })

  it('resolveAgentAlias and sortCatalogEntries', () => {
    expect(resolveAgentAlias('general-purpose')).toBe('general')
    expect(resolveAgentAlias('toString')).toBe('toString')
    expect(resolveAgentAlias('reviewer')).toBe('reviewer')
    expect(sortCatalogEntries([entry('skill', 'a'), entry('agent', 'b')]).map(item => item.kind)).toEqual(['agent', 'skill'])
  })
})
