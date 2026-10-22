// MCP prompts as slash commands (W14.2-T2, T3; ADR-061): the listing (`listServerCommands` with the MCP listings,
// `source: 'mcp'`, `mcpServer`, hints, shadowing), the resolution (`/mcp__<server>__<prompt> input`: argument binding,
// `prompts/get` once, the frozen expansion, `failed` replies for missing arguments, servers that are not connected,
// unknown prompts and server errors; null for servers the scope does not know), `isServerCommandFor`, and the real
// round trip with the OAuth MCP fixture (`greet`, `review`, `with_resource`, `with_image`; the chat stores the expansion,
// a regenerate makes no second `prompts/get`).
import type { HarnessUIMessage, McpServerStateAny } from '@harness-forge/shared'
import type { OAuthMcpServer } from '../mcp/__fixtures__/oauth-mcp-server.mjs'
import type { McpListing, McpPromptInfo, McpPromptResult, ProjectMcpListing } from '../mcp/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { CommandResolution, CommandServices } from './commands.ts'
import { Buffer } from 'node:buffer'
import { HarnessError, LIMITS, mcpPromptCommandName } from '@harness-forge/shared'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PIXEL_PNG_BASE64, README_TEXT, README_URI, startOAuthMcpServer } from '../mcp/__fixtures__/oauth-mcp-server.mjs'
import { EXPANSION_CUT_NOTE } from '../mcp/content.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeCustomizationService } from '../testing/fake-customizations.ts'
import { isMcpPromptCommandFor, isServerCommandFor, listServerCommands, mcpPromptListingsFor, mcpPromptResolution, parseSlashCommand, resolveCommand } from './commands.ts'
import { chatBody, messageText, postChat, readSse, streamedText, testChatId } from './testing.ts'

const PROJECT = 'prj_0123456789abcdef'

function prompt(serverId: string, name: string, args: McpPromptInfo['arguments'] = [], fields: Partial<McpPromptInfo> = {}): McpPromptInfo {
  return { serverId, serverName: serverId.toUpperCase(), name, commandName: mcpPromptCommandName(serverId, name), title: null, description: `The ${name} prompt.`, arguments: args, ...fields }
}

function listing(items: McpPromptInfo[], unavailable: Array<{ serverId: string, status: McpServerStateAny }> = []): McpListing<McpPromptInfo> {
  return { items, truncated: false, unavailable }
}

function projectListing(items: McpPromptInfo[], fields: { unavailable?: Array<{ serverId: string, status: McpServerStateAny }>, shadowed?: string[] } = {}): ProjectMcpListing<McpPromptInfo> {
  return { items, truncated: false, unavailable: fields.unavailable ?? [], shadowed: new Set(fields.shadowed ?? []) }
}

const GREET = prompt('docs', 'greet', [{ name: 'name', description: 'Who', required: true }, { name: 'greeting', description: null, required: false }], { title: 'Greet' })
const TEXT_RESULT = (text: string): McpPromptResult => ({ messages: [{ role: 'user', content: { type: 'text', text } }] }) as McpPromptResult

/** Command services with scripted MCP members (`getPrompt` records its calls). */
function mcpServices(options: {
  global?: McpListing<McpPromptInfo> | null
  project?: ProjectMcpListing<McpPromptInfo> | null
  result?: (call: { scope: 'global' | 'project', serverId: string, name: string, args: Readonly<Record<string, string>>, signal: AbortSignal }) => Promise<McpPromptResult>
} = {}) {
  const calls: Array<{ scope: 'global' | 'project', serverId: string, name: string, args: Readonly<Record<string, string>> }> = []
  const projectCalls: Array<{ projectId: string, waitMs: number | undefined }> = []
  const result = options.result ?? (async ({ args }) => TEXT_RESULT(`${args.greeting ?? 'Hello'}, ${args.name ?? 'you'}!`))
  const services: CommandServices = {
    registry: { commands: { get: () => undefined, list: () => [], register: () => ({ dispose() {} }) } },
    plugins: { guard: async (_id, fn) => fn(new AbortController().signal) },
    customizations: { load: async () => {
      throw new Error('no definitions')
    } },
    ...(options.global === null
      ? {}
      : { mcp: {
          prompts: async () => options.global ?? listing([]),
          getPrompt: async (serverId, name, args, signal) => {
            calls.push({ scope: 'global', serverId, name, args })
            return result({ scope: 'global', serverId, name, args, signal })
          },
        } }),
    ...(options.project === undefined || options.project === null
      ? {}
      : { projectMcp: {
          prompts: async (projectId, listingOptions) => {
            projectCalls.push({ projectId, waitMs: listingOptions?.waitMs })
            return options.project as ProjectMcpListing<McpPromptInfo>
          },
          getPrompt: async (_projectId, serverId, name, args, signal) => {
            calls.push({ scope: 'project', serverId, name, args })
            return result({ scope: 'project', serverId, name, args, signal })
          },
        } }),
  }
  return { services, calls, projectCalls }
}

const context = { chatId: 'chat', signal: new AbortController().signal }

async function resolveMcp(services: CommandServices, text: string, projectId: string | null = null): Promise<CommandResolution | null> {
  const parsed = parseSlashCommand(text)
  if (parsed === null)
    throw new Error(`not a command: ${text}`)
  return mcpPromptResolution(services, parsed, { ...context, projectId })
}

function failedOf(resolution: CommandResolution | null): { invocation: unknown, error: ReturnType<HarnessError['toJSON']>['error'] } {
  if (resolution?.kind !== 'failed')
    throw new Error(`expected a failed resolution, got ${resolution?.kind ?? 'null'}`)
  return { invocation: resolution.invocation, error: resolution.error.toJSON().error }
}

describe('listServerCommands with MCP prompts (W14.2-T2)', () => {
  const registry = mcpServices().services.registry

  it('lists the prompts of the listings as mcp commands with their server, description and hint', () => {
    const items = listServerCommands(registry, null, {
      global: listing([GREET, prompt('docs', 'plain', [], { description: null, title: 'Plain title' }), prompt('wiki', 'empty', [], { description: null })]),
      project: null,
    })
    expect(items).toEqual([
      { name: 'compact', kind: 'command', description: 'Summarize the conversation to free up context', source: 'harness', pluginId: 'core-agent' },
      { name: 'mcp__docs__greet', kind: 'command', description: 'The greet prompt.', source: 'mcp', mcpServer: { id: 'docs', name: 'DOCS' }, argumentHint: '<name> [greeting]' },
      { name: 'mcp__docs__plain', kind: 'command', description: 'Plain title', source: 'mcp', mcpServer: { id: 'docs', name: 'DOCS' } },
      { name: 'mcp__wiki__empty', kind: 'command', description: '', source: 'mcp', mcpServer: { id: 'wiki', name: 'WIKI' } },
    ])
  })

  it('lists the project\'s servers first and leaves out the global servers they shadow', () => {
    const items = listServerCommands(registry, null, {
      global: listing([GREET, prompt('wiki', 'search')]),
      project: projectListing([prompt('docs', 'local')], { shadowed: ['docs'] }),
    })
    expect(items.map(item => item.name)).toEqual(['compact', 'mcp__docs__local', 'mcp__wiki__search'])
    // Without listings (or empty ones) nothing is added.
    expect(listServerCommands(registry, null, { global: null, project: null })).toEqual(listServerCommands(registry, null))
  })

  it('keeps the first of two prompts with one command name and skips names outside the contract', () => {
    const items = listServerCommands(registry, null, {
      global: listing([
        prompt('docs', 'a', [], { description: 'first' }),
        { ...prompt('docs', 'b'), commandName: 'mcp__docs__a', description: 'second' },
        { ...prompt('docs', 'c'), commandName: 'not-mcp' },
        { ...prompt('docs', 'd'), serverId: 'Bad_Id' },
      ]),
      project: null,
    })
    expect(items.filter(item => item.source === 'mcp')).toEqual([{ name: 'mcp__docs__a', kind: 'command', description: 'first', source: 'mcp', mcpServer: { id: 'docs', name: 'DOCS' } }])
  })
})

describe('mcpPromptResolution (W14.2-T3)', () => {
  it('binds the arguments, runs prompts/get once and freezes the expansion with source mcp', async () => {
    const { services, calls } = mcpServices({ global: listing([GREET]) })
    expect(await resolveMcp(services, '/mcp__docs__greet "Ada Lovelace"')).toEqual({
      kind: 'prompt',
      invocation: { name: 'mcp__docs__greet', input: '"Ada Lovelace"', type: 'prompt', expansion: 'Hello, Ada Lovelace!', source: 'mcp' },
    })
    expect(calls).toEqual([{ scope: 'global', serverId: 'docs', name: 'greet', args: { name: 'Ada Lovelace' } }])
    // Positional in declared order (the last argument takes the rest), or by name.
    const positional = await resolveMcp(services, '/mcp__docs__greet Ada Good morning')
    expect(positional?.kind === 'prompt' ? positional.invocation.expansion : null).toBe('Good morning, Ada!')
    const named = await resolveMcp(services, '/mcp__docs__greet greeting=Hi "Ada"')
    expect(named?.kind === 'prompt' ? named.invocation.expansion : null).toBe('Hi, Ada!')
    expect(calls.map(call => call.args)).toEqual([{ name: 'Ada Lovelace' }, { name: 'Ada', greeting: 'Good morning' }, { greeting: 'Hi', name: 'Ada' }])
  })

  it('answers a missing required argument with a failed reply and the usage, without calling the server', async () => {
    const { services, calls } = mcpServices({ global: listing([GREET]) })
    const failed = failedOf(await resolveMcp(services, '/mcp__docs__greet'))
    expect(failed.invocation).toEqual({ name: 'mcp__docs__greet', input: '', type: 'reply', source: 'mcp' })
    expect(failed.error).toMatchObject({ code: 'validation_error', message: 'Missing argument: name. Usage: /mcp__docs__greet <name> [greeting]' })
    const two = mcpServices({ global: listing([prompt('docs', 'pair', [{ name: 'a', required: true }, { name: 'b', required: true }])]) })
    expect(failedOf(await resolveMcp(two.services, '/mcp__docs__pair')).error.message).toBe('Missing arguments: a, b. Usage: /mcp__docs__pair <a> <b>')
    expect(calls).toHaveLength(0)
  })

  it('answers servers that are not connected and prompts the server does not list with failed replies', async () => {
    const { services, calls } = mcpServices({ global: listing([GREET], [{ serverId: 'locked', status: 'needs-auth' }, { serverId: 'slow', status: 'connecting' }]) })
    expect(failedOf(await resolveMcp(services, '/mcp__locked__greet Ada')).error).toMatchObject({ code: 'conflict', message: 'Sign in to the MCP server "locked" first.', details: { reason: 'needs-auth' } })
    expect(failedOf(await resolveMcp(services, '/mcp__slow__greet Ada')).error).toMatchObject({ code: 'provider_unreachable', message: 'The MCP server "slow" is not connected.' })
    expect(failedOf(await resolveMcp(services, '/mcp__docs__nope')).error).toMatchObject({ code: 'not_found', message: 'The MCP server "DOCS" has no prompt /mcp__docs__nope.' })
    const project = mcpServices({ global: listing([]), project: projectListing([], { unavailable: [{ serverId: 'vars', status: 'needs-variables' }] }) })
    expect(failedOf(await resolveMcp(project.services, '/mcp__vars__x', PROJECT)).error).toMatchObject({ code: 'provider_unreachable', message: 'The MCP server "vars" needs its variables before it can run.' })
    expect(calls).toHaveLength(0)
  })

  it('answers null for a server the scope does not know, a malformed name and without MCP services', async () => {
    const { services } = mcpServices({ global: listing([GREET]) })
    expect(await resolveMcp(services, '/mcp__other__greet Ada')).toBeNull()
    expect(await resolveMcp(services, '/mcp__nodelimiter')).toBeNull()
    expect(await resolveMcp(mcpServices({ global: null }).services, '/mcp__docs__greet Ada')).toBeNull()
    // `resolveCommand` sends such a text to the model as typed.
    expect(await resolveCommand(services, '/mcp__other__greet Ada', context)).toBeNull()
  })

  it('looks in the project first: its servers shadow global ones; unshadowed global servers still answer', async () => {
    const { services, calls, projectCalls } = mcpServices({
      global: listing([GREET, prompt('wiki', 'search', [{ name: 'q', required: true }])]),
      project: projectListing([prompt('docs', 'local')], { shadowed: ['docs'] }),
    })
    expect((await resolveMcp(services, '/mcp__docs__local', PROJECT))?.kind).toBe('prompt')
    expect(failedOf(await resolveMcp(services, '/mcp__docs__greet Ada', PROJECT)).error).toMatchObject({ code: 'not_found', message: 'The MCP server "DOCS" has no prompt /mcp__docs__greet.' })
    // A shadowing project server without prompts still hides the global server's prompts.
    const bare = mcpServices({ global: listing([GREET]), project: projectListing([], { shadowed: ['docs'] }) })
    expect(failedOf(await resolveMcp(bare.services, '/mcp__docs__greet Ada', PROJECT)).error).toMatchObject({ code: 'not_found', message: 'The MCP server "docs" has no prompt /mcp__docs__greet.' })
    expect((await resolveMcp(services, '/mcp__wiki__search cats', PROJECT))?.kind).toBe('prompt')
    expect(calls.map(call => `${call.scope}:${call.serverId}:${call.name}`)).toEqual(['project:docs:local', 'global:wiki:search'])
    // The project's approved servers are waited for like a run waits.
    expect(projectCalls[0]).toEqual({ projectId: PROJECT, waitMs: LIMITS.projectMcpConnectWaitMs })
    // Without a project only the global servers answer.
    expect((await resolveMcp(services, '/mcp__docs__greet Ada'))?.kind).toBe('prompt')
  })

  it('maps server failures and empty results to failed replies and rethrows an abort', async () => {
    const harness = mcpServices({ global: listing([GREET]), result: async () => {
      throw new HarnessError({ code: 'provider_error', message: 'The MCP server "docs" failed: boom' })
    } })
    expect(failedOf(await resolveMcp(harness.services, '/mcp__docs__greet Ada')).error).toMatchObject({ code: 'provider_error', message: 'The MCP server "docs" failed: boom' })
    const plain = mcpServices({ global: listing([GREET]), result: async () => {
      throw new Error('secret detail')
    } })
    const failed = failedOf(await resolveMcp(plain.services, '/mcp__docs__greet Ada'))
    expect(failed.error).toMatchObject({ code: 'provider_error', message: 'The MCP server "DOCS" could not run the prompt /mcp__docs__greet.' })
    const empty = mcpServices({ global: listing([GREET]), result: async () => ({ messages: [] }) as unknown as McpPromptResult })
    expect(failedOf(await resolveMcp(empty.services, '/mcp__docs__greet Ada')).error).toMatchObject({ code: 'provider_error', message: 'The MCP prompt /mcp__docs__greet returned no text.' })

    const controller = new AbortController()
    const stopped = mcpServices({ global: listing([GREET]), result: async ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }) })
    const parsed = parseSlashCommand('/mcp__docs__greet Ada')!
    const pending = mcpPromptResolution(stopped.services, parsed, { chatId: 'chat', signal: controller.signal })
    controller.abort(new Error('stopped by the user'))
    await expect(pending).rejects.toThrow('stopped by the user')
  })

  it('cuts an expansion above 64 KB', async () => {
    const { services } = mcpServices({ global: listing([GREET]), result: async () => TEXT_RESULT('x'.repeat(LIMITS.commandExpansionBytes + 10)) })
    const resolution = await resolveMcp(services, '/mcp__docs__greet Ada')
    const expansion = resolution?.kind === 'prompt' ? resolution.invocation.expansion : ''
    expect(Buffer.byteLength(expansion, 'utf8')).toBeLessThanOrEqual(LIMITS.commandExpansionBytes)
    expect(expansion.endsWith(EXPANSION_CUT_NOTE)).toBe(true)
  })

  it('a project listing that fails leaves the global servers (only an abort rejects)', async () => {
    const { services } = mcpServices({ global: listing([GREET]), project: projectListing([]) })
    const broken: CommandServices = { ...services, projectMcp: { prompts: async () => {
      throw new HarnessError({ code: 'not_found', message: 'Project gone.' })
    }, getPrompt: async () => {
      throw new Error('never')
    } } }
    expect((await resolveMcp(broken, '/mcp__docs__greet Ada', PROJECT))?.kind).toBe('prompt')
    const listings = await mcpPromptListingsFor(broken, PROJECT)
    expect(listings.project).toBeNull()
    expect(listings.global?.items).toHaveLength(1)
  })
})

describe('isServerCommandFor / isMcpPromptCommandFor (W14.2-T3)', () => {
  it('counts the listed prompts of connected servers of the scope', async () => {
    const { services } = mcpServices({ global: listing([GREET], [{ serverId: 'locked', status: 'needs-auth' }]), project: projectListing([prompt('local', 'run')]) })
    const deps = { registry: services.registry, customizations: createFakeCustomizationService(), mcp: services.mcp, projectMcp: services.projectMcp } as unknown as Parameters<typeof isServerCommandFor>[0]
    expect(await isServerCommandFor(deps, null, '/mcp__docs__greet Ada')).toBe(true)
    expect(await isServerCommandFor(deps, null, '/mcp__docs__nope')).toBe(false)
    expect(await isServerCommandFor(deps, null, '/mcp__locked__greet')).toBe(false)
    expect(await isServerCommandFor(deps, PROJECT, '/mcp__local__run')).toBe(true)
    expect(await isServerCommandFor(deps, null, '/mcp__local__run')).toBe(false)
    expect(await isMcpPromptCommandFor({}, null, 'mcp__docs__greet')).toBe(false)
    expect(await isMcpPromptCommandFor(deps, null, 'not-mcp')).toBe(false)
    const throwing = { mcp: { prompts: async () => {
      throw new Error('broken')
    } } } as unknown as Parameters<typeof isMcpPromptCommandFor>[0]
    expect(await isMcpPromptCommandFor(throwing, null, 'mcp__docs__greet')).toBe(false)
  })
})

describe('mCP prompts with the OAuth MCP fixture (W14.2-T3, real round trip)', () => {
  let fixture: OAuthMcpServer
  let t: TestApp

  beforeAll(async () => {
    fixture = await startOAuthMcpServer({ toggles: { noAuth: true } })
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, mcpAuth: 'fake' })
    await t.deps.mcp.create({ id: 'fake', name: 'Fake', transport: { type: 'http', url: fixture.url } })
    await vi.waitFor(async () => expect((await t.deps.mcp.get('fake')).status).toBe('connected'), { timeout: 15_000, interval: 50 })
    await vi.waitFor(async () => expect((await t.deps.mcp.prompts()).items.length).toBe(4), { timeout: 10_000, interval: 50 })
  }, 30_000)

  afterAll(async () => {
    await t?.close()
    await fixture?.stop()
  })

  async function resolved(text: string): Promise<CommandResolution | null> {
    return resolveCommand(t.deps, text, { chatId: testChatId(0xF00), signal: new AbortController().signal, projectId: null })
  }

  it('lists the fixture prompts with their hints', async () => {
    const listed = listServerCommands(t.deps.registry, null, await mcpPromptListingsFor(t.deps, null)).filter(item => item.source === 'mcp')
    expect(listed.map(item => [item.name, item.argumentHint ?? null])).toEqual([
      ['mcp__fake__greet', '<name> [greeting]'],
      ['mcp__fake__review', '[topic]'],
      ['mcp__fake__with_image', null],
      ['mcp__fake__with_resource', null],
    ])
    expect(listed[0]).toMatchObject({ description: 'Greets someone by name.', mcpServer: { id: 'fake', name: 'Fake' } })
  })

  it('expands greet, review, with_resource and with_image; a missing argument is failed', async () => {
    fixture.resetCounters()
    const greet = await resolved('/mcp__fake__greet Ada')
    expect(greet).toEqual({ kind: 'prompt', invocation: { name: 'mcp__fake__greet', input: 'Ada', type: 'prompt', expansion: 'Hello, Ada!', source: 'mcp' } })
    const review = await resolved('/mcp__fake__review topic=docs')
    expect(review?.kind === 'prompt' ? review.invocation.expansion : '').toMatch(/^<prompt-message role="assistant">\n[\s\S]+\n<\/prompt-message>\n\n<prompt-message role="user">\n[\s\S]+\n<\/prompt-message>$/)
    const resource = await resolved('/mcp__fake__with_resource')
    expect(resource?.kind === 'prompt' ? resource.invocation.expansion : '').toContain(`<resource uri="${README_URI}" mimeType="text/markdown">\n${README_TEXT}\n</resource>`)
    const image = await resolved('/mcp__fake__with_image')
    expect(image?.kind === 'prompt' ? image.invocation.expansion : '').toContain(`[Image: image/png, ${Buffer.from(PIXEL_PNG_BASE64, 'base64').byteLength} bytes]`)
    expect(fixture.counters().promptsGet).toBe(4)
    expect(failedOf(await resolved('/mcp__fake__greet')).error.message).toBe('Missing argument: name. Usage: /mcp__fake__greet <name> [greeting]')
    expect(fixture.counters().promptsGet).toBe(4)
  })

  it('a chat stores the frozen expansion and a regenerate makes no second prompts/get', async () => {
    fixture.resetCounters()
    const chatId = testChatId(0xF01)
    const first = await readSse(await postChat(t, chatBody(chatId, '/mcp__fake__greet Ada')))
    expect(streamedText(first.chunks)).toContain('Hello, Ada!')
    const user = (await t.deps.chats.listMessages(chatId)).find(message => message.role === 'user') as HarnessUIMessage
    expect(messageText(user)).toBe('/mcp__fake__greet Ada')
    expect(user.metadata?.command).toEqual({ name: 'mcp__fake__greet', input: 'Ada', type: 'prompt', expansion: 'Hello, Ada!', source: 'mcp' })
    expect(fixture.counters().promptsGet).toBe(1)
    const again = await readSse(await postChat(t, { ...chatBody(chatId, ''), trigger: 'regenerate-message', messageId: user.id, message: user }))
    expect(streamedText(again.chunks)).toContain('Hello, Ada!')
    expect(fixture.counters().promptsGet).toBe(1)
    // Prompt arguments and expansions are never logged (the debug line carries the server id, the size, the duration).
    expect(t.logs.text()).not.toContain('Hello, Ada!')
    const expanded = t.logs.records.filter(record => record.msg === 'MCP prompt expanded')
    expect(expanded.length).toBeGreaterThan(0)
    for (const record of expanded)
      expect(record).toMatchObject({ level: 'debug', serverId: 'fake', scope: 'global', bytes: 11 })
    expect(t.logs.records.filter(record => record.level !== 'debug').map(record => JSON.stringify(record)).join('\n')).not.toContain('Ada')
  }, 30_000)
})
