import type { HarnessUIMessagePart } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  capText,
  firstStringArg,
  formatCost,
  formatDuration,
  formatToolValue,
  isServerTruncated,
  isSupersededDenial,
  messageBlocks,
  messageText,
  safeExternalUrl,
  splitMcpToolName,
  TOOL_BODY_PREVIEW_CHARS,
  toolNameOf,
} from './chat-format'

describe('messageBlocks', () => {
  it('keeps part order, merges consecutive sources and skips invisible parts', () => {
    const parts: HarnessUIMessagePart[] = [
      { type: 'step-start' },
      { type: 'reasoning', text: 'hmm', state: 'done' },
      { type: 'tool-web_fetch', toolCallId: 'c1', state: 'output-available', input: { url: 'https://a.example' }, output: 'ok' },
      { type: 'source-url', sourceId: 's1', url: 'https://a.example' },
      { type: 'source-document', sourceId: 's2', mediaType: 'application/pdf', title: 'Doc' },
      { type: 'text', text: 'Answer', state: 'done' },
      { type: 'source-url', sourceId: 's3', url: 'https://b.example' },
      { type: 'data-notice', data: { level: 'info', code: 'context-trimmed', message: 'Trimmed' } },
      { type: 'custom', kind: 'x.y' },
    ]
    const blocks = messageBlocks(parts)
    expect(blocks.map(block => block.kind)).toEqual(['reasoning', 'tool', 'sources', 'text', 'sources', 'notice'])
    const firstSources = blocks[2]!
    expect(firstSources.kind === 'sources' && firstSources.parts.map(part => part.sourceId)).toEqual(['s1', 's2'])
    expect(blocks[1]!.key).toBe('tool-c1')
  })
})

describe('tool helpers', () => {
  it('reads static and dynamic tool names and splits MCP names', () => {
    expect(toolNameOf({ type: 'tool-web_fetch', toolCallId: 'c', state: 'input-available', input: {} })).toBe('web_fetch')
    expect(toolNameOf({ type: 'dynamic-tool', toolName: 'mcp__docs__search', toolCallId: 'c', state: 'input-available', input: {} })).toBe('mcp__docs__search')
    expect(splitMcpToolName('mcp__docs__search_pages')).toEqual({ serverId: 'docs', tool: 'search_pages' })
    expect(splitMcpToolName('web_fetch')).toBeNull()
  })

  it('finds the first string argument on one line, capped at 60 characters', () => {
    expect(firstStringArg({ count: 3, query: 'nuxt 4\nsessions' })).toBe('nuxt 4 sessions')
    expect(firstStringArg({ nested: { deep: ['x'] } })).toBe('x')
    expect(firstStringArg({ n: 1 })).toBeNull()
    const long = firstStringArg({ text: 'a'.repeat(100) })!
    expect(long).toHaveLength(60)
    expect(long.endsWith('…')).toBe(true)
  })

  it('formats values and caps them at 4 KB', () => {
    expect(formatToolValue('plain')).toBe('plain')
    expect(formatToolValue({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(formatToolValue(undefined)).toBe('')
    const capped = capText('x'.repeat(TOOL_BODY_PREVIEW_CHARS + 10), TOOL_BODY_PREVIEW_CHARS)
    expect(capped.text).toHaveLength(TOOL_BODY_PREVIEW_CHARS)
    expect(capped.truncated).toBe(true)
    expect(capText('short', TOOL_BODY_PREVIEW_CHARS)).toEqual({ text: 'short', truncated: false })
  })

  it('recognizes server truncation markers and superseded denials', () => {
    expect(isServerTruncated('data…[truncated]')).toBe(true)
    expect(isServerTruncated('data [truncated 12 KB]')).toBe(true)
    expect(isServerTruncated({ truncated: true, value: 'x' })).toBe(true)
    expect(isServerTruncated('complete output')).toBe(false)
    expect(isSupersededDenial({
      type: 'tool-x',
      toolCallId: 'c',
      state: 'output-denied',
      input: {},
      approval: { id: 'a', approved: false, reason: 'superseded' },
    })).toBe(true)
  })
})

describe('formatting', () => {
  it('formats durations', () => {
    expect(formatDuration(400)).toBe('0.4s')
    expect(formatDuration(14_200)).toBe('14s')
    expect(formatDuration(125_000)).toBe('2m 5s')
    expect(formatDuration(3_780_000)).toBe('1h 3m')
    expect(formatDuration(undefined)).toBe('')
  })

  it('formats costs', () => {
    expect(formatCost(0.004)).toBe('$0.004')
    expect(formatCost(0.1234)).toBe('$0.12')
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(0.0001)).toBe('<$0.001')
    expect(formatCost(null)).toBe('')
  })

  it('joins text parts for copying', () => {
    expect(messageText({ parts: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }] })).toBe('a\n\nb')
  })

  it('accepts only http(s) URLs as external links', () => {
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('/relative')).toBeNull()
  })
})
