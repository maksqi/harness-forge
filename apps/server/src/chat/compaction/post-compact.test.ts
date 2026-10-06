// PostCompact (Phase 12, C44-T5 call sites; ADR-057): the context guard's automatic compaction runs it through the
// host's hooks right after its marker (`trigger: 'auto'`, the record behind the marker); `/compact [focus]` runs it over
// the reply's snapshot right after the marker (`trigger: 'manual'`, the record right after the marker). Observe only: a
// `continue: false` or a failing hook changes nothing; an abort re-throws; a failed compaction runs none.
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ModelMessage, StepResult, ToolSet } from 'ai'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeHookService } from '../../testing/fake-hooks.ts'
import type { HarnessDataChunk } from '../pipeline.ts'
import type { StepInput } from '../steps.ts'
import { chatDetailSchema, createMessageId } from '@harness-forge/shared'
import { MockLanguageModelV4 } from 'ai/test'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult } from '../../testing/fake-hooks.ts'
import { createRunHooks } from '../hooks.ts'
import { chatBody, postChat, readSse, runnerOf, testChatId } from '../testing.ts'
import { createContextGuard } from './guard.ts'
import { fakeSession, mockCompactReply, resolvedModel, seedChat, summaryModel, user } from './testing.ts'

const WINDOW = 1000

function conversation(turns: number): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `question ${turn} ${'q'.repeat(400)}` }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${turn} ${'a'.repeat(400)}` }] })
  }
  messages.push({ role: 'user', content: [{ type: 'text', text: 'the latest request' }] })
  return messages
}

function step(stepNumber: number): StepInput {
  return { stepNumber, messages: conversation(5), instructions: 'Be brief.', steps: [] as StepResult<ToolSet>[] }
}

describe('postCompact of an automatic compaction', () => {
  function guarded(result: Parameters<typeof createFakeHookSnapshot>[0], summarizer = summaryModel('THE SUMMARY')) {
    const logs = createMemoryLogger()
    const fake = fakeSession({ history: [user('msg_u000000000000001', 'q')], logger: logs.logger })
    const snapshot = createFakeHookSnapshot(result)
    fake.session.hooks = createRunHooks({ snapshot, host: fake.session, continued: null, messageId: fake.session.assistantId, logger: logs.logger })
    fake.session.stepNumber = 1
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summarizer, WINDOW), keptUser: async () => null })
    return { fake, snapshot, guard, logs }
  }

  it('runs after the marker with trigger auto; its record lies right behind the marker of the step', async () => {
    const record = fakeHookRecord('PostCompact', 'error')
    const { fake, snapshot, guard } = guarded({ results: { PostCompact: fakeHookResult({ record }) } })
    expect((await guard(step(2)))?.messages).toHaveLength(1)
    expect(snapshot.calls.map(call => [call.event, call.input])).toEqual([['PostCompact', { messageId: fake.session.assistantId, trigger: 'auto' }]])
    const chunks = fake.session.takeInjections(2) as HarnessDataChunk[]
    expect(chunks.map(chunk => chunk.type)).toEqual(['data-compaction', 'data-hook'])
    expect(chunks[1]).toEqual({ type: 'data-hook', data: record })
    // The compacting activity ends before the hooks' activity.
    expect(fake.transient.map(chunk => (chunk.data as { kind: string }).kind)).toEqual(['compacting', 'idle', 'hooks', 'idle'])
  })

  it('observe only: continue: false and a failing hook keep the compaction; an abort re-throws', async () => {
    const stopping = guarded({ results: { PostCompact: fakeHookResult({ continue: false, stopReason: 'no' }) } })
    expect((await stopping.guard(step(2)))?.messages).toHaveLength(1)
    expect(stopping.fake.session.hooks.stopRequested).toBe(false)
    expect(stopping.logs.records.some(entry => entry.level === 'info' && entry.msg.includes('PostCompact only observes'))).toBe(true)

    const failing = guarded({ results: { PostCompact: () => {
      throw new Error('hook runner broke')
    } } })
    expect((await failing.guard(step(2)))?.messages).toHaveLength(1)
    expect(failing.logs.records.some(entry => entry.level === 'warn' && entry.msg.includes('PostCompact hooks failed'))).toBe(true)

    const aborted = guarded({ results: { PostCompact: (_input, options) => {
      aborted.fake.controller.abort(new DOMException('stopped', 'AbortError'))
      options.signal.throwIfAborted()
      return fakeHookResult()
    } } })
    await expect(aborted.guard(step(2))).rejects.toBeDefined()
  })

  it('a failed compaction (the trim fallback) runs no PostCompact', async () => {
    const broken = new MockLanguageModelV4({ doGenerate: async () => {
      throw new Error('summarizer down')
    } })
    const { snapshot, guard, fake } = guarded({ results: { PostCompact: fakeHookResult() } }, broken)
    await guard(step(0))
    expect(snapshot.calls).toEqual([])
    expect((fake.session.takeInjections(0) as HarnessDataChunk[]).map(chunk => chunk.type)).not.toContain('data-compaction')
  })
})

describe('postCompact of /compact', () => {
  let t: TestApp
  let hooks: FakeHookService

  beforeAll(async () => {
    t = await createTestApp({ env: { HF_MOCK_PROVIDER: '1' }, hooks: 'fake' })
    hooks = t.deps.hooks as FakeHookService
  })

  beforeEach(() => {
    hooks.results.clear()
    hooks.present.clear()
    hooks.runCalls.length = 0
    hooks.snapshots.length = 0
  })

  afterAll(async () => {
    await t.close()
  })

  async function compact(chatId: string, text: string): Promise<HarnessUIMessage> {
    await seedChat(t.deps, chatId, [user(createMessageId(), 'first'), mockCompactReply(createMessageId(), 'first')])
    await readSse(await postChat(t, chatBody(chatId, text, { modelRef: 'mock:compact' })))
    await runnerOf(t).idle()
    return chatDetailSchema.parse(await (await t.request(`/api/chats/${chatId}`)).json()).messages.at(-1)!
  }

  it('runs with trigger manual after PreCompact; its record is written right after the marker', async () => {
    const record = fakeHookRecord('PostCompact', 'error')
    hooks.results.set('PostCompact', fakeHookResult({ record }))
    hooks.present.add('PreCompact')
    const reply = await compact(testChatId(0xD601), '/compact')
    const types = reply.parts.map(part => part.type)
    const marker = types.indexOf('data-compaction')
    expect(marker).toBeGreaterThanOrEqual(0)
    expect(reply.parts[marker + 1]).toEqual({ type: 'data-hook', data: record })
    expect(reply.metadata?.aborted).toBeUndefined()
    expect(hooks.runCalls.map(call => [call.event, call.input])).toEqual([
      ['PreCompact', { messageId: reply.id, trigger: 'manual', customInstructions: null }],
      ['PostCompact', { messageId: reply.id, trigger: 'manual' }],
    ])
    // One snapshot serves both events.
    expect(hooks.snapshots).toHaveLength(1)
  })

  it('a failing PostCompact hook keeps the compaction', async () => {
    hooks.results.set('PostCompact', () => {
      throw new Error('broken')
    })
    const reply = await compact(testChatId(0xD602), '/compact')
    expect(reply.parts.some(part => part.type === 'data-compaction')).toBe(true)
    expect(reply.parts.some(part => part.type === 'data-hook')).toBe(false)
  })
})
