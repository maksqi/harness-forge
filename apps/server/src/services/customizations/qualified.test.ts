// Qualified names and the bare alias (W12.7-T3; ADR-053, open point 8): the rule of `qualified.ts` and the snapshot
// getters `agent` / `command` / `skill` / `style(name)` that use it (a qualified name exactly; a bare name when exactly
// one active entry ends in `:<bare>` and none has the exact name; a harness plugin's `<pluginId>:<name>`; Claude Code's
// agent type names), and the frontmatter keys of the entries (W12.7-T1).
import type { CustomizationEntry, CustomizationKind } from '@harness-forge/shared'
import { parseDefinition } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { entryFromParse, newKeyFields } from './entries.ts'
import { bareAliasNames, findCatalogEntry, isQualifiedName, resolveCatalogName } from './qualified.ts'
import { applyPrecedence, createCatalogSnapshot, resolveAgentAlias } from './snapshot.ts'

function entry(kind: CustomizationKind, name: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  return { kind, name, description: `The ${name} ${kind}.`, source: 'plugin', enabled: true, state: 'active', diagnostics: [], ...fields }
}

describe('resolveCatalogName', () => {
  const entries = [
    { name: 'review-kit:review', source: 'plugin', pluginId: 'review-kit' },
    { name: 'review-kit:db:migrate', source: 'plugin', pluginId: 'review-kit' },
    { name: 'summarize', source: 'plugin', pluginId: 'demo' },
    { name: 'notes', source: 'user' },
  ]

  it('exact names, a unique bare alias, a harness plugin\'s <pluginId>:<name>; nothing else', () => {
    expect(resolveCatalogName(entries, 'review-kit:review')).toBe('review-kit:review')
    expect(resolveCatalogName(entries, 'review')).toBe('review-kit:review')
    expect(resolveCatalogName(entries, 'migrate')).toBe('review-kit:db:migrate')
    expect(resolveCatalogName(entries, 'demo:summarize')).toBe('summarize')
    expect(resolveCatalogName(entries, 'notes')).toBe('notes')
    for (const name of ['db:migrate', 'other:summarize', 'user:notes', 'unknown', '', 'review-kit:db', 'Review'])
      expect(resolveCatalogName(entries, name), name).toBeNull()
  })

  it('an ambiguous alias and an exact name both block the alias', () => {
    expect(resolveCatalogName([...entries, { name: 'other:review', source: 'plugin', pluginId: 'other' }], 'review')).toBeNull()
    expect(resolveCatalogName([...entries, { name: 'review', source: 'user' }], 'review')).toBe('review')
    // The same qualified name twice (a command and a skill of one plugin) is still one name.
    expect(bareAliasNames([...entries, { name: 'review-kit:review' }], 'review')).toEqual(['review-kit:review'])
    expect(isQualifiedName('a:b')).toBe(true)
    expect(isQualifiedName('ab')).toBe(false)
    expect(findCatalogEntry(entries, 'review')?.pluginId).toBe('review-kit')
  })
})

describe('the snapshot getters (W12.7-T3)', () => {
  it('command / skill / agent / style accept qualified names, the bare alias and plugin-qualified bare names', () => {
    const catalog = createCatalogSnapshot({
      projectId: null,
      builtAt: 1,
      entries: applyPrecedence([
        entry('command', 'review-kit:review', { pluginId: 'review-kit' }),
        entry('command', 'summarize', { pluginId: 'demo' }),
        entry('skill', 'review-kit:pdf', { pluginId: 'review-kit' }),
        entry('agent', 'general', { source: 'builtin' }),
        entry('agent', 'explore', { source: 'builtin' }),
        entry('agent', 'review-kit:code-reviewer', { pluginId: 'review-kit' }),
        entry('style', 'review-kit:terse', { pluginId: 'review-kit' }),
        entry('skill', 'tool-a:shared', { pluginId: 'tool-a' }),
        entry('skill', 'tool-b:shared', { pluginId: 'tool-b' }),
      ]),
    })
    expect(catalog.command('review-kit:review')?.name).toBe('review-kit:review')
    expect(catalog.command('/review')?.name).toBe('review-kit:review')
    expect(catalog.command('demo:summarize')?.name).toBe('summarize')
    expect(catalog.command('other:summarize')).toBeNull()
    expect(catalog.skill('pdf')?.name).toBe('review-kit:pdf')
    expect(catalog.skill('shared')).toBeNull()
    expect(catalog.skill('tool-a:shared')?.name).toBe('tool-a:shared')
    expect(catalog.agent('code-reviewer')?.name).toBe('review-kit:code-reviewer')
    expect(catalog.agent('review-kit:code-reviewer')?.name).toBe('review-kit:code-reviewer')
    expect(catalog.agent('general-purpose')?.name).toBe('general')
    expect(catalog.agent('Explore')?.name).toBe('explore')
    expect(catalog.style('terse')?.name).toBe('review-kit:terse')
    // The kinds never mix: a skill name is no command.
    expect(catalog.command('pdf')).toBeNull()
  })

  it('a shadowed or turned-off entry is never an alias target', () => {
    const catalog = createCatalogSnapshot({
      projectId: null,
      builtAt: 1,
      entries: applyPrecedence([entry('command', 'review-kit:review', { pluginId: 'review-kit', state: 'off', enabled: false })]),
    })
    expect(catalog.command('review')).toBeNull()
    expect(catalog.command('review-kit:review')).toBeNull()
    expect(resolveAgentAlias('general-purpose')).toBe('general')
    expect(resolveAgentAlias('reviewer')).toBe('reviewer')
  })
})

describe('the new frontmatter keys in the catalog (W12.7-T1)', () => {
  it('agents, commands and skills list the Phase 12 keys; ignored keys stay infos; v1.7 entries are unchanged', () => {
    const agent = parseDefinition('agent', '---\nname: planner\ndescription: Plans.\ndisallowedTools: Bash, Write\nmaxTurns: 5\ncolor: purple\nskills: [pdf, review-kit:notes]\nmodel: sonnet\npermissionMode: plan\n---\nPlan.')
    expect(entryFromParse('agent', 'user', agent, { fallbackName: 'planner' })).toMatchObject({
      name: 'planner',
      disallowedTools: ['shell', 'write_file'],
      maxTurns: 5,
      color: 'purple',
      skills: ['pdf', 'review-kit:notes'],
      modelAlias: 'sonnet',
      state: 'active',
    })
    expect(entryFromParse('agent', 'user', agent, { fallbackName: 'planner' }).diagnostics.map(item => item.code)).toEqual(expect.arrayContaining(['ignored-key', 'model-alias']))

    const command = parseDefinition('command', '---\nname: ship\ndescription: Ship it.\nwhen_to_use: When the user says ship.\narguments: [env, tag]\ndisallowed-tools: Bash\ncontext: fork\nagent: explore\nmodel: claude-sonnet-4-5\n---\nShip $env.')
    expect(entryFromParse('command', 'project', command, { fallbackName: 'ship', path: '.harness/commands/ship.md' })).toMatchObject({
      whenToUse: 'When the user says ship.',
      arguments: ['env', 'tag'],
      disallowedTools: ['shell'],
      context: 'fork',
      agent: 'explore',
      modelAlias: 'claude-sonnet-4-5',
    })

    const skill = parseDefinition('skill', '---\nname: pdf\ndescription: PDF.\nallowed-tools: Read\nmodel: mock:agents\nwhen_to_use: A PDF is named.\n---\nBody', { folderName: 'pdf' })
    expect(entryFromParse('skill', 'user', skill, { fallbackName: 'pdf' })).toMatchObject({ tools: ['read_file'], modelRef: 'mock:agents', whenToUse: 'A PDF is named.' })

    // A v1.7 definition: exactly the v1.7 entry (no new key appears).
    const old = parseDefinition('command', '---\nname: old\ndescription: Old.\nargument-hint: <x>\nallowed-tools: Read\n---\nOld $1')
    expect(entryFromParse('command', 'user', old, { fallbackName: 'old' })).toEqual({
      kind: 'command',
      source: 'user',
      enabled: true,
      diagnostics: [],
      name: 'old',
      description: 'Old.',
      argumentHint: '<x>',
      tools: ['read_file'],
      state: 'active',
    })
    const oldSkill = parseDefinition('skill', '---\nname: s\ndescription: S.\n---\nBody', { folderName: 's' })
    expect(Object.keys(entryFromParse('skill', 'user', oldSkill, { fallbackName: 's' })).sort()).toEqual(['description', 'diagnostics', 'enabled', 'kind', 'name', 'source', 'state'])
  })

  it('newKeyFields drops values the entry schema would refuse', () => {
    expect(newKeyFields({ maxTurns: 0, color: 'magenta', skills: [''], context: 'inline', agent: 'x', whenToUse: '  ' })).toEqual({})
    expect(newKeyFields({ context: 'fork', agent: 'explore', maxTurns: 200 })).toEqual({ context: 'fork', agent: 'explore', maxTurns: 200 })
  })
})
