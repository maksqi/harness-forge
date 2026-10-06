import type { ClientCommandContext } from './slash-commands'
import { describe, expect, it } from 'vitest'
import { projectTrustList, styleEntry, trustCommandItem, trustHookItem } from '~/utils/testing/fixtures'
import { styleOptions } from './output-style'
import {
  argumentHintAt,
  CLIENT_COMMAND_DESCRIPTIONS,
  clientSlashItems,
  filterSlashItems,
  isTypedCommand,
  parseClientCommand,
  parseSlashCommand,
  parseToolMode,
  pendingCommandNames,
  resolveClientCommand,
  serverSlashItems,
  SLASH_GROUPS,
  slashGroupOf,
  slashItemDetail,
  slashItemLabel,
  slashQueryAt,
  withPendingCommands,
} from './slash-commands'

const commands = [
  { name: 'summarize', description: 'Summarize the chat', source: 'plugin' as const, pluginId: 'core-commands' },
  { name: 'model-card', description: 'Show a model card', source: 'plugin' as const, pluginId: 'model-tools' },
  // Plugins cannot register client names; a stray one never shadows the client command.
  { name: 'new', description: 'Server new', source: 'plugin' as const, pluginId: 'rogue' },
]

const items = [...clientSlashItems(), ...serverSlashItems(commands, id => (id === 'core-commands' ? 'Core commands' : undefined))]

describe('slash menu items', () => {
  it('lists the client commands first, in the documented order, /remember included (Phase 10)', () => {
    expect(clientSlashItems().map(item => [item.name, item.description])).toEqual([
      ['new', 'Start a new chat'],
      ['model', 'Switch model'],
      ['effort', 'Set reasoning effort'],
      ['mode', 'Set permission mode'],
      ['help', 'Show shortcuts and commands'],
      ['remember', 'Save a note to your instructions'],
      // Phase 11 (ADR-051).
      ['output-style', 'Set the output style'],
    ])
  })

  it('adds server commands with their plugin name (or id) and drops client names', () => {
    expect(serverSlashItems(commands, id => (id === 'core-commands' ? 'Core commands' : undefined))).toEqual([
      { name: 'summarize', description: 'Summarize the chat', kind: 'server', source: 'Core commands', group: 'plugin' },
      { name: 'model-card', description: 'Show a model card', kind: 'server', source: 'model-tools', group: 'plugin' },
    ])
  })

  it('filters by prefix, case-insensitively, App group first', () => {
    expect(filterSlashItems(items, '').map(item => item.name)).toEqual(['new', 'model', 'effort', 'mode', 'help', 'remember', 'output-style', 'summarize', 'model-card'])
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

  it('resolves /remember to the remember action with the trimmed text and lists it in the App group', () => {
    const context: ClientCommandContext = { resolveModel: () => null, efforts: [], toolsAvailable: true, projectChat: false }
    expect(CLIENT_COMMAND_DESCRIPTIONS.remember).toBe('Save a note to your instructions')
    expect(parseClientCommand('/remember  Run pnpm check first ')).toEqual({ name: 'remember', args: 'Run pnpm check first' })
    expect(parseClientCommand('/REMEMBER line one\nline two')).toEqual({ name: 'remember', args: 'line one\nline two' })
    expect(resolveClientCommand('remember', '  Run pnpm check first ', context)).toEqual({ type: 'remember', text: 'Run pnpm check first' })
    expect(resolveClientCommand('remember', '', context)).toEqual({ type: 'remember', text: '' })
    // It works without tools and without a project (it is not a model feature).
    expect(resolveClientCommand('remember', 'x', { ...context, toolsAvailable: false })).toEqual({ type: 'remember', text: 'x' })
    expect(clientSlashItems().find(item => item.name === 'remember')).toEqual({
      name: 'remember',
      description: 'Save a note to your instructions',
      kind: 'client',
      group: 'app',
    })
    // A plugin or command file can never take the name.
    expect(serverSlashItems([{ name: 'remember', description: 'Plugin remember', source: 'plugin', pluginId: 'rogue' }])).toEqual([])
  })

  it('orders the matches by group (App, Project, Personal, Plugins), keeping the order inside a group', () => {
    expect(SLASH_GROUPS).toEqual([
      { value: 'app', label: 'App' },
      { value: 'project', label: 'Project' },
      { value: 'personal', label: 'Personal' },
      { value: 'plugin', label: 'Plugins' },
      // Phase 11 (ADR-052): user-invocable skills, last.
      { value: 'skill', label: 'Skills' },
    ])
    // The server answers by name; the menu regroups.
    const server = serverSlashItems([
      { name: 'compact', description: 'Summarize the conversation', source: 'harness', pluginId: 'core-agent' },
      { name: 'deploy', description: 'Deploy', source: 'plugin', pluginId: 'ops' },
      { name: 'release', description: 'Release notes', source: 'project', namespace: 'docs' },
      { name: 'review', description: 'Review a file', source: 'project', namespace: 'frontend', argumentHint: '<file> [focus]' },
      { name: 'standup', description: 'Standup notes', source: 'user' },
      { name: 'summarize', description: 'Summarize', source: 'plugin', pluginId: 'core-commands' },
    ], id => ({ 'core-agent': 'Agent tools', 'core-commands': 'Core commands' })[id])
    const all = [...clientSlashItems(), ...server]
    expect(filterSlashItems(all, '').map(item => `${item.group}:${item.name}`)).toEqual([
      'app:new',
      'app:model',
      'app:effort',
      'app:mode',
      'app:help',
      'app:remember',
      'app:output-style',
      'app:compact',
      'project:release',
      'project:review',
      'personal:standup',
      'plugin:deploy',
      'plugin:summarize',
    ])
    expect(filterSlashItems(all, 're').map(item => `${item.group}:${item.name}`)).toEqual(['app:remember', 'project:release', 'project:review'])
    expect(filterSlashItems(all, 's').map(item => item.name)).toEqual(['standup', 'summarize'])
  })

  it('shows the namespace or the plugin name on the right, and names a row with its hint', () => {
    const [compact, deploy, review, standup] = serverSlashItems([
      { name: 'compact', description: 'Summarize the conversation', source: 'harness', pluginId: 'core-agent', argumentHint: '[focus]' },
      { name: 'deploy', description: 'Deploy', source: 'plugin', pluginId: 'ops' },
      { name: 'review', description: 'Review a file', source: 'project', namespace: 'frontend', argumentHint: '<file> [focus]' },
      { name: 'standup', description: 'Standup notes', source: 'user' },
    ], id => (id === 'core-agent' ? 'Agent tools' : undefined))
    expect([compact, deploy, review, standup].map(item => slashItemDetail(item!))).toEqual([null, 'ops', 'frontend', null])
    expect(slashItemDetail(clientSlashItems()[0]!)).toBeNull()
    expect(slashItemLabel(review!)).toBe('/review, Review a file, arguments <file> [focus]')
    expect(slashItemLabel(compact!)).toBe('/compact, Summarize the conversation, arguments [focus]')
    expect(slashItemLabel(standup!)).toBe('/standup, Standup notes')
    expect(slashItemLabel({ name: 'x', description: '', kind: 'server', group: 'personal' })).toBe('/x')
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

describe('skills and long names (Phase 11, P11-0b types)', () => {
  it('puts user-invocable skills of any source into the Skills group, last', () => {
    const skills = serverSlashItems([
      { name: 'deploy', kind: 'skill', description: 'Deploy the app', source: 'project', argumentHint: '<env>' },
      { name: 'review', description: 'Review a file', source: 'user' },
    ])
    expect(skills.map(item => [item.name, item.group, item.skill])).toEqual([['deploy', 'skill', true], ['review', 'personal', undefined]])
    expect(slashGroupOf({ source: 'plugin', kind: 'skill' })).toBe('skill')
    expect(filterSlashItems(skills, '').map(item => item.name)).toEqual(['review', 'deploy'])
  })

  it('accepts names of up to 64 characters in the query, the hint and the command patterns', () => {
    const long = `a${'b'.repeat(63)}`
    expect(slashQueryAt(`/${long}`, long.length + 1)).toBe(long)
    expect(slashQueryAt(`/${long}x`, long.length + 2)).toBeNull()
    expect(parseSlashCommand(`/${long} prod`)).toEqual({ name: long, args: 'prod' })
    expect(parseSlashCommand(`/${long}x`)).toBeNull()
    const longItems = serverSlashItems([{ name: long, kind: 'skill', description: 'A long skill', source: 'user', argumentHint: '<env>' }])
    expect(argumentHintAt(`/${long} `, longItems)).toBe('<env>')
    // W11.19: where SlashArgumentHint shows the hint follows the same rule.
    expect(isTypedCommand(`/${long} `)).toBe(true)
    expect(isTypedCommand(`/${long}\t`)).toBe(true)
    expect(isTypedCommand(`/${long}x `)).toBe(false)
    expect(isTypedCommand(`/${long} a`)).toBe(false)
    expect(isTypedCommand(`/${long}`)).toBe(false)
  })
})

describe('/output-style (Phase 11)', () => {
  const context: ClientCommandContext = {
    resolveModel: () => null,
    efforts: [],
    toolsAvailable: false,
    projectChat: false,
    styles: styleOptions([styleEntry()]),
  }

  it('is an App command "Set the output style"', () => {
    expect(clientSlashItems().find(item => item.name === 'output-style')).toEqual({ name: 'output-style', description: 'Set the output style', kind: 'client', group: 'app' })
    expect(parseClientCommand('/output-style terse')).toEqual({ name: 'output-style', args: 'terse' })
  })

  it('opens the menu alone and sets a style by name or label, or Automatic', () => {
    expect(resolveClientCommand('output-style', '', context)).toEqual({ type: 'open', menu: 'style' })
    expect(resolveClientCommand('output-style', 'Terse', context)).toEqual({ type: 'set-style', style: 'terse' })
    expect(resolveClientCommand('output-style', 'explanatory', context)).toEqual({ type: 'set-style', style: 'explanatory' })
    expect(resolveClientCommand('output-style', 'auto', context)).toEqual({ type: 'set-style', style: null })
    expect(resolveClientCommand('output-style', 'Automatic', context)).toEqual({ type: 'set-style', style: null })
  })

  it('explains an unknown name; without styles only the built-ins resolve', () => {
    expect(resolveClientCommand('output-style', 'pirate', context)).toEqual({
      type: 'error',
      message: 'Unknown output style "pirate". Use auto, default, explanatory, learning or a style from the menu.',
    })
    const { styles: _styles, ...builtinsOnly } = context
    expect(resolveClientCommand('output-style', 'learning', builtinsOnly)).toEqual({ type: 'set-style', style: 'learning' })
    expect(resolveClientCommand('output-style', 'terse', builtinsOnly).type).toBe('error')
  })
})

describe('the Skills group and Needs approval (Phase 11)', () => {
  const summaries = [
    { name: 'deploy', description: 'Deploy the app', source: 'project' as const, namespace: 'ops' },
    { name: 'status', description: 'Git status', source: 'project' as const },
    { name: 'standup', description: 'Draft my standup notes', source: 'user' as const },
    { name: 'release-notes', kind: 'skill' as const, description: 'Write release notes', source: 'project' as const, argumentHint: '<version>' },
    { name: 'tidy', kind: 'skill' as const, description: 'Tidy imports', source: 'user' as const },
    { name: 'charts', kind: 'skill' as const, description: 'Draw charts', source: 'plugin' as const, pluginId: 'viz-pack' },
    { name: 'mystery', kind: 'skill' as const, description: 'Unknown plugin', source: 'plugin' as const },
    { name: 'basics', kind: 'skill' as const, description: 'Built-in skill', source: 'harness' as const },
  ]
  const skillItems = serverSlashItems(summaries, id => (id === 'viz-pack' ? 'Viz pack' : undefined))

  it('shows a skill\'s source on the right and lists the Skills group last', () => {
    const detail = (name: string) => slashItemDetail(skillItems.find(item => item.name === name)!)
    expect([detail('release-notes'), detail('tidy'), detail('charts'), detail('mystery'), detail('basics')])
      .toEqual(['Project', 'Personal', 'Viz pack', 'Plugin', 'Built-in'])
    expect(detail('deploy')).toBe('ops')
    expect(detail('standup')).toBeNull()
    expect(SLASH_GROUPS.at(-1)).toEqual({ value: 'skill', label: 'Skills' })
    expect(filterSlashItems([...clientSlashItems(), ...skillItems], '').map(item => item.group).at(-1)).toBe('skill')
    expect(slashItemLabel(skillItems.find(item => item.name === 'release-notes')!)).toBe('/release-notes, Write release notes, arguments <version>')
  })

  it('marks the project commands whose trust item is pending', () => {
    expect(pendingCommandNames(null).size).toBe(0)
    const list = projectTrustList({
      items: [
        trustHookItem(),
        trustCommandItem({ state: 'pending', label: '/deploy', detail: { name: 'deploy', spans: ['./deploy.sh'] } }),
        trustCommandItem(),
      ],
    })
    const pending = pendingCommandNames(list)
    expect([...pending]).toEqual(['deploy'])
    const marked = withPendingCommands(skillItems, pending)
    expect(marked.filter(item => item.pending).map(item => item.name)).toEqual(['deploy'])
    expect(slashItemLabel(marked.find(item => item.name === 'deploy')!)).toBe('/deploy, Deploy the app, needs approval')
    // Nothing pending: the same array.
    expect(withPendingCommands(skillItems, new Set())).toBe(skillItems)
    // Only project commands carry the badge (a personal command or a skill with the name never does).
    expect(withPendingCommands(skillItems, new Set(['standup', 'tidy']))).toBe(skillItems)
  })
})
