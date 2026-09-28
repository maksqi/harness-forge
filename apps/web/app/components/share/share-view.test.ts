import { HarnessError } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { isShareToken, modelIdOf, shareMessageBlocks, sharePageErrorMessage, toUserMessage } from './share-view'
import { OTHER_TOKEN, TOKEN } from './testing'

describe('share view helpers', () => {
  it('accepts only tokens in the documented format', () => {
    expect(isShareToken(TOKEN)).toBe(true)
    expect(isShareToken(OTHER_TOKEN)).toBe(true)
    expect(isShareToken('')).toBe(false)
    expect(isShareToken(TOKEN.slice(1))).toBe(false)
    expect(isShareToken(`${TOKEN}x`)).toBe(false)
    expect(isShareToken(`../${TOKEN.slice(3)}`)).toBe(false)
  })

  it('turns snapshot parts into blocks in order, merging consecutive sources only', () => {
    const blocks = shareMessageBlocks([
      { type: 'reasoning', text: 'plan' },
      { type: 'text', text: 'Hello' },
      { type: 'source-url', sourceId: 'a', url: 'https://a.example', title: 'A' },
      { type: 'source-document', sourceId: 'b', title: 'B', mediaType: 'text/plain', filename: 'b.txt' },
      { type: 'tool', toolName: 'web_fetch', status: 'done' },
      { type: 'source-url', sourceId: 'c', url: 'https://c.example' },
      { type: 'file', mediaType: 'image/png', url: '/api/share/t/files/f' },
    ])
    expect(blocks.map(block => block.kind)).toEqual(['reasoning', 'text', 'sources', 'tool', 'sources', 'file'])
    expect(blocks[0]).toMatchObject({ part: { type: 'reasoning', text: 'plan', state: 'done' } })
    expect(blocks[1]).toMatchObject({ part: { type: 'text', text: 'Hello', state: 'done' } })
    expect(blocks[2]).toMatchObject({
      parts: [
        { type: 'source-url', sourceId: 'a', url: 'https://a.example', title: 'A' },
        { type: 'source-document', sourceId: 'b', title: 'B', mediaType: 'text/plain', filename: 'b.txt' },
      ],
    })
    expect(blocks[4]).toMatchObject({ parts: [{ type: 'source-url', sourceId: 'c', url: 'https://c.example' }] })
    expect(blocks[5]).toMatchObject({ part: { type: 'file', mediaType: 'image/png', url: '/api/share/t/files/f' } })
    expect(new Set(blocks.map(block => block.key)).size).toBe(blocks.length)
  })

  it('builds the user message the bubble reads: text, files and the command name', () => {
    const message = toUserMessage({
      role: 'user',
      command: { name: 'review' },
      parts: [
        { type: 'text', text: 'Look' },
        { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: '/api/share/t/files/f' },
        { type: 'source-url', sourceId: 'x', url: 'https://x.example' },
      ],
    }, 'share-message-0')
    expect(message).toEqual({
      id: 'share-message-0',
      role: 'user',
      parts: [
        { type: 'text', text: 'Look', state: 'done' },
        { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: '/api/share/t/files/f' },
      ],
      metadata: { command: { name: 'review' } },
    })
    expect(toUserMessage({ role: 'user', parts: [] }, 'id').metadata).toBeUndefined()
  })

  it('shows the model id of a model ref, split on the first colon', () => {
    expect(modelIdOf('anthropic:claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(modelIdOf('ollama:llama3:8b')).toBe('llama3:8b')
    expect(modelIdOf('openrouter:anthropic/claude-sonnet-5')).toBe('anthropic/claude-sonnet-5')
    expect(modelIdOf('no-colon')).toBe('no-colon')
  })

  it('says how long to wait on a rate limit, else shows the server message', () => {
    expect(sharePageErrorMessage(new HarnessError({ code: 'rate_limited', message: 'Slow down.', retryAfterMs: 30_000 }))).toBe('Too many requests. Try again in 30s.')
    expect(sharePageErrorMessage(new HarnessError({ code: 'rate_limited', message: 'Slow down.' }))).toBe('Too many requests. Try again in 1s.')
    expect(sharePageErrorMessage(new HarnessError({ code: 'internal_error', message: 'Broken.' }))).toBe('Broken.')
  })
})
