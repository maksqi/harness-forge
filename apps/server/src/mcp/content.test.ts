// MCP content as text (W14.2-T6) and the frozen prompt expansion (W14.2-T3, ADR-061): text items as they are, embedded
// text resources as `<resource>` blocks, one-line placeholders for images, audio, blobs and links, JSON for anything
// else; the expansion joins user-only text, wraps every message when an assistant message is present and is cut at
// 64 KB.
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import { base64ByteLength, EXPANSION_CUT_NOTE, mcpContentText, mcpPromptExpansion } from './content.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4]).toString('base64')

describe('mcpContentText', () => {
  it('answers a text item as it is and caps it', () => {
    expect(mcpContentText({ type: 'text', text: 'hi\nthere' })).toBe('hi\nthere')
    expect(mcpContentText({ type: 'text', text: 'abcdef' }, { maxChars: 3 })).toBe('abc...')
  })

  it('turns an embedded text resource into a <resource> block with escaped attributes', () => {
    expect(mcpContentText({ type: 'resource', resource: { uri: 'fixture://notes/readme.md', mimeType: 'text/markdown', text: '# Notes\nHello' } }))
      .toBe('<resource uri="fixture://notes/readme.md" mimeType="text/markdown">\n# Notes\nHello\n</resource>')
    expect(mcpContentText({ type: 'resource', resource: { uri: 'x://a"b<c>&\nd', text: 't' } }))
      .toBe('<resource uri="x://a&quot;b&lt;c&gt;&amp; d">\nt\n</resource>')
  })

  it('caps a resource block but keeps its closing tag', () => {
    const text = mcpContentText({ type: 'resource', resource: { uri: 'u:1', text: 'x'.repeat(500) } }, { maxChars: 100 })
    expect(text).toHaveLength(100)
    expect(text.startsWith('<resource uri="u:1">\n')).toBe(true)
    expect(text.endsWith('...\n</resource>')).toBe(true)
  })

  it('turns images, audio, blobs and links into one-line placeholders', () => {
    expect(mcpContentText({ type: 'image', data: PNG, mimeType: 'image/png' })).toBe('[Image: image/png, 12 bytes]')
    expect(mcpContentText({ type: 'audio', data: Buffer.alloc(2048).toString('base64'), mimeType: 'audio/wav' })).toBe('[Audio: audio/wav, 2.0 KB]')
    expect(mcpContentText({ type: 'resource', resource: { uri: 'fixture://images/pixel.png', mimeType: 'image/png', blob: PNG } }))
      .toBe('[Binary resource: fixture://images/pixel.png (image/png, 12 bytes)]')
    expect(mcpContentText({ type: 'resource_link', uri: 'file:///a', name: 'a' })).toBe('[Resource link: a <file:///a>]')
    expect(mcpContentText({ type: 'resource_link', uri: 'repo://o/n/README.md', name: 'README.md', title: 'Read\nme', mimeType: 'text/markdown', description: 'The readme.\nSecond line.' }))
      .toBe('[Resource link: Read me <repo://o/n/README.md> (text/markdown) - The readme. Second line.]')
    expect(mcpContentText({ type: 'resource_link', uri: 'file:///b', name: 'file:///b' })).toBe('[Resource link: file:///b]')
    for (const text of [mcpContentText({ type: 'resource_link', uri: 'u:x', name: 'n\u2028m', description: 'd'.repeat(1000) })])
      expect(text).not.toMatch(/[\n\r\u2028]/)
  })

  it('keeps JSON for anything else and never throws', () => {
    expect(mcpContentText({ type: 'chart', points: [1, 2] })).toBe('{"type":"chart","points":[1,2]}')
    expect(mcpContentText({ type: 'resource', resource: { uri: 'u:1' } })).toBe('{"type":"resource","resource":{"uri":"u:1"}}')
    expect(mcpContentText(undefined)).toBe('undefined')
    const cyclic: Record<string, unknown> = { type: 'x' }
    cyclic.self = cyclic
    expect(mcpContentText(cyclic)).toBe('[object Object]')
    const hostile = { get type(): string {
      throw new Error('boom')
    } }
    expect(mcpContentText(hostile)).toBe('[Unreadable MCP content]')
  })

  it('base64ByteLength counts the decoded bytes', () => {
    expect(base64ByteLength(PNG)).toBe(12)
    expect(base64ByteLength('aGk=')).toBe(2)
    expect(base64ByteLength('')).toBe(0)
  })
})

describe('mcpPromptExpansion', () => {
  it('joins the text of user-only messages with blank lines', () => {
    expect(mcpPromptExpansion({ messages: [{ role: 'user', content: { type: 'text', text: 'Hello, Ada!' } }] })).toBe('Hello, Ada!')
    expect(mcpPromptExpansion({ messages: [
      { role: 'user', content: { type: 'text', text: 'Read this:' } },
      { role: 'user', content: { type: 'resource', resource: { uri: 'fixture://notes/readme.md', mimeType: 'text/markdown', text: 'Notes' } } },
      { role: 'user', content: { type: 'image', data: PNG, mimeType: 'image/png' } },
    ] })).toBe('Read this:\n\n<resource uri="fixture://notes/readme.md" mimeType="text/markdown">\nNotes\n</resource>\n\n[Image: image/png, 12 bytes]')
  })

  it('wraps every message as <prompt-message role> when an assistant message is present', () => {
    expect(mcpPromptExpansion({ messages: [
      { role: 'assistant', content: { type: 'text', text: 'I review code.' } },
      { role: 'user', content: { type: 'text', text: 'Review it.' } },
    ] })).toBe('<prompt-message role="assistant">\nI review code.\n</prompt-message>\n\n<prompt-message role="user">\nReview it.\n</prompt-message>')
  })

  it('cuts an expansion above the byte cap and ends it with the note', () => {
    const big = mcpPromptExpansion({ messages: [{ role: 'user', content: { type: 'text', text: 'é'.repeat(LIMITS.commandExpansionBytes) } }] })
    expect(Buffer.byteLength(big, 'utf8')).toBeLessThanOrEqual(LIMITS.commandExpansionBytes)
    expect(big.endsWith(`\n\n${EXPANSION_CUT_NOTE}`)).toBe(true)
    expect(big).not.toContain('\uFFFD')
    const small = mcpPromptExpansion({ messages: [{ role: 'user', content: { type: 'text', text: 'x'.repeat(200) } }] }, { maxBytes: 120 })
    expect(Buffer.byteLength(small, 'utf8')).toBeLessThanOrEqual(120)
    expect(small.startsWith('xxx')).toBe(true)
  })

  it('answers an empty string without readable messages and never throws', () => {
    expect(mcpPromptExpansion({ messages: [] })).toBe('')
    expect(mcpPromptExpansion(null)).toBe('')
    expect(mcpPromptExpansion({ messages: 'nope' })).toBe('')
    expect(mcpPromptExpansion({ messages: [{ role: 'user', content: { type: 'text', text: '' } }] })).toBe('')
  })
})
