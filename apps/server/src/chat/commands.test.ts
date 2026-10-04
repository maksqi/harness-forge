import type { CommandDefinition } from '@harness-forge/plugin-sdk'
import type { CommandInvocation, CustomizationEntry, HarnessUIMessage } from '@harness-forge/shared'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { CommandResolution, CommandServices } from './commands.ts'
import type { ChatQueueDeps } from './queue.ts'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { createSilentLogger } from '../logger.ts'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import {
  compactNeedsChatModel,
  definitionCommand,
  expandTemplate,
  HARNESS_COMMAND_SUMMARIES,
  isServerCommandFor,
  listServerCommands,
  parseSlashCommand,
  resolveCommand,
  turnToolRestriction,
} from './commands.ts'
import { createChatQueue } from './queue.ts'
import { catalogEntry, testCatalog } from './testing.ts'

describe('parseSlashCommand', () => {
  it('reads /name at the start followed by whitespace or the end', () => {
    expect(parseSlashCommand('/summarize some text')).toEqual({ name: 'summarize', input: 'some text' })
    expect(parseSlashCommand('/summarize')).toEqual({ name: 'summarize', input: '' })
    expect(parseSlashCommand('  /fix\n  the bug  ')).toEqual({ name: 'fix', input: 'the bug' })
    expect(parseSlashCommand('/sum-up it')).toEqual({ name: 'sum-up', input: 'it' })
  })

  it('ignores text that is not a command', () => {
    expect(parseSlashCommand('hello /summarize')).toBeNull()
    expect(parseSlashCommand('/Summarize x')).toBeNull()
    expect(parseSlashCommand('/summarize,now')).toBeNull()
    expect(parseSlashCommand('/1abc')).toBeNull()
    expect(parseSlashCommand('/')).toBeNull()
    expect(parseSlashCommand(`/${'a'.repeat(40)}`)).toBeNull()
  })
})

describe('expandTemplate', () => {
  it('replaces every {{input}} or appends the input after a blank line', () => {
    expect(expandTemplate('Say {{input}} twice: {{input}}', 'hi')).toBe('Say hi twice: hi')
    expect(expandTemplate('No placeholder.', 'extra')).toBe('No placeholder.\n\nextra')
    expect(expandTemplate('No placeholder.', '')).toBe('No placeholder.')
    expect(expandTemplate('A {{input}} B', '')).toBe('A  B')
  })
})

function services(commands: Record<string, CommandDefinition>, pluginId = 'demo'): CommandServices {
  return {
    registry: {
      commands: {
        get: name => (commands[name] === undefined ? undefined : { pluginId, definition: commands[name] }),
        list: () => [],
        register: () => ({ dispose() {} }),
      },
    },
    plugins: {
      guard: async (_pluginId, fn) => {
        try {
          return await fn(new AbortController().signal)
        }
        catch (error) {
          throw new HarnessError({ code: 'plugin_error', message: error instanceof Error ? error.message : 'failed', details: { pluginId, phase: 'tool' } })
        }
      },
    },
    customizations: {
      load: async () => {
        throw new Error('no command file is loaded before W10.2')
      },
    },
  }
}

const context = { chatId: 'chat', signal: new AbortController().signal }

describe('resolveCommand', () => {
  it('expands template commands', async () => {
    const result = await resolveCommand(services({ tldr: { name: 'tldr', description: 'x', template: 'TL;DR: {{input}}' } }), '/tldr long text', context)
    expect(result).toEqual({ kind: 'prompt', invocation: { name: 'tldr', input: 'long text', type: 'prompt', expansion: 'TL;DR: long text' } })
  })

  it('ignores unknown and client-only commands', async () => {
    const all = services({ new: { name: 'new', description: 'x', template: 'never' } })
    expect(await resolveCommand(all, '/unknown x', context)).toBeNull()
    expect(await resolveCommand(all, '/new', context)).toBeNull()
    expect(await resolveCommand(all, 'plain text', context)).toBeNull()
  })

  it('runs run commands: prompt and reply results', async () => {
    const commands: Record<string, CommandDefinition> = {
      ask: { name: 'ask', description: 'x', run: async ({ input, chatId }) => ({ type: 'prompt', text: `${chatId}: ${input}` }) },
      roll: { name: 'roll', description: 'x', run: async () => ({ type: 'reply', markdown: '**4**' }) },
    }
    expect(await resolveCommand(services(commands), '/ask why', context)).toEqual({ kind: 'prompt', invocation: { name: 'ask', input: 'why', type: 'prompt', expansion: 'chat: why' } })
    expect(await resolveCommand(services(commands), '/roll', context)).toEqual({ kind: 'reply', invocation: { name: 'roll', input: '', type: 'reply' }, markdown: '**4**' })
  })

  it('reports a failing or invalid run command as plugin_error', async () => {
    const commands: Record<string, CommandDefinition> = {
      boom: { name: 'boom', description: 'x', run: async () => {
        throw new Error('exploded')
      } },
      odd: { name: 'odd', description: 'x', run: async () => ({ type: 'other' }) as never },
    }
    const failed = await resolveCommand(services(commands), '/boom', context)
    expect(failed?.kind).toBe('failed')
    expect(failed?.kind === 'failed' ? failed.error.toJSON().error : null).toMatchObject({ code: 'plugin_error', message: 'exploded' })
    expect(failed?.invocation).toEqual({ name: 'boom', input: '', type: 'reply' })
    const odd = await resolveCommand(services(commands), '/odd', context)
    expect(odd?.kind === 'failed' ? odd.error.message : '').toBe('The /odd command returned an invalid result.')
  })

  it('rejects an expansion larger than 64 KB', async () => {
    const big = services({ big: { name: 'big', description: 'x', template: '{{input}}' } })
    await expect(resolveCommand(big, `/big ${'x'.repeat(LIMITS.commandExpansionBytes + 1)}`, context)).rejects.toMatchObject({ code: 'validation_error' })
  })

  it('rethrows the abort of a stopped run', async () => {
    const controller = new AbortController()
    const slow: CommandServices = {
      ...services({}),
      registry: services({ slow: { name: 'slow', description: 'x', run: async () => ({ type: 'reply', markdown: 'late' }) } }).registry,
      plugins: {
        guard: async () => {
          controller.abort(new DOMException('stopped', 'AbortError'))
          throw controller.signal.reason
        },
      },
    }
    await expect(resolveCommand(slow, '/slow', { chatId: 'chat', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})

describe('resolveCommand: /compact (Phase 9)', () => {
  it('resolves the harness command before the registry, with the trimmed input as the focus', async () => {
    const shadowed = services({ compact: { name: 'compact', description: 'x', template: 'never {{input}}' } })
    expect(await resolveCommand(shadowed, '/compact keep numbers', context)).toEqual({
      kind: 'compact',
      invocation: { name: 'compact', input: 'keep numbers', type: 'compact' },
      focus: 'keep numbers',
    })
    expect(await resolveCommand(services({}), '  /compact  ', context)).toEqual({
      kind: 'compact',
      invocation: { name: 'compact', input: '', type: 'compact' },
      focus: null,
    })
  })

  it('does not match other names or text after the start', async () => {
    expect(await resolveCommand(services({}), '/compactx now', context)).toBeNull()
    expect(await resolveCommand(services({}), 'please /compact', context)).toBeNull()
    expect(await resolveCommand(services({}), '/Compact', context)).toBeNull()
  })

  it('refuses a focus longer than 1000 characters on the message', async () => {
    expect(await resolveCommand(services({}), `/compact ${'f'.repeat(LIMITS.compactFocusMaxChars)}`, context)).toMatchObject({ kind: 'compact' })
    await expect(resolveCommand(services({}), `/compact ${'f'.repeat(LIMITS.compactFocusMaxChars + 1)}`, context)).rejects.toMatchObject({
      code: 'validation_error',
      details: { issues: [{ path: ['message'] }] },
    })
  })

  it('never reads the plugin command registry, so a command list that changes meanwhile cannot shadow it', async () => {
    const changing: CommandServices = {
      registry: {
        commands: {
          get: () => {
            throw new Error('the registry is being reloaded')
          },
          list: () => [],
          register: () => ({ dispose() {} }),
        },
      } as unknown as CommandServices['registry'],
      plugins: { guard: async () => { throw new Error('not used') } } as unknown as CommandServices['plugins'],
      customizations: { load: async () => { throw new Error('not used') } },
    }
    expect(await resolveCommand(changing, '/compact\n  the API\n  and errors  ', context)).toEqual({
      kind: 'compact',
      invocation: { name: 'compact', input: 'the API\n  and errors', type: 'compact' },
      focus: 'the API\n  and errors',
    })
  })

  it('names the model in the error of an image model', () => {
    expect(compactNeedsChatModel()).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['modelRef'] }] } })
  })

  it('lists compact for GET /commands under the agent tools plugin', () => {
    expect(HARNESS_COMMAND_SUMMARIES).toEqual([{ name: 'compact', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' }])
  })
})

// ---------- Phase 10 (W10.2): command files and personal commands ----------

const PROJECT = 'prj_0123456789abcdef'
const OTHER_PROJECT = 'prj_fedcba9876543210'

/** A command file of the fake catalog with its markdown body. */
function commandFile(fake: FakeCustomizationService, projectId: string, folder: '.harness' | '.claude', name: string, content: string, fields: Partial<CustomizationEntry> = {}): CustomizationEntry {
  const entry = fakeCatalogEntry('command', name, { source: 'project', path: `${folder}/commands/${fields.namespace === undefined ? '' : `${fields.namespace}/`}${name}.md`, ...fields })
  fake.entries.set(projectId, [...(fake.entries.get(projectId) ?? []), entry])
  fake.bodies.set(catalogEntryKey(entry), content)
  return entry
}

/** Command services over the fake catalog's `load` and a plugin registry with `commands`. */
function fileServices(fake: FakeCustomizationService, commands: Record<string, CommandDefinition> = {}): CommandServices {
  return { ...services(commands, 'demo'), customizations: fake }
}

async function resolveIn(fake: FakeCustomizationService, projectId: string | null, text: string, commands: Record<string, CommandDefinition> = {}): Promise<CommandResolution | null> {
  return resolveCommand(fileServices(fake, commands), text, { ...context, catalog: await fake.catalog(projectId) })
}

function expansionOf(resolution: CommandResolution | null): string | undefined {
  return resolution?.kind === 'prompt' ? resolution.invocation.expansion : undefined
}

const pluginReview: CommandDefinition = { name: 'review', description: 'Plugin review.', template: 'PLUGIN {{input}}' }

describe('resolveCommand: command files and personal commands (W10.2-T1)', () => {
  it('follows the precedence .harness > .claude > personal > plugin and records the source', async () => {
    const fake = createFakeCustomizationService()
    const plugins = { review: pluginReview }
    expect(await resolveIn(fake, PROJECT, '/review x', plugins)).toEqual({ kind: 'prompt', invocation: { name: 'review', input: 'x', type: 'prompt', expansion: 'PLUGIN x' } })

    await fake.create({ kind: 'command', content: '---\nname: review\ndescription: Personal review.\n---\nPERSONAL $ARGUMENTS' })
    expect(await resolveIn(fake, PROJECT, '/review x', plugins)).toEqual({ kind: 'prompt', invocation: { name: 'review', input: 'x', type: 'prompt', expansion: 'PERSONAL x', source: 'user' } })

    commandFile(fake, PROJECT, '.claude', 'review', '---\ndescription: Claude review.\n---\nCLAUDE $ARGUMENTS', { path: '.claude/commands/review.md' })
    expect(await resolveIn(fake, PROJECT, '/review x', plugins)).toEqual({ kind: 'prompt', invocation: { name: 'review', input: 'x', type: 'prompt', expansion: 'CLAUDE x', source: 'project' } })

    commandFile(fake, PROJECT, '.harness', 'review', '---\ndescription: Harness review.\n---\nHARNESS $ARGUMENTS')
    expect(await resolveIn(fake, PROJECT, '/review x', plugins)).toEqual({ kind: 'prompt', invocation: { name: 'review', input: 'x', type: 'prompt', expansion: 'HARNESS x', source: 'project' } })
    // The file is read again for every invocation (`load`), never cached by the resolver.
    expect(fake.calls.load).toBe(3)
  })

  it('shadows a plugin command by a project command only in that project\'s chats', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'review', '---\ndescription: Project review.\n---\nPROJECT $ARGUMENTS')
    const plugins = { review: pluginReview }
    expect(expansionOf(await resolveIn(fake, PROJECT, '/review a', plugins))).toBe('PROJECT a')
    expect(expansionOf(await resolveIn(fake, OTHER_PROJECT, '/review a', plugins))).toBe('PLUGIN a')
    expect(expansionOf(await resolveIn(fake, null, '/review a', plugins))).toBe('PLUGIN a')
    // Without a plugin of that name another project's chat has no such command.
    expect(await resolveIn(fake, OTHER_PROJECT, '/review a')).toBeNull()
  })

  it('expands $ARGUMENTS, $1 … $9 (quotes group words), {{input}}, and appends the input without a placeholder', async () => {
    const fake = createFakeCustomizationService()
    const cases: Array<[body: string, text: string, expansion: string]> = [
      ['Review $ARGUMENTS now.', '/args  src/a.ts  src/b.ts ', 'Review src/a.ts  src/b.ts now.'],
      ['First $1, second $2, third $3.', '/args "a b" c', 'First a b, second c, third .'],
      ['One: $1 | Ten stays: $10', '/args \'x y\' z', 'One: x y | Ten stays: $10'],
      ['Template {{input}} and $ARGUMENTS', '/args hi', 'Template hi and hi'],
      ['No placeholder here.', '/args extra words', 'No placeholder here.\n\nextra words'],
      ['No placeholder here.', '/args', 'No placeholder here.'],
      ['Keep $ARGUMENTS even if it holds $1.', '/args $1 and {{input}}', 'Keep $1 and {{input}} even if it holds $1.'],
    ]
    for (const [index, [body, text, expansion]] of cases.entries()) {
      const name = `args${index}`
      commandFile(fake, PROJECT, '.harness', name, `---\ndescription: Arguments.\n---\n${body}`)
      expect(expansionOf(await resolveIn(fake, PROJECT, text.replace('/args', `/${name}`), {})), body).toBe(expansion)
    }
  })

  it('leaves ! lines and @file references as text (never run, never expanded)', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'risky', '---\ndescription: Risky.\n---\n!rm -rf / && echo $ARGUMENTS\nRead @src/secret.ts and @$1.\n!`cat ~/.ssh/id_rsa`')
    const resolution = await resolveIn(fake, PROJECT, '/risky notes.md')
    expect(expansionOf(resolution)).toBe('!rm -rf / && echo notes.md\nRead @src/secret.ts and @notes.md.\n!`cat ~/.ssh/id_rsa`')
  })

  it('stores the declared model and the normalized allowed-tools in the invocation (never a grant)', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'audit', '---\ndescription: Audit.\nmodel: mock:agents\nallowed-tools: Read, Grep, mcp__github__*\nargument-hint: <path>\n---\nAudit $ARGUMENTS')
    commandFile(fake, PROJECT, '.harness', 'plain', '---\ndescription: Plain.\nmodel: sonnet\n---\nPlain $ARGUMENTS')
    commandFile(fake, PROJECT, '.harness', 'none', '---\ndescription: No tools.\nallowed-tools: []\n---\nNothing')
    expect(await resolveIn(fake, PROJECT, '/audit src')).toEqual({
      kind: 'prompt',
      invocation: { name: 'audit', input: 'src', type: 'prompt', expansion: 'Audit src', source: 'project', modelRef: 'mock:agents', allowedTools: ['read_file', 'search_files', 'mcp__github__*'] },
    })
    // A model alias without a provider is not a model reference: the chat's model runs (the catalog shows the info).
    expect(await resolveIn(fake, PROJECT, '/plain x')).toEqual({ kind: 'prompt', invocation: { name: 'plain', input: 'x', type: 'prompt', expansion: 'Plain x', source: 'project' } })
    // An empty list narrows to nothing (exit_plan_mode excepted, `restrictTools`).
    expect((await resolveIn(fake, PROJECT, '/none'))?.invocation).toMatchObject({ allowedTools: [] })
  })

  it('never takes a client or harness command name, and skips invalid, shadowed and turned-off definitions', async () => {
    const fake = createFakeCustomizationService()
    const forged = [
      fakeCatalogEntry('command', 'model', { path: '.harness/commands/model.md' }),
      fakeCatalogEntry('command', 'compact', { path: '.harness/commands/compact.md' }),
      fakeCatalogEntry('command', 'broken', { path: '.harness/commands/broken.md', state: 'invalid' }),
    ]
    fake.entries.set(PROJECT, forged)
    for (const entry of forged)
      fake.bodies.set(catalogEntryKey(entry), `---\ndescription: Forged.\n---\nFORGED`)
    expect(await resolveIn(fake, PROJECT, '/model mock:echo')).toBeNull()
    expect(await resolveIn(fake, PROJECT, '/compact focus')).toMatchObject({ kind: 'compact', focus: 'focus' })
    expect(await resolveIn(fake, PROJECT, '/broken x', { broken: { name: 'broken', description: 'p', template: 'PLUGIN' } })).toMatchObject({ kind: 'prompt', invocation: { expansion: 'PLUGIN\n\nx' } })
    expect(await resolveIn(fake, PROJECT, '/broken x')).toBeNull()

    const off = await fake.create({ kind: 'command', content: '---\nname: later\ndescription: Off.\n---\nOFF', enabled: false })
    expect(await resolveIn(fake, PROJECT, '/later x')).toBeNull()
    await fake.update(off.id, { enabled: true })
    expect(expansionOf(await resolveIn(fake, PROJECT, '/later x'))).toBe('OFF\n\nx')
  })

  it('keeps the plugin path for a plugin entry of the catalog (run commands included)', async () => {
    const fake = createFakeCustomizationService({ entries: { '': [fakeCatalogEntry('command', 'roll', { source: 'plugin', pluginId: 'demo' })] } })
    const roll: CommandDefinition = { name: 'roll', description: 'Roll.', run: async () => ({ type: 'reply', markdown: '**6**' }) }
    expect(await resolveIn(fake, PROJECT, '/roll', { roll })).toEqual({ kind: 'reply', invocation: { name: 'roll', input: '', type: 'reply' }, markdown: '**6**' })
    expect(fake.calls.load).toBe(0)
    // A catalog that still lists a disposed plugin's command does not bring it back.
    expect(await resolveIn(fake, PROJECT, '/roll', {})).toBeNull()
  })

  it('refuses an expansion larger than 64 KB on the message', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'big', '---\ndescription: Big.\n---\n$ARGUMENTS $ARGUMENTS')
    const half = 'x'.repeat(LIMITS.commandExpansionBytes / 2)
    await expect(resolveIn(fake, PROJECT, `/big ${half}`)).rejects.toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
    expect(expansionOf(await resolveIn(fake, PROJECT, `/big ${'x'.repeat(100)}`))).toHaveLength(201)
  })

  it('answers a definition that can no longer be loaded with a validation_error on the message; rethrows an abort', async () => {
    const fake = createFakeCustomizationService()
    const gone = commandFile(fake, PROJECT, '.harness', 'gone', '---\ndescription: Gone.\n---\nGONE')
    fake.bodies.delete(catalogEntryKey(gone))
    const missing = await resolveIn(fake, PROJECT, '/gone').catch((error: unknown) => error)
    expect(missing).toBeInstanceOf(HarnessError)
    expect((missing as HarnessError).toJSON().error).toMatchObject({ code: 'validation_error', details: { issues: [{ path: ['message', 'parts'] }] } })
    expect((missing as HarnessError).message).toContain('/gone')

    const renamed = commandFile(fake, PROJECT, '.harness', 'renamed', '---\ndescription: Renamed.\n---\nX')
    fake.bodies.set(catalogEntryKey(renamed), '---\nname: other\ndescription: Renamed.\n---\nX')
    await expect(resolveIn(fake, PROJECT, '/renamed')).rejects.toMatchObject({ code: 'validation_error' })

    const controller = new AbortController()
    controller.abort(new DOMException('stopped', 'AbortError'))
    const catalog = await fake.catalog(PROJECT)
    await expect(resolveCommand(fileServices(fake), '/renamed', { chatId: 'chat', signal: controller.signal, catalog })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('without a catalog only the harness command and the plugin registry resolve', async () => {
    const catalog = testCatalog([catalogEntry('command', 'greet', { source: 'project', path: '.harness/commands/greet.md' })])
    expect(await resolveCommand(services({ review: pluginReview }), '/review it', context)).toMatchObject({ kind: 'prompt', invocation: { expansion: 'PLUGIN it' } })
    expect(await resolveCommand(services({}), '/greet Ada', context)).toBeNull()
    expect(definitionCommand(catalog, 'greet')).toMatchObject({ name: 'greet', source: 'project' })
    expect(definitionCommand(undefined, 'greet')).toBeNull()
    expect(definitionCommand(catalog, 'nope')).toBeNull()
  })
})

describe('isServerCommandFor (W10.2-T4)', () => {
  it('counts the harness command, plugin commands and the effective file and personal commands of the chat\'s project', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'review', '---\ndescription: Review.\n---\nReview')
    await fake.create({ kind: 'command', content: '---\nname: mine\ndescription: Mine.\n---\nMine' })
    await fake.create({ kind: 'command', content: '---\nname: off\ndescription: Off.\n---\nOff', enabled: false })
    const deps = { registry: services({ plugged: { name: 'plugged', description: 'x', template: 'y' } }).registry, customizations: fake } as unknown as Parameters<typeof isServerCommandFor>[0]
    const table: Array<[text: string, project: boolean, other: boolean, none: boolean]> = [
      ['/compact', true, true, true],
      ['/plugged now', true, true, true],
      ['/review this', true, false, false],
      ['  /review', true, false, false],
      ['/mine', true, true, true],
      ['/off', false, false, false],
      ['/help', false, false, false],
      ['/remember a note', false, false, false],
      ['/nope', false, false, false],
      ['plain /review', false, false, false],
    ]
    for (const [text, project, other, none] of table) {
      expect(await isServerCommandFor(deps, PROJECT, text), text).toBe(project)
      expect(await isServerCommandFor(deps, OTHER_PROJECT, text), text).toBe(other)
      expect(await isServerCommandFor(deps, null, text), text).toBe(none)
    }
    // The texts that name no harness or plugin command read the catalog of the chat's project.
    expect(fake.calls.catalog).toBeGreaterThan(0)
  })

  it('answers false for an unknown name when the catalog cannot be read', async () => {
    const deps = { registry: services({}).registry, customizations: {} } as unknown as Parameters<typeof isServerCommandFor>[0]
    expect(await isServerCommandFor(deps, PROJECT, '/nope')).toBe(false)
    expect(await isServerCommandFor(deps, PROJECT, '/compact')).toBe(true)
  })
})

describe('turnToolRestriction (W10.2-T3)', () => {
  const meta = (command?: CommandInvocation) => ({ modelRef: 'mock:echo', startedAt: 1, ...(command === undefined ? {} : { command }) })
  const turn: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: '/review' }], metadata: meta({ name: 'review', input: '', type: 'prompt', expansion: 'R', source: 'project', allowedTools: ['read_file', 'mcp__github__*'] }) }
  const reply: HarnessUIMessage = { id: 'msg_a000000000000001', role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }
  const next: HarnessUIMessage = { id: 'msg_u000000000000002', role: 'user', parts: [{ type: 'text', text: 'and now?' }], metadata: meta() }

  it('reads the allowed-tools of the turn\'s user message (the last user message), also for a continuation', () => {
    expect(turnToolRestriction([turn])).toEqual(['read_file', 'mcp__github__*'])
    // A continuation: the continued reply is last; its turn's user message still carries the list.
    expect(turnToolRestriction([turn, reply])).toEqual(['read_file', 'mcp__github__*'])
    // A later turn without a command has no restriction.
    expect(turnToolRestriction([turn, reply, next])).toBeNull()
    expect(turnToolRestriction([turn, reply, next, reply])).toBeNull()
    expect(turnToolRestriction([])).toBeNull()
    expect(turnToolRestriction([reply])).toBeNull()
  })

  it('keeps an empty list (no tool) and ignores commands without allowed-tools', () => {
    const empty = { ...turn, metadata: meta({ name: 'none', input: '', type: 'prompt', expansion: 'N', source: 'project', allowedTools: [] }) }
    expect(turnToolRestriction([empty])).toEqual([])
    const plugin = { ...turn, metadata: meta({ name: 'tldr', input: '', type: 'prompt', expansion: 'T' }) }
    expect(turnToolRestriction([plugin])).toBeNull()
    expect(Object.isFrozen(turnToolRestriction([turn]))).toBe(true)
  })
})

describe('listServerCommands (W10.2-T6)', () => {
  it('lists /compact, the plugin commands and the effective project and personal commands with their fields', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'review', '---\ndescription: Project review.\n---\nR', { argumentHint: '<files>', modelRef: 'mock:agents', namespace: 'code' })
    commandFile(fake, PROJECT, '.claude', 'review', '---\ndescription: Claude review.\n---\nC', { path: '.claude/commands/review.md' })
    await fake.create({ kind: 'command', content: '---\nname: mine\ndescription: Mine.\n---\nMine' })
    const registry = services({ review: pluginReview, tldr: { name: 'tldr', description: 'TL;DR.', template: 'T' } }).registry
    const plugins = [{ pluginId: 'demo', definition: pluginReview }, { pluginId: 'demo', definition: { name: 'tldr', description: 'TL;DR.', template: 'T' } }, { pluginId: 'demo', definition: { name: 'compact', description: 'Forged.', template: 'X' } }]
    const listed = { ...registry, commands: { ...registry.commands, list: () => plugins } } as unknown as Parameters<typeof listServerCommands>[0]
    expect(listServerCommands(listed, await fake.catalog(PROJECT))).toEqual([
      { name: 'compact', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' },
      { name: 'mine', description: 'Mine.', source: 'user' },
      { name: 'review', description: 'The review command.', source: 'project', namespace: 'code', argumentHint: '<files>', modelRef: 'mock:agents' },
      { name: 'tldr', description: 'TL;DR.', source: 'plugin', pluginId: 'demo' },
    ])
    expect(listServerCommands(listed, await fake.catalog(OTHER_PROJECT)).map(item => `${item.name}:${item.source}`)).toEqual(['compact:harness', 'mine:user', 'review:plugin', 'tldr:plugin'])
    expect(listServerCommands(listed, null).map(item => `${item.name}:${item.source}`)).toEqual(['compact:harness', 'review:plugin', 'tldr:plugin'])
  })
})

describe('the queue marks queued command files turnOnly (W10.2-T4 through createChatQueue)', () => {
  it('a queued /review of the chat\'s project is turnOnly; the same text in another project\'s chat is not; a client command never is', async () => {
    const fake = createFakeCustomizationService()
    commandFile(fake, PROJECT, '.harness', 'review', '---\ndescription: Review.\n---\nReview $ARGUMENTS')
    const chats = new Map([['chat-a', { id: 'chat-a', projectId: PROJECT, pendingApproval: false }], ['chat-b', { id: 'chat-b', projectId: OTHER_PROJECT, pendingApproval: false }]])
    const deps = {
      chats: { find: async (id: string) => chats.get(id) ?? null, getMessage: async () => null },
      files: { idFromUrl: () => null, get: async () => null },
      registry: services({}).registry,
      customizations: fake,
      events: { emit: () => {}, subscribe: () => ({ dispose() {} }) },
      logger: createSilentLogger(),
    } as unknown as ChatQueueDeps
    const queue = createChatQueue(deps, { hasRun: () => true, now: () => 1 })
    const add = (chatId: string, id: string, text: string) => queue.add(chatId, { message: { id, role: 'user', parts: [{ type: 'text', text }] }, modelRef: 'mock:echo', reasoningEffort: 'auto', toolMode: 'ask' }, { logger: createSilentLogger(), requestId: 'req' })
    expect((await add('chat-a', 'msg_q000000000000001', '/review a.ts')).turnOnly).toBe(true)
    expect((await add('chat-b', 'msg_q000000000000002', '/review a.ts')).turnOnly).toBe(false)
    expect((await add('chat-a', 'msg_q000000000000003', '/model mock:echo')).turnOnly).toBe(false)
    expect((await add('chat-a', 'msg_q000000000000004', 'please /review')).turnOnly).toBe(false)
  })
})
