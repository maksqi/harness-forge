// PreCompact (W11.2-T6): the context guard's automatic compaction runs it through the host's hooks (`trigger: 'auto'`)
// and places its record for the step right before the marker; `/compact [focus]` runs it over a snapshot taken for the
// reply (`trigger: 'manual'`, the focus as `custom_instructions`) and writes its record right before the marker. Observe
// only: `continue: false` and a failing hook leave the compaction alone; an abort re-throws.
import type { CompactionData, HarnessUIMessage, HookData } from '@harness-forge/shared'
import type { ModelMessage, StepResult, ToolSet } from 'ai'
import type { HookScope } from '../../services/hooks/types.ts'
import type { TestApp } from '../../testing/create-test-app.ts'
import type { FakeHookService } from '../../testing/fake-hooks.ts'
import type { HarnessDataChunk, RunSession } from '../pipeline.ts'
import type { StepInput } from '../steps.ts'
import { chatDetailSchema, createMessageId } from '@harness-forge/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMemoryLogger } from '../../logger.ts'
import { createTestApp } from '../../testing/create-test-app.ts'
import { createFakeHookSnapshot, fakeHookRecord, fakeHookResult } from '../../testing/fake-hooks.ts'
import { createRunHooks } from '../hooks.ts'
import { chatBody, postChat, readSse, runnerOf, testChatId } from '../testing.ts'
import { createContextGuard } from './guard.ts'
import { compactHooks } from './stream.ts'
import { fakeSession, mockCompactReply, resolvedModel, seedChat, summaryModel, user } from './testing.ts'

const WINDOW = 1000
const FOCUS = 'keep the API notes'

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

describe('preCompact of an automatic compaction (W11.2-T6)', () => {
  function guarded(result: Parameters<typeof createFakeHookSnapshot>[0]) {
    const logs = createMemoryLogger()
    const fake = fakeSession({ history: [user('msg_u000000000000001', 'q')], logger: logs.logger })
    const snapshot = createFakeHookSnapshot(result)
    fake.session.hooks = createRunHooks({ snapshot, host: fake.session, continued: null, messageId: fake.session.assistantId, logger: logs.logger })
    // The hooks piece of the previous step recorded its number.
    fake.session.stepNumber = 1
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('THE SUMMARY'), WINDOW), keptUser: async () => null })
    return { fake, snapshot, guard, logs }
  }

  it('runs before the compaction with trigger auto; its record lies right before the marker of the step', async () => {
    const record = fakeHookRecord('PreCompact', 'context', { context: 'saved the notes' })
    const { fake, snapshot, guard } = guarded({ results: { PreCompact: fakeHookResult({ record }) } })
    const result = await guard(step(2))
    expect(result?.messages).toHaveLength(1)
    expect(snapshot.calls.map(call => call.input)).toEqual([{ messageId: fake.session.assistantId, trigger: 'auto', customInstructions: null }])
    const chunks = fake.session.takeInjections(2) as HarnessDataChunk[]
    expect(chunks.map(chunk => chunk.type)).toEqual(['data-hook', 'data-compaction'])
    expect(chunks[0]).toEqual({ type: 'data-hook', data: record })
    // The hooks' activity comes before the compacting activity.
    expect(fake.transient.map(chunk => (chunk.data as { kind: string }).kind)).toEqual(['hooks', 'idle', 'compacting', 'idle'])
  })

  it('observe only: continue: false and a failing hook leave the compaction alone; an abort re-throws', async () => {
    const stopping = guarded({ results: { PreCompact: fakeHookResult({ continue: false, stopReason: 'no' }) } })
    expect((await stopping.guard(step(2)))?.messages).toHaveLength(1)
    expect((stopping.fake.session.takeInjections(2) as HarnessDataChunk[]).map(chunk => chunk.type)).toEqual(['data-compaction'])
    expect(stopping.logs.records.some(entry => entry.level === 'info' && entry.msg.includes('PreCompact only observes'))).toBe(true)

    const failing = guarded({ results: { PreCompact: () => {
      throw new Error('hook runner broke')
    } } })
    expect((await failing.guard(step(2)))?.messages).toHaveLength(1)
    expect(failing.logs.records.some(entry => entry.level === 'warn' && entry.msg.includes('PreCompact hooks failed'))).toBe(true)

    const aborted = guarded({ results: { PreCompact: (_input, options) => {
      aborted.fake.controller.abort(new DOMException('stopped', 'AbortError'))
      options.signal.throwIfAborted()
      return fakeHookResult()
    } } })
    await expect(aborted.guard(step(2))).rejects.toBeDefined()
    expect((aborted.fake.session.takeInjections(2) as HarnessDataChunk[]).some(chunk => chunk.type === 'data-compaction')).toBe(false)
  })

  it('a guard below the threshold runs no PreCompact', async () => {
    const { snapshot, guard } = guarded({ results: { PreCompact: fakeHookResult() } })
    expect(await guard({ stepNumber: 0, messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }, { role: 'user', content: 'x' }], instructions: '', steps: [] })).toBeUndefined()
    expect(snapshot.calls).toEqual([])
  })
})

describe('preCompact of /compact (W11.2-T6)', () => {
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

  it('runs with trigger manual and the focus; its record is written right before the marker', async () => {
    const record = fakeHookRecord('PreCompact', 'context', { context: 'notes saved' })
    hooks.results.set('PreCompact', fakeHookResult({ record }))
    const chatId = testChatId(0xD501)
    const reply = await compact(chatId, `/compact ${FOCUS}`)
    const types = reply.parts.map(part => part.type)
    const marker = types.indexOf('data-compaction')
    expect(marker).toBeGreaterThan(0)
    expect(reply.parts[marker - 1]).toEqual({ type: 'data-hook', data: record })
    expect((reply.parts[marker] as { data: CompactionData }).data.focus).toBe(FOCUS)
    expect(hooks.runCalls.map(call => call.input)).toEqual([{ messageId: reply.id, trigger: 'manual', customInstructions: FOCUS }])
    expect(hooks.snapshots.map(snapshot => snapshot.scope)).toEqual([{ chatId, projectId: null, workspace: null, toolMode: 'ask', origin: 'request', modelRef: 'mock:compact' }])
  })

  it('without a focus custom_instructions is null; continue: false still compacts; no hooks → nothing runs', async () => {
    hooks.results.set('PreCompact', fakeHookResult({ continue: false, stopReason: 'no' }))
    const first = await compact(testChatId(0xD502), '/compact')
    expect(first.parts.some(part => part.type === 'data-compaction')).toBe(true)
    expect(first.parts.some(part => part.type === 'data-hook')).toBe(false)
    expect(hooks.runCalls.map(call => call.input.customInstructions)).toEqual([null])

    hooks.results.clear()
    hooks.runCalls.length = 0
    const second = await compact(testChatId(0xD503), '/compact')
    expect(second.parts.some(part => part.type === 'data-compaction')).toBe(true)
    expect(hooks.runCalls).toEqual([])
  })
})

describe('compactHooks (unit)', () => {
  it('opens the chat\'s project folder for the scope and writes records through the given writer', async () => {
    const workspace = { projectId: 'prj_0123456789abcdef', name: 'P', root: '/srv/p', instructions: null, projectFile: null }
    const record: HookData = fakeHookRecord('PreCompact', 'context', { context: 'x' })
    const snapshot = createFakeHookSnapshot({ results: { PreCompact: fakeHookResult({ record }) } })
    const scopes: HookScope[] = []
    const written: HarnessDataChunk[] = []
    const transient: HarnessDataChunk[] = []
    const controller = new AbortController()
    const session = {
      chatId: 'chat',
      assistantId: 'msg_a000000000000009',
      writeTransient: (chunk: HarnessDataChunk) => void transient.push(chunk),
      ctx: {
        deps: {
          hooks: { snapshot: async (scope: HookScope) => {
            scopes.push(scope)
            return snapshot
          } },
          projects: { openWorkspace: async () => ({ ok: true, workspace }) },
        },
        prepared: { workspace: null, chat: { projectId: workspace.projectId }, resolved: { modelRef: 'mock:compact' } },
        run: { signal: controller.signal },
        logger: createMemoryLogger().logger,
        toolMode: 'edits',
        origin: 'queue',
      },
    } as unknown as RunSession
    const hooks = await compactHooks(session, chunk => void written.push(chunk))
    expect(scopes).toEqual([{ chatId: 'chat', projectId: workspace.projectId, workspace, toolMode: 'edits', origin: 'queue', modelRef: 'mock:compact' }])
    await hooks.preCompact({ trigger: 'manual', customInstructions: null }, controller.signal)
    expect(written).toEqual([{ type: 'data-hook', data: record }])
    expect(transient.map(chunk => (chunk.data as { kind: string }).kind)).toEqual(['hooks', 'idle'])
  })
})
