import type { ClientCommandContext } from './slash-commands'
import { describe, expect, it } from 'vitest'
import {
  clientSlashItems,
  filterSlashItems,
  parseClientCommand,
  parseSlashCommand,
  resolveClientCommand,
  serverSlashItems,
  slashQueryAt,
} from './slash-commands'

const commands = [
  { name: 'summarize', description: 'Summarize the chat', pluginId: 'core-commands' },
  { name: 'model-card', description: 'Show a model card', pluginId: 'model-tools' },
  // Plugins cannot register client names; a stray one never shadows the client command.
  { name: 'new', description: 'Server new', pluginId: 'rogue' },
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
      { name: 'summarize', description: 'Summarize the chat', kind: 'server', source: 'Core commands' },
      { name: 'model-card', description: 'Show a model card', kind: 'server', source: 'model-tools' },
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
    expect(resolveClientCommand('mode', 'yolo', context)).toEqual({ type: 'error', message: 'Unknown mode "yolo". Use off, ask or auto.' })
    expect(resolveClientCommand('effort', 'high', { ...context, efforts: [] }).type).toBe('error')
    expect(resolveClientCommand('mode', '', { ...context, toolsAvailable: false }).type).toBe('error')
  })
})
