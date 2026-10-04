import { describe, expect, it } from 'vitest'
import { AGENT_MARKDOWN, agentCustomization, commandCustomization, customizationEntry, customizationList, definitionDiagnostic } from '~/utils/testing/fixtures'
import { draftFromEntry, draftFromUser, EDITOR_COPY, emptyDraft, importDraft, kindOfTab, rowMeta, sectionsOf, stateBadge } from './customize'

const pluginName = (id: string) => (id === 'db-tools' ? 'DB tools' : id)

describe('customize sections', () => {
  it('lists Personal, the project, plugins (when any) and Built-in in that order', () => {
    const list = customizationList({
      items: [
        ...customizationList().items,
        customizationEntry({ name: 'mine', source: 'user', id: 'cus_sample0000000001', path: undefined }),
        customizationEntry({ name: 'sql-expert', source: 'plugin', pluginId: 'db-tools', path: undefined }),
        customizationEntry({ kind: 'command', name: 'review', source: 'project', path: '.harness/commands/review.md' }),
      ],
    })
    expect(sectionsOf(list, 'agent').map(section => [section.source, section.entries.map(entry => entry.name)])).toEqual([
      ['user', ['mine']],
      ['project', ['reviewer']],
      ['plugin', ['sql-expert']],
      ['builtin', ['explore', 'general']],
    ])
    expect(sectionsOf(list, 'command').map(section => section.source)).toEqual(['user', 'project', 'builtin'])
    expect(sectionsOf(customizationList({ project: null }), 'skill').map(section => section.source)).toEqual(['user'])
    expect(sectionsOf(null, 'agent').map(section => section.source)).toEqual(['user', 'builtin'])
  })

  it('reads the tab of the query (agents when missing or unknown)', () => {
    expect(kindOfTab('commands')).toBe('command')
    expect(kindOfTab(['skills'])).toBe('skill')
    expect(kindOfTab('nope')).toBe('agent')
    expect(kindOfTab(undefined)).toBe('agent')
  })
})

describe('customize rows', () => {
  it('gives each state its badge, warnings only for active rows', () => {
    expect(stateBadge(customizationEntry({ state: 'shadowed' }))).toEqual({ label: 'Shadowed', tone: 'muted' })
    expect(stateBadge(customizationEntry({ state: 'invalid' }))).toEqual({ label: 'Invalid', tone: 'destructive' })
    expect(stateBadge(customizationEntry({ state: 'off' }))).toEqual({ label: 'Off', tone: 'muted' })
    expect(stateBadge(customizationEntry({ diagnostics: [definitionDiagnostic(), definitionDiagnostic()] }))).toEqual({ label: '2 warnings', tone: 'warning' })
    expect(stateBadge(customizationEntry())).toBeNull()
  })

  it('builds the meta line: source, path, model, tools, argument hint', () => {
    expect(rowMeta(customizationEntry(), pluginName)).toEqual(['Project', '.harness/agents/reviewer.md', '2 tools'])
    expect(rowMeta(customizationEntry({ source: 'plugin', pluginId: 'db-tools', path: undefined, tools: undefined, modelRef: 'inherit' }), pluginName))
      .toEqual(['DB tools', 'Same as the chat', 'All tools'])
    expect(rowMeta(customizationEntry({ kind: 'command', name: 'review', source: 'user', path: undefined, tools: ['read_file'], argumentHint: '<file>' }), pluginName))
      .toEqual(['Personal', 'Tools limited to 1', '<file>'])
  })
})

describe('customize drafts', () => {
  it('drafts a personal definition from its parsed fields', () => {
    expect(draftFromUser(agentCustomization())).toEqual({
      kind: 'agent',
      name: 'reviewer',
      description: 'Reviews a diff and reports bugs',
      tools: ['read_file', 'search_files'],
      model: null,
      argumentHint: null,
      body: 'Review the diff. Report each bug with its file and line.\n',
    })
    expect(draftFromUser(commandCustomization())).toMatchObject({ kind: 'command', name: 'greet', argumentHint: '<name>', model: 'mock:echo', tools: null })
  })

  it('drafts a catalog entry from its file with the shared parser', () => {
    const draft = draftFromEntry(customizationEntry(), AGENT_MARKDOWN)
    expect(draft).toMatchObject({ kind: 'agent', name: 'reviewer', description: 'Reviews a diff and reports bugs' })
    expect(draft.tools).toEqual(expect.arrayContaining(['read_file']))
  })

  it('imports a file as a draft with one note per diagnostic', async () => {
    const file = new File(['\uFEFF---\r\nname: reviewer\r\ndescription: Reviews diffs\r\ncolor: blue\r\n---\r\nReview it.\r\n'], 'reviewer.md', { type: 'text/markdown' })
    const { draft, notes } = await importDraft(file, 'agent')
    expect(draft).toMatchObject({ kind: 'agent', name: 'reviewer', description: 'Reviews diffs', body: 'Review it.' })
    expect(notes.length).toBeGreaterThan(0)
    expect(emptyDraft('skill')).toEqual({ kind: 'skill', name: '', description: '', tools: null, model: null, argumentHint: null, body: '' })
    expect(EDITOR_COPY.command.save).toBe('Save command')
  })
})
