// Pure helpers of the chat transcript (docs/UI.md 7): part grouping (galleries of generated images, merged sources),
// tool names and arguments, size caps, durations, costs and the image-turn meta line. No Vue, no stores: unit tested
// on their own.
import type { HarnessUIMessage, HarnessUIMessagePart, ImageTurnMetadata, NoticeData } from '@harness-forge/shared'
import type {
  DynamicToolUIPart,
  FileUIPart,
  ReasoningFileUIPart,
  ReasoningUIPart,
  SourceDocumentUIPart,
  SourceUrlUIPart,
  TextUIPart,
  ToolUIPart,
} from 'ai'
import { getToolName, isToolUIPart } from 'ai'

export type ToolPartLike = ToolUIPart | DynamicToolUIPart
export type ToolState = ToolPartLike['state']
export type SourcePart = SourceUrlUIPart | SourceDocumentUIPart

/** One rendered block of an assistant message, in part order (docs/UI.md 7.1). */
export type MessageBlock
  = | { kind: 'text', key: string, index: number, part: TextUIPart }
    | { kind: 'reasoning', key: string, index: number, part: ReasoningUIPart }
    | { kind: 'tool', key: string, index: number, part: ToolPartLike }
    | { kind: 'file', key: string, index: number, part: FileUIPart | ReasoningFileUIPart }
    /** A run of consecutive `image/*` file parts (generated images, docs/UI.md 7.16): one `ImageGallery`. */
    | { kind: 'gallery', key: string, index: number, parts: FileUIPart[] }
    | { kind: 'sources', key: string, index: number, parts: SourcePart[] }
    | { kind: 'notice', key: string, index: number, notice: NoticeData }

/** Characters of a tool input / output shown before "Show all" (docs/UI.md 7.2). */
export const TOOL_BODY_PREVIEW_CHARS = 4096
/** Characters shown after "Show all" (4 KB + another 60 KB). */
export const TOOL_BODY_MAX_CHARS = 65_536
/** Characters of the first argument in a tool row. */
export const TOOL_ARG_MAX_CHARS = 60

function isSourcePart(part: HarnessUIMessagePart): part is SourcePart {
  return part.type === 'source-url' || part.type === 'source-document'
}

/** An `image/*` media type. */
export function isImageMediaType(mediaType: string): boolean {
  return mediaType.trim().toLowerCase().startsWith('image/')
}

/** A `file` part holding an image: generated images in assistant messages, attachments in user ones. */
export function isImageFilePart(part: HarnessUIMessagePart): part is FileUIPart {
  return part.type === 'file' && isImageMediaType(part.mediaType)
}

/** The image file parts of a message, in part order. */
export function imageFileParts(message: Pick<HarnessUIMessage, 'parts'>): FileUIPart[] {
  return message.parts.filter(isImageFilePart)
}

function isNoticeData(value: unknown): value is NoticeData {
  if (typeof value !== 'object' || value === null)
    return false
  const data = value as Record<string, unknown>
  return typeof data.message === 'string' && (data.level === 'info' || data.level === 'warning')
}

/**
 * Renderable blocks of an assistant message: consecutive sources merge into one row, image file parts with no other
 * rendered block between them form one gallery (a `reasoning-file` draft image stays a thumbnail), `step-start`,
 * unknown `data-*` and custom parts render nothing, `data-notice` becomes a notice row.
 */
export function messageBlocks(parts: readonly HarnessUIMessagePart[]): MessageBlock[] {
  const blocks: MessageBlock[] = []
  parts.forEach((part, index) => {
    if (part.type === 'text') {
      blocks.push({ kind: 'text', key: `text-${index}`, index, part })
    }
    else if (part.type === 'reasoning') {
      blocks.push({ kind: 'reasoning', key: `reasoning-${index}`, index, part })
    }
    else if (isToolUIPart(part)) {
      blocks.push({ kind: 'tool', key: `tool-${part.toolCallId || index}`, index, part })
    }
    else if (part.type === 'file' && isImageMediaType(part.mediaType)) {
      // Invisible parts (e.g. `step-start`) render nothing, so they never split a gallery.
      const previous = blocks.at(-1)
      if (previous?.kind === 'gallery')
        previous.parts.push(part)
      else
        blocks.push({ kind: 'gallery', key: `gallery-${index}`, index, parts: [part] })
    }
    else if (part.type === 'file' || part.type === 'reasoning-file') {
      blocks.push({ kind: 'file', key: `file-${index}`, index, part })
    }
    else if (isSourcePart(part)) {
      const previous = blocks.at(-1)
      if (previous?.kind === 'sources' && previous.index + previous.parts.length === index)
        previous.parts.push(part)
      else
        blocks.push({ kind: 'sources', key: `sources-${index}`, index, parts: [part] })
    }
    else if (part.type === 'data-notice' && isNoticeData(part.data)) {
      blocks.push({ kind: 'notice', key: `notice-${index}`, index, notice: part.data })
    }
  })
  return blocks
}

/** All text parts of a message as markdown (message "Copy", read aloud); '' when it has none. */
export function messageText(message: Pick<HarnessUIMessage, 'parts'>): string {
  return message.parts
    .filter((part): part is TextUIPart => part.type === 'text')
    .map(part => part.text)
    .join('\n\n')
    .trim()
}

/** The tool name of a static (`tool-<name>`) or dynamic tool part. */
export function toolNameOf(part: ToolPartLike): string {
  return getToolName(part)
}

const MCP_TOOL = /^mcp__([\da-z](?:[\da-z-]*[\da-z])?)__(.+)$/

/** `mcp__<server>__<tool>` -> `{ serverId, tool }`; null for other tools. */
export function splitMcpToolName(name: string): { serverId: string, tool: string } | null {
  const match = name.match(MCP_TOOL)
  return match ? { serverId: match[1]!, tool: match[2]! } : null
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** The first string value of a tool input (breadth first), on one line, at most 60 characters; null when none. */
export function firstStringArg(input: unknown, max = TOOL_ARG_MAX_CHARS): string | null {
  const queue: unknown[] = [input]
  let visited = 0
  while (queue.length > 0 && visited < 200) {
    const value = queue.shift()
    visited += 1
    if (typeof value === 'string') {
      const line = oneLine(value, max)
      if (line)
        return line
    }
    else if (Array.isArray(value)) {
      queue.push(...value)
    }
    else if (typeof value === 'object' && value !== null) {
      queue.push(...Object.values(value))
    }
  }
  return null
}

/** A tool input or output as display text: strings as they are, everything else as pretty JSON. */
export function formatToolValue(value: unknown): string {
  if (value === undefined)
    return ''
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  }
  catch {
    return String(value)
  }
}

/** The first `limit` characters of `text` and whether anything was cut. */
export function capText(text: string, limit: number): { text: string, truncated: boolean } {
  return text.length > limit ? { text: text.slice(0, limit), truncated: true } : { text, truncated: false }
}

const SERVER_TRUNCATION = /\[(?:output )?truncated\b[^\]]*\]\s*$|…\s*\(truncated\)\s*$/i

/**
 * True when the server capped a tool output at 64 KB. The marker is not part of the shared contract yet, so this
 * recognizes a trailing `[truncated …]` marker or an object with `truncated: true`.
 */
export function isServerTruncated(output: unknown): boolean {
  if (typeof output === 'string')
    return SERVER_TRUNCATION.test(output)
  if (typeof output === 'object' && output !== null && !Array.isArray(output))
    return (output as Record<string, unknown>).truncated === true
  return false
}

/** True when a denied tool call was skipped because the user sent a new message (server reason `superseded`). */
export function isSupersededDenial(part: ToolPartLike): boolean {
  const reason = part.approval && 'reason' in part.approval ? part.approval.reason : undefined
  return typeof reason === 'string' && /supersed/i.test(reason)
}

/** Whole seconds for "Thought for Ns" (at least 1). */
export function wholeSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000))
}

/** "0.4s", "14s", "2m 5s", "1h 3m". */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0)
    return ''
  if (ms < 1000)
    return `${(Math.max(ms, 100) / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  if (seconds < 60)
    return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60)
    return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** "$0.004", "$0.12", "$1.50", "<$0.001". */
export function formatCost(usd: number | undefined | null): string {
  if (usd === undefined || usd === null || !Number.isFinite(usd) || usd < 0)
    return ''
  if (usd === 0)
    return '$0'
  if (usd < 0.001)
    return '<$0.001'
  if (usd < 0.01)
    return `$${Number(usd.toPrecision(1))}`
  return `$${usd.toFixed(2)}`
}

/** Exact token counts with thousands separators. */
export function formatTokens(tokens: number | undefined | null): string {
  return typeof tokens === 'number' && Number.isFinite(tokens) ? Math.round(tokens).toLocaleString('en-US') : ''
}

function countLabel(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The meta line of an image turn (`metadata.image`, docs/UI.md 7.5): "2 images · 16:9 · edited 1 image". The aspect
 * ratio is left out for Auto, the edit part when no input image was sent.
 */
export function formatImageTurn(image: Pick<ImageTurnMetadata, 'n' | 'aspectRatio' | 'inputs'>): string {
  const items = [countLabel(image.n, 'image')]
  if (image.aspectRatio)
    items.push(image.aspectRatio)
  if (image.inputs && image.inputs > 0)
    items.push(`edited ${countLabel(image.inputs, 'image')}`)
  return items.join(' · ')
}

/** Host name of a URL for source rows; the input when it does not parse. */
export function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  }
  catch {
    return url
  }
}

/** Only absolute http(s) URLs may become links from model output. */
export function safeExternalUrl(url: string | undefined | null): string | null {
  if (!url)
    return null
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  }
  catch {
    return null
  }
}
