// `UserPromptSubmit` at enqueue (W11.2-T2) through `POST /api/chat/:id/queue` with the C36 fake hook service and a
// scripted test-kit model held at its first step: a block is the 409 `hook-blocked` and queues nothing; a context is kept
// with the item and delivered exactly once, as a `data-hook` part on the user message of the turn the item starts, or
// right after its `data-steer` part when the item is steered into the run (the model reads it after the item, also when
// the history is rebuilt from the saved reply). Plus `runQueuedPromptHooks` (unit).
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { ChatDetail, HarnessUIMessage, HookData, QueueAddBody, ServerEvent } from '@harness-forge/shared'
import type { HookScope } from '../services/hooks/types.ts'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import type { QueuedPromptHooksInput } from './hooks-prompt.ts'
import { chatDetailSchema, createMessageId, hookModelText } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createSilentLogger } from '../logger.ts'
import { createTestApp } from '../testing/create-test-app.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult } from '../testing/fake-hooks.ts'
import { runQueuedPromptHooks } from './hooks-prompt.ts'
import { chatBody, postChat, readSse, runnerOf, testChatId } from './testing.ts'

const QUEUED_SECRET = 'queued-sentinel-8e21'

let nextChat = 0xD200

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function finishPart(reason: 'stop' | 'tool-calls' = 'stop'): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: reason, raw: reason },
  }
}

function textParts(text: string): LanguageModelV4StreamPart[] {
  return [{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: text }, { type: 'text-end', id: 't' }, finishPart()]
}

function callParts(toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId: 'call_1', toolName, input: JSON.stringify(input) }, finishPart('tool-calls')]
}

/** The user texts of a call's prompt, in order. */
function userTexts(call: LanguageModelV4CallOptions | undefined): string[] {
  return (call?.prompt ?? []).flatMap(message => (message.role === 'user' ? message.content.flatMap(part => (part.type === 'text' ? [part.text] : [])) : []))
}

/** A scripted model whose first call waits until `release()` (`entered` resolves when it is waiting). */
function heldModel(script: (call: number) => LanguageModelV4StreamPart[]) {
  const calls: LanguageModelV4CallOptions[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const waiting = new Promise<void>((resolve) => {
    entered = resolve
  })
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      calls.push(options)
      const call = calls.length
      if (call === 1) {
        entered()
        await gate
      }
      return { stream: convertArrayToReadableStream(script(call)) }
    },
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'Title' }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
  })
  return { model, calls, release, waiting }
}

function recordsOf(message: HarnessUIMessage | undefined): HookData[] {
  return (message?.parts ?? []).flatMap(part => (part.type === 'data-hook' ? [(part as { data: HookData }).data] : []))
}

describe('userPromptSubmit at enqueue (W11.2-T2)', () => {
  let t: TestApp
  let hooks: FakeHookService
  let events: ServerEvent[] = []
  const disposables: Disposable[] = []
  const scripted = new Map<string, LanguageModelV4>()

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
    t.deps.events.subscribe(event => void events.push(event))
    disposables.push(t.deps.registry.providers.register('mock', {
      id: 'queuekit',
      name: 'Queue kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 64_000, capabilities: { tools: true } }],
      createLanguageModel: (modelId) => {
        const model = scripted.get(modelId)
        if (model === undefined)
          throw new Error(`No scripted model "${modelId}".`)
        return model
      },
    }))
    disposables.push(t.deps.registry.tools.register('mock', {
      name: 'queue_probe',
      description: 'Answers at once.',
      inputSchema: z.object({ text: z.string() }),
      policy: 'safe',
      execute: async () => ({ ok: true }),
    }))
  })

  beforeEach(() => {
    events = []
    scripted.clear()
    hooks.results.clear()
    hooks.targets.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
    hooks.snapshots.length = 0
  })

  afterAll(async () => {
    for (const disposable of disposables)
      disposable.dispose()
    await t.close()
  })

  async function detail(chatId: string): Promise<ChatDetail> {
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json())
  }

  function queueBody(text: string): QueueAddBody {
    const id = createMessageId()
    return { message: { id, role: 'user', parts: [{ type: 'text', text }] }, modelRef: 'queuekit:agent', reasoningEffort: 'auto', toolMode: 'auto' }
  }

  function enqueue(chatId: string, body: QueueAddBody): Promise<Response> {
    return t.request(`/api/chat/${chatId}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  }

  /** Waits until `count` runs of the chat finished. */
  async function finished(chatId: string, count: number): Promise<void> {
    await vi.waitFor(() => {
      expect(events.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(count)
    }, { timeout: 5000, interval: 5 })
    await runnerOf(t).idle()
  }

  it('a block answers 409 hook-blocked and queues nothing; an idle chat runs no hook', async () => {
    const held = heldModel(() => textParts('one'))
    scripted.set('agent', held.model)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'queuekit:agent', toolMode: 'auto' }))
    await held.waiting
    const record = fakeHookRecord('UserPromptSubmit', 'blocked', { reason: 'not in the queue' })
    hooks.results.set('UserPromptSubmit', fakeHookResult({ block: true, reason: 'not in the queue', record }))
    hooks.runCalls.length = 0
    const blocked = await enqueue(chatId, queueBody(`queued ${QUEUED_SECRET}`))
    expect(blocked.status).toBe(409)
    expect(((await blocked.json()) as { error: unknown }).error).toEqual({ code: 'conflict', message: 'A hook blocked this message: not in the queue', details: { reason: 'hook-blocked', chatId, hook: record } })
    expect(hooks.runCalls.map(call => [call.event, call.input.prompt])).toEqual([['UserPromptSubmit', `queued ${QUEUED_SECRET}`]])
    expect(hooks.snapshots.at(-1)!.scope).toEqual({ chatId, projectId: null, workspace: null, toolMode: 'auto', origin: 'queue', modelRef: 'queuekit:agent' })
    expect(runnerOf(t).queueList(chatId)).toEqual([])
    expect(events.some(event => event.type === 'queue.changed')).toBe(false)
    held.release()
    await readSse(response)
    await finished(chatId, 1)
    expect((await detail(chatId)).messages).toHaveLength(2)
    // An idle chat refuses the item before any hook runs.
    hooks.runCalls.length = 0
    const idle = await enqueue(chatId, queueBody('too late'))
    expect(idle.status).toBe(409)
    expect(((await idle.json()) as { error: { details: unknown } }).error.details).toEqual({ reason: 'run-idle', chatId })
    expect(hooks.runCalls).toEqual([])
    const loud = t.logs.records.filter(entry => entry.level !== 'debug').map(entry => JSON.stringify(entry)).join('\n')
    expect(loud).not.toContain(QUEUED_SECRET)
  })

  it('a context goes onto the user message of the turn the item starts (once)', async () => {
    const held = heldModel(() => textParts('done'))
    scripted.set('agent', held.model)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'queuekit:agent', toolMode: 'auto' }))
    await held.waiting
    const record = fakeHookRecord('UserPromptSubmit', 'context', { context: 'Ticket: HF-7' })
    hooks.results.set('UserPromptSubmit', fakeHookResult({ context: 'Ticket: HF-7', record }))
    const body = queueBody('next one')
    const queued = await enqueue(chatId, body)
    expect(queued.status).toBe(201)
    expect(await queued.json()).toMatchObject({ id: body.message.id, turnOnly: false })
    expect(runnerOf(t).queueList(chatId).map(item => item.id)).toEqual([body.message.id])
    hooks.results.clear()
    held.release()
    await readSse(response)
    await finished(chatId, 2)
    const messages = (await detail(chatId)).messages
    expect(messages.map(message => message.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(messages[2]!.id).toBe(body.message.id)
    expect(messages[2]!.parts).toEqual([{ type: 'text', text: 'next one' }, { type: 'data-hook', data: record }])
    expect(messages.flatMap(message => recordsOf(message))).toEqual([record])
    // The queued turn's model call reads the context after the item's text; nothing ran again.
    expect(userTexts(held.calls[1])).toEqual(['go', 'next one', hookModelText(record, 'user')])
    expect(hooks.runCalls.filter(call => call.event === 'UserPromptSubmit')).toHaveLength(1)
    expect(events.find(event => event.type === 'run.started' && event.data.origin === 'queue')?.data).toMatchObject({ userMessageId: body.message.id })
  })

  it('a steered item gets its record right after its steer part; the model reads it after the item (live and rebuilt)', async () => {
    const held = heldModel(call => (call === 1 ? callParts('queue_probe', { text: 'a' }) : textParts(`answer ${call}`)))
    scripted.set('agent', held.model)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'queuekit:agent', toolMode: 'auto' }))
    await held.waiting
    const record = fakeHookRecord('UserPromptSubmit', 'context', { context: 'Steer note' })
    hooks.results.set('UserPromptSubmit', fakeHookResult({ context: 'Steer note', record }))
    const body = queueBody('also check the tests')
    expect((await enqueue(chatId, body)).status).toBe(201)
    hooks.results.clear()
    held.release()
    await readSse(response)
    await finished(chatId, 1)
    const reply = (await detail(chatId)).messages[1]!
    const types = reply.parts.map(part => part.type)
    const steerAt = types.indexOf('data-steer')
    expect(steerAt).toBeGreaterThan(types.indexOf('tool-queue_probe'))
    expect(reply.parts[steerAt + 1]).toEqual({ type: 'data-hook', data: record })
    expect(recordsOf(reply)).toEqual([record])
    const context = hookModelText(record, 'assistant')
    expect(userTexts(held.calls[1])).toEqual(['go', 'also check the tests', context])
    // The next turn rebuilds the same order from the saved reply (`splitSteers` + `splitHooks`).
    await readSse(await postChat(t, chatBody(chatId, 'next', { modelRef: 'queuekit:agent', toolMode: 'auto' })))
    await finished(chatId, 2)
    expect(userTexts(held.calls[2])).toEqual(['go', 'also check the tests', context, 'next'])
    expect(runnerOf(t).queueList(chatId)).toEqual([])
  })
})

describe('runQueuedPromptHooks (unit)', () => {
  const chat = { id: testChatId(0xD2FF), projectId: null }
  const workspace = { projectId: 'prj_0123456789abcdef', name: 'P', root: '/srv/p', instructions: null, projectFile: null }

  function input(overrides: Partial<QueuedPromptHooksInput> = {}, kind: 'chat' | 'image' = 'chat') {
    const snapshot = createFakeHookSnapshot({ results: { UserPromptSubmit: fakeHookResult({ record: fakeHookRecord('UserPromptSubmit', 'context', { context: 'c' }) }) } })
    const scopes: HookScope[] = []
    const opened: string[] = []
    const deps = {
      hooks: { snapshot: async (scope: HookScope) => {
        scopes.push(scope)
        return snapshot
      } },
      projects: { openWorkspace: async (id: string) => {
        opened.push(id)
        return { ok: true as const, workspace }
      } },
      catalog: { get: async () => ({ kind }) },
    } as unknown as QueuedPromptHooksInput['deps']
    const value: QueuedPromptHooksInput = {
      deps,
      chat,
      body: { message: { id: 'msg_q000000000000001', role: 'user', parts: [{ type: 'text', text: '/review now' }] }, modelRef: 'mock:hooks', reasoningEffort: 'auto', toolMode: 'plan' },
      parts: [{ type: 'text', text: '/review now' }],
      turnOnly: true,
      signal: new AbortController().signal,
      logger: createSilentLogger(),
      ...overrides,
    }
    return { value, snapshot, scopes, opened }
  }

  it('runs with the queue scope, the project folder and the command name of a server command', async () => {
    const { value, snapshot, scopes, opened } = input({ chat: { id: chat.id, projectId: workspace.projectId } })
    const records = await runQueuedPromptHooks(value)
    expect(records.map(record => record.context)).toEqual(['c'])
    expect(opened).toEqual([workspace.projectId])
    expect(scopes).toEqual([{ chatId: chat.id, projectId: workspace.projectId, workspace, toolMode: 'plan', origin: 'queue', modelRef: 'mock:hooks' }])
    expect(snapshot.calls.map(call => call.input)).toEqual([{ messageId: 'msg_q000000000000001', prompt: '/review now', command: 'review' }])
    // A plain text item (not a server command) carries no command name.
    const plain = input({ turnOnly: false })
    await runQueuedPromptHooks(plain.value)
    expect(plain.snapshot.calls[0]!.input).toEqual({ messageId: 'msg_q000000000000001', prompt: '/review now' })
  })

  it('/compact and image models run nothing; an abort rejects', async () => {
    const compact = input({ parts: [{ type: 'text', text: '/compact focus' }] })
    expect(await runQueuedPromptHooks(compact.value)).toEqual([])
    expect(compact.scopes).toEqual([])
    const image = input({}, 'image')
    expect(await runQueuedPromptHooks(image.value)).toEqual([])
    expect(image.scopes).toEqual([])
    const controller = new AbortController()
    controller.abort()
    await expect(runQueuedPromptHooks(input({ signal: controller.signal }).value)).rejects.toBeDefined()
  })
})
