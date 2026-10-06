// The model history builder (Phase 9, C26-T3; Phase 10, C31-T3; Phase 11, C37-T6): the stage order applyCompaction →
// splitSteers → splitTaskResults → splitHooks → reduceAgentOutputs → applyCommandExpansions → the summary merge, with
// fake stages; and `buildModelHistory` with the real stages (a v1.4 – v1.6 path comes back unchanged, a delivered task
// result and a carrier message become user text, hook records become model text).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ModelHistoryStages } from './model-history.ts'
import { hookModelText, splitHooks, splitSteers, splitTaskResults, taskResultText } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { fakeHookRecord } from '../testing/fake-hooks.ts'
import { applyCommandExpansions } from './context.ts'
import { buildModelHistory, COMPACTION_SUMMARY_MESSAGE_ID, composeModelHistory, mergeSummary, MODEL_HISTORY_STAGES } from './model-history.ts'

function user(id: string, text: string, extra: Partial<HarnessUIMessage> = {}): HarnessUIMessage {
  return { id, role: 'user', parts: [{ type: 'text', text }], ...extra }
}

function assistant(id: string, ...parts: HarnessUIMessage['parts']): HarnessUIMessage {
  return { id, role: 'assistant', parts }
}

const steerData = { id: 'msg_s000000000000001', parts: [{ type: 'text' as const, text: 'also b' }], queuedAt: 1, deliveredAt: 2 }

/** A v1.4 path: a prompt command, a reply with a tool call, a follow-up. */
const V14_PATH: HarnessUIMessage[] = [
  user('msg_u000000000000001', '/tldr long text', { metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'tldr', input: 'long text', type: 'prompt', expansion: 'TL;DR: long text' } } }),
  assistant('msg_a000000000000001', { type: 'step-start' }, { type: 'text', text: 'short', state: 'done' }),
  user('msg_u000000000000002', 'and now?'),
  assistant(
    'msg_a000000000000002',
    { type: 'step-start' },
    { type: 'tool-current_time', toolCallId: 'call_1', state: 'output-available', input: {}, output: { iso: 'x' } } as unknown as HarnessUIMessage['parts'][number],
    { type: 'step-start' },
    { type: 'text', text: 'done', state: 'done' },
  ),
]

describe('composeModelHistory', () => {
  it('runs the stages in order, each on the previous result, and merges the summary last', () => {
    const order: string[] = []
    const tag = (name: string) => (messages: readonly HarnessUIMessage[]): HarnessUIMessage[] => {
      order.push(name)
      return messages.map(message => ({ ...message, parts: [...message.parts, { type: 'text', text: name }] }))
    }
    const stages: ModelHistoryStages = {
      applyCompaction: (history) => {
        order.push('compaction')
        return { messages: history.slice(1), summaryText: 'SUMMARY' }
      },
      splitSteers: tag('split'),
      splitTaskResults: tag('results'),
      splitHooks: tag('hooks'),
      reduceAgentOutputs: tag('reduce'),
      applyCommandExpansions: tag('expand'),
    }
    const result = composeModelHistory([user('msg_u0', 'old'), user('msg_u1', 'kept')], stages)
    expect(order).toEqual(['compaction', 'split', 'results', 'hooks', 'reduce', 'expand'])
    expect(result).toEqual([
      user('msg_u1', 'SUMMARY', { parts: [{ type: 'text', text: 'SUMMARY' }, { type: 'text', text: 'kept' }, { type: 'text', text: 'split' }, { type: 'text', text: 'results' }, { type: 'text', text: 'hooks' }, { type: 'text', text: 'reduce' }, { type: 'text', text: 'expand' }] }),
    ])
  })

  it('merges the summary after the command expansion of the kept user message', () => {
    const kept = V14_PATH[0]!
    const result = composeModelHistory([assistant('msg_a0', { type: 'text', text: 'before' }), kept], {
      ...MODEL_HISTORY_STAGES,
      applyCompaction: history => ({ messages: history.slice(1), summaryText: 'SUMMARY' }),
    })
    expect(result).toHaveLength(1)
    expect(result[0]!.parts).toEqual([{ type: 'text', text: 'SUMMARY' }, { type: 'text', text: 'TL;DR: long text' }])
  })

  it('adds a standalone summary message when the history after the marker does not start with a user message', () => {
    const tail = assistant('msg_a1', { type: 'step-start' }, { type: 'text', text: 'after the marker' })
    const result = composeModelHistory([tail, user('msg_u2', 'next')], {
      ...MODEL_HISTORY_STAGES,
      applyCompaction: history => ({ messages: [...history], summaryText: 'SUMMARY' }),
    })
    expect(result.map(message => [message.id, message.role])).toEqual([[COMPACTION_SUMMARY_MESSAGE_ID, 'user'], ['msg_a1', 'assistant'], ['msg_u2', 'user']])
    expect(result[0]!.parts).toEqual([{ type: 'text', text: 'SUMMARY' }])
    for (let index = 1; index < result.length; index++)
      expect(result[index - 1]!.role === 'user' && result[index]!.role === 'user').toBe(false)
  })

  it('splits steers into user messages between the halves of a reply', () => {
    const reply = assistant('msg_a3', { type: 'step-start' }, { type: 'text', text: 'one' }, { type: 'data-steer', data: steerData }, { type: 'step-start' }, { type: 'text', text: 'two' })
    const result = buildModelHistory([user('msg_u3', 'go'), reply])
    expect(result.map(message => [message.id, message.role])).toEqual([['msg_u3', 'user'], ['msg_a3', 'assistant'], ['msg_s000000000000001', 'user'], ['msg_a3~1', 'assistant']])
  })
})

describe('mergeSummary', () => {
  it('leaves the messages alone without a summary', () => {
    const messages = [assistant('msg_a0', { type: 'text', text: 'x' })]
    expect(mergeSummary(messages, null)).toEqual(messages)
    expect(mergeSummary([], 'SUMMARY')).toEqual([{ id: COMPACTION_SUMMARY_MESSAGE_ID, role: 'user', parts: [{ type: 'text', text: 'SUMMARY' }] }])
  })
})

describe('buildModelHistory (P9-0b stages)', () => {
  it('returns a v1.4 path unchanged, with the command expansions applied', () => {
    const result = buildModelHistory(V14_PATH)
    expect(result).toEqual(applyCommandExpansions(V14_PATH))
    expect(result.slice(1)).toEqual(V14_PATH.slice(1))
    // Messages without a change are the same objects (the stages copy arrays, never messages).
    expect(result[1]).toBe(V14_PATH[1])
    expect(result[3]).toBe(V14_PATH[3])
    expect(splitSteers(V14_PATH)).toEqual(V14_PATH)
  })

  it('does not change its input', () => {
    const copy = structuredClone(V14_PATH)
    buildModelHistory(V14_PATH)
    expect(V14_PATH).toEqual(copy)
  })
})

describe('buildModelHistory: background task results (Phase 10, C31-T3)', () => {
  const taskId = 'bgt_0000000000000001'
  const result = {
    taskId,
    toolCallId: 'call_bg',
    messageId: 'msg_a000000000000009',
    output: {
      status: 'completed' as const,
      type: 'explore',
      description: 'Look around',
      modelRef: 'mock:background',
      steps: [],
      stepsOmitted: 0,
      report: 'Found the config.',
      startedAt: 1,
      finishedAt: 2,
      taskId,
    },
    deliveredAt: 3,
  }

  /** A v1.5 path: the v1.4 path plus a todo call and a delivered steer (no task result). */
  const V15_PATH: HarnessUIMessage[] = [
    ...V14_PATH,
    user('msg_u000000000000003', 'track it'),
    assistant(
      'msg_a000000000000003',
      { type: 'step-start' },
      { type: 'tool-todo_write', toolCallId: 'call_t', state: 'output-available', input: { todos: [] }, output: { todos: [], counts: { pending: 0, inProgress: 0, completed: 0, total: 0 } } } as unknown as HarnessUIMessage['parts'][number],
      { type: 'data-steer', data: steerData },
      { type: 'step-start' },
      { type: 'text', text: 'ok', state: 'done' },
    ),
  ]

  it('leaves a v1.5 path without task results as the Phase 9 stages built it', () => {
    const phase9 = composeModelHistory(V15_PATH, { ...MODEL_HISTORY_STAGES, splitTaskResults: messages => [...messages] })
    expect(buildModelHistory(V15_PATH)).toEqual(phase9)
    const split = splitSteers(V15_PATH)
    const results = splitTaskResults(split)
    for (const [index, message] of results.entries())
      expect(message).toBe(split[index])
  })

  it('splits a reply at a delivered result after the steer split: the result is a user message between the halves', () => {
    const reply = assistant(
      'msg_a4',
      { type: 'step-start' },
      { type: 'text', text: 'one' },
      { type: 'data-steer', data: steerData },
      { type: 'data-task-result', data: result },
      { type: 'step-start' },
      { type: 'text', text: 'two' },
    )
    const history = buildModelHistory([user('msg_u4', 'go'), reply])
    expect(history.map(message => [message.id, message.role])).toEqual([
      ['msg_u4', 'user'],
      ['msg_a4', 'assistant'],
      ['msg_s000000000000001', 'user'],
      [taskId, 'user'],
      ['msg_a4~1', 'assistant'],
    ])
    expect(history[3]!.parts).toEqual([{ type: 'text', text: taskResultText(result) }])
  })

  it('turns the carrier message of a server-started turn into a user text message', () => {
    const carrier: HarnessUIMessage = { id: 'msg_c000000000000001', role: 'user', parts: [{ type: 'data-task-result', data: result }] }
    const history = buildModelHistory([user('msg_u5', 'start it'), assistant('msg_a5', { type: 'text', text: 'started' }), carrier])
    expect(history.at(-1)).toEqual({ id: 'msg_c000000000000001', role: 'user', parts: [{ type: 'text', text: taskResultText(result) }] })
    expect(history.at(-1)!.parts[0]).toMatchObject({ text: expect.stringContaining('<background-task id="bgt_0000000000000001"') })
  })
})

describe('buildModelHistory: hook records (Phase 11, C37-T6)', () => {
  const sessionStart = fakeHookRecord('SessionStart', 'context', { context: 'Branch: main' })
  const postContext = fakeHookRecord('PostToolUse', 'context', { toolCallId: 'call_1', toolName: 'current_time', context: 'lint ok' })
  const preDenied = fakeHookRecord('PreToolUse', 'denied', { toolCallId: 'call_1', toolName: 'current_time', reason: 'no' })
  const stopRecord = fakeHookRecord('Stop', 'continued', { reason: 'run the tests' })

  /** A v1.6 path: the v1.4 path plus a delivered steer and a task carrier (no hook record). */
  const V16_PATH: HarnessUIMessage[] = [
    ...V14_PATH,
    user('msg_u000000000000003', 'go on'),
    assistant('msg_a000000000000003', { type: 'step-start' }, { type: 'text', text: 'one' }, { type: 'data-steer', data: steerData }, { type: 'step-start' }, { type: 'text', text: 'two' }),
  ]

  it('leaves a v1.6 path as the Phase 10 stages built it (the same message objects)', () => {
    const phase10 = composeModelHistory(V16_PATH, { ...MODEL_HISTORY_STAGES, splitHooks: messages => [...messages] })
    expect(buildModelHistory(V16_PATH)).toEqual(phase10)
    const split = splitTaskResults(splitSteers(V16_PATH))
    for (const [index, message] of splitHooks(split).entries())
      expect(message).toBe(split[index])
  })

  it('splits a reply at a PostToolUse context; display-only records leave no trace', () => {
    const reply = assistant(
      'msg_a6',
      { type: 'step-start' },
      { type: 'tool-current_time', toolCallId: 'call_1', state: 'output-available', input: {}, output: { iso: 'x' } } as unknown as HarnessUIMessage['parts'][number],
      { type: 'data-hook', data: preDenied },
      { type: 'data-hook', data: postContext },
      { type: 'step-start' },
      { type: 'text', text: 'done' },
    )
    const history = buildModelHistory([user('msg_u6', 'go'), reply])
    expect(history.map(message => [message.id, message.role])).toEqual([['msg_u6', 'user'], ['msg_a6', 'assistant'], [postContext.id, 'user'], ['msg_a6~h1', 'assistant']])
    expect(history[2]!.parts).toEqual([{ type: 'text', text: hookModelText(postContext, 'assistant') }])
    expect(JSON.stringify(history)).not.toContain(preDenied.id)
  })

  it('turns a hook carrier into a <hook-feedback> user text and a SessionStart context into text on its user message', () => {
    const carrier: HarnessUIMessage = { id: 'msg_c000000000000002', role: 'user', parts: [{ type: 'data-hook', data: stopRecord }] }
    const first = user('msg_u7', 'hi', { parts: [{ type: 'text', text: 'hi' }, { type: 'data-hook', data: sessionStart }] })
    const history = buildModelHistory([first, assistant('msg_a7', { type: 'text', text: 'done' }), carrier])
    expect(history[0]!.parts).toEqual([{ type: 'text', text: 'hi' }, { type: 'text', text: hookModelText(sessionStart, 'user') }])
    expect(history.at(-1)).toEqual({ id: 'msg_c000000000000002', role: 'user', parts: [{ type: 'text', text: '<hook-feedback event="Stop">\nrun the tests\n</hook-feedback>' }] })
  })

  it('keeps a SessionStart context on the kept user message of a compaction', () => {
    const turn = user('msg_u8', 'continue', { parts: [{ type: 'text', text: 'continue' }, { type: 'data-hook', data: sessionStart }] })
    const marker = {
      type: 'data-compaction' as const,
      data: { trigger: 'auto' as const, keep: 'last-user' as const, summary: 'SUMMARY', modelRef: 'mock:compact', messagesCompacted: 2, tokensBefore: 100, tokensAfter: 10, createdAt: 1 },
    }
    const reply = assistant('msg_a8', { type: 'step-start' }, marker, { type: 'step-start' }, { type: 'text', text: 'after' })
    const history = buildModelHistory([user('msg_u0', 'old'), assistant('msg_a0', { type: 'text', text: 'old reply' }), turn, reply])
    const kept = history.find(message => message.id === 'msg_u8')!
    expect(kept.parts.map(part => (part.type === 'text' ? part.text : part.type))).toEqual([expect.stringContaining('SUMMARY'), 'continue', hookModelText(sessionStart, 'user')])
  })
})
