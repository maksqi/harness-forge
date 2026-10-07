import type { ParsedDefinition } from '@harness-forge/shared'
import { formatDefinition, parseDefinition } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { AGENT_MARKDOWN, agentCustomization, commandCustomization, commandSummary, customizationEntry, customizationList, definitionDiagnostic, projectTrustList, styleCustomization, styleEntry, trustCommandItem, trustSha } from '~/utils/testing/fixtures'
import {
  AGENT_COLOR_LABELS,
  argumentHintError,
  ARGUMENTS_HELP,
  bareName,
  bodyDiagnostics,
  bodyError,
  builtinCommandEntries,
  checkProjectFile,
  CUSTOMIZE_TAB_ORDER,
  CUSTOMIZE_TAB_VALUES,
  deleteCopy,
  descriptionError,
  diagnosticField,
  displayName,
  draftContent,
  draftDefinition,
  draftFromDefinition,
  draftFromEntry,
  draftFromUser,
  EDITOR_COPY,
  EDITOR_FIELD_COPY,
  emptyDraft,
  existsError,
  freeName,
  hasRowMenu,
  importDraft,
  importNotes,
  importTooLarge,
  isEditableProjectEntry,
  isScopeDefault,
  kindFolders,
  kindOfTab,
  maxTurnsError,
  maxTurnsValue,
  mcpServersOf,
  mcpServersText,
  middleTruncate,
  nameError,
  newProjectFileContent,
  newProjectFilePath,
  pendingCommandTrust,
  PERSONAL_EMPTY,
  projectDeleteCopy,
  projectEmpty,
  projectFileName,
  projectFileTitle,
  projectSavedText,
  rowDiagnostics,
  rowMeta,
  rowMetaItems,
  sectionsOf,
  shadowedTooltip,
  sizeLabel,
  skillsError,
  stateBadge,
  styleDefaultBadges,
  TAB_REVEAL_INSET,
  tabOf,
  tabRevealOffset,
  whenToUseError,
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

  it('reads the Phase 11 tabs: the four kinds and the hooks, in order', () => {
    expect(CUSTOMIZE_TAB_ORDER.map(tab => CUSTOMIZE_TAB_VALUES[tab])).toEqual(['agents', 'commands', 'skills', 'output-styles', 'hooks'])
    expect(tabOf('hooks')).toBe('hook')
    expect(tabOf(['output-styles'])).toBe('style')
    expect(tabOf('nope')).toBe('agent')
    expect(tabOf(undefined)).toBe('agent')
    // The definition kind of the hooks tab falls back to agents (the page's New button, W11.8).
    expect(kindOfTab('hooks')).toBe('agent')
    expect(kindFolders(['.harness/output-styles', '.claude/output-styles', '.harness/agents'], 'style')).toEqual(['.harness/output-styles', '.claude/output-styles'])
  })

  it('tabRevealOffset: how far the tab row scrolls so the active tab shows whole, with the inset beside it (W11.19)', () => {
    const row = { left: 0, right: 358 }
    expect(TAB_REVEAL_INSET).toBe(16)
    // Visible with room on both sides: no scroll.
    expect(tabRevealOffset(row, { left: 100, right: 200 })).toBe(0)
    // Cut off at the end, or too close to it: forward to the tab's end plus the inset.
    expect(tabRevealOffset(row, { left: 391, right: 472 })).toBe(472 + 16 - 358)
    expect(tabRevealOffset(row, { left: 300, right: 350 })).toBe(8)
    // Cut off at the start: back to the tab's start minus the inset.
    expect(tabRevealOffset(row, { left: -50, right: 30 })).toBe(-66)
    // A tab wider than the row keeps its start in view.
    expect(tabRevealOffset(row, { left: 40, right: 600 })).toBe(24)
    // A row with its own offset in the viewport, and another inset.
    expect(tabRevealOffset({ left: 240, right: 960 }, { left: 900, right: 980 }, 0)).toBe(20)
    expect(tabRevealOffset({ left: 240, right: 960 }, { left: 240, right: 320 }, 0)).toBe(0)
  })

  it('keeps the style and skill fields of a parsed definition in the draft and writes them back (Phase 11)', () => {
    const style = draftFromDefinition({ kind: 'style', fields: { name: 'terse', label: 'terse', description: 'Short', keepCodingInstructions: true, content: 'Be short.' } })
    expect(style).toMatchObject({ kind: 'style', keepCodingInstructions: true, body: 'Be short.' })
    expect(draftDefinition(style)).toEqual({ kind: 'style', fields: { name: 'terse', label: 'terse', description: 'Short', keepCodingInstructions: true, content: 'Be short.' } })
    const skill = draftFromDefinition({ kind: 'skill', fields: { name: 'deploy', description: 'Deploy', content: 'Ship it.', userInvocable: false, modelInvocable: false, argumentHint: '<env>' } })
    expect(skill).toMatchObject({ userInvocable: false, modelInvocable: false, argumentHint: '<env>' })
    expect(draftDefinition(skill)).toEqual({ kind: 'skill', fields: { name: 'deploy', description: 'Deploy', content: 'Ship it.', userInvocable: false, modelInvocable: false, argumentHint: '<env>' } })
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
    expect(rows.map(row => row.name)).toEqual(['compact', 'effort', 'help', 'mode', 'model', 'new', 'output-style', 'remember'])
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
    // Phase 12: `color` is read now (ADR-058); `effort` is still ignored.
    const file = new File(['---\nname: reviewer\ndescription: Reviews diffs\ntools: Read, Grep\nmodel: sonnet\neffort: high\n---\nReview.\n'], 'reviewer.md')
    const { draft, notes } = await importDraft(file, 'agent')
    expect(draft).toMatchObject({ name: 'reviewer', tools: ['read_file', 'search_files'], model: null, body: 'Review.' })
    expect(notes[0]).toBe('Imported from reviewer.md. Check the fields, then save.')
    expect(notes).toContain('Ignored: effort')
    expect(notes.some(note => note.includes('model alias'))).toBe(true)
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

describe('customize output styles and skills (W11.8-T6, T7)', () => {
  it('shows a style by its label with the slug and the coding-instructions meta', () => {
    const style = styleEntry({ name: 'my-style', label: 'My Style', keepCodingInstructions: false })
    expect(displayName(style)).toBe('My Style')
    expect(displayName(styleEntry({ label: undefined }))).toBe('terse')
    expect(displayName(customizationEntry({ kind: 'command', name: 'deploy' }))).toBe('/deploy')
    expect(rowMeta(style, pluginName)).toEqual(['Project', 'my-style', '.harness/output-styles/terse.md', 'Replaces coding instructions'])
    expect(rowMeta(styleEntry({ label: 'terse', source: 'builtin', path: undefined }), pluginName)).toEqual(['Built-in', 'Keeps coding instructions'])
    expect(rowMetaItems(style, pluginName)[1]).toEqual({ text: 'my-style', mono: true })
  })

  it('shows how a skill runs: /name in the slash menu, Only when you run it', () => {
    const skill = customizationEntry({ kind: 'skill', name: 'deploy', source: 'user', path: undefined, tools: undefined, argumentHint: '<env>' })
    expect(rowMeta(skill, pluginName)).toEqual(['Personal', '/deploy', '<env>'])
    expect(rowMeta({ ...skill, userInvocable: false, modelInvocable: true }, pluginName)).toEqual(['Personal', '<env>'])
    expect(rowMeta({ ...skill, argumentHint: undefined, modelInvocable: false }, pluginName)).toEqual(['Personal', '/deploy', 'Only when you run it'])
  })

  it('badges the global and the project default and knows the scope default', () => {
    const terse = styleEntry()
    expect(styleDefaultBadges(terse, { global: 'terse', project: null, projectName: null })).toEqual(['Your default'])
    expect(styleDefaultBadges(terse, { global: 'default', project: 'terse', projectName: 'website' })).toEqual(['Default in website'])
    expect(styleDefaultBadges(terse, { global: 'terse', project: 'terse', projectName: 'website' })).toEqual(['Your default', 'Default in website'])
    expect(styleDefaultBadges({ ...terse, state: 'shadowed' }, { global: 'terse', project: null, projectName: null })).toEqual([])
    expect(styleDefaultBadges(customizationEntry(), { global: 'reviewer', project: null, projectName: null })).toEqual([])
    expect(styleDefaultBadges(terse, null)).toEqual([])
    expect(isScopeDefault(terse, { global: 'terse', project: null, projectName: null })).toBe(true)
    expect(isScopeDefault(terse, { global: 'terse', project: null, projectName: 'website' })).toBe(false)
    expect(isScopeDefault(terse, { global: 'default', project: 'terse', projectName: 'website' })).toBe(true)
  })

  it('finds the pending trust item of a project command with `!` lines', () => {
    const command = customizationEntry({ kind: 'command', name: 'status', path: '.claude/commands/status.md' })
    const pending = trustCommandItem({ state: 'pending', sha256: trustSha(5) })
    expect(pendingCommandTrust(command, projectTrustList({ items: [pending] }))).toEqual(pending)
    expect(pendingCommandTrust(command, projectTrustList())).toBeNull()
    expect(pendingCommandTrust({ ...command, source: 'user' }, projectTrustList({ items: [pending] }))).toBeNull()
    expect(pendingCommandTrust(command, null)).toBeNull()
  })

  it('keeps a style\'s label on save while the name is its slug', () => {
    const draft = draftFromUser(styleCustomization())
    expect(draft).toMatchObject({ kind: 'style', name: 'terse', label: 'Terse', keepCodingInstructions: true })
    expect(draftContent(draft)).toBe('---\nname: Terse\ndescription: Short answers without preamble\nkeep-coding-instructions: true\n---\n\nAnswer in at most three sentences.\n')
    const renamed = draftDefinition({ ...draft, name: 'short' })
    expect(renamed).toMatchObject({ kind: 'style', fields: { name: 'short', label: 'short' } })
    // The round trip through the shared parser keeps every field.
    expect(draftFromDefinition(parseDefinition('style', draftContent(draft)).definition!)).toEqual({ ...draft, body: draft.body.trimEnd() })
  })

  it('round-trips the skill keys through formatDefinition', () => {
    const skill = { ...emptyDraft('skill'), name: 'deploy', description: 'Deploy the app', argumentHint: '<env>', body: 'Run the deploy.', userInvocable: false, modelInvocable: false }
    const content = draftContent(skill)
    expect(content).toContain('user-invocable: false')
    expect(content).toContain('disable-model-invocation: true')
    expect(content).toContain('argument-hint: <env>')
    expect(draftFromDefinition(parseDefinition('skill', content).definition!)).toEqual(skill)
  })

  it('words the style copy of Phase 11', () => {
    expect(EDITOR_COPY.style).toMatchObject({ title: 'output style', save: 'Save output style', bodyHelp: 'How the agent writes its replies. They go first in the main agent\'s instructions, never in sub-agents\'.' })
    expect(deleteCopy('style', 'terse')).toEqual({ title: 'Delete terse?', description: 'Chats that use it fall back to Default.', confirm: 'Delete output style', toast: 'Deleted terse' })
    expect(PERSONAL_EMPTY.style).toBe('No personal output styles yet. A style changes how the agent writes its replies.')
    expect(projectEmpty('style', 'website')).toBe('No output styles in website. Add Markdown files to .harness/output-styles/ (or .claude/output-styles/) in the project folder.')
    expect(nameError('style', 'learning')).toBe('learning is a built-in name.')
    expect(existsError('style', 'terse')).toBe('You already have an output style named terse.')
  })
})

describe('newProjectFilePath (Phase 12, C46)', () => {
  it('names the file of a new project definition', () => {
    expect(newProjectFilePath('agent', '.claude', 'reviewer')).toBe('.claude/agents/reviewer.md')
    expect(newProjectFilePath('command', '.harness', 'deploy')).toBe('.harness/commands/deploy.md')
    expect(newProjectFilePath('skill', '.claude', 'pdf')).toBe('.claude/skills/pdf/SKILL.md')
    expect(newProjectFilePath('style', '.harness', 'terse')).toBe('.harness/output-styles/terse.md')
    expect(newProjectFilePath('mcp', '.claude', '')).toBe('.mcp.json')
  })
})

describe('customize Claude Code keys (Phase 12, W12.11-T3)', () => {
  function parsed(kind: 'agent' | 'command' | 'skill', text: string, fileName = 'x.md', folderName?: string): ParsedDefinition {
    const result = parseDefinition(kind, text, { fileName, ...(folderName ? { folderName } : {}) })
    expect(result.diagnostics.filter(diagnostic => diagnostic.level === 'error')).toEqual([])
    return result.definition!
  }

  it('round-trips an agent\'s new keys through the draft (formatDefinition writes them only when set)', () => {
    const definition = parsed('agent', '---\nname: reviewer\ndescription: Reviews\ndisallowedTools: Bash, Write\nmaxTurns: 12\ncolor: purple\nskills: [pdf, docs]\nmodel: sonnet\n---\nReview.\n')
    const draft = draftFromDefinition(definition)
    expect(draft).toMatchObject({ kind: 'agent', maxTurns: 12, color: 'purple', skills: ['pdf', 'docs'], modelAlias: 'sonnet', model: null })
    expect(draft.disallowedTools?.length).toBe(2)
    expect(draftContent(draft)).toBe(formatDefinition(definition))
    // Without the keys the draft has none of them (a Phase 10 agent stays as it was).
    expect(Object.keys(draftFromDefinition(parsed('agent', '---\nname: a\ndescription: b\n---\nc\n')))).toEqual(['kind', 'name', 'description', 'tools', 'model', 'argumentHint', 'body'])
    // A chosen model replaces the Claude model name.
    expect(draftContent({ ...draft, model: 'mock:echo' })).toContain('model: mock:echo')
    expect(draftContent({ ...draft, model: 'mock:echo' })).not.toContain('sonnet')
  })

  it('round-trips a command and a skill with when_to_use, arguments, disallowed tools and a fork', () => {
    const command = parsed('command', '---\ndescription: Deploy\nwhen_to_use: After a merge\narguments: [env]\ndisallowed-tools: [Write]\ncontext: fork\nagent: explore\n---\nDeploy $env.\n', 'deploy.md')
    const commandDraft = draftFromDefinition(command)
    expect(commandDraft).toMatchObject({ whenToUse: 'After a merge', arguments: ['env'], fork: true, forkAgent: 'explore' })
    expect(draftContent(commandDraft)).toBe(formatDefinition(command))

    const skill = parsed('skill', '---\nname: pdf\ndescription: Fill PDFs\nallowed-tools: [Read]\nmodel: mock:echo\ncontext: fork\n---\nFill it.\n', 'SKILL.md', 'pdf')
    const skillDraft = draftFromDefinition(skill)
    expect(skillDraft).toMatchObject({ kind: 'skill', model: 'mock:echo', fork: true })
    expect(skillDraft.tools?.length).toBe(1)
    expect(skillDraft.forkAgent).toBeUndefined()
    expect(draftContent(skillDraft)).toBe(formatDefinition(skill))
    // Turning the fork off drops context and agent.
    expect(draftContent({ ...commandDraft, fork: false })).not.toMatch(/context:|agent:/)
  })

  it('drafts a qualified plugin entry under its bare name', () => {
    const entry = customizationEntry({ kind: 'command', name: 'review-kit:db:migrate', source: 'plugin', pluginId: 'review-kit', path: undefined, tools: undefined })
    expect(bareName(entry)).toBe('migrate')
    expect(bareName(customizationEntry())).toBe('reviewer')
    const draft = draftFromEntry(entry, '---\nname: review-kit:db:migrate\ndescription: Run the migrations\n---\nMigrate.\n')
    expect(draft).toMatchObject({ kind: 'command', name: 'migrate', description: 'Run the migrations' })
    expect(draftFromEntry(entry, '---\ndescription: Run the migrations\n---\nMigrate.\n').name).toBe('migrate')
  })

  it('shows "Runs in a sub-agent" for fork skills and commands', () => {
    const fork = customizationEntry({ kind: 'skill', name: 'pdf', source: 'user', path: undefined, tools: undefined, context: 'fork', agent: 'explore' })
    expect(rowMeta(fork, pluginName)).toContain('Runs in a sub-agent')
    expect(rowMeta({ ...fork, context: undefined }, pluginName)).not.toContain('Runs in a sub-agent')
  })

  it('checks Max turns, Skills and When to use with the editor copy', () => {
    expect(maxTurnsValue('12')).toBe(12)
    expect(maxTurnsValue(' 200 ')).toBe(200)
    for (const bad of ['0', '201', '1.5', '-3', 'ten', ''])
      expect(maxTurnsValue(bad)).toBeNull()
    expect(maxTurnsError('')).toBeNull()
    expect(maxTurnsError('201')).toBe('Enter a whole number from 1 to 200.')
    expect(skillsError(['a', 'b', 'c', 'd', 'e'])).toBeNull()
    expect(skillsError(['a', 'b', 'c', 'd', 'e', 'f'])).toBe('Choose at most 5 skills.')
    expect(whenToUseError('x'.repeat(1024))).toBeNull()
    expect(whenToUseError('x'.repeat(1025))).toBe('Use at most 1,024 characters.')
    expect(AGENT_COLOR_LABELS.purple).toBe('Purple')
  })

  it('words the editor copy of skills like commands and names the Claude argument placeholders', () => {
    expect(EDITOR_FIELD_COPY.skill).toMatchObject({ toolsLabel: 'Allowed tools', toolsAll: 'No restriction', modelNone: 'The chat\'s model' })
    expect(ARGUMENTS_HELP).toBe('$ARGUMENTS[0] or $0 is the first argument when the file uses them or declares arguments; $name reads a named argument; ' + '$' + '{CLAUDE_SKILL_DIR} is the skill\'s folder.')
    expect(EDITOR_COPY.command.bodyHelp.endsWith(ARGUMENTS_HELP)).toBe(true)
    expect(EDITOR_COPY.skill.bodyHelp.endsWith(ARGUMENTS_HELP)).toBe(true)
  })
})

describe('customize project files (Phase 12, W12.11-T1, T2)', () => {
  it('tells which project rows can be edited and names their files', () => {
    expect(isEditableProjectEntry(customizationEntry({ path: '.claude/agents/reviewer.md' }))).toBe(true)
    expect(isEditableProjectEntry(customizationEntry({ kind: 'skill', path: '.harness/skills/pdf/SKILL.md' }))).toBe(true)
    expect(isEditableProjectEntry(customizationEntry({ kind: 'command', path: '.claude/commands/a/b/c/d/deep.md' }))).toBe(false)
    expect(isEditableProjectEntry(customizationEntry({ path: '.claude/commands/reviewer.md' }))).toBe(false)
    expect(isEditableProjectEntry(customizationEntry({ source: 'plugin', pluginId: 'x', path: undefined }))).toBe(false)
    expect(projectFileName('.claude/agents/reviewer.md')).toBe('reviewer.md')
    expect(projectFileName('.claude/skills/pdf/SKILL.md')).toBe('pdf/SKILL.md')
    expect(projectFileName('.mcp.json')).toBe('.mcp.json')
    expect(projectFileTitle({ kind: 'agent', path: '.claude/agents/reviewer.md' }, 'edit', 'website')).toBe('Edit reviewer.md')
    expect(projectFileTitle({ kind: 'style', path: '.harness/output-styles/x.md' }, 'new', 'website')).toBe('New output style in website')
    expect(projectFileTitle({ kind: 'mcp', path: '.mcp.json' }, 'new', null)).toBe('New .mcp.json in this project')
  })

  it('words the save toast and the delete confirmation', () => {
    expect(projectSavedText('.claude/agents/a.md', 0)).toBe('Saved .claude/agents/a.md.')
    expect(projectSavedText('.mcp.json', 1)).toBe('Saved .mcp.json. 1 item needs your approval.')
    expect(projectSavedText('.mcp.json', 3)).toBe('Saved .mcp.json. 3 items need your approval.')
    expect(projectDeleteCopy('.claude/agents/a.md')).toEqual({
      title: 'Delete .claude/agents/a.md?',
      description: 'The file is removed from the project folder. It can\'t be undone here.',
      confirm: 'Delete file',
      toast: 'Deleted .claude/agents/a.md',
    })
  })

  it('starts a new definition with a frontmatter that asks for its description', () => {
    expect(newProjectFileContent('agent', 'reviewer')).toBe('---\nname: reviewer\ndescription: \n---\n\n')
    expect(newProjectFileContent('command', 'deploy')).toBe('---\ndescription: \n---\n\n')
    expect(newProjectFileContent('skill', '')).toBe('---\ndescription: \n---\n\n')
    expect(checkProjectFile('agent', '.claude/agents/reviewer.md', newProjectFileContent('agent', 'reviewer')).blocked).toBe(true)
  })

  it('shows the mcpServers object of .mcp.json and reads it back with or without the wrapper', () => {
    expect(mcpServersText(null)).toBe('{}\n')
    expect(mcpServersText('{ "mcpServers": { "a": { "command": "x" } }, "other": 1 }')).toBe('{\n  "a": {\n    "command": "x"\n  }\n}\n')
    expect(mcpServersText('not json')).toBe('not json')
    expect(mcpServersOf('{ "a": { "command": "x" } }')).toEqual({ a: { command: 'x' } })
    expect(mcpServersOf('{ "mcpServers": { "a": { "command": "x" } } }')).toEqual({ a: { command: 'x' } })
    expect(mcpServersOf('  ')).toBeNull()
    expect(() => mcpServersOf('[1]')).toThrow(SyntaxError)
    expect(() => mcpServersOf('{')).toThrow(SyntaxError)
  })

  it('checks a project file with the shared parsers: summary, color, problems and markers', () => {
    const agent = checkProjectFile('agent', '.claude/agents/reviewer.md', '---\nname: reviewer\ndescription: Reviews\ndisallowedTools: Bash\nmaxTurns: 12\ncolor: purple\npermissionMode: plan\n---\nReview.\n')
    expect(agent.summary[0]).toBe('Agent reviewer')
    expect(agent.summary).toContain('Max turns 12')
    expect(agent.summary.some(item => item.startsWith('Not allowed: '))).toBe(true)
    expect(agent.color).toBe('purple')
    expect(agent.blocked).toBe(false)
    expect(agent.problems.some(problem => problem.level === 'info' && problem.message.includes('permissionMode'))).toBe(true)
    expect(agent.markers.every(marker => marker.line !== undefined)).toBe(true)

    const broken = checkProjectFile('command', '.claude/commands/deploy.md', '---\ndescription: [\n---\n')
    expect(broken.blocked).toBe(true)
    expect(broken.problems[0]?.level).toBe('error')

    const skill = checkProjectFile('skill', '.claude/skills/pdf/SKILL.md', '---\ndescription: Fill PDFs\ncontext: fork\n---\nFill.\n')
    expect(skill.summary).toEqual(['Skill pdf', 'Runs in a sub-agent (general)'])

    expect(checkProjectFile('mcp', '.mcp.json', '{ "a": { "command": "x" }, "b": { "type": "http", "url": "https://mcp.example.test/mcp" } }').summary).toEqual(['2 servers'])
    expect(checkProjectFile('mcp', '.mcp.json', '{}').summary).toEqual(['0 servers'])
    const invalid = checkProjectFile('mcp', '.mcp.json', '{ "a": ')
    expect(invalid).toMatchObject({ blocked: true, problems: [{ level: 'error', message: 'This isn\'t valid JSON.' }] })
    const bad = checkProjectFile('mcp', '.mcp.json', '{ "a": { "type": "http", "url": "ftp://example.test" } }')
    expect(bad.blocked).toBe(true)
    expect(bad.problems[0]?.message.startsWith('a: ')).toBe(true)
  })
})
