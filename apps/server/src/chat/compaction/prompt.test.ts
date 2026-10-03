// The compaction prompt (W9.1-T4): the instructions (marker, sections, focus line) and the text transcript (caps, the
// middle cut, no tool-call / tool-result model parts).
import type { ModelMessage } from 'ai'
import { describe, expect, it } from 'vitest'
import { COMPACT_INSTRUCTIONS_MARKER } from '../markers.ts'
import {
  capText,
  compactionInstructions,
  cutMiddle,
  renderTranscript,
  TRANSCRIPT_BLOCK_MIN_CHARS,
  TRANSCRIPT_TOOL_ARGS_MAX_CHARS,
  TRANSCRIPT_TOOL_RESULT_MAX_CHARS,
} from './prompt.ts'

const FOCUS_LINE = /^Focus: (.*)$/m

describe('compactionInstructions', () => {
  it('carries the marker and the Claude Code-style sections, without a focus line by default', () => {
    const text = compactionInstructions(null)
    expect(text.startsWith(COMPACT_INSTRUCTIONS_MARKER)).toBe(true)
    for (const heading of ['Request and intent', 'Files and code', 'Errors and fixes', 'User messages', 'Pending tasks', 'Current work', 'Next step'])
      expect(text).toContain(heading)
    expect(text).not.toMatch(FOCUS_LINE)
    expect(compactionInstructions('   ')).not.toMatch(FOCUS_LINE)
  })

  it('states the focus on its own line, whitespace collapsed', () => {
    expect(compactionInstructions('keep numbers').match(FOCUS_LINE)?.[1]).toBe('keep numbers')
    expect(compactionInstructions('  the API\n\n  and  errors ').match(FOCUS_LINE)?.[1]).toBe('the API and errors')
  })
})

describe('capText / cutMiddle', () => {
  it('cuts long text with a note and never splits a surrogate pair', () => {
    expect(capText('short', 10)).toBe('short')
    const capped = capText('x'.repeat(5000), 2000)
    expect(capped.length).toBeLessThanOrEqual(2000)
    expect(capped).toContain('5000 characters in all')
    const emoji = '\u{1F600}'.repeat(1000)
    const cut = capText(emoji, 1001)
    expect(cut.length).toBeLessThanOrEqual(1001)
    expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('keeps the start and the end of a long text', () => {
    const text = `HEAD ${'m'.repeat(3000)} TAIL`
    const cut = cutMiddle(text, 500)
    expect(cut.length).toBeLessThanOrEqual(500)
    expect(cut.startsWith('HEAD')).toBe(true)
    expect(cut.endsWith('TAIL')).toBe(true)
    expect(cutMiddle('abc', 2)).toBe('ab')
  })
})

const toolTurn: ModelMessage[] = [
  { role: 'user', content: 'list the files OLD-1' },
  {
    role: 'assistant',
    content: [
      { type: 'reasoning', text: 'secret thoughts' },
      { type: 'text', text: 'Let me look.' },
      { type: 'tool-call', toolCallId: 'c1', toolName: 'list_directory', input: { path: '.', note: 'a'.repeat(2000) } },
    ],
  },
  {
    role: 'tool',
    content: [
      { type: 'tool-result', toolCallId: 'c1', toolName: 'list_directory', output: { type: 'text', value: `files: ${'f'.repeat(5000)}` } },
    ],
  },
  { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] },
]

describe('renderTranscript', () => {
  it('renders one text block per message, tool calls and results as capped text, reasoning dropped', () => {
    const text = renderTranscript(toolTurn, 1_000_000)
    expect(text.startsWith('User:\nlist the files OLD-1')).toBe(true)
    expect(text).toContain('Assistant:\nLet me look.\n[tool list_directory({"path":".","note":"')
    expect(text).toContain('Tool results:\n[result of list_directory: files: ')
    expect(text).not.toContain('secret thoughts')
    const call = text.match(/\[tool list_directory\((.*)\)\]/)?.[1] ?? ''
    expect(call.length).toBeLessThanOrEqual(TRANSCRIPT_TOOL_ARGS_MAX_CHARS)
    const result = text.match(/\[result of list_directory: ([^\]]*)/)?.[1] ?? ''
    expect(result.length).toBeLessThanOrEqual(TRANSCRIPT_TOOL_RESULT_MAX_CHARS)
    expect(text.endsWith('Assistant:\nDone.')).toBe(true)
  })

  it('renders files as [file …], errors, denials and JSON outputs as text', () => {
    const messages: ModelMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', image: new Uint8Array([1, 2, 3]), mediaType: 'image/png' },
          { type: 'file', data: new Uint8Array([1]), mediaType: 'application/pdf', filename: 'spec.pdf' },
        ],
      },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'a', input: {} }, { type: 'tool-call', toolCallId: 'c2', toolName: 'b', input: {} }, { type: 'tool-call', toolCallId: 'c3', toolName: 'c', input: {} }] },
      {
        role: 'tool',
        content: [
          { type: 'tool-result', toolCallId: 'c1', toolName: 'a', output: { type: 'error-text', value: 'boom' } },
          { type: 'tool-result', toolCallId: 'c2', toolName: 'b', output: { type: 'execution-denied', reason: 'not now' } },
          { type: 'tool-result', toolCallId: 'c3', toolName: 'c', output: { type: 'json', value: { ok: true } } },
          { type: 'tool-approval-response', approvalId: 'x', approved: true },
        ],
      },
    ]
    const text = renderTranscript(messages, 100_000)
    expect(text).toContain('look\n[file image/png]\n[file spec.pdf (application/pdf)]')
    expect(text).toContain('[error of a: boom]')
    expect(text).toContain('[result of b: denied: not now]')
    expect(text).toContain('[result of c: {"ok":true}]')
    expect(text).not.toContain('approval')
    // Nothing of the input survives as a model part: the transcript is one string.
    expect(typeof text).toBe('string')
  })

  it('shortens the long middle blocks first, keeping the start of each one', () => {
    const steps: ModelMessage[] = [{ role: 'user', content: 'MOCK-SUMMARY: earlier | steps-done=3' }]
    for (let step = 4; step <= 9; step++)
      steps.push({ role: 'assistant', content: [{ type: 'text', text: `Step ${step} done. ${'filler '.repeat(150)}` }] })
    steps.push({ role: 'user', content: 'newest message' })
    const full = renderTranscript(steps, 1_000_000)
    const budget = Math.floor(full.length * 0.6)
    const text = renderTranscript(steps, budget)
    expect(text.length).toBeLessThanOrEqual(budget)
    expect(text.startsWith('User:\nMOCK-SUMMARY: earlier | steps-done=3')).toBe(true)
    expect(text.endsWith('User:\nnewest message')).toBe(true)
    for (let step = 4; step <= 9; step++)
      expect(text).toContain(`Step ${step} done.`)
  })

  it('leaves out the oldest middle blocks when shortening is not enough (the head and the newest stay)', () => {
    const messages: ModelMessage[] = [{ role: 'user', content: `HEAD-SUMMARY ${'h'.repeat(200)}` }]
    for (let index = 1; index <= 40; index++)
      messages.push({ role: index % 2 === 0 ? 'user' : 'assistant', content: `block-${index} ${'x'.repeat(1000)}` })
    const budget = TRANSCRIPT_BLOCK_MIN_CHARS * 10
    const text = renderTranscript(messages, budget)
    expect(text.length).toBeLessThanOrEqual(budget)
    expect(text).toContain('HEAD-SUMMARY')
    expect(text).toContain('block-40')
    expect(text).toMatch(/\[… \d+ earlier messages left out …\]/)
    expect(text).not.toContain('block-1 ')
  })

  it('fits the head and the newest block into a tiny budget', () => {
    const text = renderTranscript([{ role: 'user', content: `A${'a'.repeat(5000)}` }, { role: 'assistant', content: `B${'b'.repeat(5000)}` }], 1000)
    expect(text.length).toBeLessThanOrEqual(1000)
    expect(text.startsWith('User:\nA')).toBe(true)
    expect(text.endsWith('b')).toBe(true)
    expect(renderTranscript([], 100)).toBe('')
  })
})
