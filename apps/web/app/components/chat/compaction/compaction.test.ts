import type { HarnessUIMessage } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { assistantMessage, compactionData, compactionPart, userMessage } from '~/utils/testing/fixtures'
import { compactionLabel, compactionLayout, compactionVariant } from './compaction'

describe('compaction helpers (P9-0b signatures)', () => {
  it('labels manual, automatic and in-run markers', () => {
    expect(compactionLabel(compactionData(), 'history')).toBe('Conversation compacted')
    expect(compactionLabel(compactionData(), 'run')).toBe('Conversation compacted')
    expect(compactionLabel(compactionData({ trigger: 'auto' }), 'history')).toBe('Conversation compacted automatically')
    expect(compactionLabel(compactionData({ trigger: 'auto' }), 'run')).toBe('Context compacted during this response')
  })

  it('puts a marker in the history variant unless a rendered block precedes it', () => {
    const opening = assistantMessage('msg_a000000000000001', '', {
      parts: [{ type: 'step-start' }, compactionPart({ trigger: 'auto' }), { type: 'text', text: 'Done', state: 'done' }],
    })
    expect(compactionVariant(opening, 1)).toBe('history')
    const inRun = assistantMessage('msg_a000000000000002', '', {
      parts: [{ type: 'text', text: 'Step 1 done.', state: 'done' }, { type: 'step-start' }, compactionPart({ trigger: 'auto' })],
    })
    expect(compactionVariant(inRun, 2)).toBe('run')
  })

  it('dims nothing until W9.11 implements the layout', () => {
    const messages: HarnessUIMessage[] = [
      userMessage('msg_u000000000000001', 'Old question'),
      assistantMessage('msg_a000000000000001', 'Old answer'),
      userMessage('msg_u000000000000002', '/compact'),
      assistantMessage('msg_a000000000000002', '', { parts: [compactionPart()] }),
    ]
    expect(compactionLayout(messages).dimmed.size).toBe(0)
  })
})
