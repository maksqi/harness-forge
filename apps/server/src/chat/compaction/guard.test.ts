// The context guard (W9.1-T3): below the threshold nothing; above it one marker and the new messages; the per-run cap;
// an unknown window; autoCompact off → trim + context-trimmed; a summarizer error → trim + compaction-failed; an abort
// re-throws; silent mode injects nothing.
import type { LanguageModelV4CallOptions } from '@ai-sdk/provider'
import type { CompactionData, HarnessUIMessage } from '@harness-forge/shared'
import type { ModelMessage, StepResult, ToolSet } from 'ai'
import type { StepInput } from '../steps.ts'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { CONTEXT_BUDGET_RATIO, estimateTokens } from '../context.ts'
import { NOTICES } from '../notices.ts'
import { COMPACT_TRIGGER_RATIO, createContextGuard, lastStepTokens, mergeSummaryMessage, runTodos, stepEstimate } from './guard.ts'
import { COMPACTION_CONTINUE_TEXT, COMPACTION_TODOS_HEADING } from './history.ts'
import { failingModel, fakeSession, hangingModel, resolvedModel, summaryModel, user } from './testing.ts'

const WINDOW = 1000
const turnUser: ModelMessage = { role: 'user', content: [{ type: 'text', text: 'the latest request' }] }

/** A conversation of `turns` turns of about `chars` characters each, ending with the turn user message. */
function conversation(turns: number, chars = 400): ModelMessage[] {
  const messages: ModelMessage[] = []
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `question ${turn} OLD-${turn} ${'q'.repeat(chars)}` }] })
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `answer ${turn} ${'a'.repeat(chars)}` }] })
  }
  messages.push(turnUser)
  return messages
}

function step(messages: ModelMessage[], stepNumber = 0, steps: Partial<StepResult<ToolSet>>[] = []): StepInput {
  return { stepNumber, messages, instructions: 'Be brief.', steps: steps as StepResult<ToolSet>[] }
}

function usageStep(input: number, output: number, toolResults: unknown[] = []): Partial<StepResult<ToolSet>> {
  return {
    usage: { inputTokens: input, outputTokens: output, totalTokens: input + output, inputTokenDetails: { noCacheTokens: input, cacheReadTokens: 0, cacheWriteTokens: 0 }, outputTokenDetails: { textTokens: output, reasoningTokens: 0 } },
    toolResults: toolResults as StepResult<ToolSet>['toolResults'],
  }
}

function injected(session: ReturnType<typeof fakeSession>['session']): unknown[] {
  return session.takeInjections(Number.POSITIVE_INFINITY)
}

describe('context guard helpers', () => {
  it('estimates the larger of the messages and the last step usage', () => {
    expect(lastStepTokens([])).toBe(0)
    expect(lastStepTokens([usageStep(10, 5) as StepResult<ToolSet>, usageStep(700, 50) as StepResult<ToolSet>])).toBe(750)
    const messages = conversation(1, 10)
    expect(stepEstimate(step(messages))).toBe(estimateTokens(messages, 'Be brief.'))
    expect(stepEstimate(step(messages, 1, [usageStep(5000, 10)]))).toBe(5010)
  })

  it('merges the summary as the first part of the kept user message', () => {
    expect(mergeSummaryMessage('S', turnUser)).toEqual({ role: 'user', content: [{ type: 'text', text: 'S' }, { type: 'text', text: 'the latest request' }] })
    expect(mergeSummaryMessage('S', { role: 'user', content: 'plain' })).toEqual({ role: 'user', content: [{ type: 'text', text: 'S' }, { type: 'text', text: 'plain' }] })
    expect(mergeSummaryMessage('S', null)).toEqual({ role: 'user', content: [{ type: 'text', text: 'S' }] })
  })

  it('takes the todo list from this run first, then from the history', () => {
    const todos = [{ id: 'loop', content: 'Run 6 steps', status: 'in_progress' as const }]
    const output = { todos, counts: { pending: 0, inProgress: 1, completed: 0, total: 1 } }
    const historyTodos = [{ id: '1', content: 'Old', status: 'completed' as const }]
    const history: HarnessUIMessage[] = [{
      id: 'msg_a000000000000001',
      role: 'assistant',
      parts: [{ type: 'tool-todo_write', toolCallId: 't1', state: 'output-available', input: { todos: historyTodos }, output: { todos: historyTodos, counts: { pending: 0, inProgress: 0, completed: 1, total: 1 } } } as unknown as HarnessUIMessage['parts'][number]],
    }]
    expect(runTodos(history, [usageStep(1, 1, [{ toolName: 'todo_write', output }]) as StepResult<ToolSet>])).toEqual(todos)
    expect(runTodos(history, [usageStep(1, 1, [{ toolName: 'todo_write', output: { invalid: true } }, { toolName: 'other', output }]) as StepResult<ToolSet>])).toEqual(historyTodos)
    expect(runTodos([], [])).toBeNull()
  })
})

describe('createContextGuard', () => {
  it('changes nothing below the threshold, with an unknown window, or for a single user message', async () => {
    const { session } = fakeSession()
    const small = conversation(1, 10)
    expect(stepEstimate(step(small))).toBeLessThan(WINDOW * COMPACT_TRIGGER_RATIO)
    const guard = createContextGuard({ session, model: resolvedModel('mock:run', summaryModel('S'), WINDOW), keptUser: async () => turnUser })
    expect(await guard(step(small))).toBeUndefined()
    const unknown = createContextGuard({ session, model: resolvedModel('mock:run', summaryModel('S'), null), keptUser: async () => turnUser })
    expect(await unknown(step(conversation(5)))).toBeUndefined()
    expect(await guard(step([{ role: 'user', content: 'x'.repeat(10_000) }]))).toBeUndefined()
    expect(injected(session)).toEqual([])
  })

  it('compacts above 0.8 of the window: one marker for the step, the summary merged into the kept user message', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const fake = fakeSession({ history: [user('msg_u000000000000001', 'q'), user('msg_u000000000000002', 'the latest request')], now: () => 777 })
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('THE SUMMARY', calls), WINDOW), keptUser: async () => turnUser })
    const messages = conversation(5)
    const estimate = stepEstimate(step(messages))
    expect(estimate).toBeGreaterThan(WINDOW * COMPACT_TRIGGER_RATIO)
    const result = await guard(step(messages, 2, [usageStep(10, 5)]))
    expect(result?.messages).toHaveLength(1)
    const [merged] = result!.messages!
    expect(merged?.role).toBe('user')
    const parts = merged?.content as { type: string, text: string }[]
    expect(parts[1]).toEqual({ type: 'text', text: 'the latest request' })
    expect(parts[0]?.text).toContain('THE SUMMARY')
    expect(parts[0]?.text).toContain(COMPACTION_CONTINUE_TEXT)
    expect(calls).toHaveLength(1)
    const chunks = fake.session.takeInjections(1)
    expect(chunks).toEqual([])
    const [marker] = fake.session.takeInjections(2) as { type: string, data: CompactionData }[]
    expect(marker?.type).toBe('data-compaction')
    expect(marker?.data).toMatchObject({ trigger: 'auto', keep: 'last-user', summary: 'THE SUMMARY', modelRef: 'mock:run', tokensBefore: estimate, createdAt: 777 })
    expect(marker?.data.tokensAfter).toBe(estimateTokens(result!.messages!, 'Be brief.'))
    // The history (two user messages) minus the kept one, plus this reply's earlier steps.
    expect(marker?.data.messagesCompacted).toBe(2)
    expect(fake.transient).toEqual([
      { type: 'data-activity', data: { kind: 'compacting' }, transient: true },
      { type: 'data-activity', data: { kind: 'idle' }, transient: true },
    ])
    expect(fake.usage).toEqual([expect.objectContaining({ purpose: 'compact', messageId: 'msg_a000000000000009' })])
  })

  it('keeps no user message when the merged message would still exceed 0.85 of the window', async () => {
    const fake = fakeSession()
    const huge: ModelMessage = { role: 'user', content: [{ type: 'text', text: 'h'.repeat(WINDOW * 4) }] }
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('S'), WINDOW), keptUser: async () => huge })
    const result = await guard(step(conversation(5)))
    expect(result?.messages).toHaveLength(1)
    expect(estimateTokens(result!.messages!)).toBeLessThan(WINDOW * CONTEXT_BUDGET_RATIO)
    const [marker] = injected(fake.session) as { data: CompactionData }[]
    expect(marker?.data.keep).toBe('none')
  })

  it('snapshots the todo list of the run in the marker and the summary text', async () => {
    const fake = fakeSession()
    const todos = [{ id: 'loop', content: 'Run 6 steps', status: 'in_progress' as const, activeForm: 'Running step 2 of 6' }]
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('S'), WINDOW), keptUser: async () => turnUser })
    const result = await guard(step(conversation(5), 1, [usageStep(1, 1, [{ toolName: 'todo_write', output: { todos, counts: { pending: 0, inProgress: 1, completed: 0, total: 1 } } }])]))
    const [marker] = injected(fake.session) as { data: CompactionData }[]
    expect(marker?.data.todos).toEqual(todos)
    expect(JSON.stringify(result?.messages)).toContain(`${COMPACTION_TODOS_HEADING}\\n- [in_progress] Run 6 steps`)
  })

  it(`compacts at most ${LIMITS.compactionsPerRunMax} times per run`, async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const fake = fakeSession()
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('S', calls), WINDOW), keptUser: async () => turnUser })
    for (let index = 0; index < LIMITS.compactionsPerRunMax + 2; index++)
      await guard(step(conversation(5), index))
    expect(calls).toHaveLength(LIMITS.compactionsPerRunMax)
    expect(injected(fake.session)).toHaveLength(LIMITS.compactionsPerRunMax)
  })

  it('stops compacting when the call right after a compaction still reports a context above the trigger', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const fake = fakeSession()
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('S', calls), WINDOW), keptUser: async () => turnUser })
    const small = conversation(1, 10)
    // Step 3 compacts because of the reported usage; step 4 (on the compacted context) still reports 950 tokens.
    expect((await guard(step(small, 3, [usageStep(900, 50)])))?.messages).toHaveLength(1)
    expect(await guard(step(small, 4, [usageStep(900, 50)]))).toBeUndefined()
    expect(await guard(step(conversation(5), 5, [usageStep(10, 5)]))).toBeUndefined()
    expect(calls).toHaveLength(1)
    // A compaction that helped (the next call reports a small context) leaves the guard on.
    const helped = createContextGuard({ session: fakeSession().session, model: resolvedModel('mock:run', summaryModel('S', calls), WINDOW), keptUser: async () => turnUser })
    await helped(step(conversation(5), 1))
    expect(await helped(step(small, 2, [usageStep(100, 5)]))).toBeUndefined()
    expect((await helped(step(conversation(5), 3, [usageStep(100, 5)])))?.messages).toHaveLength(1)
    expect(calls).toHaveLength(3)
  })

  it('autoCompact off: trims the oldest turns on step 0 only, with context-trimmed', async () => {
    const calls: LanguageModelV4CallOptions[] = []
    const fake = fakeSession({ settings: { autoCompact: false } })
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', summaryModel('S', calls), WINDOW), keptUser: async () => turnUser })
    const messages = conversation(4)
    const result = await guard(step(messages))
    expect(result?.messages?.at(-1)).toEqual(turnUser)
    expect(result!.messages!.length).toBeLessThan(messages.length)
    expect(estimateTokens(result!.messages!, 'Be brief.')).toBeLessThanOrEqual(WINDOW * CONTEXT_BUDGET_RATIO)
    expect(fake.session.takeInjections(0)).toEqual([{ type: 'data-notice', data: NOTICES.contextTrimmed() }])
    expect(await guard(step(messages, 1))).toBeUndefined()
    expect(calls).toHaveLength(0)
    expect(fake.transient).toEqual([])
    // Nothing to trim: no notice.
    expect(await guard(step(conversation(1, 10)))).toBeUndefined()
    expect(injected(fake.session)).toEqual([])
  })

  it('a summarizer error on step 0: trims down to the trigger with compaction-failed, then stops compacting', async () => {
    const fake = fakeSession()
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', failingModel(), WINDOW), keptUser: async () => turnUser })
    const messages = conversation(4)
    const result = await guard(step(messages))
    expect(result?.messages?.at(-1)).toEqual(turnUser)
    expect(estimateTokens(result!.messages!, 'Be brief.')).toBeLessThanOrEqual(WINDOW * COMPACT_TRIGGER_RATIO)
    expect(fake.session.takeInjections(0)).toEqual([{ type: 'data-notice', data: NOTICES.compactionFailed() }])
    expect(NOTICES.compactionFailed()).toEqual({ level: 'warning', code: 'compaction-failed', message: 'Couldn\'t compact the conversation. Older messages were left out instead.' })
    expect(fake.transient.map(chunk => chunk.data)).toEqual([{ kind: 'compacting' }, { kind: 'idle' }])
    // Later steps go on untouched, and the failing summarizer is not called again in this run.
    expect(await guard(step(messages, 1))).toBeUndefined()
    expect(fake.transient).toHaveLength(2)
  })

  it('a summarizer error after step 0 leaves the messages as they are, without a notice', async () => {
    const fake = fakeSession()
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', failingModel(), WINDOW), keptUser: async () => turnUser })
    expect(await guard(step(conversation(4), 3))).toBeUndefined()
    expect(injected(fake.session)).toEqual([])
  })

  it('re-throws an abort of the run (the run ends aborted)', async () => {
    const fake = fakeSession()
    let started!: () => void
    const running = new Promise<void>((resolve) => {
      started = resolve
    })
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', hangingModel(() => started()), WINDOW), keptUser: async () => turnUser })
    const pending = guard(step(conversation(4)))
    await running
    fake.controller.abort(new DOMException('The run was stopped.', 'AbortError'))
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(injected(fake.session)).toEqual([])
    expect(fake.transient.map(chunk => chunk.data)).toEqual([{ kind: 'compacting' }, { kind: 'idle' }])
  })

  it('re-throws an abort of its own signal (a sub-agent deadline)', async () => {
    const fake = fakeSession()
    const controller = new AbortController()
    controller.abort(new DOMException('deadline', 'AbortError'))
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:run', hangingModel(), WINDOW), keptUser: async () => turnUser, signal: controller.signal, silent: true })
    await expect(guard(step(conversation(4)))).rejects.toBeDefined()
  })

  it('silent mode (sub-agents): compacts with a usage row, but no marker, notice or activity', async () => {
    const fake = fakeSession()
    const guard = createContextGuard({ session: fake.session, model: resolvedModel('mock:child', summaryModel('S'), WINDOW), keptUser: async () => turnUser, silent: true })
    const result = await guard(step(conversation(4), 2))
    expect(result?.messages).toHaveLength(1)
    expect(injected(fake.session)).toEqual([])
    expect(fake.transient).toEqual([])
    expect(fake.usage).toEqual([expect.objectContaining({ purpose: 'compact', modelId: 'child' })])
    // A failure on step 0 trims without a notice.
    const failing = fakeSession()
    const silentFailing = createContextGuard({ session: failing.session, model: resolvedModel('mock:child', failingModel(), WINDOW), keptUser: async () => turnUser, silent: true })
    expect((await silentFailing(step(conversation(4))))?.messages?.at(-1)).toEqual(turnUser)
    expect(injected(failing.session)).toEqual([])
  })
})
