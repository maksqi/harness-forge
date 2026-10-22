// MCP content as text (Phase 14, ADR-061; ARCHITECTURE.md 6.41 / 6.42). Owner: W14.2. One content item of a tool
// result, a prompt message or a resource as plain text for the model, and the frozen expansion of an MCP prompt.
//
// - `mcpContentText(content, options)` (the signature is FROZEN after Gate P14-0b; `mcpModelOutput` calls it for the
//   items of a tool result that are neither text nor images): a `text` item is its text; an embedded text resource
//   becomes a `<resource uri="…" mimeType="…">…</resource>` block; images, audio, binary resources and resource links
//   become one-line placeholders (`[Image: image/png, 68 bytes]`, `[Resource link: …]`, …); anything else a server
//   sends stays JSON text.
// - `mcpPromptExpansion(result, options)`: the `prompts/get` result as the command expansion (`metadata.command
//   .expansion`, frozen by `chat/commands.ts`): the text of user-only messages joined with blank lines; when any message
//   is an assistant message, every message wrapped as `<prompt-message role="user|assistant">…</prompt-message>`; at
//   most `LIMITS.commandExpansionBytes` (64 KB) UTF-8 bytes, a longer expansion is cut and ends in `EXPANSION_CUT_NOTE`.
// MCP content is untrusted: every text is capped before use and never logged (not even at `debug`).
import { Buffer } from 'node:buffer'
import { LIMITS } from '@harness-forge/shared'

/** Options of `mcpContentText`. */
export interface McpContentTextOptions {
  /** Longest text answered (a longer one is cut and ends in `...`); default: no cap. */
  readonly maxChars?: number
}

/** Options of `mcpPromptExpansion`. */
export interface McpPromptExpansionOptions {
  /** Most UTF-8 bytes of the expansion (default `LIMITS.commandExpansionBytes`). */
  readonly maxBytes?: number
}

/** The last line of an expansion that was cut to its byte cap. */
export const EXPANSION_CUT_NOTE = '[The MCP prompt was cut: it is longer than 64 KB.]'

/** Characters of one URI in a placeholder or a resource block. */
const URI_MAX_CHARS = 2048
/** Characters of a name, a title or a MIME type in a placeholder. */
const LABEL_MAX_CHARS = 256
/** Characters of the description of a resource link. */
const DESCRIPTION_MAX_CHARS = 300

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function capped(text: string, maxChars: number | undefined): string {
  if (maxChars === undefined || !Number.isFinite(maxChars) || maxChars < 0 || text.length <= maxChars)
    return text
  return `${cutChars(text, Math.floor(maxChars))}...`
}

/** `text` cut to at most `max` UTF-16 code units, never inside a surrogate pair. */
function cutChars(text: string, max: number): string {
  if (text.length <= max)
    return text
  const code = text.charCodeAt(max - 1)
  return text.slice(0, code >= 0xD800 && code <= 0xDBFF ? max - 1 : max)
}

/** One line of plain text: control, format and line-break characters become spaces, blanks collapse; capped. */
function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string')
    return ''
  const text = value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${cutChars(text, max - 1)}…`
}

/** A value for a double-quoted attribute of a block tag: one line, `&`, `"`, `<` and `>` escaped. */
function attribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** The decoded size of a base64 string (padding and blanks ignored), without decoding it. */
export function base64ByteLength(data: string): number {
  const clean = data.replace(/[\s=]/g, '')
  return Math.floor(clean.length * 3 / 4)
}

/** `68 bytes`, `1.5 KB`, `6.0 MB`. */
function sizeText(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `(<detail>, <detail>)` of the non-empty details, or ''. */
function details(...parts: string[]): string {
  const kept = parts.filter(part => part !== '')
  return kept.length === 0 ? '' : ` (${kept.join(', ')})`
}

/** The placeholder of an image or audio item. */
function mediaText(label: string, content: Record<string, unknown>): string {
  const mime = oneLine(content.mimeType, LABEL_MAX_CHARS)
  const size = typeof content.data === 'string' ? sizeText(base64ByteLength(content.data)) : ''
  return `[${label}${mime === '' && size === '' ? '' : `: ${[mime, size].filter(part => part !== '').join(', ')}`}]`
}

/** An embedded resource (`{ type: 'resource', resource }`): a text block, or a placeholder for a binary one. */
function resourceText(resource: unknown, maxChars: number | undefined): string | null {
  if (!isRecord(resource))
    return null
  const uri = oneLine(resource.uri, URI_MAX_CHARS)
  const mime = oneLine(resource.mimeType, LABEL_MAX_CHARS)
  if (typeof resource.text === 'string') {
    const open = `<resource uri="${attribute(uri)}"${mime === '' ? '' : ` mimeType="${attribute(mime)}"`}>\n`
    const close = '\n</resource>'
    // The cap keeps the closing tag: the body gets what the tags leave (`...` included).
    const room = maxChars === undefined ? undefined : maxChars - open.length - close.length - 3
    if (room !== undefined && room < 0)
      return capped(`${open}${resource.text}${close}`, maxChars)
    return `${open}${capped(resource.text, room)}${close}`
  }
  if (typeof resource.blob === 'string')
    return `[Binary resource: ${uri === '' ? 'unnamed' : uri}${details(mime, sizeText(base64ByteLength(resource.blob)))}]`
  return null
}

/** A resource link (`{ type: 'resource_link', uri, name, description?, mimeType? }`) as one line. */
function linkText(content: Record<string, unknown>): string {
  const uri = oneLine(content.uri, URI_MAX_CHARS)
  const name = oneLine(content.title, LABEL_MAX_CHARS) || oneLine(content.name, LABEL_MAX_CHARS)
  const mime = oneLine(content.mimeType, LABEL_MAX_CHARS)
  const description = oneLine(content.description, DESCRIPTION_MAX_CHARS)
  const label = name === '' || name === uri ? uri : `${name} ${uri === '' ? '' : `<${uri}>`}`.trim()
  return `[Resource link: ${label === '' ? 'unnamed' : label}${details(mime)}${description === '' ? '' : ` - ${description}`}]`
}

function jsonText(content: unknown): string {
  let json: string | undefined
  try {
    json = JSON.stringify(content)
  }
  catch {
    json = undefined
  }
  return json ?? String(content)
}

/**
 * The text of one MCP content item (`text`, `image`, `audio`, `resource`, `resource_link`, or anything a server sends):
 * a text item's `text`; an embedded text resource as a `<resource uri mimeType>` block; images, audio, binary resources
 * and resource links as one-line placeholders; anything else as its JSON. `maxChars` caps the answer. Never throws.
 */
export function mcpContentText(content: unknown, options: McpContentTextOptions = {}): string {
  const maxChars = options.maxChars
  try {
    if (isRecord(content)) {
      if (content.type === 'text' && typeof content.text === 'string')
        return capped(content.text, maxChars)
      if (content.type === 'image')
        return capped(mediaText('Image', content), maxChars)
      if (content.type === 'audio')
        return capped(mediaText('Audio', content), maxChars)
      if (content.type === 'resource') {
        const text = resourceText(content.resource, maxChars)
        if (text !== null)
          return capped(text, maxChars)
      }
      if (content.type === 'resource_link' && (typeof content.uri === 'string' || typeof content.name === 'string'))
        return capped(linkText(content), maxChars)
    }
    return capped(jsonText(content), maxChars)
  }
  catch {
    // A hostile object (throwing getters): nothing readable.
    return '[Unreadable MCP content]'
  }
}

/** `text` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
function cutBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.byteLength <= maxBytes)
    return text
  let end = Math.max(0, maxBytes)
  // Back off to the start of a UTF-8 sequence (continuation bytes are 10xxxxxx).
  while (end > 0 && ((bytes[end] ?? 0) & 0xC0) === 0x80)
    end--
  return bytes.subarray(0, end).toString('utf8')
}

/** The content items of one prompt message (a single item per the protocol; an array is read too). */
function messageContents(message: Record<string, unknown>): unknown[] {
  const content = message.content
  return Array.isArray(content) ? content : content === undefined ? [] : [content]
}

/**
 * The command expansion of a `prompts/get` result (see the module comment): user-only text joined, `<prompt-message
 * role>` wrapping when an assistant message is present, at most `maxBytes` UTF-8 bytes (cut with `EXPANSION_CUT_NOTE`).
 * An empty string when the result has no readable message. Never throws.
 */
export function mcpPromptExpansion(result: unknown, options: McpPromptExpansionOptions = {}): string {
  const maxBytes = options.maxBytes ?? LIMITS.commandExpansionBytes
  let messages: Array<{ role: 'user' | 'assistant', text: string }> = []
  try {
    const list = isRecord(result) && Array.isArray(result.messages) ? result.messages as unknown[] : []
    messages = list.filter(isRecord).map(message => ({
      role: message.role === 'assistant' ? 'assistant' as const : 'user' as const,
      // Each item is capped before joining, so a huge embedded resource never builds a huge string.
      text: messageContents(message).map(content => mcpContentText(content, { maxChars: maxBytes })).join('\n\n'),
    }))
  }
  catch {
    messages = []
  }
  const withAssistant = messages.some(message => message.role === 'assistant')
  const text = withAssistant
    ? messages.map(message => `<prompt-message role="${message.role}">\n${message.text}\n</prompt-message>`).join('\n\n')
    : messages.map(message => message.text).filter(part => part !== '').join('\n\n')
  if (Buffer.byteLength(text, 'utf8') <= maxBytes)
    return text
  const note = `\n\n${EXPANSION_CUT_NOTE}`
  return `${cutBytes(text, Math.max(0, maxBytes - Buffer.byteLength(note, 'utf8')))}${note}`
}
