import type { HarnessUIMessagePart } from '@harness-forge/shared'
import { describe, expect, it } from 'vitest'
import {
  assistantMessage,
  backgroundTaskId,
  compactionData,
  compactionPart,
  steerData,
  steerPart,
  taskPart,
  taskResultCarrier,
  taskResultData,
  taskResultPart,
  userMessage,
} from '~/utils/testing/fixtures'
import {
  capText,
  firstStringArg,
  formatCost,
  formatDuration,
  formatImageTurn,
  formatToolValue,
  imageFileParts,
  isImageFilePart,
  isServerTruncated,
  isSupersededDenial,
  isTaskResultMessage,
  messageBlocks,
  messageText,
  safeExternalUrl,
  splitMcpToolName,
  taskResultsOf,
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

  it('turns every run of image file parts into one gallery (generated images, docs/UI.md 7.16)', () => {
    const image = (n: number, mediaType = 'image/png') => ({ type: 'file' as const, mediaType, url: `/api/files/file_${n}`, filename: `image-${n}.png` })
    const parts: HarnessUIMessagePart[] = [
      { type: 'step-start' },
      image(1),
      { type: 'step-start' },
      image(2, 'image/webp'),
      { type: 'text', text: 'Here is a PDF too', state: 'done' },
      { type: 'file', mediaType: 'application/pdf', url: '/api/files/file_3', filename: 'a.pdf' },
      image(4),
      { type: 'data-notice', data: { level: 'warning', code: 'generated-file-dropped', message: 'Dropped' } },
      image(5),
      { type: 'reasoning-file', mediaType: 'image/png', url: '/api/files/file_6' },
    ]
    const blocks = messageBlocks(parts)
    expect(blocks.map(block => block.kind)).toEqual(['gallery', 'text', 'file', 'gallery', 'notice', 'gallery', 'file'])
    const galleries = blocks.filter(block => block.kind === 'gallery')
    expect(galleries.map(block => block.parts.map(part => part.url))).toEqual([
      ['/api/files/file_1', '/api/files/file_2'],
      ['/api/files/file_4'],
      ['/api/files/file_5'],
    ])
    // Keys stay stable while more images stream into a gallery.
    expect(galleries[0]!.key).toBe('gallery-1')
    expect(messageBlocks(parts.slice(0, 2))[0]!.key).toBe('gallery-1')
  })

  it('turns compaction markers, steers and task calls into their blocks; activity never renders (Phase 9)', () => {
    const parts: HarnessUIMessagePart[] = [
      { type: 'step-start' },
      { type: 'data-activity', data: { kind: 'compacting' } },
      compactionPart({ trigger: 'auto', keep: 'last-user' }),
      { type: 'text', text: 'Working', state: 'done' },
      steerPart(),
      taskPart(),
      { type: 'tool-web_fetch', toolCallId: 'c2', state: 'output-available', input: { url: 'https://a.example' }, output: 'ok' },
      // Invalid data renders nothing.
      { type: 'data-compaction', data: { trigger: 'manual' } } as unknown as HarnessUIMessagePart,
      { type: 'data-steer', data: { id: 'nope' } } as unknown as HarnessUIMessagePart,
    ]
    const blocks = messageBlocks(parts)
    expect(blocks.map(block => block.kind)).toEqual(['compaction', 'text', 'steer', 'task', 'tool'])
    const [compaction, , steer, task] = blocks
    expect(compaction).toMatchObject({ kind: 'compaction', index: 2, data: compactionData({ trigger: 'auto', keep: 'last-user' }) })
    expect(steer).toMatchObject({ kind: 'steer', index: 4, steer: steerData() })
    expect(task).toMatchObject({ kind: 'task', key: 'task-call_task_1', index: 5 })
    expect(new Set(blocks.map(block => block.key)).size).toBe(blocks.length)
  })

  it('makes a dynamic task call a task block, and splits galleries at rendered agent blocks (Phase 9)', () => {
    const image = (n: number): HarnessUIMessagePart => ({ type: 'file', mediaType: 'image/png', url: `/api/files/file_${n}` })
    const parts: HarnessUIMessagePart[] = [
      image(1),
      { type: 'data-activity', data: { kind: 'idle' } },
      image(2),
      steerPart(),
      image(3),
      compactionPart({ trigger: 'auto' }),
      image(4),
      { type: 'dynamic-tool', toolName: 'task', toolCallId: 'call_task_9', state: 'input-available', input: {} } as HarnessUIMessagePart,
      { type: 'tool-mcp__docs__task', toolCallId: 'c3', state: 'input-available', input: {} } as HarnessUIMessagePart,
    ]
    const blocks = messageBlocks(parts)
    expect(blocks.map(block => block.kind)).toEqual(['gallery', 'steer', 'gallery', 'compaction', 'gallery', 'task', 'tool'])
    expect(blocks[0]).toMatchObject({ parts: [{ url: '/api/files/file_1' }, { url: '/api/files/file_2' }] })
    expect(blocks[5]).toMatchObject({ kind: 'task', key: 'task-call_task_9', index: 7 })
    // Copy and Read aloud take the reply's own text: never a steer or a summary.
    expect(messageText({ parts: [{ type: 'text', text: 'Before', state: 'done' }, steerPart(), compactionPart(), { type: 'text', text: 'After', state: 'done' }] }))
      .toBe('Before\n\nAfter')
  })

  it('finds the image file parts of a message', () => {
    const png = { type: 'file' as const, mediaType: 'IMAGE/PNG', url: '/api/files/file_1' }
    const pdf = { type: 'file' as const, mediaType: 'application/pdf', url: '/api/files/file_2' }
    expect(isImageFilePart(png)).toBe(true)
    expect(isImageFilePart(pdf)).toBe(false)
    expect(isImageFilePart({ type: 'reasoning-file', mediaType: 'image/png', url: '/api/files/file_3' })).toBe(false)
    expect(imageFileParts({ parts: [png, pdf, { type: 'text', text: 'x' }] })).toEqual([png])
  })
})

describe('background agent results (Phase 10)', () => {
  const invalid = { type: 'data-task-result', id: 'x', data: { taskId: 'nope' } } as unknown as HarnessUIMessagePart

  it('turns a valid data-task-result part into a task-result block; invalid data renders nothing', () => {
    const blocks = messageBlocks([
      { type: 'text', text: 'Working', state: 'done' },
      taskResultPart(),
      invalid,
      { type: 'text', text: 'Done', state: 'done' },
    ])
    expect(blocks.map(block => block.kind)).toEqual(['text', 'task-result', 'text'])
    expect(blocks[1]).toMatchObject({ kind: 'task-result', index: 1, part: taskResultData() })
    // A result is never part of the reply's own text (Copy, Read aloud).
    expect(messageText({ parts: [{ type: 'text', text: 'Before', state: 'done' }, taskResultPart()] })).toBe('Before')
  })

  it('collects the delivered results of a path by task id, in path order, the first one winning', () => {
    const second = taskResultData({ taskId: backgroundTaskId(2), toolCallId: 'call_task_2' })
    const duplicate = taskResultData({ deliveredAt: 1_759_000_099_000 })
    const path = [
      userMessage('u1', 'Start two background agents'),
      assistantMessage('a1', 'Started', { parts: [{ type: 'text', text: 'Started', state: 'done' }, taskResultPart(), invalid] }),
      taskResultCarrier('u2', [second, duplicate]),
      assistantMessage('a2', 'Both finished'),
    ]
    const results = taskResultsOf(path)
    expect([...results.keys()]).toEqual([backgroundTaskId(1), backgroundTaskId(2)])
    expect(results.get(backgroundTaskId(1))).toEqual(taskResultData())
    expect(results.get(backgroundTaskId(2))).toEqual(second)
    expect(taskResultsOf([userMessage('u1', 'Hello')]).size).toBe(0)
  })

  it('recognizes the carrier: a user message whose parts are all valid results', () => {
    expect(isTaskResultMessage(taskResultCarrier('u1'))).toBe(true)
    expect(isTaskResultMessage(taskResultCarrier('u1', [taskResultData(), taskResultData({ taskId: backgroundTaskId(2) })]))).toBe(true)
    expect(isTaskResultMessage({ ...taskResultCarrier('u1'), role: 'assistant' })).toBe(false)
    expect(isTaskResultMessage({ role: 'user', parts: [] })).toBe(false)
    expect(isTaskResultMessage({ role: 'user', parts: [taskResultPart(), { type: 'text', text: 'and more' }] })).toBe(false)
    expect(isTaskResultMessage({ role: 'user', parts: [invalid] })).toBe(false)
    expect(isTaskResultMessage(userMessage('u2', 'Hello'))).toBe(false)
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

  it('describes an image turn for the meta hover', () => {
    expect(formatImageTurn({ n: 2, aspectRatio: '16:9', inputs: 1 })).toBe('2 images · 16:9 · edited 1 image')
    expect(formatImageTurn({ n: 1 })).toBe('1 image')
    expect(formatImageTurn({ n: 4, inputs: 0 })).toBe('4 images')
    expect(formatImageTurn({ n: 1, aspectRatio: '1:1', inputs: 3 })).toBe('1 image · 1:1 · edited 3 images')
  })

  it('joins text parts for copying', () => {
    expect(messageText({ parts: [{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'r' }, { type: 'text', text: 'b' }] })).toBe('a\n\nb')
    expect(messageText({ parts: [{ type: 'file', mediaType: 'image/png', url: '/api/files/file_1' }] })).toBe('')
  })

  it('accepts only http(s) URLs as external links', () => {
    expect(safeExternalUrl('https://example.com/a')).toBe('https://example.com/a')
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull()
    expect(safeExternalUrl('/relative')).toBeNull()
  })
})
