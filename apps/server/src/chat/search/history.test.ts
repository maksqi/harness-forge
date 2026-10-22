// Smoke test of the P14-0b history stage (C52-T7): the identity until W14.4 implements it.
import type { HarnessUIMessage } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { stripForeignProviderParts } from './history.ts'

describe('stripForeignProviderParts (P14-0b stub)', () => {
  it('answers the messages as they are (a new array, the same messages)', () => {
    const messages: HarnessUIMessage[] = [
      { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'search' }] },
      { id: 'msg_a000000000000001', role: 'assistant', metadata: { modelRef: 'other:model', startedAt: 1 }, parts: [{ type: 'text', text: 'done' }] },
    ]
    const result = stripForeignProviderParts(messages, 'test')
    expect(result).toEqual(messages)
    expect(result).not.toBe(messages)
    expect(result[1]).toBe(messages[1])
  })
})
