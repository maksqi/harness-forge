// `GET /chats/:id/export?format=md|json` (API.md 5.9): Markdown or JSON (`ChatExport`) of a chat, with a sanitized
// `<title-slug>-<yyyy-mm-dd>.<md|json>` file name. Exports carry the chat as the API shows it (no secrets, no internal
// ids beyond the chat's own and its messages'); `running` and `pendingApproval` are always false.
import type { ChatDetail, ChatExport, ChatExportFormat, HarnessUIMessage } from '@harness-forge/shared'
import type { ChatExportFile } from './types.ts'
import { Buffer } from 'node:buffer'

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
      return part.type.startsWith('tool-') || part.type === 'dynamic-tool' ? toolBlocks(loose) : []
  }
}

function messageHeading(message: HarnessUIMessage, chatModelRef: string | null): string {
  if (message.role === 'user')
    return '## User'
  if (message.role === 'system')
    return '## System'
  const modelRef = message.metadata?.modelRef ?? chatModelRef
  return modelRef ? `## Assistant (${modelRef})` : '## Assistant'
}

/** Markdown export: title, an export line (date, model), then one section per message. */
export function renderChatMarkdown(chat: ChatDetail, at: number): string {
  const title = chat.title ?? UNTITLED
  const exportLine = `Exported from harness-forge on ${isoDate(at)}${chat.modelRef ? ` · Model: ${chat.modelRef}` : ''}`
  const sections = [`# ${title}`, exportLine]
  for (const message of chat.messages) {
    sections.push(messageHeading(message, chat.modelRef))
    for (const part of message.parts)
      sections.push(...partBlocks(part))
  }
  return `${sections.join('\n\n')}\n`
}

/** JSON export (`ChatExport`). */
export function renderChatJson(chat: ChatDetail, at: number): string {
  const body: ChatExport = {
    format: 'harness-forge.chat',
    version: 1,
    exportedAt: at,
    chat: { ...chat, running: false, pendingApproval: false },
  }
  return `${JSON.stringify(body, null, 2)}\n`
}

export function buildChatExport(chat: ChatDetail, format: ChatExportFormat, at: number): ChatExportFile {
  const exportable: ChatDetail = { ...chat, running: false, pendingApproval: false }
  return format === 'json'
    ? { filename: exportFilename(chat.title, 'json', at), contentType: 'application/json; charset=utf-8', body: renderChatJson(exportable, at) }
    : { filename: exportFilename(chat.title, 'md', at), contentType: 'text/markdown; charset=utf-8', body: renderChatMarkdown(exportable, at) }
}
