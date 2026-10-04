import { parseDefinition } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { AGENT_MARKDOWN, agentCustomization, commandCustomization, commandSummary, customizationEntry, customizationList, definitionDiagnostic } from '~/utils/testing/fixtures'
import {
  argumentHintError,
  bodyDiagnostics,
  bodyError,
  builtinCommandEntries,
  deleteCopy,
  descriptionError,
  diagnosticField,
  draftContent,
  draftDefinition,
  draftFromDefinition,
  draftFromEntry,
  draftFromUser,
  EDITOR_COPY,
  emptyDraft,
  existsError,
  freeName,
  hasRowMenu,
  importDraft,
  importNotes,
  importTooLarge,
  kindFolders,
  kindOfTab,
  middleTruncate,
  nameError,
  rowDiagnostics,
  rowMeta,
  rowMetaItems,
  sectionsOf,
  shadowedTooltip,
  sizeLabel,
  stateBadge,
} from './customize'

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

describe('customize built-in commands and row details (W10.8)', () => {
  it('lists /compact from the command list and the client commands, without a menu', () => {
    const rows = builtinCommandEntries([
      commandSummary({ name: 'compact', description: 'Summarize the conversation', source: 'harness', pluginId: 'core-agent' }),
      commandSummary(),
    ])
    expect(rows.map(row => row.name)).toEqual(['compact', 'effort', 'help', 'mode', 'model', 'new', 'remember'])
    expect(rows[0]).toMatchObject({ kind: 'command', source: 'builtin', state: 'active', description: 'Summarize the conversation' })
    expect(rows.find(row => row.name === 'remember')?.description).toBe('Save a note to your instructions')
    expect(hasRowMenu(rows[0]!)).toBe(false)
    expect(hasRowMenu(customizationEntry({ source: 'builtin', name: 'explore' }))).toBe(true)
    expect(rowMeta(rows[0]!, id => id)).toEqual(['Built-in', 'Reserved: a personal or project command can\'t use this name.'])
  })

  it('names the winner of a shadowed row', () => {
    const name = (id: string) => (id === 'db-tools' ? 'DB tools' : id)
    expect(shadowedTooltip(customizationEntry({ source: 'user', state: 'shadowed', shadowedBy: { source: 'project', path: '.harness/agents/x.md' } }), name))
      .toBe('Not used: the project\'s .harness/agents/x.md wins.')
    expect(shadowedTooltip(customizationEntry({ source: 'plugin', state: 'shadowed', shadowedBy: { source: 'user' } }), name)).toBe('Not used: your personal agent wins.')
    expect(shadowedTooltip(customizationEntry({ kind: 'skill', source: 'builtin', state: 'shadowed', shadowedBy: { source: 'plugin', pluginId: 'db-tools' } }), name))
      .toBe('Not used: the skill from DB tools wins.')
  })

  it('shortens long paths in the middle, filters the folders of a kind and orders diagnostics', () => {
    expect(middleTruncate('.harness/agents/short.md')).toBe('.harness/agents/short.md')
    const long = `.harness/commands/${'deep/'.repeat(10)}review.md`
    const short = middleTruncate(long, 30)
    expect([...short]).toHaveLength(30)
    expect(short.startsWith('.harness/comm')).toBe(true)
    expect(short.endsWith('review.md')).toBe(true)
    expect(kindFolders(['.claude/agents', '.claude/commands', '.harness/agents'], 'agent')).toEqual(['.claude/agents', '.harness/agents'])
    expect(kindFolders(undefined, 'skill')).toEqual([])
    const entry = customizationEntry({ diagnostics: [definitionDiagnostic({ level: 'info' }), definitionDiagnostic({ level: 'error', message: 'Line 2: Add a description.' })] })
    expect(rowDiagnostics(entry).map(diagnostic => diagnostic.level)).toEqual(['error', 'info'])
  })

  it('builds structured meta items with model names and shortened paths', () => {
    const items = rowMetaItems(
      customizationEntry({ path: `.harness/agents/${'x'.repeat(60)}.md`, modelRef: 'mock:echo', namespace: undefined }),
      id => id,
      ref => (ref === 'mock:echo' ? 'Echo' : ref),
    )
    expect(items.map(item => item.text)).toEqual(['Project', expect.stringContaining('…'), 'Echo', '2 tools'])
    expect(items[1]).toMatchObject({ mono: true, title: `.harness/agents/${'x'.repeat(60)}.md` })
  })
})

describe('customize editor rules (W10.8)', () => {
  it('checks names with the editor copy', () => {
    expect(nameError('agent', '')).toBe('Add a name.')
    expect(nameError('agent', 'Reviewer')).toBe('Use lowercase letters, digits and hyphens, starting with a letter.')
    expect(nameError('agent', '1st')).toBe('Use lowercase letters, digits and hyphens, starting with a letter.')
    expect(nameError('command', 'a'.repeat(33))).toBe('Use at most 32 characters.')
    expect(nameError('agent', 'a'.repeat(64))).toBeNull()
    expect(nameError('agent', 'explore')).toBe('explore is a built-in name.')
    expect(nameError('agent', 'general-purpose')).toBe('general-purpose is a built-in name.')
    expect(nameError('command', 'compact')).toBe('compact is a built-in name.')
    expect(nameError('command', 'remember')).toBe('remember is a built-in name.')
    expect(nameError('skill', 'explore')).toBeNull()
  })

  it('checks descriptions, argument hints and the size of the file', () => {
    expect(descriptionError('agent', ' ')).toBe('Add a description.')
    expect(descriptionError('command', '')).toBeNull()
    expect(descriptionError('skill', 'x'.repeat(1025))).toBe('Use at most 1,024 characters.')
    expect(argumentHintError('x'.repeat(101))).toBe('Use at most 100 characters.')
    expect(argumentHintError(null)).toBeNull()
    const big = { ...emptyDraft('agent'), name: 'big', description: 'Big', body: 'x'.repeat(70_000) }
    expect(bodyError(big)).toBe('The file can be up to 64 KB.')
    expect(bodyError({ ...emptyDraft('command'), name: 'go', body: '  ' })).toBe('Add the prompt.')
    expect(bodyError({ ...emptyDraft('skill'), name: 'go', description: 'Go' })).toBeNull()
    expect(sizeLabel(1229)).toBe('1.2 KB / 64 KB')
    expect(existsError('agent', 'reviewer')).toBe('You already have an agent named reviewer.')
    expect(existsError('command', 'go')).toBe('You already have a command named go.')
  })

  it('maps parser diagnostics to the fields', () => {
    expect(diagnosticField({ level: 'warning', code: 'unknown-tool', message: 'x' })).toBe('tools')
    expect(diagnosticField({ level: 'info', code: 'model-alias', message: 'x' })).toBe('model')
    expect(diagnosticField({ level: 'error', code: 'missing-field', message: 'Line 2: Add a description.' })).toBe('description')
    expect(diagnosticField({ level: 'error', code: 'missing-field', message: 'Add the prompt below the frontmatter.' })).toBe('body')
    expect(diagnosticField({ level: 'error', code: 'reserved-name', message: 'x' })).toBe('name')
    expect(diagnosticField({ level: 'warning', code: 'invalid-frontmatter', message: 'x' })).toBeNull()
  })

  it('serializes a draft with formatDefinition and reads it back unchanged (export round trip)', () => {
    const agent = { kind: 'agent' as const, name: 'reviewer', description: 'Reviews diffs: carefully', tools: ['read_file', 'search_files'], model: 'inherit', argumentHint: null, body: 'Review the diff.\n\n- Report bugs.' }
    const parsed = parseDefinition('agent', draftContent(agent))
    expect(parsed.diagnostics).toEqual([])
    expect(draftFromDefinition(parsed.definition!)).toEqual(agent)
    const command = { kind: 'command' as const, name: 'review', description: 'Review a file', tools: null, model: 'mock:echo', argumentHint: ' <file> [focus] ', body: 'Review $1 for $2.' }
    expect(draftDefinition(command)).toEqual({ kind: 'command', fields: { name: 'review', description: 'Review a file', argumentHint: '<file> [focus]', model: 'mock:echo', allowedTools: null, body: 'Review $1 for $2.' } })
    expect(draftFromDefinition(parseDefinition('command', draftContent(command)).definition!)).toEqual({ ...command, argumentHint: '<file> [focus]' })
    // A command never inherits a model.
    expect(draftDefinition({ ...command, model: 'inherit' }).fields).toMatchObject({ model: null })
    const skill = { kind: 'skill' as const, name: 'release-notes', description: 'Write release notes', tools: null, model: null, argumentHint: null, body: '# Notes' }
    expect(draftFromDefinition(parseDefinition('skill', draftContent(skill)).definition!)).toEqual(skill)
  })

  it('finds a free name for a copy within the length of the kind', () => {
    expect(freeName('agent', 'reviewer', ['reviewer'])).toBe('reviewer-copy')
    expect(freeName('agent', 'reviewer', ['reviewer', 'reviewer-copy', 'reviewer-copy-2'])).toBe('reviewer-copy-3')
    const long = freeName('command', 'a'.repeat(32), [])
    expect(long).toHaveLength(32)
    expect(long.endsWith('-copy')).toBe(true)
  })

  it('words the delete confirmation per kind', () => {
    expect(deleteCopy('agent', 'reviewer')).toEqual({
      title: 'Delete reviewer?',
      description: 'Chats that used it keep their messages. The agent can\'t start it anymore.',
      confirm: 'Delete agent',
      toast: 'Deleted reviewer',
    })
    expect(deleteCopy('command', 'go').description).toBe('Chats that used it keep their messages. You can\'t run /go anymore.')
    expect(deleteCopy('skill', 'notes')).toMatchObject({ description: 'Chats that used it keep their messages. The agent can\'t load it anymore.', confirm: 'Delete skill' })
  })

  it('moves body diagnostics to the lines of the body editor', () => {
    const content = '---\nname: x\n---\n\nline one\nline two\n'
    const diagnostics = [
      { level: 'warning' as const, code: 'invalid-field' as const, message: 'Line 2: front', line: 2 },
      { level: 'warning' as const, code: 'invalid-field' as const, message: 'Line 6: body', line: 6 },
      { level: 'error' as const, code: 'too-large' as const, message: 'no line' },
    ]
    expect(bodyDiagnostics(content, 'line one\nline two', diagnostics)).toEqual([{ ...diagnostics[1], line: 2 }])
    expect(bodyDiagnostics(content, '\n\nline one\nline two', diagnostics)).toEqual([{ ...diagnostics[1], line: 4 }])
    expect(bodyDiagnostics('no frontmatter', 'x', diagnostics)).toEqual([])
  })
})

describe('customize import (W10.8)', () => {
  it('gathers ignored keys into one note and keeps the other messages as the parser wrote them', () => {
    expect(importNotes([
      { level: 'info', code: 'ignored-key', message: 'Line 5: The key "color" is ignored.', line: 5 },
      { level: 'warning', code: 'unknown-tool', message: 'Line 4: The tool "Task" is unknown and was dropped.', line: 4 },
      { level: 'info', code: 'ignored-key', message: 'Line 6: The key "permissionMode" is ignored.', line: 6 },
    ])).toEqual(['Ignored: color, permissionMode', 'Line 4: The tool "Task" is unknown and was dropped.'])
  })

  it('starts the notes with the file and ignores keys of a Claude Code agent', async () => {
    const file = new File(['---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\ncolor: blue\n---\nReview.\n'], 'reviewer.md')
    const { draft, notes } = await importDraft(file, 'agent')
    expect(draft).toMatchObject({ name: 'reviewer', tools: ['read_file', 'search_files'], model: null, body: 'Review.' })
    expect(notes[0]).toBe('Imported from reviewer.md. Check the fields, then save.')
    expect(notes).toContain('Ignored: color')
    expect(notes.some(note => note.includes('provider'))).toBe(true)
  })

  it('keeps the fields of a SKILL.md without a name and leaves the name to the user', async () => {
    const file = new File(['---\ndescription: Write release notes\n---\nUse the changelog.\n'], 'SKILL.md')
    const { draft, notes } = await importDraft(file, 'skill')
    expect(draft).toEqual({ kind: 'skill', name: '', description: 'Write release notes', tools: null, model: null, argumentHint: null, body: 'Use the changelog.' })
    expect(notes.slice(1)).toEqual(['Add a name.'])
  })

  it('keeps the text of a file that cannot be parsed as the body, and refuses files over 256 KB', async () => {
    const text = '---\nname: [unclosed\n'
    const { draft, notes } = await importDraft(new File([text], 'broken.md'), 'command')
    expect(draft).toMatchObject({ kind: 'command', name: '', body: text })
    expect(notes.length).toBeGreaterThan(1)
    const huge = new File(['x'.repeat(256 * 1024 + 1)], 'huge.md')
    expect(importTooLarge(huge)).toEqual({ title: 'huge.md is too large', description: 'Definition files can be up to 64 KB.' })
    expect(importTooLarge(new File(['x'], 'small.md'))).toBeNull()
    await expect(importDraft(huge, 'agent')).rejects.toBeInstanceOf(RangeError)
  })
})
