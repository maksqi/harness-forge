// The model history builder (Phase 9, C26-T3): the stage order applyCompaction → splitSteers → reduceAgentOutputs →
// applyCommandExpansions → the summary merge, with fake stages; and `buildModelHistory` with the P9-0b stages (a v1.4
// path comes back unchanged).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ModelHistoryStages } from './model-history.ts'
import { splitSteers } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
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
      reduceAgentOutputs: tag('reduce'),
      applyCommandExpansions: tag('expand'),
    }
    const result = composeModelHistory([user('msg_u0', 'old'), user('msg_u1', 'kept')], stages)
    expect(order).toEqual(['compaction', 'split', 'reduce', 'expand'])
    expect(result).toEqual([
      user('msg_u1', 'SUMMARY', { parts: [{ type: 'text', text: 'SUMMARY' }, { type: 'text', text: 'kept' }, { type: 'text', text: 'split' }, { type: 'text', text: 'reduce' }, { type: 'text', text: 'expand' }] }),
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
