// W12.6-T5 (ADR-057): `UserPromptSubmit` prompt hooks at submit (`POST /api/chat`) and at enqueue
// (`POST /api/chat/:id/queue`) with the C36 fake hook service scripted with what a prompt hook decides
// (`promptHookResult`: the shared `readPromptHookAnswer` → `promptHookOutcome` → `combineHookOutcomes`): `ok: false` is
// the 409 `hook-blocked` with the prompt hook's record and stores (or queues) nothing; `ok: true` decides nothing (no
// record, the turn runs); an unreadable answer is a non-blocking error kept on the user message. Prompts and reasons
// never reach the log above `debug`.
import type { LanguageModelV4, LanguageModelV4CallOptions, LanguageModelV4StreamPart } from '@ai-sdk/provider'
import type { Disposable } from '@harness-forge/plugin-sdk'
import type { HarnessUIMessage, HookData, QueueAddBody, ServerEvent } from '@harness-forge/shared'
import type { TestApp } from '../testing/create-test-app.ts'
import type { FakeHookService } from '../testing/fake-hooks.ts'
import { chatDetailSchema, createMessageId } from '@harness-forge/shared'
import { convertArrayToReadableStream, MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../testing/create-test-app.ts'
import { FAKE_PROMPT_HOOK_MODEL } from '../testing/fake-hooks.ts'
import { promptHookResult } from './hooks-prompt-testing.ts'
import { chatBody, messageText, postChat, readSse, runnerOf, streamedText, testChatId } from './testing.ts'

const PROMPT_SECRET = 'prompt-hook-sentinel-6b1e'
const REASON_SECRET = 'prompt-hook-reason-a93f'

let nextChat = 0xD700

function newChatId(): string {
  nextChat += 1
  return testChatId(nextChat)
}

function recordsOf(message: HarnessUIMessage | undefined): HookData[] {
  return (message?.parts ?? []).flatMap(part => (part.type === 'data-hook' ? [(part as { data: HookData }).data] : []))
}

function finishPart(): LanguageModelV4StreamPart {
  return {
    type: 'finish',
    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
    finishReason: { unified: 'stop', raw: 'stop' },
  }
}

/** A model whose first call waits until `release()` (`waiting` resolves when it waits). */
function heldModel() {
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
      if (calls.length === 1) {
        entered()
        await gate
      }
      return { stream: convertArrayToReadableStream<LanguageModelV4StreamPart>([{ type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: `turn ${calls.length}` }, { type: 'text-end', id: 't' }, finishPart()]) }
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

describe('userPromptSubmit prompt hooks (W12.6-T5)', () => {
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
      id: 'promptkit',
      name: 'Prompt kit',
      credentials: [],
      seedModels: [{ id: 'agent', name: 'Agent', contextWindow: 64_000, capabilities: { tools: true } }],
      createLanguageModel: (modelId) => {
        const model = scripted.get(modelId)
        if (model === undefined)
          throw new Error(`No scripted model "${modelId}".`)
        return model
      },
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

  function loudLogs(): string {
    return t.logs.records.filter(entry => entry.level !== 'debug').map(entry => JSON.stringify(entry)).join('\n')
  }

  it('at submit: ok false is the 409 hook-blocked with the prompt hook\'s record; nothing is stored', async () => {
    hooks.results.set('UserPromptSubmit', promptHookResult('UserPromptSubmit', JSON.stringify({ ok: false, reason: REASON_SECRET })))
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, `deploy with ${PROMPT_SECRET}`, { modelRef: 'mock:hooks' }))
    expect(response.status).toBe(409)
    const envelope = await response.json() as { error: { code: string, message: string, details: { reason: string, chatId: string, hook: HookData } } }
    expect(envelope.error).toMatchObject({ code: 'conflict', message: `A hook blocked this message: ${REASON_SECRET}`, details: { reason: 'hook-blocked', chatId } })
    expect(envelope.error.details.hook).toMatchObject({ event: 'UserPromptSubmit', outcome: 'blocked', reason: REASON_SECRET, hooks: [{ kind: 'prompt', model: FAKE_PROMPT_HOOK_MODEL }] })
    expect((await t.request(`/api/chats/${chatId}`)).status).toBe(404)
    expect(events.some(event => event.type === 'run.started')).toBe(false)
    expect(hooks.runCalls.map(call => [call.event, call.input.prompt])).toEqual([['UserPromptSubmit', `deploy with ${PROMPT_SECRET}`]])
    expect(loudLogs()).not.toContain(PROMPT_SECRET)
    expect(loudLogs()).not.toContain(REASON_SECRET)
  })

  it('at submit: ok true decides nothing (no record); an unreadable answer is a non-blocking error on the user message', async () => {
    hooks.results.set('UserPromptSubmit', promptHookResult('UserPromptSubmit', '{"ok":true}'))
    const chatId = newChatId()
    const { chunks } = await readSse(await postChat(t, chatBody(chatId, 'hello', { modelRef: 'mock:hooks' })))
    await runnerOf(t).idle()
    expect(streamedText(chunks)).toBe('Hooks mock: hello')
    let messages = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages
    expect(recordsOf(messages[0])).toEqual([])

    hooks.results.set('UserPromptSubmit', promptHookResult('UserPromptSubmit', 'I cannot decide.'))
    const second = await readSse(await postChat(t, chatBody(chatId, 'again', { modelRef: 'mock:hooks' })))
    await runnerOf(t).idle()
    expect(streamedText(second.chunks)).toBe('Hooks mock: again')
    messages = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages
    expect(messages.map(message => messageText(message))).toEqual(['hello', 'Hooks mock: hello', 'again', 'Hooks mock: again'])
    expect(recordsOf(messages[2])).toMatchObject([{ event: 'UserPromptSubmit', outcome: 'error', hooks: [{ kind: 'prompt' }] }])
  })

  it('at enqueue: ok false is the 409 hook-blocked and queues nothing; the run goes on', async () => {
    const held = heldModel()
    scripted.set('agent', held.model)
    const chatId = newChatId()
    const response = await postChat(t, chatBody(chatId, 'go', { modelRef: 'promptkit:agent', toolMode: 'auto' }))
    await held.waiting
    hooks.results.set('UserPromptSubmit', promptHookResult('UserPromptSubmit', JSON.stringify({ ok: false, reason: REASON_SECRET })))
    hooks.runCalls.length = 0
    const body: QueueAddBody = { message: { id: createMessageId(), role: 'user', parts: [{ type: 'text', text: `queued ${PROMPT_SECRET}` }] }, modelRef: 'promptkit:agent', reasoningEffort: 'auto', toolMode: 'auto' }
    const blocked = await t.request(`/api/chat/${chatId}/queue`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect(blocked.status).toBe(409)
    const envelope = await blocked.json() as { error: { details: { reason: string, hook: HookData } } }
    expect(envelope.error.details).toMatchObject({ reason: 'hook-blocked', hook: { event: 'UserPromptSubmit', outcome: 'blocked', reason: REASON_SECRET, hooks: [{ kind: 'prompt' }] } })
    expect(hooks.runCalls.map(call => [call.event, call.input.prompt])).toEqual([['UserPromptSubmit', `queued ${PROMPT_SECRET}`]])
    expect(hooks.snapshots.at(-1)!.scope).toMatchObject({ chatId, origin: 'queue' })
    expect(runnerOf(t).queueList(chatId)).toEqual([])
    expect(events.some(event => event.type === 'queue.changed')).toBe(false)
    held.release()
    await readSse(response)
    await vi.waitFor(() => {
      expect(events.filter(event => event.type === 'run.finished' && event.data.chatId === chatId)).toHaveLength(1)
    }, { timeout: 5000, interval: 5 })
    await runnerOf(t).idle()
    const messages = chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages
    expect(messages.map(message => messageText(message))).toEqual(['go', 'turn 1'])
    expect(held.calls).toHaveLength(1)
    expect(loudLogs()).not.toContain(PROMPT_SECRET)
  })
})
