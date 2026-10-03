// Text helpers of the chats service: plain text of UI messages, `messages.search_text`, the `GET /chats?q=` matching
// rules, snippets and title sanitizing.
//
// Phase 9 (ADR-040 / ADR-042, W9.7): the plain text of a reply includes the text of its steers (`data-steer`, messages
// the user queued during the run; read through the shared `splitSteers`, in place), so a search finds them and the
// snippet can show them; compaction summaries (`data-compaction`) are never indexed.
//
// Case-insensitive search: SQLite's LIKE folds ASCII letters only, so `search_text` stores the message text
// NFC-normalized and lowercased with JavaScript's Unicode-aware `toLowerCase()`, and the query is normalized the same
// way before it becomes a LIKE pattern (`%` and `_` escaped). Titles are matched in JavaScript with the same rule.
// Snippets are cut from the original (not lowercased) text of the matching message.
import type { AgentStateMessage } from '@harness-forge/shared'
import { splitSteers, STEER_PART_TYPE } from '@harness-forge/shared'

/** Maximum length of `ChatSummary.snippet`. */
export const SNIPPET_MAX_LENGTH = 160
/** Maximum length of a chat title (ARCHITECTURE.md 10.4 "chat title 200 chars"). */
export const TITLE_MAX_LENGTH = 200
/** Escape character of the LIKE patterns built by `likeContainsPattern`. */
export const LIKE_ESCAPE = '\\'

const ELLIPSIS = '…'
/** Characters kept before the match in a snippet. */
const SNIPPET_LEADING_CONTEXT = 40

/** True for C0 / C1 control characters, DEL, the line / paragraph separators and bidi override / isolate controls. */
export function isControlChar(code: number): boolean {
  return code < 0x20
    || (code >= 0x7F && code <= 0x9F)
    || code === 0x2028
    || code === 0x2029
    || (code >= 0x202A && code <= 0x202E)
    || (code >= 0x2066 && code <= 0x2069)
}

/** Replaces every control character (see `isControlChar`) with `replacement`. */
export function replaceControlChars(value: string, replacement: string): string {
  let out = ''
  for (const char of value)
    out += isControlChar(char.codePointAt(0) ?? 0) ? replacement : char
  return out
}

/** `value` with lone UTF-16 surrogates replaced by U+FFFD (like `String.prototype.toWellFormed`). */
export function wellFormed(value: string): string {
  let out = ''
  for (const char of value) {
    // Iterating a string yields whole code points; a lone surrogate comes out as a single code unit in that range.
    const code = char.codePointAt(0) ?? 0
    out += code >= 0xD800 && code <= 0xDFFF ? '\uFFFD' : char
  }
  return out
}

/** The first `max` code points of `value` (never splits a surrogate pair). */
export function truncateCodePoints(value: string, max: number): string {
  const chars = Array.from(value)
  return chars.length <= max ? value : chars.slice(0, max).join('')
}

function collectTexts(parts: readonly unknown[], texts: string[]): void {
  for (const part of parts) {
    if (typeof part !== 'object' || part === null)
      continue
    const { type, text } = part as { type?: unknown, text?: unknown }
    if (type === 'text' && typeof text === 'string' && text !== '')
      texts.push(text)
  }
}

/**
 * Plain text of a message: its `text` parts joined with newlines, with the text of each valid steer (`data-steer`,
 * `splitSteers`) at its place in the reply. Other data parts (compaction summaries, notices) are not text.
 */
export function messagePlainText(parts: readonly unknown[]): string {
  const texts: string[] = []
  if (!Array.isArray(parts))
    return ''
  const steered = parts.some(part => typeof part === 'object' && part !== null && (part as { type?: unknown }).type === STEER_PART_TYPE)
  if (!steered) {
    collectTexts(parts, texts)
    return texts.join('\n')
  }
  // Steers are only recognized in assistant messages; the role does not matter for the text.
  for (const piece of splitSteers([{ id: 'text', role: 'assistant', parts: parts as AgentStateMessage['parts'] }]))
    collectTexts(piece.parts, texts)
  return texts.join('\n')
}

/** Search normalization shared by stored text, titles and queries: NFC + Unicode-aware lowercase. */
export function normalizeForSearch(value: string): string {
  return value.normalize('NFC').toLowerCase()
}

/** Value of `messages.search_text` for a message with these parts. */
export function toSearchText(parts: readonly unknown[]): string {
  return normalizeForSearch(messagePlainText(parts))
}

/** `%<needle>%` with `\`, `%` and `_` escaped; use with `ESCAPE '\'`. The needle must already be normalized. */
export function likeContainsPattern(needle: string): string {
  return `%${needle.replace(/[\\%_]/g, char => `${LIKE_ESCAPE}${char}`)}%`
}

/** Title match of `GET /chats?q=` (`needle` normalized with `normalizeForSearch`). */
export function titleMatches(title: string | null, needle: string): boolean {
  return title !== null && needle !== '' && normalizeForSearch(title).includes(needle)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF
}

/** Index of the first case-insensitive (Unicode) occurrence of `needle` in `text`, or -1. */
function findInsensitive(text: string, needle: string): number {
  return needle === '' ? -1 : text.search(new RegExp(escapeRegExp(needle), 'iu'))
}

/**
 * A plain-text excerpt of at most `maxLength` characters around the first case-insensitive occurrence of `query`
 * (whitespace collapsed, `…` where text was cut). Starts at the beginning when the query is not found.
 */
export function makeSnippet(text: string, query: string, maxLength = SNIPPET_MAX_LENGTH): string {
  const flat = replaceControlChars(text.normalize('NFC'), ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= maxLength)
    return flat
  const index = findInsensitive(flat, query.normalize('NFC').replace(/\s+/g, ' ').trim())
  let start = Math.max(0, index - SNIPPET_LEADING_CONTEXT)
  // Near the end of the text: use the whole window instead of leaving it partly empty.
  start = Math.min(start, flat.length - maxLength + 1)
  const hasPrefix = start > 0
  let end = start + maxLength - (hasPrefix ? 1 : 0)
  const hasSuffix = end < flat.length
  if (hasSuffix)
    end -= 1
  if (start > 0 && isLowSurrogate(flat.charCodeAt(start)))
    start += 1
  if (end < flat.length && isHighSurrogate(flat.charCodeAt(end - 1)))
    end -= 1
  const body = flat.slice(start, end).trim()
  return `${hasPrefix ? ELLIPSIS : ''}${body}${hasSuffix ? ELLIPSIS : ''}`
}

/**
 * A title as stored: NFC, control characters and line breaks replaced by spaces, whitespace collapsed, trimmed, at most
 * 200 characters. Null when nothing is left.
 */
export function sanitizeTitle(raw: string): string | null {
  const clean = replaceControlChars(wellFormed(raw).normalize('NFC'), ' ').replace(/\s+/g, ' ').trim()
  if (clean === '')
    return null
  return truncateCodePoints(clean, TITLE_MAX_LENGTH).trim()
}
