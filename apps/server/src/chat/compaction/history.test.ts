// The compaction history rule (P9-0b stub, C26-T5): the identity without a summary until W9.1.
import type { CompactionData, HarnessUIMessage } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { applyCompaction, compactionSummaryText } from './history.ts'

describe('applyCompaction (stub until W9.1)', () => {
  it('returns the history unchanged and no summary', () => {
    const history: HarnessUIMessage[] = [{ id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'hi' }] }]
    const result = applyCompaction(history)
    expect(result).toEqual({ messages: history, summaryText: null })
    expect(result.messages[0]).toBe(history[0])
  })

  it('has no summary wording yet', () => {
    const data: CompactionData = { trigger: 'manual', keep: 'none', summary: 'S', modelRef: 'mock:compact', messagesCompacted: 2, tokensBefore: 10, tokensAfter: 2, createdAt: 1 }
    expect(() => compactionSummaryText(data)).toThrow(expect.objectContaining({ code: 'not_implemented' }))
  })
})
