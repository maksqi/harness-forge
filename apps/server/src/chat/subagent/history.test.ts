// Sub-agent outputs in the model history (P9-0b stub, C26-T5): the identity until W9.5.
import type { HarnessUIMessage } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { reduceAgentOutputs } from './history.ts'

describe('reduceAgentOutputs (stub until W9.5)', () => {
  it('returns the same messages', () => {
    const messages: HarnessUIMessage[] = [{ id: 'msg_a000000000000001', role: 'assistant', parts: [{ type: 'text', text: 'x' }] }]
    const result = reduceAgentOutputs(messages)
    expect(result).toEqual(messages)
    expect(result[0]).toBe(messages[0])
  })
})
