import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { assistantMessage, compactionData, compactionPart, steerPart, userMessage } from '~/utils/testing/fixtures'
import { compactionLabel, compactionLayout, compactionMeta, compactionVariant, messageCompaction } from './compaction'

const U1 = 'msg_u000000000000001'
const A1 = 'msg_a000000000000001'
const U2 = 'msg_u000000000000002'
const A2 = 'msg_a000000000000002'
const U3 = 'msg_u000000000000003'
const A3 = 'msg_a000000000000003'

function reply(id: string, ...parts: HarnessUIMessagePart[]): HarnessUIMessage {
  return assistantMessage(id, '', { parts })
}

const text = (value: string): HarnessUIMessagePart => ({ type: 'text', text: value, state: 'done' })

function dimmed(messages: readonly HarnessUIMessage[]): string[] {
  return [...compactionLayout(messages).dimmed]
}

describe('compaction labels and meta', () => {
  it('labels manual, automatic and in-run markers', () => {
    expect(compactionLabel(compactionData(), 'history')).toBe('Conversation compacted')
    expect(compactionLabel(compactionData(), 'run')).toBe('Conversation compacted')
    expect(compactionLabel(compactionData({ trigger: 'auto' }), 'history')).toBe('Conversation compacted automatically')
    expect(compactionLabel(compactionData({ trigger: 'auto' }), 'run')).toBe('Context compacted during this response')
  })

  it('summarizes the count and the token sizes in the 14.3K style', () => {
    expect(compactionMeta(compactionData({ messagesCompacted: 42 }))).toBe('42 messages summarized · 182K → 9K tokens')
    expect(compactionMeta({ messagesCompacted: 1, tokensBefore: 14_300, tokensAfter: 900 })).toBe('1 message summarized · 14.3K → 900 tokens')
    expect(compactionMeta({ messagesCompacted: 0, tokensBefore: 1_250_000, tokensAfter: 0 })).toBe('0 messages summarized · 1.3M → 0 tokens')
  })
})

describe('compaction variants', () => {
  it('puts a marker in the history variant unless content of its own message precedes it', () => {
    const opening = reply(A1, { type: 'step-start' }, compactionPart({ trigger: 'auto' }), text('Done'))
    expect(compactionVariant(opening, 1)).toBe('history')
    const inRun = reply(A2, text('Step 1 done.'), { type: 'step-start' }, compactionPart({ trigger: 'auto' }))
    expect(compactionVariant(inRun, 2)).toBe('run')
    // A notice before the first step is not content: still before the reply.
    const noticed = reply(A3, { type: 'data-notice', data: { level: 'warning', code: 'workspace-unavailable', message: 'No workspace.' } }, compactionPart({ trigger: 'auto' }))
    expect(compactionVariant(noticed, 1)).toBe('history')
  })

  it('keeps a manual marker in the history variant and answers history for a part that is no marker', () => {
    const manual = reply(A1, text('Earlier'), compactionPart())
    expect(compactionVariant(manual, 1)).toBe('history')
    expect(compactionVariant(manual, 0)).toBe('history')
  })

  it('lists the variant of every marker of a reply and the index of the last one', () => {
    const message = reply(A1, compactionPart({ trigger: 'auto' }), text('Step 1.'), compactionPart({ trigger: 'auto' }, 'compaction_2'), text('Step 2.'))
    const compaction = messageCompaction(message)
    expect([...compaction.variants]).toEqual([[0, 'history'], [2, 'run']])
    expect(compaction.lastIndex).toBe(2)
    expect(messageCompaction(reply(A2, text('Plain'))).lastIndex).toBeNull()
    // Only assistant messages hold markers; invalid marker data is skipped.
    expect(messageCompaction(userMessage(U1, 'q', { parts: [compactionPart()] })).lastIndex).toBeNull()
    const invalid = reply(A3, { type: 'data-compaction', data: { trigger: 'manual' } } as unknown as HarnessUIMessagePart)
    expect(messageCompaction(invalid).lastIndex).toBeNull()
  })
})

describe('compactionLayout', () => {
  it('dims everything before a /compact reply, the command exchange included', () => {
    const messages = [
      userMessage(U1, 'Old question'),
      assistantMessage(A1, 'Old answer'),
      userMessage(U2, '/compact keep numbers'),
      reply(A2, compactionPart({ focus: 'keep numbers' })),
      userMessage(U3, 'Next'),
      assistantMessage(A3, 'Answer'),
    ]
    expect(dimmed(messages)).toEqual([U1, A1, U2])
  })

  it('keeps the user message of an automatic compaction before the reply (keep: last-user)', () => {
    const messages = [
      userMessage(U1, 'Old question'),
      assistantMessage(A1, 'Old answer'),
      userMessage(U2, 'New question'),
      reply(A2, { type: 'step-start' }, compactionPart({ trigger: 'auto', keep: 'last-user' }), text('Answer')),
    ]
    expect(dimmed(messages)).toEqual([U1, A1])
  })

  it('dims the messages before a reply that compacted during the run', () => {
    const messages = [
      userMessage(U1, 'Old question'),
      assistantMessage(A1, 'Old answer'),
      userMessage(U2, 'Loop'),
      reply(A2, text('Step 1 done.'), steerPart(), { type: 'step-start' }, compactionPart({ trigger: 'auto', keep: 'last-user' }), text('Step 2 done.')),
    ]
    expect(dimmed(messages)).toEqual([U1, A1])
  })

  it('follows the latest of several markers', () => {
    const messages = [
      userMessage(U1, 'First'),
      reply(A1, compactionPart({ trigger: 'auto', keep: 'last-user' }), text('One')),
      userMessage(U2, '/compact'),
      reply(A2, compactionPart()),
      userMessage(U3, 'Third'),
      assistantMessage(A3, 'Three'),
    ]
    expect(dimmed(messages)).toEqual([U1, A1, U2])
    // Without the later marker (a branch above it), the earlier one is the latest.
    expect(dimmed([messages[0]!, messages[1]!])).toEqual([])
    expect(dimmed([...messages.slice(0, 2), userMessage(U3, 'Other branch'), assistantMessage(A3, 'Other')])).toEqual([])
  })

  it('dims nothing on a path without a valid marker (a branch above it, a regenerated reply)', () => {
    expect(dimmed([])).toEqual([])
    expect(dimmed([userMessage(U1, 'Q'), assistantMessage(A1, 'A'), userMessage(U2, 'Q2'), assistantMessage(A2, 'A2')])).toEqual([])
    const invalid = { type: 'data-compaction', data: { trigger: 'auto' } } as unknown as HarnessUIMessagePart
    expect(dimmed([userMessage(U1, 'Q'), assistantMessage(A1, 'A'), userMessage(U2, 'Q2'), reply(A2, invalid, text('A2'))])).toEqual([])
    // A marker that user messages hold is not a marker.
    expect(dimmed([userMessage(U1, 'Q'), userMessage(U2, 'Q2', { parts: [compactionPart()] })])).toEqual([])
  })

  it('reads the last message again while it streams (it changes in place)', () => {
    const last = reply(A2, text('Step 1 done.'))
    const messages = [userMessage(U1, 'Q'), assistantMessage(A1, 'A'), userMessage(U2, 'Loop'), last]
    expect(dimmed(messages)).toEqual([])
    last.parts.push(compactionPart({ trigger: 'auto', keep: 'last-user' }))
    expect(dimmed(messages)).toEqual([U1, A1])
  })
})
