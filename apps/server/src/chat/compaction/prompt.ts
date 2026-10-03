// The compaction prompt (Phase 9, ADR-040, ARCHITECTURE.md 6.18). Signatures FROZEN after P9-0b (C26).
//
// `compactionInstructions(focus)`: the summarizer instructions, containing `COMPACT_INSTRUCTIONS_MARKER`
// (`chat/markers.ts`; the mock models read it) and Claude Code-style sections (request and intent, files and code,
// errors and fixes, every user message, pending tasks, current work, next step) plus the focus on its own `Focus: …`
// line when set (whitespace collapsed; `mock:compact` reads that line).
// `renderTranscript(messages, budgetChars)`: the model messages as one text transcript, so the summarizer never gets
// tool content without tool definitions: a block per message (`User:` / `Assistant:` / `Tool results:`), tool calls as
// `[tool name(args ≤ 500 characters)]`, results cut at 2,000 characters, files and images as `[file …]`, reasoning and
// approval bookkeeping dropped. Above `budgetChars` the long blocks between the first and the last one are shortened
// first (each keeps its start and end), then whole blocks are left out of the middle: the head (the first block, which
// holds an earlier summary) and the newest blocks stay.
import type { ModelMessage } from 'ai'
import { COMPACT_INSTRUCTIONS_MARKER } from '../markers.ts'

/** Characters of a tool call's input in the transcript. */
export const TRANSCRIPT_TOOL_ARGS_MAX_CHARS = 500
/** Characters of a tool result in the transcript. */
export const TRANSCRIPT_TOOL_RESULT_MAX_CHARS = 2000
/** The shortest a middle block is shortened to before blocks are left out. */
export const TRANSCRIPT_BLOCK_MIN_CHARS = 300
/** Share of the budget the head block may keep when the middle is left out. */
const HEAD_SHARE = 0.4
const BLOCK_SEPARATOR = '\n\n'

/** The instructions of the summarizer call (see the module comment). */
export function compactionInstructions(focus: string | null): string {
  const lines = [
    COMPACT_INSTRUCTIONS_MARKER,
    'You write the working summary of a conversation between a user and an AI assistant that works with tools. The '
    + 'assistant continues the conversation from your summary alone: everything before it is removed from its context, '
    + 'so keep every detail it needs to go on without asking the user to repeat anything.',
    'The conversation follows as a transcript in the user message. Do not answer or continue it, and do not call tools: '
    + 'reply with the summary only, in Markdown, under these headings:',
    '1. Request and intent: what the user asked for, in detail, and the goal behind it.',
    '2. Key concepts: the technologies, conventions and decisions that matter for the work.',
    '3. Files and code: every file read, created or changed, with why it matters and the important code or changes.',
    '4. Errors and fixes: the problems met, how they were solved, and what the user said about them.',
    '5. User messages: every message the user wrote (not tool results), close to their own words.',
    '6. Pending tasks: what the user asked for that is not done yet.',
    '7. Current work: what was being done right before this summary, with file names and code where relevant.',
    '8. Next step: the step that follows directly from the latest request, if any, quoting the request it serves.',
    'Be precise and complete rather than short; leave out greetings and filler.',
  ]
  const topic = focus?.replace(/\s+/g, ' ').trim() ?? ''
  if (topic !== '')
    lines.push('The user asked the summary to pay special attention to the topic on the next line.', `Focus: ${topic}`)
  return lines.join('\n')
}

/** `text` cut to at most `max` characters, with a note of what was left out (never inside a surrogate pair). */
export function capText(text: string, max: number): string {
  if (text.length <= max)
    return text
  const note = ` [… cut, ${text.length} characters in all]`
  if (max < note.length * 2)
    return safeSlice(text, Math.max(0, max))
  return `${safeSlice(text, max - note.length)}${note}`
}

/** The first `end` UTF-16 code units of `text`, one less when that would split a surrogate pair. */
function safeSlice(text: string, end: number): string {
  if (end <= 0)
    return ''
  const last = text.charCodeAt(end - 1)
  return text.slice(0, last >= 0xD800 && last <= 0xDBFF ? end - 1 : end)
}

/** The last `count` UTF-16 code units of `text`, one less when that would split a surrogate pair. */
function safeTail(text: string, count: number): string {
  if (count <= 0)
    return ''
  const start = Math.max(0, text.length - count)
  const first = text.charCodeAt(start)
  return text.slice(first >= 0xDC00 && first <= 0xDFFF ? start + 1 : start)
}

/** `text` shortened to at most `max` characters by leaving out its middle (its start and end stay). */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max)
    return text
  const note = `\n[… middle left out, ${text.length} characters in all …]\n`
  if (max < note.length * 2)
    return safeSlice(text, Math.max(0, max))
  const room = max - note.length
  const head = Math.ceil(room / 2)
  return `${safeSlice(text, head)}${note}${safeTail(text, room - head)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value) ?? ''
  }
  catch {
    return ''
  }
}

/** `[file …]` for a file or image part (the name when known, else the media type). */
function fileText(part: Record<string, unknown>): string {
  const name = typeof part.filename === 'string' && part.filename.trim() !== '' ? part.filename.trim() : null
  const mediaType = typeof part.mediaType === 'string' ? part.mediaType : part.type === 'image' ? 'image' : 'file'
  return name === null ? `[file ${mediaType}]` : `[file ${name} (${mediaType})]`
}

/** The text of a tool result output (`ToolResultOutput`, or any value). */
function outputText(output: unknown): string {
  if (!isRecord(output))
    return json(output)
  switch (output.type) {
    case 'text':
    case 'error-text':
      return typeof output.value === 'string' ? output.value : json(output.value)
    case 'json':
    case 'error-json':
      return json(output.value)
    case 'execution-denied':
      return typeof output.reason === 'string' && output.reason !== '' ? `denied: ${output.reason}` : 'denied'
    case 'content':
      return Array.isArray(output.value)
        ? output.value.map(item => (isRecord(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : isRecord(item) ? fileText(item) : '')).filter(text => text !== '').join('\n')
        : json(output.value)
    default:
      return json(output)
  }
}

/** One line per tool result: `[result of name: …]` (an error result says so). */
function toolResultText(part: Record<string, unknown>): string {
  const name = typeof part.toolName === 'string' ? part.toolName : 'tool'
  const output = isRecord(part.output) ? part.output : undefined
  const failed = output?.type === 'error-text' || output?.type === 'error-json'
  const label = failed ? `error of ${name}` : `result of ${name}`
  return `[${label}: ${capText(outputText(part.output), TRANSCRIPT_TOOL_RESULT_MAX_CHARS)}]`
}

/** The text of one content part, or null when the part is left out (reasoning, approval bookkeeping). */
function partText(part: unknown): string | null {
  if (typeof part === 'string')
    return part
  if (!isRecord(part))
    return null
  switch (part.type) {
    case 'text':
      return typeof part.text === 'string' ? part.text : null
    case 'image':
    case 'file':
      return fileText(part)
    case 'tool-call': {
      const name = typeof part.toolName === 'string' ? part.toolName : 'tool'
      return `[tool ${name}(${capText(json(part.input), TRANSCRIPT_TOOL_ARGS_MAX_CHARS)})]`
    }
    case 'tool-result':
      return toolResultText(part)
    default:
      // `reasoning`, `reasoning-file`, `tool-approval-request`, `tool-approval-response` and anything unknown.
      return null
  }
}

const ROLE_LABELS: Readonly<Record<ModelMessage['role'], string>> = {
  system: 'System',
  user: 'User',
  assistant: 'Assistant',
  tool: 'Tool results',
}

/** One transcript block per message (`Role:` and its parts, one per line), or null when nothing of it is shown. */
function messageBlock(message: ModelMessage): string | null {
  const content: unknown = message.content
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content : []
  const texts = parts.map(partText).filter((text): text is string => text !== null && text.trim() !== '')
  if (texts.length === 0)
    return null
  return `${ROLE_LABELS[message.role] ?? 'Message'}:\n${texts.join('\n')}`
}

function joinedLength(blocks: readonly string[]): number {
  return blocks.reduce((sum, block) => sum + block.length, 0) + Math.max(0, blocks.length - 1) * BLOCK_SEPARATOR.length
}

/**
 * The largest per-block size `cap` (at least `floor`) so that the blocks, each shortened to `cap`, fit `room`; null
 * when even `floor` does not fit.
 */
function blockCap(sizes: readonly number[], room: number, floor: number): number | null {
  const sorted = [...sizes].sort((a, b) => a - b)
  let used = 0
  for (const [index, size] of sorted.entries()) {
    const remaining = sorted.length - index
    // Every block from here on is at least `size` long: cap them all at an equal share of what is left.
    const share = Math.floor((room - used) / remaining)
    if (share < size)
      return share >= floor ? share : null
    used += size
  }
  return Number.POSITIVE_INFINITY
}

/** The messages to summarize as one text transcript of at most `budgetChars` characters (see the module comment). */
export function renderTranscript(messages: readonly ModelMessage[], budgetChars: number): string {
  const budget = Math.max(0, Math.floor(budgetChars))
  const blocks = messages.map(messageBlock).filter((block): block is string => block !== null)
  if (joinedLength(blocks) <= budget)
    return blocks.join(BLOCK_SEPARATOR)
  if (blocks.length <= 2)
    return fitEnds(blocks, budget)

  // 1. Shorten the long blocks between the head and the newest block, each keeping its start and end.
  const head = blocks[0]!
  const last = blocks.at(-1)!
  const middle = blocks.slice(1, -1)
  const room = budget - head.length - last.length - (blocks.length - 1) * BLOCK_SEPARATOR.length
  const cap = blockCap(middle.map(block => block.length), room, TRANSCRIPT_BLOCK_MIN_CHARS)
  if (cap !== null)
    return [head, ...middle.map(block => cutMiddle(block, cap)), last].join(BLOCK_SEPARATOR)

  // 2. Leave out the oldest middle blocks (shortened to the floor) until the rest fits.
  const shortened = middle.map(block => cutMiddle(block, TRANSCRIPT_BLOCK_MIN_CHARS))
  for (let dropped = 1; dropped <= shortened.length; dropped++) {
    const note = `[… ${dropped} earlier ${dropped === 1 ? 'message' : 'messages'} left out …]`
    const kept = [head, note, ...shortened.slice(dropped), last]
    if (joinedLength(kept) <= budget)
      return kept.join(BLOCK_SEPARATOR)
  }
  const note = `[… ${shortened.length} earlier ${shortened.length === 1 ? 'message' : 'messages'} left out …]`
  return fitEnds([head, last], budget, note)
}

/**
 * The head and the newest block within `budget`: the head keeps at most `HEAD_SHARE` of it (more when the newest
 * block is short), both lose their middle; `note` goes between them.
 */
function fitEnds(blocks: readonly string[], budget: number, note?: string): string {
  const head = blocks[0] ?? ''
  const last = blocks.length > 1 ? blocks.at(-1)! : ''
  const separators = (blocks.length > 1 ? BLOCK_SEPARATOR.length : 0) + (note === undefined ? 0 : BLOCK_SEPARATOR.length + note.length)
  const room = Math.max(0, budget - separators)
  if (last === '')
    return cutMiddle(head, room)
  const headRoom = Math.max(Math.floor(room * HEAD_SHARE), room - last.length)
  const shortHead = cutMiddle(head, Math.min(head.length, headRoom))
  const shortLast = cutMiddle(last, Math.max(0, room - shortHead.length))
  return [shortHead, ...(note === undefined ? [] : [note]), shortLast].join(BLOCK_SEPARATOR)
}
