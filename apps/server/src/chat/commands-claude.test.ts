/* eslint-disable no-template-curly-in-string -- the bodies hold `${CLAUDE_…}` variables on purpose */
// Phase 12 slash commands (W12.7-T3 – T6, T8, T9; ADR-053 / ADR-058): qualified names and the bare alias, markdown
// plugin commands (Claude Code plugins: the command-file path, the plugin variables, `!` spans with the plugin's folder
// in their environment), the argument options, Claude model names on `/name`, skills with `allowed-tools` / `model`, fork
// definitions (a delegation directive) and the restrict-only `disallowed-tools`. The catalog is the fake service (its
// snapshot uses the real getters of `snapshot.ts`); spans run real POSIX shells in `realpath(mkdtemp())` folders.
import type { CommandDefinition, SkillDefinition } from '@harness-forge/plugin-sdk'
import type { CommandInvocation, CustomizationEntry, HarnessUIMessage } from '@harness-forge/shared'
import type { ResolvedModel } from '../providers/types.ts'
import type { FakeCustomizationService } from '../testing/fake-customizations.ts'
import type { AppDeps } from '../types.ts'
import type { CommandContext, CommandExpansionHost, CommandResolution, CommandServices } from './commands.ts'
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { commandInvocationSchema, HarnessError } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { catalogEntryKey, createFakeCustomizationService, fakeCatalogEntry } from '../testing/fake-customizations.ts'
import { killLiveShellGroups } from '../workspace/shell.ts'
import {
  FORK_TOOL_NAME,
  forkDirective,
  invocationDisallowedTools,
  isServerCommandFor,
  listServerCommands,
  parseSlashCommand,
  resolveCommand,
  resolveSlashName,
  turnToolRestrictionFor,
  withoutDisallowedTools,
} from './commands.ts'

const PROJECT = 'prj_0123456789abcdef'
const PLUGIN_ROOT = '/srv/hf/plugins/review-kit'
const PLUGIN_DATA = '/srv/hf/plugins/.data'

interface Registered {
  readonly pluginId: string
  readonly definition: CommandDefinition
}

/** Command services over a registry of `commands` (name → owner and definition) and the fake catalog. */
function services(fake: FakeCustomizationService, commands: readonly Registered[] = [], extra: Partial<CommandServices> = {}, skills: Record<string, { pluginId: string, definition: SkillDefinition }> = {}): CommandServices {
  return {
    registry: {
      commands: {
        get: (name: string) => commands.find(entry => entry.definition.name === name),
        list: () => [...commands],
        register: () => ({ dispose() {} }),
      },
      skills: {
        get: (name: string) => skills[name],
        list: () => Object.values(skills),
        register: () => ({ dispose() {} }),
        onChange: () => ({ dispose() {} }),
      },
    } as unknown as CommandServices['registry'],
    plugins: {
      guard: async (_pluginId, fn) => fn(new AbortController().signal),
      directory: async id => (id === 'review-kit' ? PLUGIN_ROOT : null),
    },
    customizations: fake,
    env: { paths: { pluginData: PLUGIN_DATA } },
    ...extra,
  }
}

const REVIEW: Registered = {
  pluginId: 'review-kit',
  definition: {
    name: 'review-kit:review',
    description: 'Review the changed files',
    syntax: 'markdown',
    argumentHint: '[focus]',
    allowedTools: ['read_file', 'search_files'],
    template: 'Review the changed files. Focus on $ARGUMENTS.\nChecklist: ${CLAUDE_PLUGIN_ROOT}/skills/pdf/reference.md',
  },
}
const MIGRATE: Registered = {
  pluginId: 'review-kit',
  definition: { name: 'review-kit:db:migrate', description: 'Plan a database migration', syntax: 'markdown', template: 'Plan a migration of the table $0 that does this: $1.' },
}
const SUMMARIZE: Registered = { pluginId: 'demo', definition: { name: 'summarize', description: 'Summarize.', template: 'PLUGIN SUMMARY {{input}}' } }

/** The catalog entries the registry's plugin commands give (global: every catalog lists them). */
function pluginEntries(fake: FakeCustomizationService, commands: readonly Registered[], fields: Record<string, Partial<CustomizationEntry>> = {}): void {
  const entries = commands.map(entry => fakeCatalogEntry('command', entry.definition.name, { source: 'plugin', pluginId: entry.pluginId, description: entry.definition.description, ...(fields[entry.definition.name] ?? {}) }))
  fake.entries.set('', [...(fake.entries.get('') ?? []), ...entries])
}

function base(signal = new AbortController().signal): CommandContext {
  return { chatId: 'chat_1', signal }
}

async function resolveIn(fake: FakeCustomizationService, text: string, commands: readonly Registered[] = [], context: Partial<CommandContext> = {}, extra: Partial<CommandServices> = {}): Promise<CommandResolution | null> {
  return resolveCommand(services(fake, commands, extra), text, { ...base(), catalog: await fake.catalog(PROJECT), ...context })
}

function invocationOf(resolution: CommandResolution | null): CommandInvocation | undefined {
  return resolution?.kind === 'prompt' ? resolution.invocation : undefined
}

function expansionOf(resolution: CommandResolution | null): string | undefined {
  return invocationOf(resolution)?.expansion
}

function projectCommand(fake: FakeCustomizationService, name: string, content: string): CustomizationEntry {
  const entry = fakeCatalogEntry('command', name, { source: 'project', path: `.harness/commands/${name}.md` })
  fake.entries.set(PROJECT, [...(fake.entries.get(PROJECT) ?? []), entry])
  fake.bodies.set(catalogEntryKey(entry), content)
  return entry
}

function providersOf(known: readonly string[]): NonNullable<CommandServices['providers']> {
  return {
    resolveModel: async (modelRef) => {
      if (!known.includes(modelRef))
        throw new HarnessError({ code: 'provider_not_configured', message: 'Not configured.', providerId: 'anthropic', action: 'configure-provider' })
      return { modelRef, entry: { kind: 'chat' } } as unknown as ResolvedModel
    },
  }
}

describe('parseSlashCommand: qualified names (W12.7-T3)', () => {
  it('reads qualified names of up to 128 characters; anything that is no catalog name is no command', () => {
    expect(parseSlashCommand('/review-kit:review security')).toEqual({ name: 'review-kit:review', input: 'security' })
    expect(parseSlashCommand('/review-kit:db:migrate users x')).toEqual({ name: 'review-kit:db:migrate', input: 'users x' })
    expect(parseSlashCommand('/1password:login')).toEqual({ name: '1password:login', input: '' })
    const long = `p:${'a'.repeat(63)}:${'b'.repeat(62)}`
    expect(long.length).toBe(128)
    expect(parseSlashCommand(`/${long} x`)).toEqual({ name: long, input: 'x' })
    expect(parseSlashCommand(`/${long}b`)).toBeNull()
    for (const text of ['/note: remember this', '/a:', '/:a', '/a::b', '/review-kit:Review', '/a:b:c:d:e', '/1abc', '/http://x'])
      expect(parseSlashCommand(text), text).toBeNull()
  })
})

describe('qualified names and the bare alias (W12.7-T3)', () => {
  it('/review-kit:review, /review-kit:db:migrate, the bare /review and /migrate while unique; a collision gives no alias', async () => {
    const fake = createFakeCustomizationService()
    pluginEntries(fake, [REVIEW, MIGRATE])
    const commands = [REVIEW, MIGRATE]
    const review = await resolveIn(fake, '/review-kit:review security', commands)
    expect(invocationOf(review)).toEqual({
      name: 'review-kit:review',
      input: 'security',
      type: 'prompt',
      expansion: `Review the changed files. Focus on security.\nChecklist: ${PLUGIN_ROOT}/skills/pdf/reference.md`,
      allowedTools: ['read_file', 'search_files'],
    })
    expect(commandInvocationSchema.parse(invocationOf(review))).toEqual(invocationOf(review))
    expect(expansionOf(await resolveIn(fake, '/review-kit:db:migrate users "add a column"', commands))).toBe('Plan a migration of the table users that does this: add a column.')
    expect(invocationOf(await resolveIn(fake, '/review security', commands))).toMatchObject({ name: 'review-kit:review', input: 'security' })
    expect(invocationOf(await resolveIn(fake, '/migrate users drop', commands))).toMatchObject({ name: 'review-kit:db:migrate', expansion: 'Plan a migration of the table users that does this: drop.' })

    const other: Registered = { pluginId: 'other', definition: { name: 'other:review', description: 'Other review.', syntax: 'markdown', template: 'OTHER $ARGUMENTS' } }
    pluginEntries(fake, [other])
    expect(await resolveIn(fake, '/review x', [...commands, other])).toBeNull()
    expect(expansionOf(await resolveIn(fake, '/other:review x', [...commands, other]))).toBe('OTHER x')
  })

  it('an exact name wins over an alias; a harness plugin\'s <pluginId>:<name> runs its own command', async () => {
    const fake = createFakeCustomizationService()
    pluginEntries(fake, [REVIEW, SUMMARIZE])
    projectCommand(fake, 'review', '---\ndescription: Project review.\n---\nPROJECT $ARGUMENTS')
    expect(expansionOf(await resolveIn(fake, '/review x', [REVIEW, SUMMARIZE]))).toBe('PROJECT x')
    // A personal command shadows the plugin's `summarize`; `/demo:summarize` still names the plugin's.
    await fake.create({ kind: 'command', content: '---\nname: summarize\ndescription: Mine.\n---\nMINE $ARGUMENTS' })
    expect(expansionOf(await resolveIn(fake, '/summarize a', [REVIEW, SUMMARIZE]))).toBe('MINE a')
    expect(invocationOf(await resolveIn(fake, '/demo:summarize a', [REVIEW, SUMMARIZE]))).toEqual({ name: 'demo:summarize', input: 'a', type: 'prompt', expansion: 'PLUGIN SUMMARY a' })
    expect(await resolveIn(fake, '/wrong:summarize a', [REVIEW, SUMMARIZE])).toBeNull()
    expect(await resolveIn(fake, '/review-kit:summarize a', [REVIEW, SUMMARIZE])).toBeNull()
  })

  it('resolveSlashName and isServerCommandFor follow the same rule (the queue marks aliases turnOnly)', async () => {
    const fake = createFakeCustomizationService()
    pluginEntries(fake, [REVIEW, MIGRATE])
    const { registry } = services(fake, [REVIEW, MIGRATE])
    const catalog = await fake.catalog(PROJECT)
    expect(resolveSlashName(registry, catalog, 'review')).toBe('review-kit:review')
    expect(resolveSlashName(registry, catalog, 'migrate')).toBe('review-kit:db:migrate')
    expect(resolveSlashName(registry, catalog, 'unknown')).toBe('unknown')
    const deps = { registry, customizations: fake } as unknown as Pick<AppDeps, 'registry' | 'customizations'>
    for (const text of ['/review x', '/review-kit:review', '/migrate a b', '/review-kit:db:migrate'])
      expect(await isServerCommandFor(deps, PROJECT, text), text).toBe(true)
    for (const text of ['/unknown', '/model mock:echo', 'review', '/kit:review'])
      expect(await isServerCommandFor(deps, PROJECT, text), text).toBe(false)
  })

  it('skills: a qualified plugin skill runs as /name, its bare alias too; a command of the name still wins', async () => {
    const fake = createFakeCustomizationService()
    const skill = fakeCatalogEntry('skill', 'review-kit:notes', { source: 'plugin', pluginId: 'review-kit' })
    fake.entries.set('', [skill])
    fake.bodies.set(catalogEntryKey(skill), { kind: 'skill', fields: { name: 'review-kit:notes', description: 'Notes.', content: 'Write notes about $ARGUMENTS.' } })
    expect(invocationOf(await resolveIn(fake, '/review-kit:notes the API', []))).toEqual({ name: 'review-kit:notes', input: 'the API', type: 'prompt', expansion: 'Write notes about the API.', kind: 'skill', source: 'plugin' })
    expect(invocationOf(await resolveIn(fake, '/notes x', []))).toMatchObject({ name: 'review-kit:notes', kind: 'skill' })
  })
})

describe('arguments, variables and models (W12.7-T5, T8)', () => {
  it('$0 / $ARGUMENTS[1] / $name bodies are 0-based, \\$ is a literal $, the Phase 10 $1 keeps its meaning', async () => {
    const fake = createFakeCustomizationService()
    projectCommand(fake, 'zero', '---\ndescription: Zero.\n---\nFirst $0, second $ARGUMENTS[1], all $ARGUMENTS, cost \\$5.')
    projectCommand(fake, 'named', '---\ndescription: Named.\narguments: [table, change]\n---\nTable $table, change $change, other $missing.')
    projectCommand(fake, 'legacy', '---\ndescription: Legacy.\n---\nFirst $1, second $2.')
    expect(expansionOf(await resolveIn(fake, '/zero a b', []))).toBe('First a, second b, all a b, cost $5.')
    expect(expansionOf(await resolveIn(fake, '/named users "drop x"', []))).toBe('Table users, change drop x, other $missing.')
    expect(expansionOf(await resolveIn(fake, '/legacy a b', []))).toBe('First a, second b.')
  })

  it('${CLAUDE_SESSION_ID} from the context, ${CLAUDE_PROJECT_DIR} from the open folder (only when named), others literal', async () => {
    const fake = createFakeCustomizationService()
    projectCommand(fake, 'where', '---\ndescription: Where.\n---\nSession ${CLAUDE_SESSION_ID} in ${CLAUDE_PROJECT_DIR}, skill ${CLAUDE_SKILL_DIR}.')
    projectCommand(fake, 'plain', '---\ndescription: Plain.\n---\nNo variables: $ARGUMENTS')
    const asked: string[] = []
    const host: CommandExpansionHost = {
      projectId: PROJECT,
      shellEnabled: true,
      trusted: async () => false,
      workspace: async () => {
        asked.push('workspace')
        return { projectId: PROJECT, name: 'Demo', root: '/work/demo', instructions: null, projectFile: null }
      },
    }
    const context = { expansion: host, argumentVars: { CLAUDE_SESSION_ID: 'chat_1' } }
    expect(expansionOf(await resolveIn(fake, '/where', [], context))).toBe('Session chat_1 in /work/demo, skill ${CLAUDE_SKILL_DIR}.')
    expect(asked).toEqual(['workspace'])
    expect(expansionOf(await resolveIn(fake, '/plain x', [], context))).toBe('No variables: x')
    expect(asked).toEqual(['workspace'])
  })

  it('a Claude model name resolves through modelAliases, a full id to anthropic:<id>; one that does not is modelUnavailable', async () => {
    const fake = createFakeCustomizationService()
    projectCommand(fake, 'fast', '---\ndescription: Fast.\nmodel: sonnet\n---\nGo $ARGUMENTS')
    projectCommand(fake, 'pinned', '---\ndescription: Pinned.\nmodel: claude-sonnet-4-5\n---\nGo')
    const providers = providersOf(['anthropic:claude-sonnet-4-5'])
    const aliases = { modelAliases: { sonnet: 'mock:agents', opus: null, haiku: null, fable: null } }
    expect(await resolveIn(fake, '/fast x', [], aliases, { providers })).toEqual({ kind: 'prompt', invocation: { name: 'fast', input: 'x', type: 'prompt', expansion: 'Go x', source: 'project', modelRef: 'mock:agents' } })
    expect(await resolveIn(fake, '/fast x', [], {}, { providers })).toMatchObject({ modelUnavailable: 'sonnet' })
    expect(invocationOf(await resolveIn(fake, '/fast x', [], {}, { providers }))?.modelRef).toBeUndefined()
    expect(invocationOf(await resolveIn(fake, '/pinned', [], {}, { providers }))?.modelRef).toBe('anthropic:claude-sonnet-4-5')
    expect(await resolveIn(fake, '/pinned', [], {}, { providers: providersOf([]) })).toMatchObject({ modelUnavailable: 'claude-sonnet-4-5' })
    // A plugin command's `model` may be a Claude name too.
    const plugin: Registered = { pluginId: 'review-kit', definition: { name: 'review-kit:fast', description: 'Fast.', syntax: 'markdown', model: 'opusplan', template: 'Go' } }
    const opus = { modelAliases: { sonnet: null, opus: 'mock:echo', haiku: null, fable: null } }
    expect(invocationOf(await resolveIn(fake, '/review-kit:fast', [plugin], opus, { providers }))?.modelRef).toBe('mock:echo')
  })
})

describe('skills on /name and fork definitions (W12.7-T6, T9)', () => {
  it('a skill\'s allowed-tools and model apply to the turn; ${CLAUDE_SKILL_DIR} of a project, plugin and personal skill', async () => {
    const fake = createFakeCustomizationService()
    await fake.create({ kind: 'skill', content: '---\nname: lint\ndescription: Lint.\nallowed-tools: Read, Grep\nmodel: mock:agents\n---\nLint $ARGUMENTS in ${CLAUDE_SKILL_DIR}.' })
    const project = fakeCatalogEntry('skill', 'pdf', { source: 'project', path: '.claude/skills/pdf/SKILL.md' })
    fake.entries.set(PROJECT, [project])
    fake.bodies.set(catalogEntryKey(project), '---\nname: pdf\ndescription: PDF.\n---\nRead ${CLAUDE_SKILL_DIR}/reference.md for $ARGUMENTS.')
    const plugin = fakeCatalogEntry('skill', 'review-kit:forms', { source: 'plugin', pluginId: 'review-kit' })
    fake.entries.set('', [plugin])
    fake.bodies.set(catalogEntryKey(plugin), { kind: 'skill', fields: { name: 'review-kit:forms', description: 'Forms.', content: 'Run ${CLAUDE_SKILL_DIR}/fill.sh $0.' } })
    const skills = { 'review-kit:forms': { pluginId: 'review-kit', definition: { name: 'review-kit:forms', description: 'Forms.', content: '', baseDir: 'skills/forms' } } }
    const resolve = async (text: string): Promise<CommandResolution | null> => resolveCommand(services(fake, [], {}, skills), text, { ...base(), catalog: await fake.catalog(PROJECT) })

    expect(invocationOf(await resolve('/lint src'))).toEqual({
      name: 'lint',
      input: 'src',
      type: 'prompt',
      expansion: 'Lint src in ${CLAUDE_SKILL_DIR}.',
      kind: 'skill',
      source: 'user',
      modelRef: 'mock:agents',
      allowedTools: ['read_file', 'search_files'],
    })
    expect(expansionOf(await resolve('/pdf form.pdf'))).toBe('Read .claude/skills/pdf/reference.md for form.pdf.')
    expect(expansionOf(await resolve('/review-kit:forms a.pdf'))).toBe(`Run ${PLUGIN_ROOT}/skills/forms/fill.sh a.pdf.`)
  })

  it('a fork skill or command expands with the delegation directive; task stays in its allowed tools', async () => {
    const fake = createFakeCustomizationService()
    await fake.create({ kind: 'skill', content: '---\nname: deep\ndescription: Deep research.\ncontext: fork\nagent: explore\nallowed-tools: Read\n---\nResearch $ARGUMENTS thoroughly.' })
    projectCommand(fake, 'audit', '---\ndescription: Audit.\ncontext: fork\n---\nAudit $ARGUMENTS.')
    const skill = invocationOf(await resolveIn(fake, '/deep the cache', []))
    expect(skill).toMatchObject({ name: 'deep', kind: 'skill', allowedTools: ['read_file', FORK_TOOL_NAME] })
    expect(skill?.expansion).toBe(forkDirective('deep', 'explore', 'Research the cache thoroughly.'))
    expect(skill?.expansion).toContain('call the task tool once with type "explore"')
    expect(skill?.expansion).toContain('<instructions>\nResearch the cache thoroughly.\n</instructions>')
    const command = invocationOf(await resolveIn(fake, '/audit auth', []))
    expect(command?.expansion).toBe(forkDirective('audit', 'general', 'Audit auth.'))
    expect(command?.allowedTools).toBeUndefined()
  })
})

describe.skipIf(process.platform === 'win32')('markdown plugin commands with spans (W12.7-T4)', () => {
  let folder: string
  let root: string
  let pluginRoot: string

  beforeAll(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), 'hf-')))
    root = join(folder, 'project')
    pluginRoot = join(folder, 'plugin')
    await mkdir(root, { recursive: true })
    await mkdir(pluginRoot, { recursive: true })
  })

  afterAll(async () => {
    killLiveShellGroups()
    await rm(folder, { recursive: true, force: true })
  })

  function host(): CommandExpansionHost {
    return {
      projectId: PROJECT,
      shellEnabled: true,
      trusted: async () => false,
      workspace: async () => ({ projectId: PROJECT, name: 'Demo', root, instructions: null, projectFile: null }),
    }
  }

  it('a registered (trusted, active) plugin\'s span runs with CLAUDE_PLUGIN_ROOT / CLAUDE_PLUGIN_DATA; $ARGUMENTS expands next to it', async () => {
    const fake = createFakeCustomizationService()
    const span: Registered = {
      pluginId: 'review-kit',
      definition: {
        name: 'review-kit:where',
        description: 'Where.',
        syntax: 'markdown',
        template: 'Root: !`printf %s "$CLAUDE_PLUGIN_ROOT|$HARNESS_PLUGIN_ROOT|$CLAUDE_PLUGIN_DATA|$CLAUDE_PROJECT_DIR"`\nFocus ${CLAUDE_SESSION_ID} on $ARGUMENTS, cost \\$1.',
      },
    }
    const extra: Partial<CommandServices> = {
      plugins: { guard: async (_pluginId, fn) => fn(new AbortController().signal), directory: async () => pluginRoot },
      env: { paths: { pluginData: join(folder, 'data') } },
    }
    const resolution = await resolveIn(fake, '/review-kit:where the tests', [span], { expansion: host(), argumentVars: { CLAUDE_SESSION_ID: 'chat_1' } }, extra)
    expect(invocationOf(resolution)).toEqual({
      name: 'review-kit:where',
      input: 'the tests',
      type: 'prompt',
      expansion: `Root: ${pluginRoot}|${pluginRoot}|${join(folder, 'data', 'review-kit')}|${root}\nFocus chat_1 on the tests, cost $1.`,
      kind: 'command',
      inlined: { shell: 1, files: [] },
    })
    // An untrusted or disabled Claude plugin registers nothing: the name is no command, nothing runs.
    expect(await resolveIn(fake, '/review-kit:where x', [], { expansion: host() }, extra)).toBeNull()
  })
})

describe('restrict-only tools (W12.7-T9)', () => {
  const KNOWN = ['read_file', 'write_file', 'shell', 'task', 'skill', 'exit_plan_mode', 'mcp__github__get', 'mcp__github__delete']

  it('withoutDisallowedTools: names, prefixes and MCP servers are removed, never added', () => {
    expect(withoutDisallowedTools(null, ['shell'], KNOWN)).toEqual(['read_file', 'write_file', 'task', 'skill', 'exit_plan_mode', 'mcp__github__get', 'mcp__github__delete', 'mcp__*'])
    expect(withoutDisallowedTools(null, ['mcp__github__delete'], KNOWN)).toEqual(['read_file', 'write_file', 'shell', 'task', 'skill', 'exit_plan_mode', 'mcp__github__get'])
    expect(withoutDisallowedTools(['read_file', 'shell'], ['shell'], KNOWN)).toEqual(['read_file'])
    expect(withoutDisallowedTools(['mcp__github__*'], ['mcp__github__delete'], KNOWN)).toEqual(['mcp__github__get'])
    expect(withoutDisallowedTools(['mcp__github'], ['mcp__github__*'], KNOWN)).toEqual([])
    expect(withoutDisallowedTools(['mcp__github__*', 'read_file'], ['shell'], KNOWN)).toEqual(['mcp__github__*', 'read_file'])
    expect(withoutDisallowedTools(['read_file'], ['read_file'], KNOWN)).toEqual([])
  })

  it('turnToolRestrictionFor: the invocation\'s allowed-tools minus the catalog entry\'s disallowed-tools; a fork keeps task', async () => {
    const fake = createFakeCustomizationService()
    const noShell = projectCommand(fake, 'no-shell', '---\ndescription: x\n---\nx')
    const forked = projectCommand(fake, 'forked', '---\ndescription: x\n---\nx')
    fake.entries.set(PROJECT, [{ ...noShell, disallowedTools: ['shell'] }, { ...forked, context: 'fork', disallowedTools: ['task', 'write_file'] }])
    const catalog = await fake.catalog(PROJECT)
    const user = (command: CommandInvocation): HarnessUIMessage => ({ id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: '/x' }], metadata: { modelRef: 'mock:echo', startedAt: 1, command } })
    const turn = (command: CommandInvocation): HarnessUIMessage[] => [user(command)]
    expect(turnToolRestrictionFor(turn({ name: 'no-shell', input: '', type: 'prompt', expansion: 'x', source: 'project' }), { catalog, toolNames: KNOWN }))
      .toEqual(['read_file', 'write_file', 'task', 'skill', 'exit_plan_mode', 'mcp__github__get', 'mcp__github__delete', 'mcp__*'])
    expect(turnToolRestrictionFor(turn({ name: 'no-shell', input: '', type: 'prompt', expansion: 'x', allowedTools: ['shell', 'read_file'] }), { catalog, toolNames: () => KNOWN })).toEqual(['read_file'])
    expect(turnToolRestrictionFor(turn({ name: 'forked', input: '', type: 'prompt', expansion: 'x', allowedTools: ['read_file', 'task'] }), { catalog, toolNames: KNOWN })).toEqual(['read_file', 'task'])
    // No disallowed list: exactly the Phase 10 restriction (the tool names are never read).
    expect(turnToolRestrictionFor(turn({ name: 'other', input: '', type: 'prompt', expansion: 'x' }), { catalog, toolNames: () => {
      throw new Error('not read')
    } })).toBeNull()
    expect(invocationDisallowedTools(catalog, { name: 'no-shell', input: '', type: 'reply' })).toEqual([])
    expect(invocationDisallowedTools(null, { name: 'no-shell', input: '', type: 'prompt' })).toEqual([])
  })
})

describe('listServerCommands (W12.7-T1, T3)', () => {
  it('lists qualified names as they are, plugin hints and models, and appends when_to_use to descriptions', async () => {
    const fake = createFakeCustomizationService()
    pluginEntries(fake, [REVIEW, MIGRATE], { 'review-kit:review': { whenToUse: 'Use before a merge.' } })
    const mine = projectCommand(fake, 'mine', '---\ndescription: Mine.\nwhen_to_use: When asked.\n---\nx')
    fake.entries.set(PROJECT, [{ ...mine, description: 'Mine.', whenToUse: 'When asked.' }])
    const skill = fakeCatalogEntry('skill', 'review-kit:pdf', { source: 'plugin', pluginId: 'review-kit', description: 'PDF forms.', whenToUse: 'A PDF is named.', argumentHint: '[file]' })
    fake.entries.set('', [...(fake.entries.get('') ?? []), skill])
    const fast: Registered = { pluginId: 'review-kit', definition: { name: 'review-kit:fast', description: 'Fast.', syntax: 'markdown', model: 'mock:agents', template: 'x' } }
    const { registry } = services(fake, [REVIEW, MIGRATE, fast])
    const items = listServerCommands(registry, await fake.catalog(PROJECT))
    expect(items.map(item => item.name)).toEqual(['compact', 'mine', 'review-kit:db:migrate', 'review-kit:fast', 'review-kit:pdf', 'review-kit:review'])
    expect(items.find(item => item.name === 'review-kit:review')).toEqual({ name: 'review-kit:review', kind: 'command', description: 'Review the changed files - Use before a merge.', source: 'plugin', pluginId: 'review-kit', argumentHint: '[focus]' })
    expect(items.find(item => item.name === 'review-kit:fast')?.modelRef).toBe('mock:agents')
    expect(items.find(item => item.name === 'mine')?.description).toBe('Mine. - When asked.')
    expect(items.find(item => item.name === 'review-kit:pdf')).toEqual({ name: 'review-kit:pdf', kind: 'skill', description: 'PDF forms. - A PDF is named.', source: 'plugin', pluginId: 'review-kit', argumentHint: '[file]' })
  })
})
