// The compaction history rule (W9.1-T1): the latest marker on the path replaces everything before it; branch-aware and
// positional (a chat import with new ids gives the same result).
import type { CompactionData, HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { buildModelHistory } from '../model-history.ts'
import {
  applyCompaction,
  COMPACTION_CONTINUE_TEXT,
  COMPACTION_SUMMARY_PREFACE,
  COMPACTION_TODOS_HEADING,
  compactionSummaryText,
} from './history.ts'
import { assistant, user } from './testing.ts'

function marker(data: Partial<CompactionData> = {}): HarnessUIMessagePart {
  return {
    type: 'data-compaction',
    data: { trigger: 'manual', keep: 'none', summary: 'S', modelRef: 'mock:compact', messagesCompacted: 2, tokensBefore: 100, tokensAfter: 10, createdAt: 1, ...data },
  }
}

function withParts(message: HarnessUIMessage, ...parts: HarnessUIMessagePart[]): HarnessUIMessage {
  return { ...message, parts: [...message.parts, ...parts] }
}

const u1 = user('msg_u000000000000001', 'first OLD-1')
const a1 = assistant('msg_a000000000000001', 'answer one')
const u2 = user('msg_u000000000000002', 'second')
const a2 = assistant('msg_a000000000000002', 'answer two')

describe('applyCompaction', () => {
  it('returns the history unchanged without a marker (the same message objects)', () => {
    const history = [u1, a1, u2]
    const result = applyCompaction(history)
    expect(result).toEqual({ messages: history, summaryText: null })
    expect(result.messages[0]).toBe(u1)
    expect(result.messages).not.toBe(history)
  })

  it('a manual marker (keep none): only the later messages, and the summary text', () => {
    const compactUser = user('msg_u000000000000003', '/compact')
    const reply: HarnessUIMessage = { id: 'msg_a000000000000003', role: 'assistant', parts: [marker({ summary: 'the summary' })] }
    const u4 = user('msg_u000000000000004', 'seen?')
    const result = applyCompaction([u1, a1, u2, a2, compactUser, reply, u4])
    expect(result.messages).toEqual([u4])
    expect(result.summaryText).toContain('the summary')
    // The summary becomes the first part of the next user message.
    expect(buildModelHistory([u1, a1, u2, a2, compactUser, reply, u4])).toEqual([{ ...u4, parts: [{ type: 'text', text: result.summaryText }, ...u4.parts] }])
  })

  it('an automatic marker at step 0 with keep last-user: the turn user message, then the reply after the marker', () => {
    const reply: HarnessUIMessage = {
      id: 'msg_a000000000000003',
      role: 'assistant',
      parts: [marker({ trigger: 'auto', keep: 'last-user' }), { type: 'step-start' }, { type: 'text', text: 'after', state: 'done' }],
    }
    const result = applyCompaction([u1, a1, u2, reply])
    expect(result.messages).toEqual([u2, { ...reply, parts: reply.parts.slice(1) }])
    expect(result.summaryText).toContain(COMPACTION_CONTINUE_TEXT)
  })

  it('an in-run marker at part p: the later parts stay, the earlier ones are dropped', () => {
    const reply: HarnessUIMessage = {
      id: 'msg_a000000000000003',
      role: 'assistant',
      parts: [
        { type: 'step-start' },
        { type: 'text', text: 'step one OLD-2', state: 'done' },
        marker({ trigger: 'auto', keep: 'last-user' }),
        { type: 'step-start' },
        { type: 'text', text: 'step two', state: 'done' },
      ],
    }
    const result = applyCompaction([u1, a1, u2, reply])
    expect(result.messages).toEqual([u2, { ...reply, parts: reply.parts.slice(3) }])
    expect(JSON.stringify(result.messages)).not.toContain('OLD-2')
  })

  it('leaves out the marker message when nothing but step boundaries and notices follow the marker', () => {
    const reply: HarnessUIMessage = {
      id: 'msg_a000000000000003',
      role: 'assistant',
      parts: [marker(), { type: 'step-start' }, { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'x' } }],
    }
    expect(applyCompaction([u1, a1, user('msg_u000000000000003', '/compact'), reply]).messages).toEqual([])
  })

  it('several markers: the latest wins (also inside one message, scanning parts last to first)', () => {
    const first: HarnessUIMessage = { id: 'msg_a000000000000003', role: 'assistant', parts: [marker({ summary: 'older' })] }
    const second = withParts(assistant('msg_a000000000000004', 'early'), marker({ trigger: 'auto', keep: 'none', summary: 'inner one' }), { type: 'text', text: 'middle' }, marker({ trigger: 'auto', keep: 'none', summary: 'inner two' }), { type: 'text', text: 'late' })
    const result = applyCompaction([u1, first, u2, second])
    expect(result.summaryText).toContain('inner two')
    expect(result.messages).toEqual([{ ...second, parts: [{ type: 'text', text: 'late' }] }])
  })

  it('a branch above the marker, a regenerate of its reply and a deleted marker message see no marker', () => {
    const reply: HarnessUIMessage = { id: 'msg_a000000000000003', role: 'assistant', parts: [marker()] }
    const full = [u1, a1, u2, reply, user('msg_u000000000000005', 'next')]
    expect(applyCompaction(full).summaryText).not.toBeNull()
    // A branch edited at u2 (a sibling above the marker): the path never holds the marker.
    const branch = [u1, a1, user('msg_u000000000000006', 'edited')]
    expect(applyCompaction(branch)).toEqual({ messages: branch, summaryText: null })
    // A regenerate of the reply that held the marker: the history ends at the answered user message.
    expect(applyCompaction([u1, a1, u2]).summaryText).toBeNull()
  })

  it('a deleted compaction message falls back to the previous marker', () => {
    const older: HarnessUIMessage = { id: 'msg_a000000000000003', role: 'assistant', parts: [marker({ summary: 'older summary' })] }
    const u4 = user('msg_u000000000000004', 'more')
    const a4 = assistant('msg_a000000000000004', 'more answer')
    const result = applyCompaction([u1, older, u4, a4])
    expect(result.summaryText).toContain('older summary')
    expect(result.messages).toEqual([u4, a4])
  })

  it('keep last-user without a user message before the marker keeps none', () => {
    const reply: HarnessUIMessage = { id: 'msg_a000000000000003', role: 'assistant', parts: [marker({ trigger: 'auto', keep: 'last-user' }), { type: 'text', text: 'x' }] }
    expect(applyCompaction([reply]).messages).toEqual([{ ...reply, parts: [{ type: 'text', text: 'x' }] }])
  })

  it('ignores an invalid marker (the previous valid one or none applies)', () => {
    const invalid = { type: 'data-compaction', data: { trigger: 'sometimes' } } as unknown as HarnessUIMessagePart
    const reply: HarnessUIMessage = { id: 'msg_a000000000000003', role: 'assistant', parts: [invalid] }
    expect(applyCompaction([u1, reply]).summaryText).toBeNull()
  })

  it('gives the same result for a chat imported with new ids (positional)', () => {
    const reply: HarnessUIMessage = {
      id: 'msg_a000000000000003',
      role: 'assistant',
      parts: [{ type: 'text', text: 'early' }, marker({ trigger: 'auto', keep: 'last-user' }), { type: 'text', text: 'late' }],
    }
    const original = [u1, a1, u2, reply]
    const remap = (message: HarnessUIMessage, index: number): HarnessUIMessage => ({ ...message, id: `msg_i${String(index).padStart(15, '0')}` })
    const imported = original.map(remap)
    const strip = (messages: HarnessUIMessage[]): unknown => messages.map(({ id: _id, ...rest }) => rest)
    expect(strip(applyCompaction(imported).messages)).toEqual(strip(applyCompaction(original).messages))
    expect(applyCompaction(imported).summaryText).toBe(applyCompaction(original).summaryText)
  })
})

describe('compactionSummaryText', () => {
  const base: CompactionData = { trigger: 'manual', keep: 'none', summary: '  ## Summary\nDone.  ', modelRef: 'mock:compact', messagesCompacted: 2, tokensBefore: 10, tokensAfter: 2, createdAt: 1 }

  it('is the preface and the summary for a manual marker', () => {
    expect(compactionSummaryText(base)).toBe(`${COMPACTION_SUMMARY_PREFACE}\n\n## Summary\nDone.`)
  })

  it('adds the todo snapshot and, for auto, the continue line', () => {
    const text = compactionSummaryText({
      ...base,
      trigger: 'auto',
      todos: [{ id: '1', content: 'Read the code', status: 'completed' }, { id: '2', content: 'Change the code', status: 'in_progress', activeForm: 'Changing' }],
    })
    expect(text).toBe([
      COMPACTION_SUMMARY_PREFACE,
      '## Summary\nDone.',
      `${COMPACTION_TODOS_HEADING}\n- [completed] Read the code\n- [in_progress] Change the code`,
      COMPACTION_CONTINUE_TEXT,
    ].join('\n\n'))
    expect(compactionSummaryText({ ...base, todos: [] })).not.toContain(COMPACTION_TODOS_HEADING)
  })

  it('carries no sentinel-like words of its own', () => {
    expect(compactionSummaryText({ ...base, summary: 'x', trigger: 'auto' })).not.toMatch(/OLD-[A-Za-z0-9]+/)
  })
})
