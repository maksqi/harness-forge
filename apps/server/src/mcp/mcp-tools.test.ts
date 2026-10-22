import type { CallToolResult, ElicitResult } from '@ai-sdk/mcp'
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { McpElicitation, McpElicitationForm } from '@harness-forge/shared'
import type { AgentRunScope } from '../chat/agent-scope.ts'
import type { AppDeps } from '../types.ts'
import type { McpListedTool, McpToolBinding } from './mcp-tools.ts'
import { AuthorizationServerMismatchError, UnauthorizedError } from '@ai-sdk/mcp'
import { HarnessError, LIMITS } from '@harness-forge/shared'
import { asSchema } from 'ai'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindAgentScope } from '../chat/agent-scope.ts'
import { createMemoryLogger } from '../logger.ts'
import { createFakeElicitationBroker } from '../testing/fake-elicitations.ts'
import { createRecordingEventBus } from '../testing/fakes.ts'
import { runToolExecute, toolContext } from './__fixtures__/harness.ts'
import { mcpContentText } from './content.ts'
import { createElicitationBroker } from './elicitation/broker.ts'
import {
  authRequiredInit,
  connectionErrorInit,
  HEADER_REJECTED_MESSAGE,
  isAuthRequired,
  isConnectionFailure,
  isPermanentMcpError,
  mcpConfigError,
  NEEDS_AUTH_MESSAGE,
} from './errors.ts'
import { createActiveBudget, MCP_ELICITATION_KEEPALIVE_MS, MCP_TOOL_TIMEOUT_MS, mcpErrorText, mcpInputSchema, mcpModelOutput, mcpToolDefinition, mcpToolOutput, offlineToolOf } from './mcp-tools.ts'
import { McpAuthRequired } from './oauth/types.ts'

afterEach(() => {
  vi.useRealTimers()
})

function listed(overrides: Partial<McpListedTool> = {}): McpListedTool {
  return { name: 'search', description: 'Search things.', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }, ...overrides } as McpListedTool
}

const FORM: McpElicitationForm = { fields: [{ name: 'name', type: 'string', title: 'Name', description: null, required: true }] }

/** The iterator of an async generator `execute`. */
function iterate(result: unknown): AsyncIterator<unknown> {
  return (result as AsyncIterable<unknown>)[Symbol.asyncIterator]()
}

/** A call that settles when the test says so (or rejects with the signal's reason). */
function controlledCall() {
  let settle: ((result: CallToolResult) => void) | undefined
  const call = vi.fn<McpToolBinding['call']>((_name, _input, _c, signal) => new Promise<CallToolResult>((resolve, reject) => {
    settle = resolve
    signal.addEventListener('abort', () => reject(new Error('Request was aborted')), { once: true })
  }))
  return { call, settle: (result: CallToolResult) => settle?.(result) }
}

describe('mcpToolDefinition', () => {
  it('maps name, description, schema and policy, and calls the server with the original name and the budget signal', async () => {
    const call = vi.fn(async () => ({ content: [{ type: 'text', text: 'found' }], _meta: { trace: 1 } }) as CallToolResult)
    const definition = mcpToolDefinition(listed({ name: 'search.v2', annotations: { readOnlyHint: true } }), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'always', call })
    expect(definition.name).toBe('mcp__docs__search_v2')
    expect(definition.policy).toBe('safe')
    expect(definition.description).toBe('Search things.')
    expect(definition.timeoutMs).toBe(MCP_TOOL_TIMEOUT_MS)
    expect(MCP_TOOL_TIMEOUT_MS).toBe(600_000)
    expect(Object.prototype.toString.call(definition.execute)).toBe('[object AsyncGeneratorFunction]')
    expect(await asSchema(definition.inputSchema).jsonSchema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
      required: ['q'],
      additionalProperties: false,
    })
    const context = toolContext()
    const run = await runToolExecute(definition.execute({ q: 'x' }, context))
    expect(run).toEqual({ preliminary: [], output: { content: [{ type: 'text', text: 'found' }] } })
    expect(call).toHaveBeenCalledWith('search.v2', { q: 'x' }, context, expect.any(AbortSignal))
    // The budget signal is closed once the call ended (a late request on it would abort).
    expect((call.mock.calls[0] as unknown as [string, unknown, ToolCallContext, AbortSignal])[3].aborted).toBe(true)
  })

  it('throws the error text of an isError result', async () => {
    const definition = mcpToolDefinition(listed(), {
      serverId: 'docs',
      pluginId: 'core-mcp',
      serverPolicy: 'ask',
      call: async () => ({ content: [{ type: 'text', text: 'Quota exceeded' }, { type: 'text', text: 'Try later' }], isError: true }) as CallToolResult,
    })
    await expect(runToolExecute(definition.execute({ q: 'x' }, toolContext()))).rejects.toThrow('Quota exceeded\nTry later')
    expect(definition.policy).toBe('ask')
  })

  it('uses the title as a description fallback and keeps a missing schema an object', () => {
    const tool = listed({ description: undefined, title: 'Find', inputSchema: {} as McpListedTool['inputSchema'] })
    const offline = offlineToolOf(tool, { serverId: 'docs', pluginId: 'acme', serverPolicy: 'always' })
    expect(offline).toEqual({
      name: 'mcp__docs__search',
      title: 'Find',
      description: 'Find',
      pluginId: 'acme',
      mcpServerId: 'docs',
      policy: 'always',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    })
    expect(mcpInputSchema(listed({ inputSchema: { type: 'object', properties: 'bad' } as unknown as McpListedTool['inputSchema'] })).properties).toEqual({})
  })
})

describe('mcpToolDefinition and the elicitation broker', () => {
  it('registers the call, yields input-required / running, and keeps the records (never the values) in the final output', async () => {
    const broker = createFakeElicitationBroker()
    const { call, settle } = controlledCall()
    const definition = mcpToolDefinition(listed(), {
      serverId: 'docs',
      pluginId: 'core-mcp',
      serverPolicy: 'ask',
      call,
      elicitation: { broker, runtimeKey: 'mcp:docs#3', serverName: 'Docs' },
    })
    const context = toolContext()
    bindAgentScope(context, { chatId: context.chatId } as AgentRunScope)
    const iterator = iterate(definition.execute({ q: 'x' }, context))

    const first = iterator.next()
    await vi.waitFor(() => expect(broker.inFlight).toHaveLength(1))
    expect(broker.inFlight[0]).toMatchObject({ runtimeKey: 'mcp:docs#3', chatId: context.chatId, toolCallId: 'call_1', serverId: 'docs', serverName: 'Docs', interactive: true })
    expect(broker.inFlight[0]?.signal).toBe(context.signal)
    const reply = broker.request({ chatId: context.chatId, toolCallId: 'call_1' }, { message: 'Your name?', form: FORM })
    expect((await first).value).toEqual({ status: 'input-required', elicitation: reply.elicitation })

    const second = iterator.next()
    await broker.answer(context.chatId, reply.elicitation.id, { action: 'accept', content: { name: 'Ada Lovelace' } })
    expect(await reply.result).toEqual({ action: 'accept', content: { name: 'Ada Lovelace' } })
    expect((await second).value).toEqual({ status: 'running' })

    const third = iterator.next()
    settle({ content: [{ type: 'text', text: 'Hello Ada' }] } as CallToolResult)
    const final = (await third).value as Record<string, unknown>
    expect(final).toEqual({
      content: [{ type: 'text', text: 'Hello Ada' }],
      elicitations: [{ id: reply.elicitation.id, message: 'Your name?', fields: ['name'], action: 'accept', reason: 'user' }],
    })
    expect(JSON.stringify(final)).not.toContain('Lovelace')
    expect((await iterator.next()).done).toBe(true)
    expect(broker.inFlight).toEqual([])
    // The model never sees the records.
    expect(mcpModelOutput(final)).toEqual({ type: 'content', value: [{ type: 'text', text: 'Hello Ada' }] })
  })

  it('marks sub-agent and background calls (no agent scope) not interactive and ends the call on a failure', async () => {
    const broker = createFakeElicitationBroker()
    const end = vi.fn()
    const begin = vi.fn((call: Parameters<typeof broker.begin>[0]) => ({ ...broker.begin(call), end }))
    const definition = mcpToolDefinition(listed(), {
      serverId: 'docs',
      pluginId: 'core-mcp',
      serverPolicy: 'ask',
      call: async () => {
        throw new Error('The MCP tool "search" failed: boom')
      },
      elicitation: { broker: { begin }, runtimeKey: 'mcp:docs#1', serverName: 'Docs' },
    })
    await expect(runToolExecute(definition.execute({}, toolContext()))).rejects.toThrow('boom')
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }))
    expect(end).toHaveBeenCalledOnce()
  })

  it('runs the call without a card when the broker cannot register it', async () => {
    const definition = mcpToolDefinition(listed(), {
      serverId: 'docs',
      pluginId: 'core-mcp',
      serverPolicy: 'ask',
      call: async () => ({ content: [{ type: 'text', text: 'ok' }] }) as CallToolResult,
      elicitation: {
        broker: { begin: () => {
          throw new Error('broken broker')
        } },
        runtimeKey: 'mcp:docs#1',
        serverName: 'Docs',
      },
    })
    expect((await runToolExecute(definition.execute({}, toolContext()))).output).toEqual({ content: [{ type: 'text', text: 'ok' }] })
  })

  it('times a call out after the active budget, which pauses while the call waits for the user', async () => {
    vi.useFakeTimers()
    const broker = createFakeElicitationBroker()
    const { call, settle } = controlledCall()
    const definition = mcpToolDefinition(listed(), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'ask', call, elicitation: { broker, runtimeKey: 'k', serverName: 'Docs' } })
    const context = toolContext()
    const iterator = iterate(definition.execute({}, context))
    const first = iterator.next()
    await vi.advanceTimersByTimeAsync(10_000)
    const reply = broker.request({ chatId: context.chatId, toolCallId: 'call_1' }, { message: 'Wait', form: FORM })
    expect((await first).value).toMatchObject({ status: 'input-required' })
    // Waiting for the user does not count: far beyond the 60 s budget.
    const second = iterator.next()
    await vi.advanceTimersByTimeAsync(5 * LIMITS.mcpToolActiveMs)
    expect(call.mock.calls[0]?.[3].aborted).toBe(false)
    // The keep-alive sent the card again meanwhile (W14.3).
    expect((await second).value).toEqual({ status: 'input-required', elicitation: reply.elicitation })
    const running = iterator.next()
    await broker.answer(context.chatId, reply.elicitation.id, { action: 'decline' })
    expect((await running).value).toEqual({ status: 'running' })
    // 50 s of the budget are left.
    const third = iterator.next()
    await vi.advanceTimersByTimeAsync(LIMITS.mcpToolActiveMs - 10_000 - 1000)
    expect(call.mock.calls[0]?.[3].aborted).toBe(false)
    const rejected = expect(third).rejects.toThrow(`did not finish within ${LIMITS.mcpToolActiveMs / 1000} s`)
    await vi.advanceTimersByTimeAsync(2000)
    await rejected
    settle({ content: [] } as unknown as CallToolResult)
  })

  it('times out after 60 s of work without a broker (the v1.8 tool guard)', async () => {
    vi.useFakeTimers()
    const { call } = controlledCall()
    const definition = mcpToolDefinition(listed(), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'ask', call })
    const run = runToolExecute(definition.execute({}, toolContext()))
    const rejected = expect(run).rejects.toThrow('"search" did not finish within 60 s')
    await vi.advanceTimersByTimeAsync(LIMITS.mcpToolActiveMs)
    await rejected
  })

  it('keeps the abort of the call (Stop) as it is', async () => {
    const { call } = controlledCall()
    const definition = mcpToolDefinition(listed(), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'ask', call })
    const controller = new AbortController()
    const run = runToolExecute(definition.execute({}, toolContext(controller.signal)))
    await vi.waitFor(() => expect(call).toHaveBeenCalled())
    controller.abort(new Error('Stopped'))
    await expect(run).rejects.toThrow('Request was aborted')
  })

  it('re-yields a pending card every 25 s (the keep-alive), notifies the run once per request and never stores a value', async () => {
    vi.useFakeTimers()
    expect(MCP_ELICITATION_KEEPALIVE_MS).toBe(25_000)
    const broker = createFakeElicitationBroker()
    const { call, settle } = controlledCall()
    const definition = mcpToolDefinition(listed(), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'ask', call, elicitation: { broker, runtimeKey: 'mcp:docs#1', serverName: 'Docs' } })
    const context = toolContext()
    const notify = vi.fn()
    bindAgentScope(context, { chatId: context.chatId, notify } as unknown as AgentRunScope)
    const iterator = iterate(definition.execute({ q: 'x' }, context))
    const pending = (promise: Promise<unknown>) => {
      const state = { done: false }
      void promise.then(() => {
        state.done = true
      })
      return state
    }

    const first = iterator.next()
    const reply = broker.request({ chatId: context.chatId, toolCallId: 'call_1' }, { message: 'Your name?', form: FORM })
    const card = { status: 'input-required', elicitation: reply.elicitation }
    expect((await first).value).toEqual(card)
    expect(notify).toHaveBeenCalledOnce()
    expect(notify).toHaveBeenCalledWith({ message: 'Your name?', notificationType: 'elicitation_dialog' })

    const second = iterator.next()
    const secondState = pending(second)
    await vi.advanceTimersByTimeAsync(MCP_ELICITATION_KEEPALIVE_MS - 1)
    expect(secondState.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect((await second).value).toEqual(card)
    const third = iterator.next()
    await vi.advanceTimersByTimeAsync(MCP_ELICITATION_KEEPALIVE_MS)
    expect((await third).value).toEqual(card)
    // Waiting never uses the active budget; a keep-alive never notifies again.
    expect(call.mock.calls[0]?.[3].aborted).toBe(false)
    expect(notify).toHaveBeenCalledOnce()

    const fourth = iterator.next()
    await broker.answer(context.chatId, reply.elicitation.id, { action: 'accept', content: { name: 'Ada Lovelace' } })
    expect((await fourth).value).toEqual({ status: 'running' })
    // No keep-alive once the card settled.
    const fifth = iterator.next()
    const fifthState = pending(fifth)
    await vi.advanceTimersByTimeAsync(MCP_ELICITATION_KEEPALIVE_MS + 1000)
    expect(fifthState.done).toBe(false)

    // A second request of the same call: a new card and one more notification.
    const again = broker.request({ chatId: context.chatId, toolCallId: 'call_1' }, { message: 'And your nickname?', form: FORM })
    expect((await fifth).value).toEqual({ status: 'input-required', elicitation: again.elicitation })
    expect(notify).toHaveBeenCalledTimes(2)
    const sixth = iterator.next()
    await broker.answer(context.chatId, again.elicitation.id, { action: 'decline' })
    expect((await sixth).value).toEqual({ status: 'running' })

    const last = iterator.next()
    settle({ content: [{ type: 'text', text: 'done' }] } as CallToolResult)
    const final = (await last).value
    expect(final).toEqual({
      content: [{ type: 'text', text: 'done' }],
      elicitations: [
        { id: reply.elicitation.id, message: 'Your name?', fields: ['name'], action: 'accept', reason: 'user' },
        { id: again.elicitation.id, message: 'And your nickname?', fields: ['name'], action: 'decline', reason: 'user' },
      ],
    })
    expect(JSON.stringify(final)).not.toContain('Lovelace')
    expect((await iterator.next()).done).toBe(true)
    expect(broker.inFlight).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('with the real broker: a 70 s wait does not time the call out, 61 s of server work after the answer does', async () => {
    vi.useFakeTimers()
    const memory = createMemoryLogger()
    const deps = { logger: memory.logger, events: createRecordingEventBus(), chats: { find: async () => null, summary: async () => null } } as unknown as AppDeps
    const broker = createElicitationBroker(deps)
    const handler = broker.handler('mcp:docs#1')
    const server: { answer: Promise<ElicitResult> | null } = { answer: null }
    // The MCP server asks at once, then keeps working after the answer (it never finishes).
    const call = vi.fn<McpToolBinding['call']>((_name, _input, _c, signal) => new Promise<CallToolResult>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('Request was aborted')), { once: true })
      server.answer = handler({ method: 'elicitation/create', params: { message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } } })
    }))
    const definition = mcpToolDefinition(listed(), { serverId: 'docs', pluginId: 'core-mcp', serverPolicy: 'ask', call, elicitation: { broker, runtimeKey: 'mcp:docs#1', serverName: 'Docs' } })
    const context = toolContext()
    bindAgentScope(context, { chatId: context.chatId } as AgentRunScope)
    const values: unknown[] = []
    const consumed = (async () => {
      for await (const value of definition.execute({}, context) as AsyncIterable<unknown>)
        values.push(value)
    })()
    const failed = expect(consumed).rejects.toThrow(`"search" did not finish within ${LIMITS.mcpToolActiveMs / 1000} s`)
    await vi.advanceTimersByTimeAsync(0)
    expect(broker.pendingCount(context.chatId)).toBe(1)
    const card = values[0] as { status: string, elicitation: McpElicitation }
    expect(card).toMatchObject({ status: 'input-required', elicitation: { serverId: 'docs', serverName: 'Docs', message: 'Your name?' } })

    await vi.advanceTimersByTimeAsync(70_000)
    expect(call.mock.calls[0]?.[3].aborted).toBe(false)
    // The card was sent again at 25 s and 50 s.
    expect(values).toEqual([card, card, card])

    await broker.answer(context.chatId, card.elicitation.id, { action: 'accept', content: { name: 'Ada' } })
    expect(await server.answer).toEqual({ action: 'accept', content: { name: 'Ada' } })
    await vi.advanceTimersByTimeAsync(LIMITS.mcpToolActiveMs - 1)
    expect(call.mock.calls[0]?.[3].aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1001)
    await failed
    expect(values.at(-1)).toEqual({ status: 'running' })
    expect(broker.pendingCount(context.chatId)).toBe(0)
    await broker.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('createActiveBudget', () => {
  it('aborts after the active time, pauses, resumes with the rest and follows the parent', async () => {
    vi.useFakeTimers()
    const parent = new AbortController()
    const budget = createActiveBudget(1000, parent.signal)
    await vi.advanceTimersByTimeAsync(400)
    budget.pause()
    budget.pause()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(budget.signal.aborted).toBe(false)
    budget.resume()
    budget.resume()
    await vi.advanceTimersByTimeAsync(599)
    expect(budget.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(budget.signal.aborted).toBe(true)
    expect(budget.expired()).toBe(true)
    budget.dispose()

    const second = createActiveBudget(1000, parent.signal)
    parent.abort(new Error('stop'))
    expect(second.signal.aborted).toBe(true)
    expect(second.expired()).toBe(false)
    expect((second.signal.reason as Error).message).toBe('stop')
    second.dispose()

    const third = createActiveBudget(1000, new AbortController().signal)
    third.dispose()
    expect(third.signal.aborted).toBe(true)
    expect(third.expired()).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('outputs', () => {
  it('drops protocol metadata from stored outputs', () => {
    expect(mcpToolOutput({ content: [], structuredContent: { a: 1 }, _meta: { x: 1 }, isError: false } as unknown as CallToolResult))
      .toEqual({ content: [], structuredContent: { a: 1 } })
  })

  it('converts content parts for the model and falls back to JSON', () => {
    // Resource items and links become text through `mcpContentText` (`content.ts`, W14.2's mapping).
    const link = { type: 'resource_link', uri: 'file:///a', name: 'a' }
    const resource = { type: 'resource', resource: { uri: 'fixture://notes/readme.md', mimeType: 'text/markdown', text: '# Notes' } }
    expect(mcpModelOutput({ content: [
      { type: 'text', text: 'hello' },
      { type: 'image', data: 'aGk=', mimeType: 'image/png' },
      link,
      resource,
    ] })).toEqual({ type: 'content', value: [
      { type: 'text', text: 'hello' },
      { type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'aGk=' } },
      { type: 'text', text: mcpContentText(link) },
      { type: 'text', text: mcpContentText(resource) },
    ] })
    expect(mcpModelOutput({ content: [], structuredContent: { total: 3 } })).toEqual({ type: 'json', value: { total: 3 } })
    const truncated = { truncated: true, originalBytes: 70_000, preview: '{"content"' }
    expect(mcpModelOutput(truncated)).toEqual({ type: 'json', value: truncated })
    // Phase 14: the elicitation records stay out of the model's view.
    const records = [{ id: 'eli_0000000000000000', message: 'm', fields: ['a'], action: 'decline', reason: 'user' }]
    expect(mcpModelOutput({ content: [], elicitations: records, other: 1 })).toEqual({ type: 'json', value: { content: [], other: 1 } })
    expect(mcpModelOutput({ content: [], structuredContent: { n: 1 }, elicitations: records })).toEqual({ type: 'json', value: { n: 1 } })
  })

  it('caps the error text and has a fallback', () => {
    expect(mcpErrorText({ content: [], isError: true } as unknown as CallToolResult)).toBe('The MCP tool reported an error.')
    expect(mcpErrorText({ content: [{ type: 'text', text: 'x'.repeat(3000) }], isError: true } as CallToolResult)).toHaveLength(2003)
  })
})

describe('errors', () => {
  it('maps connection failures to provider_unreachable and keeps HarnessErrors', () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' })
    expect(isConnectionFailure(refused)).toBe(true)
    expect(connectionErrorInit(refused, text => text)).toMatchObject({ code: 'provider_unreachable', action: 'retry' })
    expect(connectionErrorInit(new Error('MCP client initialization timed out after 20000ms'), text => text).code).toBe('provider_unreachable')
    const config = mcpConfigError('Missing setting')
    expect(connectionErrorInit(config, text => text)).toEqual({ code: 'validation_error', message: 'Missing setting' })
    expect(isPermanentMcpError(config)).toBe(true)
    expect(isPermanentMcpError(refused)).toBe(false)
    const failing = Object.assign(new Error('HTTP 500 oops'), { statusCode: 500 })
    expect(connectionErrorInit(failing, text => text)).toEqual({ code: 'provider_error', message: 'HTTP 500 oops', status: 500 })
    expect(isPermanentMcpError(failing)).toBe(false)
  })

  it('classifies auth failures (Phase 14): permanent auth_invalid with status 401, never the upstream text', () => {
    const unauthorized = Object.assign(new Error('HTTP 401 secret-abc'), { statusCode: 401 })
    const wrapped = new Error('MCP client initialization failed', { cause: unauthorized })
    const required = new McpAuthRequired({ kind: 'global', serverId: 'docs' })
    const sdkUnauthorized = new UnauthorizedError()
    const mismatch = new AuthorizationServerMismatchError({ message: 'other issuer' })
    const harness = new HarnessError({ code: 'auth_invalid', message: 'refused', status: 401 })
    for (const error of [unauthorized, wrapped, required, sdkUnauthorized, mismatch, harness]) {
      expect(isAuthRequired(error)).toBe(true)
      expect(isPermanentMcpError(error)).toBe(true)
    }
    expect(connectionErrorInit(unauthorized, text => text)).toEqual({ code: 'auth_invalid', message: NEEDS_AUTH_MESSAGE, status: 401 })
    expect(JSON.stringify(connectionErrorInit(wrapped, text => text))).not.toContain('secret-abc')
    expect(connectionErrorInit(required, text => text)).toEqual({ code: 'auth_invalid', message: 'The MCP server needs a sign-in.', status: 401 })
    expect(authRequiredInit(new McpAuthRequired(null, 'The stored sign-in was refused.'), text => text)).toEqual({ code: 'auth_invalid', message: 'The stored sign-in was refused.', status: 401 })
    expect(authRequiredInit(unauthorized, text => text, { header: true })).toEqual({ code: 'auth_invalid', message: HEADER_REJECTED_MESSAGE, status: 401 })
    for (const error of [new Error('fetch failed'), Object.assign(new Error('x'), { statusCode: 403 }), new HarnessError({ code: 'forbidden', message: 'no' }), null, undefined, 'text'])
      expect(isAuthRequired(error)).toBe(false)
  })
})
