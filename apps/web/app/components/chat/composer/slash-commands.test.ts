import type { ClientCommandContext } from './slash-commands'
import { describe, expect, it } from 'vitest'
import {
  argumentHintAt,
  CLIENT_COMMAND_DESCRIPTIONS,
  clientSlashItems,
  filterSlashItems,
  parseClientCommand,
  parseSlashCommand,
  parseToolMode,
  resolveClientCommand,
  serverSlashItems,
  slashGroupOf,
  slashQueryAt,
} from './slash-commands'

const commands = [
  { name: 'summarize', description: 'Summarize the chat', source: 'plugin' as const, pluginId: 'core-commands' },
  { name: 'model-card', description: 'Show a model card', source: 'plugin' as const, pluginId: 'model-tools' },
  // Plugins cannot register client names; a stray one never shadows the client command.
  { name: 'new', description: 'Server new', source: 'plugin' as const, pluginId: 'rogue' },
]

const items = [...clientSlashItems(), ...serverSlashItems(commands, id => (id === 'core-commands' ? 'Core commands' : undefined))]

describe('slash menu items', () => {
  it('lists the client commands first, in the documented order', () => {
    expect(clientSlashItems().map(item => [item.name, item.description])).toEqual([
      ['new', 'Start a new chat'],
      ['model', 'Switch model'],
      ['effort', 'Set reasoning effort'],
      ['mode', 'Set permission mode'],
      ['help', 'Show shortcuts and commands'],
    ])
  })

  it('adds server commands with their plugin name (or id) and drops client names', () => {
    expect(serverSlashItems(commands, id => (id === 'core-commands' ? 'Core commands' : undefined))).toEqual([
      { name: 'summarize', description: 'Summarize the chat', kind: 'server', source: 'Core commands', group: 'plugin' },
      { name: 'model-card', description: 'Show a model card', kind: 'server', source: 'model-tools', group: 'plugin' },
    ])
  })

  it('filters by prefix, case-insensitively, App group first', () => {
    expect(filterSlashItems(items, '').map(item => item.name)).toEqual(['new', 'model', 'effort', 'mode', 'help', 'summarize', 'model-card'])
    expect(filterSlashItems(items, 'mo').map(item => `${item.kind}:${item.name}`)).toEqual(['client:model', 'client:mode', 'server:model-card'])
    expect(filterSlashItems(items, 'MODEL').map(item => item.name)).toEqual(['model', 'model-card'])
    expect(filterSlashItems(items, 'sum').map(item => item.name)).toEqual(['summarize'])
    expect(filterSlashItems(items, 'odel')).toEqual([])
  })
})

describe('slashQueryAt', () => {
  it('returns the first token while the caret is in it', () => {
    expect(slashQueryAt('/', 1)).toBe('')
    expect(slashQueryAt('/mo', 3)).toBe('mo')
    expect(slashQueryAt('/mo', 2)).toBe('mo')
    expect(slashQueryAt('/model gpt', 6)).toBe('model')
  })

  it('stays closed after the first token, without a leading slash, or for paths', () => {
    expect(slashQueryAt('/model gpt', 7)).toBeNull()
    expect(slashQueryAt('/model ', 7)).toBeNull()
    expect(slashQueryAt('hello /model', 12)).toBeNull()
    expect(slashQueryAt(' /model', 2)).toBeNull()
    expect(slashQueryAt('/usr/bin', 8)).toBeNull()
    expect(slashQueryAt('/mo', 0)).toBeNull()
  })
})

describe('/mode edits (Accept edits, Phase 7)', () => {
  const base: ClientCommandContext = { resolveModel: () => null, efforts: [], toolsAvailable: true, projectChat: false }

  it('reads values and labels, case-insensitively, with the accept-edits aliases', () => {
    expect(parseToolMode('edits')).toBe('edits')
    expect(parseToolMode('accept-edits')).toBe('edits')
    expect(parseToolMode('accept edits')).toBe('edits')
    expect(parseToolMode('  Accept   Edits ')).toBe('edits')
    expect(parseToolMode('ACCEPT-EDITS')).toBe('edits')
    expect(parseToolMode('Ask')).toBe('ask')
    expect(parseToolMode('auto')).toBe('auto')
    expect(parseToolMode('off')).toBe('off')
    expect(parseToolMode('accept')).toBeNull()
    expect(parseToolMode('edit')).toBeNull()
    expect(parseToolMode('')).toBeNull()
  })

  it('selects Accept edits in a project chat', () => {
    const project = { ...base, projectChat: true }
    for (const args of ['edits', 'accept-edits', 'accept edits', 'Accept Edits'])
      expect(resolveClientCommand('mode', args, project)).toEqual({ type: 'set-mode', mode: 'edits' })
    expect(parseClientCommand('/mode accept edits')).toEqual({ name: 'mode', args: 'accept edits' })
  })

  it('explains that Accept edits needs a project chat, and changes nothing', () => {
    for (const args of ['edits', 'accept-edits', 'accept edits'])
      expect(resolveClientCommand('mode', args, base)).toEqual({ type: 'error', message: 'Accept edits works in project chats.' })
    // The other modes work everywhere.
    expect(resolveClientCommand('mode', 'ask', base)).toEqual({ type: 'set-mode', mode: 'ask' })
    // Without tools the menu does not apply at all.
    expect(resolveClientCommand('mode', 'edits', { ...base, projectChat: true, toolsAvailable: false })).toEqual({
      type: 'error',
      message: 'No tools are available for this model.',
    })
  })
})

describe('/mode plan (Plan, Phase 9)', () => {
  const base: ClientCommandContext = { resolveModel: () => null, efforts: [], toolsAvailable: true, projectChat: false }

  it('selects Plan in a project chat and explains it elsewhere', () => {
    expect(parseToolMode('Plan')).toBe('plan')
    expect(resolveClientCommand('mode', 'plan', { ...base, projectChat: true })).toEqual({ type: 'set-mode', mode: 'plan' })
    expect(resolveClientCommand('mode', 'PLAN', base)).toEqual({ type: 'error', message: 'Plan mode works in project chats.' })
    expect(parseClientCommand('/mode plan')).toEqual({ name: 'mode', args: 'plan' })
  })

  it('lists plan in the /mode help only in project chats', () => {
    expect(resolveClientCommand('mode', 'later', base)).toEqual({ type: 'error', message: 'Unknown mode "later". Use ask, auto or off.' })
    expect(resolveClientCommand('mode', 'later', { ...base, projectChat: true })).toEqual({
      type: 'error',
      message: 'Unknown mode "later". Use ask, edits, plan, auto or off.',
    })
  })
})

describe('/compact (Phase 9)', () => {
  const listed = [{ name: 'compact', description: 'Summarize the conversation so far', source: 'harness' as const, pluginId: 'core-agent' }]

  it('comes from GET /commands as a server command and is sent as typed', () => {
    expect(serverSlashItems(listed, id => (id === 'core-agent' ? 'Agent tools' : undefined))).toEqual([
      { name: 'compact', description: 'Summarize the conversation so far', kind: 'server', source: 'Agent tools', group: 'app' },
    ])
    const all = [...clientSlashItems(), ...serverSlashItems(listed)]
    expect(filterSlashItems(all, 'comp').map(item => `${item.kind}:${item.name}`)).toEqual(['server:compact'])
    expect(parseClientCommand('/compact keep numbers')).toBeNull()
    expect(parseSlashCommand('/compact keep numbers')).toEqual({ name: 'compact', args: 'keep numbers' })
  })
})

describe('groups, argument hints and /remember (Phase 10)', () => {
  const fileCommands = [
    { name: 'review', description: 'Review a file for bugs', source: 'project' as const, namespace: 'frontend', argumentHint: '<file> [focus]' },
    { name: 'standup', description: 'Draft my standup notes', source: 'user' as const },
  ]

  it('puts every item into a group and keeps the hint and the namespace of command files', () => {
    expect(clientSlashItems().every(item => item.group === 'app')).toBe(true)
    expect(serverSlashItems(fileCommands)).toEqual([
      { name: 'review', description: 'Review a file for bugs', kind: 'server', group: 'project', argumentHint: '<file> [focus]', namespace: 'frontend' },
      { name: 'standup', description: 'Draft my standup notes', kind: 'server', group: 'personal' },
    ])
    expect(['harness', 'project', 'user', 'plugin'].map(source => slashGroupOf({ source: source as 'harness' }))).toEqual(['app', 'project', 'personal', 'plugin'])
  })

  it('shows the argument hint only while the text is the command name plus blanks on one line', () => {
    const all = serverSlashItems(fileCommands)
    expect(argumentHintAt('/review ', all)).toBe('<file> [focus]')
    expect(argumentHintAt('/REVIEW   ', all)).toBe('<file> [focus]')
    expect(argumentHintAt('/review', all)).toBeNull()
    expect(argumentHintAt('/review a', all)).toBeNull()
    expect(argumentHintAt('/review \n', all)).toBeNull()
    expect(argumentHintAt('/standup ', all)).toBeNull()
    expect(argumentHintAt('/unknown ', all)).toBeNull()
  })

  it('resolves /remember to the remember action with the trimmed text (not offered in the menu until W10.9)', () => {
    const context: ClientCommandContext = { resolveModel: () => null, efforts: [], toolsAvailable: true, projectChat: false }
    expect(CLIENT_COMMAND_DESCRIPTIONS.remember).toBe('Save a note to your instructions')
    expect(parseClientCommand('/remember  Run pnpm check first ')).toEqual({ name: 'remember', args: 'Run pnpm check first' })
    expect(resolveClientCommand('remember', '  Run pnpm check first ', context)).toEqual({ type: 'remember', text: 'Run pnpm check first' })
    expect(resolveClientCommand('remember', '', context)).toEqual({ type: 'remember', text: '' })
    expect(clientSlashItems().map(item => item.name)).not.toContain('remember')
  })
})

describe('parsing', () => {
  it('parses /name and its arguments', () => {
    expect(parseSlashCommand('/effort high')).toEqual({ name: 'effort', args: 'high' })
    expect(parseSlashCommand('  /Model   anthropic:claude-sonnet-5  ')).toEqual({ name: 'model', args: 'anthropic:claude-sonnet-5' })
    expect(parseSlashCommand('/summarize\nline two')).toEqual({ name: 'summarize', args: 'line two' })
    expect(parseSlashCommand('/new')).toEqual({ name: 'new', args: '' })
    expect(parseSlashCommand('hello')).toBeNull()
    expect(parseSlashCommand('/usr/bin')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
  })

  it('recognizes only client commands as client commands', () => {
    expect(parseClientCommand('/mode auto')).toEqual({ name: 'mode', args: 'auto' })
    expect(parseClientCommand('/HELP')).toEqual({ name: 'help', args: '' })
    expect(parseClientCommand('/summarize this')).toBeNull()
    expect(parseClientCommand('/models')).toBeNull()
    expect(parseClientCommand('what is /model')).toBeNull()
  })
})

describe('resolveClientCommand', () => {
  const context: ClientCommandContext = {
    resolveModel: query => (query === 'sonnet' || query === 'anthropic:claude-sonnet-5' ? 'anthropic:claude-sonnet-5' : null),
    efforts: ['auto', 'low', 'medium', 'high'],
    toolsAvailable: true,
    projectChat: false,
  }

  it('runs /new and /help at once, ignoring arguments', () => {
    expect(resolveClientCommand('new', '', context)).toEqual({ type: 'new' })
    expect(resolveClientCommand('new', 'please', context)).toEqual({ type: 'new' })
    expect(resolveClientCommand('help', '', context)).toEqual({ type: 'help' })
  })

  it('opens the menus without an argument', () => {
    expect(resolveClientCommand('model', '', context)).toEqual({ type: 'open', menu: 'model' })
    expect(resolveClientCommand('effort', ' ', context)).toEqual({ type: 'open', menu: 'effort' })
    expect(resolveClientCommand('mode', '', context)).toEqual({ type: 'open', menu: 'mode' })
  })

  it('applies an argument', () => {
    expect(resolveClientCommand('model', 'anthropic:claude-sonnet-5', context)).toEqual({ type: 'set-model', modelRef: 'anthropic:claude-sonnet-5' })
    expect(resolveClientCommand('effort', 'HIGH', context)).toEqual({ type: 'set-effort', effort: 'high' })
    expect(resolveClientCommand('mode', 'Auto', context)).toEqual({ type: 'set-mode', mode: 'auto' })
  })

  it('explains invalid values and unavailable menus', () => {
    expect(resolveClientCommand('model', 'gpt-9', context)).toEqual({ type: 'error', message: 'Unknown model "gpt-9".' })
    expect(resolveClientCommand('effort', 'max', context)).toEqual({ type: 'error', message: 'Unknown effort "max". Use auto, low, medium or high.' })
    expect(resolveClientCommand('mode', 'yolo', context)).toEqual({ type: 'error', message: 'Unknown mode "yolo". Use ask, auto or off.' })
    expect(resolveClientCommand('mode', 'yolo', { ...context, projectChat: true })).toEqual({ type: 'error', message: 'Unknown mode "yolo". Use ask, edits, plan, auto or off.' })
    expect(resolveClientCommand('effort', 'high', { ...context, efforts: [] }).type).toBe('error')
    expect(resolveClientCommand('mode', '', { ...context, toolsAvailable: false }).type).toBe('error')
  })
})
