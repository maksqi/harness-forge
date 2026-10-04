import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { applyCommandExpansions, CONTEXT_BUDGET_RATIO, estimateMessageTokens, estimateTokens, trimToContext, validModelMessages } from './context.ts'

describe('applyCommandExpansions', () => {
  it('replaces the first text part of a prompt command with its expansion', () => {
    const messages: HarnessUIMessage[] = [
      {
        id: 'msg_u000000000000001',
        role: 'user',
        metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'tldr', input: 'x', type: 'prompt', expansion: 'Summarize: x' } },
        parts: [{ type: 'file', mediaType: 'image/png', url: '/api/files/file_0000000000000001' }, { type: 'text', text: '/tldr x' }, { type: 'text', text: 'more' }],
      },
      { id: 'msg_u000000000000002', role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'roll', input: '', type: 'reply' } }, parts: [{ type: 'text', text: '/roll' }] },
      { id: 'msg_a000000000000001', role: 'assistant', parts: [{ type: 'text', text: '4' }] },
    ]
    const [expanded, reply, assistant] = applyCommandExpansions(messages)
    expect(expanded?.parts).toEqual([messages[0]!.parts[0], { type: 'text', text: 'Summarize: x' }, { type: 'text', text: 'more' }])
    expect(reply).toBe(messages[1])
    expect(assistant).toBe(messages[2])
    expect(messages[0]!.parts[1]).toEqual({ type: 'text', text: '/tldr x' })
  })

  it('adds the expansion when the message has no text part', () => {
    const [message] = applyCommandExpansions([{ id: 'msg_u000000000000001', role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1, command: { name: 'x', input: '', type: 'prompt', expansion: 'E' } }, parts: [{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AA==' }] }])
    expect(message?.parts[0]).toEqual({ type: 'text', text: 'E' })
  })

  it('sends the stored expansion of a command file (W10.2-T6: the file is never read again, so a later change does not matter)', () => {
    const command = { name: 'review', input: 'a.ts', type: 'prompt' as const, expansion: 'Review a.ts with the rules of the day.', source: 'project' as const, modelRef: 'mock:agents', allowedTools: ['read_file'] }
    const message: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', metadata: { modelRef: 'mock:echo', startedAt: 1, command }, parts: [{ type: 'text', text: '/review a.ts' }] }
    const [expanded] = applyCommandExpansions([message])
    expect(expanded?.parts).toEqual([{ type: 'text', text: 'Review a.ts with the rules of the day.' }])
    // A `!` line and an `@file` reference stay text for the model.
    const raw = { ...message, metadata: { modelRef: 'mock:echo', startedAt: 1, command: { ...command, expansion: '!rm -rf /\nRead @src/a.ts.' } } }
    expect(applyCommandExpansions([raw])[0]?.parts).toEqual([{ type: 'text', text: '!rm -rf /\nRead @src/a.ts.' }])
  })
})

function user(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] }
}

function assistant(text: string): ModelMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] }
}

describe('token estimate', () => {
  it('counts text by length and attachments by kind', () => {
    expect(estimateMessageTokens(user('a'.repeat(400)))).toBe(104)
    expect(estimateMessageTokens({ role: 'system', content: 'abcd' })).toBe(5)
    const image: ModelMessage = { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array(10) }] }
    expect(estimateMessageTokens(image)).toBe(1604)
    const pdf: ModelMessage = { role: 'user', content: [{ type: 'file', mediaType: 'application/pdf', data: new Uint8Array(320_000) }] }
    expect(estimateMessageTokens(pdf)).toBe(10_004)
    const tool: ModelMessage = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', output: { type: 'json', value: { a: 'b'.repeat(40) } } }] }
    expect(estimateMessageTokens(tool)).toBeGreaterThan(10)
    expect(estimateTokens([user('abcd'), assistant('abcd')], 'abcdefgh')).toBe(12)
  })
})

describe('trimToContext', () => {
  const history: ModelMessage[] = [
    user('a'.repeat(400)),
    assistant('b'.repeat(400)),
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 't', output: { type: 'text', value: 'x' } }] },
    user('c'.repeat(400)),
    assistant('d'.repeat(400)),
    user('last'),
  ]

  it('keeps everything under the budget or without a context window', () => {
    expect(trimToContext(history, null)).toEqual({ messages: history, removed: 0 })
    expect(trimToContext(history, 100_000).removed).toBe(0)
  })

  it('drops whole turns from the start until the estimate fits', () => {
    const total = estimateTokens(history)
    const window = Math.ceil((total - 150) / CONTEXT_BUDGET_RATIO)
    const trimmed = trimToContext(history, window)
    expect(trimmed.removed).toBe(3)
    expect(trimmed.messages[0]).toBe(history[3])
  })

  it('always keeps the last turn', () => {
    const trimmed = trimToContext(history, 10)
    expect(trimmed.messages).toEqual([history[5]])
    expect(trimmed.removed).toBe(5)
    expect(trimToContext([user('x'.repeat(10_000))], 10).removed).toBe(0)
  })

  it('trims down to a lower ratio when asked (the compaction fallback trims to the 0.8 trigger)', () => {
    const total = estimateTokens(history)
    const window = Math.ceil(total / 0.84)
    expect(trimToContext(history, window).removed).toBe(0)
    const trimmed = trimToContext(history, window, undefined, 0.8)
    expect(trimmed.removed).toBe(3)
    expect(estimateTokens(trimmed.messages)).toBeLessThanOrEqual(window * 0.8)
  })

  it('counts the instructions', () => {
    const small: ModelMessage[] = [user('a'.repeat(40)), assistant('b'), user('c')]
    expect(trimToContext(small, 100).removed).toBe(0)
    expect(trimToContext(small, 100, 'i'.repeat(320)).removed).toBe(2)
  })
})

describe('validModelMessages', () => {
  it('accepts model messages and rejects anything else', () => {
    expect(validModelMessages([user('x'), assistant('y')])).toHaveLength(2)
    expect(validModelMessages([{ role: 'nobody' }])).toBeNull()
    expect(validModelMessages('nope')).toBeNull()
  })
})
