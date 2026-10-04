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
      { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: '/api/share/t/files/f' },
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
    expect(blocks[5]).toMatchObject({ part: { type: 'file', mediaType: 'application/pdf', filename: 'spec.pdf', url: '/api/share/t/files/f' } })
    expect(new Set(blocks.map(block => block.key)).size).toBe(blocks.length)
  })

  it('turns every run of consecutive images into one gallery; other files stay chips', () => {
    const image = (id: string) => ({ type: 'file' as const, mediaType: 'image/png', filename: `${id}.png`, url: `/api/share/t/files/${id}` })
    const blocks = shareMessageBlocks([
      image('a'),
      image('b'),
      { type: 'text', text: 'Here they are.' },
      { type: 'tool', toolName: 'generate_image', status: 'done' },
      image('c'),
      { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/share/t/files/n' },
      { type: 'file', mediaType: 'IMAGE/JPEG', url: '/api/share/t/files/d' },
    ])
    expect(blocks.map(block => block.kind)).toEqual(['gallery', 'text', 'tool', 'gallery', 'file', 'gallery'])
    expect(blocks[0]).toEqual({
      kind: 'gallery',
      key: 'gallery-0',
      parts: [
        { type: 'file', mediaType: 'image/png', filename: 'a.png', url: '/api/share/t/files/a' },
        { type: 'file', mediaType: 'image/png', filename: 'b.png', url: '/api/share/t/files/b' },
      ],
    })
    expect(blocks[3]).toMatchObject({ parts: [{ url: '/api/share/t/files/c' }] })
    expect(blocks[4]).toMatchObject({ kind: 'file', part: { filename: 'notes.txt' } })
    expect(blocks[5]).toMatchObject({ parts: [{ type: 'file', mediaType: 'IMAGE/JPEG', url: '/api/share/t/files/d' }] })
    expect(new Set(blocks.map(block => block.key)).size).toBe(blocks.length)
  })

  it('routes the agent tools to tool rows like any tool (Phase 9)', () => {
    const blocks = shareMessageBlocks([
      { type: 'tool', toolName: 'todo_write', status: 'done' },
      { type: 'text', text: 'Exploring first.' },
      { type: 'tool', toolName: 'task', status: 'done', input: { description: 'Find the session code', prompt: 'List files.', type: 'explore' } },
      { type: 'tool', toolName: 'task', status: 'stopped' },
      { type: 'tool', toolName: 'exit_plan_mode', status: 'denied' },
    ])
    expect(blocks.map(block => [block.kind, block.kind === 'tool' ? block.part.toolName : null])).toEqual([
      ['tool', 'todo_write'],
      ['text', null],
      ['tool', 'task'],
      ['tool', 'task'],
      ['tool', 'exit_plan_mode'],
    ])
    expect(new Set(blocks.map(block => block.key)).size).toBe(blocks.length)
  })

  it('routes skill calls and custom or background sub-agents to tool rows; task results never arrive (Phase 10)', () => {
    const blocks = shareMessageBlocks([
      { type: 'tool', toolName: 'skill', status: 'done' },
      { type: 'tool', toolName: 'skill', status: 'done', input: { name: 'release-notes' } },
      { type: 'tool', toolName: 'task', status: 'done', input: { description: 'Review the diff', prompt: 'Review.', type: 'reviewer', background: true } },
      { type: 'text', text: 'Done.' },
    ])
    expect(blocks.map(block => [block.kind, block.kind === 'tool' ? block.part.toolName : null])).toEqual([
      ['tool', 'skill'],
      ['tool', 'skill'],
      ['tool', 'task'],
      ['text', null],
    ])
    // The server drops data-task-result parts (and a carrier holding only them); a stray part is not a snapshot part.
    const stray = shareMessageBlocks([{ type: 'data-task-result', data: {} } as never, { type: 'text', text: 'Hi' }])
    expect(stray.map(block => block.kind)).toEqual(['text'])
  })

  it('keeps only the command name of a shared user message: the badge shows no source, model or tools (Phase 10)', () => {
    const message = toUserMessage({ role: 'user', command: { name: 'review' }, parts: [{ type: 'text', text: 'src/auth.ts' }] }, 'share-message-4')
    expect(message.metadata?.command).toEqual({ name: 'review' })
  })

  it('builds a plain user bubble from a steer the server split out of a reply (Phase 9)', () => {
    const message = toUserMessage({
      role: 'user',
      parts: [
        { type: 'text', text: 'Use the vitest filter instead' },
        { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/share/t/files/n' },
      ],
    }, 'share-message-2')
    expect(message).toEqual({
      id: 'share-message-2',
      role: 'user',
      parts: [
        { type: 'text', text: 'Use the vitest filter instead', state: 'done' },
        { type: 'file', mediaType: 'text/plain', filename: 'notes.txt', url: '/api/share/t/files/n' },
      ],
    })
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
