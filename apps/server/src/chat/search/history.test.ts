// The history stage of web search (W14.4-T5): provider-executed parts stay in replies of the current provider and leave
// the replies of other providers (or of an unknown provider); function tool parts and every other part stay; the input
// is never changed.
import type { HarnessUIMessage, HarnessUIMessagePart } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { stripForeignProviderParts } from './history.ts'

const user: HarnessUIMessage = { id: 'msg_u000000000000001', role: 'user', parts: [{ type: 'text', text: 'search cats' }] }

/** A provider-executed native search part with its (encrypted) results. */
function nativePart(id = 'srvtoolu_1'): HarnessUIMessagePart {
  return {
    type: 'tool-web_search',
    toolCallId: id,
    state: 'output-available',
    input: { query: 'cats' },
    output: [{ type: 'web_search_result', url: 'https://example.com/cats', title: 'Cats', encryptedContent: 'opaque' }],
    providerExecuted: true,
  } as HarnessUIMessagePart
}

/** A provider's dynamic server-tool part (e.g. Google's `server:*` calls), also provider-executed. */
function dynamicNativePart(): HarnessUIMessagePart {
  return { type: 'dynamic-tool', toolName: 'server:code_execution', toolCallId: 'srv_2', state: 'output-available', input: {}, output: {}, providerExecuted: true } as HarnessUIMessagePart
}

/** A function tool part (the builtin `search_web`), executed by the harness. */
function functionPart(): HarnessUIMessagePart {
  return { type: 'tool-search_web', toolCallId: 'call_1', state: 'output-available', input: { query: 'cats' }, output: { query: 'cats', backend: 'brave', results: [] } } as HarnessUIMessagePart
}

function reply(modelRef: string | undefined, parts: HarnessUIMessagePart[], id = 'msg_a000000000000001'): HarnessUIMessage {
  return {
    id,
    role: 'assistant',
    ...(modelRef === undefined ? {} : { metadata: { modelRef, startedAt: 1 } }),
    parts,
  } as HarnessUIMessage
}

function replyParts(): HarnessUIMessagePart[] {
  return [
    { type: 'step-start' },
    nativePart(),
    dynamicNativePart(),
    functionPart(),
    { type: 'source-url', sourceId: 'src_1', url: 'https://example.com/cats', title: 'Cats' },
    { type: 'reasoning', text: 'thinking', providerMetadata: { anthropic: { signature: 'sig' } } },
    { type: 'text', text: 'Cats are great.' },
  ] as HarnessUIMessagePart[]
}

describe('stripForeignProviderParts', () => {
  it('keeps the provider-executed parts of the current provider\'s replies (the same message object)', () => {
    const own = reply('anthropic:claude-sonnet-5', replyParts())
    const messages = [user, own]
    const result = stripForeignProviderParts(messages, 'anthropic')
    expect(result).toEqual(messages)
    expect(result).not.toBe(messages)
    expect(result[0]).toBe(user)
    expect(result[1]).toBe(own)
  })

  it('removes them from another provider\'s reply; function tool parts and every other part stay', () => {
    const foreign = reply('anthropic:claude-sonnet-5', replyParts())
    const snapshot = structuredClone(foreign)
    const [, stripped] = stripForeignProviderParts([user, foreign], 'openai')
    expect(stripped).not.toBe(foreign)
    expect(stripped?.parts.map(part => part.type)).toEqual(['step-start', 'tool-search_web', 'source-url', 'reasoning', 'text'])
    expect(stripped?.metadata).toEqual(foreign.metadata)
    expect(stripped?.id).toBe(foreign.id)
    // The stored transcript is never changed.
    expect(foreign).toEqual(snapshot)
  })

  it('splits the model ref on the first colon (a model id with colons) and never matches a prefix', () => {
    const ollama = reply('ollama:llama3:8b', [nativePart(), { type: 'text', text: 'x' }] as HarnessUIMessagePart[])
    expect(stripForeignProviderParts([ollama], 'ollama')[0]).toBe(ollama)
    expect(stripForeignProviderParts([ollama], 'llama3')[0]?.parts.map(part => part.type)).toEqual(['text'])
    const openrouter = reply('openrouter:anthropic/claude-sonnet-5', [nativePart()])
    expect(stripForeignProviderParts([openrouter], 'anthropic')[0]?.parts).toEqual([])
    expect(stripForeignProviderParts([openrouter], 'openrouter')[0]).toBe(openrouter)
  })

  it('removes them when the reply\'s provider is unknown (no metadata, no model ref, a ref without a colon)', () => {
    for (const message of [reply(undefined, [nativePart()]), reply('', [nativePart()]), reply('anthropic', [nativePart()]), reply(':model', [nativePart()])])
      expect(stripForeignProviderParts([message], 'anthropic')[0]?.parts, JSON.stringify(message.metadata ?? null)).toEqual([])
  })

  it('passes messages without provider-executed parts through as they are, user messages included', () => {
    const plain = reply('anthropic:claude-sonnet-5', [functionPart(), { type: 'text', text: 'done' }] as HarnessUIMessagePart[])
    const odd = { ...user, parts: [{ ...nativePart(), providerExecuted: true }] } as HarnessUIMessage
    const notExecuted = reply('anthropic:claude-sonnet-5', [{ ...nativePart(), providerExecuted: false } as HarnessUIMessagePart])
    const result = stripForeignProviderParts([plain, odd, notExecuted], 'openai')
    expect(result[0]).toBe(plain)
    expect(result[1]).toBe(odd)
    expect(result[2]).toBe(notExecuted)
  })

  it('handles several replies of different providers in one history', () => {
    const first = reply('anthropic:claude-sonnet-5', [nativePart('a'), { type: 'text', text: 'one' }] as HarnessUIMessagePart[], 'msg_a000000000000001')
    const second = reply('openai:gpt-6-sol', [nativePart('b'), { type: 'text', text: 'two' }] as HarnessUIMessagePart[], 'msg_a000000000000002')
    const result = stripForeignProviderParts([user, first, user, second], 'anthropic')
    expect(result[1]).toBe(first)
    expect(result[3]?.parts.map(part => part.type)).toEqual(['text'])
    expect(stripForeignProviderParts([], 'anthropic')).toEqual([])
  })
})
