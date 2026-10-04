// `GET /chats/:id/export?format=md|json` (API.md 5.9): Markdown (the active path) or JSON (`ChatExport` version 2: every
// message version, ADR-023) of a chat, with a sanitized `<title-slug>-<yyyy-mm-dd>.<md|json>` file name. Exports carry
// the chat as the API shows it (no secrets, no internal ids beyond the chat's own and its messages'); `running` and
// `pendingApproval` are always false.
//
// Phase 9 (ADR-040 / ADR-042, W9.7): in Markdown a compaction marker (`data-compaction`) reads
// "_Conversation compacted (N messages summarized)_" followed by its summary as a quote, and a reply is split at its
// steers (`data-steer`, the shared `splitSteers`): each steer becomes a "## User (during the run)" section between
// the parts of the reply before and after it. Invalid marker or steer data is left out. JSON exports carry the parts as
// stored (the import validates them with `harnessDataSchemas`).
//
// Phase 10 (ADR-046, W10.6): a background task result (`data-task-result`) reads "## Background task: <description>
// (<status>)" followed by its report (else "Error: <error>", else "_(no report)_"), at its place: a reply is split
// there like at a steer (the parts after it get the reply's heading again), and the user-role carrier message of a turn
// the server started (only results) shows its results without a "## User" heading. Invalid result data is left out.
// JSON exports keep the parts (background task rows are never exported).
import type { ChatDetail, ChatExport, ChatExportFormat, CompactionData, HarnessUIMessage, TaskOutput } from '@harness-forge/shared'
import type { ChatExportFile } from './types.ts'
import { Buffer } from 'node:buffer'
import { COMPACTION_PART_TYPE, compactionDataSchema, splitSteers, TASK_RESULT_PART_TYPE, taskResultDataSchema } from '@harness-forge/shared'

/** Tool outputs longer than this (UTF-8 bytes) are truncated in Markdown exports. */
export const EXPORT_TOOL_OUTPUT_BYTES = 4096
const SLUG_MAX_LENGTH = 60
const UNTITLED = 'Untitled chat'
const TRUNCATED_MARKER = '\n… (truncated)'

/** `yyyy-mm-dd` (UTC) of a timestamp. */
export function isoDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * File name slug of a title: lowercase letters and digits of any script separated by single dashes, at most 60
 * characters; `chat` when nothing is left.
 */
export function titleSlug(title: string | null): string {
  const slug = (title ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  const cut = Array.from(slug).slice(0, SLUG_MAX_LENGTH).join('').replace(/-+$/, '')
  return cut === '' ? 'chat' : cut
}

export function exportFilename(title: string | null, format: ChatExportFormat, at: number): string {
  return `${titleSlug(title)}-${isoDate(at)}.${format}`
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a character. */
function truncateUtf8(text: string, maxBytes: number): { text: string, truncated: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes)
    return { text, truncated: false }
  let bytes = 0
  let out = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes)
      break
    bytes += size
    out += char
  }
  return { text: out, truncated: true }
}

/** A fenced code block whose fence is longer than any backtick run inside `body`. */
function fenced(body: string, language: string): string {
  const longestRun = Math.max(0, ...Array.from(body.matchAll(/`+/g), match => match[0].length))
  const fence = '`'.repeat(Math.max(3, longestRun + 1))
  return `${fence}${language}\n${body}\n${fence}`
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null'
  }
  catch {
    return '"[unserializable]"'
  }
}

/** Link text with Markdown brackets escaped. */
function linkText(text: string): string {
  return text.replace(/[[\]\\]/g, '\\$&').replace(/\s+/g, ' ').trim()
}

/** Link destination; wrapped in `<>` when it contains spaces or parentheses. */
function linkTarget(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/[<>\s]/g, encodeURIComponent)}>` : url
}

function fileLink(name: string, url: string): string {
  if (url.startsWith('data:'))
    return `${linkText(name)} (embedded file not exported)`
  return `[${linkText(name)}](${linkTarget(url)})`
}

function quote(text: string): string {
  return text.split(/\r?\n/).map(line => (line === '' ? '>' : `> ${line}`)).join('\n')
}

/** The heading line of a compaction marker. */
export function compactionLine(data: Pick<CompactionData, 'messagesCompacted'>): string {
  const count = data.messagesCompacted
  return `_Conversation compacted (${count} ${count === 1 ? 'message' : 'messages'} summarized)_`
}

/** A compaction marker: the line and its summary as a quote; nothing for invalid data. */
function compactionBlocks(part: Record<string, unknown>): string[] {
  const parsed = compactionDataSchema.safeParse(part.data)
  if (!parsed.success)
    return []
  const summary = parsed.data.summary.trim()
  return summary === '' ? [compactionLine(parsed.data)] : [compactionLine(parsed.data), quote(summary)]
}

function toolBlocks(part: Record<string, unknown>): string[] {
  const type = String(part.type)
  const name = type === 'dynamic-tool' ? String(part.toolName ?? 'tool') : type.slice('tool-'.length)
  const state = typeof part.state === 'string' ? part.state : 'unknown'
  const blocks = [`**Tool** \`${name.replace(/`/g, '')}\` (${state})`]
  if (part.input !== undefined)
    blocks.push(fenced(json(part.input), 'json'))
  if (state === 'output-available') {
    const output = truncateUtf8(json(part.output), EXPORT_TOOL_OUTPUT_BYTES)
    blocks.push(fenced(`${output.text}${output.truncated ? TRUNCATED_MARKER : ''}`, 'json'))
  }
  if (state === 'output-error' && typeof part.errorText === 'string')
    blocks.push(fenced(part.errorText, 'text'))
  return blocks
}

function partBlocks(part: HarnessUIMessage['parts'][number]): string[] {
  const loose = part as unknown as Record<string, unknown>
  switch (part.type) {
    case 'text':
      return part.text.trim() === '' ? [] : [part.text]
    case 'reasoning':
      return part.text.trim() === '' ? [] : [quote(part.text)]
    case 'file':
      return [fileLink(part.filename ?? part.mediaType, part.url)]
    case 'reasoning-file':
      return [fileLink(part.mediaType, part.url)]
    case 'source-url':
      return [`Source: ${fileLink(part.title ?? part.url, part.url)}`]
    case 'source-document':
      return [`Source: ${linkText(part.title)}`]
    default:
      if (part.type === COMPACTION_PART_TYPE)
        return compactionBlocks(loose)
      return part.type.startsWith('tool-') || part.type === 'dynamic-tool' ? toolBlocks(loose) : []
  }
}

/** The heading of a background task result (ADR-046): its description (its type when empty) and status, on one line. */
export function taskResultHeading(output: Pick<TaskOutput, 'description' | 'type' | 'status'>): string {
  const description = output.description.replace(/\s+/g, ' ').trim()
  return `## Background task: ${description === '' ? output.type : description} (${output.status})`
}

/** A background task result: its heading and its report (else the error, else a placeholder); nothing for invalid data. */
function taskResultBlocks(part: Record<string, unknown>): string[] {
  const parsed = taskResultDataSchema.safeParse(part.data)
  if (!parsed.success)
    return []
  const { output } = parsed.data
  const report = output.report.trim()
  const error = output.error?.trim() ?? ''
  return [taskResultHeading(output), report !== '' ? report : error !== '' ? `Error: ${error}` : '_(no report)_']
}

/** The heading of a steer: a message the user queued while the agent worked (ADR-042). */
export const STEER_HEADING = '## User (during the run)'

function messageHeading(message: HarnessUIMessage, chatModelRef: string | null, steer: boolean): string {
  if (message.role === 'user')
    return steer ? STEER_HEADING : '## User'
  if (message.role === 'system')
    return '## System'
  const modelRef = message.metadata?.modelRef ?? chatModelRef
  return modelRef ? `## Assistant (${modelRef})` : '## Assistant'
}

/**
 * The sections of one message (or one piece of a reply split at its steers): its heading and its blocks; with
 * background task results, each result is a section of its own and the parts around it keep the message's heading
 * (a run of parts that renders nothing gets no heading).
 */
function messageSections(piece: HarnessUIMessage, chatModelRef: string | null, steer: boolean): string[] {
  if (!piece.parts.some(part => part.type === TASK_RESULT_PART_TYPE))
    return [messageHeading(piece, chatModelRef, steer), ...piece.parts.flatMap(partBlocks)]
  const sections: string[] = []
  let blocks: string[] = []
  const flush = (): void => {
    if (blocks.length > 0)
      sections.push(messageHeading(piece, chatModelRef, steer), ...blocks)
    blocks = []
  }
  for (const part of piece.parts) {
    if (part.type !== TASK_RESULT_PART_TYPE) {
      blocks.push(...partBlocks(part))
      continue
    }
    const result = taskResultBlocks(part as unknown as Record<string, unknown>)
    if (result.length === 0)
      continue
    flush()
    sections.push(...result)
  }
  flush()
  return sections
}

/**
 * Markdown export: title, an export line (date, model), then one section per message (replies split at steers and at
 * background task results).
 */
export function renderChatMarkdown(chat: ChatDetail, at: number): string {
  const title = chat.title ?? UNTITLED
  const exportLine = `Exported from harness-forge on ${isoDate(at)}${chat.modelRef ? ` · Model: ${chat.modelRef}` : ''}`
  const sections = [`# ${title}`, exportLine]
  for (const message of chat.messages) {
    // Only an assistant message is split; every user message that comes out of it is a steer.
    for (const piece of splitSteers([message]))
      sections.push(...messageSections(piece, chat.modelRef, piece.role === 'user' && message.role === 'assistant'))
  }
  return `${sections.join('\n\n')}\n`
}

/** The message tree of a JSON export (every version). */
export interface ChatExportTree {
  /** Every message version, in `seq` order. */
  messages: HarnessUIMessage[]
  /** The parent of `messages[i]` (`null` = a first message); always an earlier message. */
  parentIds: (string | null)[]
  /** The last message of the active path; null for an empty chat. */
  activeLeafId: string | null
}

/** The tree of a linear chat: each message the child of the one before it, the last message active. */
export function linearTree(messages: readonly HarnessUIMessage[]): ChatExportTree {
  return {
    messages: [...messages],
    parentIds: messages.map((_message, index) => messages[index - 1]?.id ?? null),
    activeLeafId: messages.at(-1)?.id ?? null,
  }
}

/**
 * JSON export (`ChatExport`, version 2, ADR-023): the summary, settings and totals of `chat`, every message version in
 * `seq` order, the parent of each message (aligned by index) and the active leaf (default: `chat.messages` as a linear
 * chat).
 */
export function renderChatJson(chat: ChatDetail, at: number, tree: ChatExportTree = linearTree(chat.messages)): string {
  // Exports never carry the project (ADR-031): projects are host-specific.
  const { branches: _branches, messages: _path, settings, totals, projectId: _projectId, ...summary } = chat
  const body: ChatExport = {
    format: 'harness-forge.chat',
    version: 2,
    exportedAt: at,
    chat: {
      ...summary,
      running: false,
      pendingApproval: false,
      settings,
      totals,
      messages: tree.messages,
      parentIds: tree.parentIds,
      activeLeafId: tree.activeLeafId,
    },
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

/** The export file of a chat: Markdown of `chat.messages` (the active path) or JSON of `tree` (every version). */
export function buildChatExport(chat: ChatDetail, format: ChatExportFormat, at: number, tree?: ChatExportTree): ChatExportFile {
  const exportable: ChatDetail = { ...chat, running: false, pendingApproval: false }
  return format === 'json'
    ? { filename: exportFilename(chat.title, 'json', at), contentType: 'application/json; charset=utf-8', body: renderChatJson(exportable, at, tree) }
    : { filename: exportFilename(chat.title, 'md', at), contentType: 'text/markdown; charset=utf-8', body: renderChatMarkdown(exportable, at) }
}
