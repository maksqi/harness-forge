// File mentions of project chats (Phase 9, ADR-042): `@path` tokens in the composer text, their canonical form, and the
// fuzzy ranking of project paths for the `@` menu (`GET /projects/:id/files` ranks with `rankPaths`, the web highlights
// with the returned ranges). Pure and isomorphic; the server and the web never re-implement any of it.
//
// Mention grammar (one line; a mention never spans a line break):
// - a mention starts with `@` at the start of the text or right after whitespace (`a@b` and e-mail addresses never
//   match);
// - unquoted `@path`: the path is the run of non-whitespace characters after the `@` and must not contain `"`;
// - quoted `@"path with spaces"`: the path is everything up to the next `"` on the same line (non-empty); characters
//   right after the closing quote do not matter (`@"a b",` is a mention of `a b`);
// - whitespace is JavaScript `\s`; line breaks are `\n`, `\r`, U+2028 and U+2029.
// A path is mentionable when it is non-empty and holds no `"` and no line break (`isMentionablePath`); every
// mentionable path round-trips: `parseMentions(formatMention(path))` is `[{ path, start: 0, end }]`.
import type { ProjectFileKind } from '../schemas/project-files.ts'

/** Longest query `mentionTokenAt` reports (the characters between the `@` or `@"` and the caret). */
export const MENTION_QUERY_MAX_CHARS = 256

/** The `@` token under the caret (the `@` menu is open while there is one). */
export interface MentionToken {
  /** Index of the `@`. */
  start: number
  /**
   * End (exclusive) of the token: the end of the whitespace-free run that holds the caret, or, inside a quote that is
   * closed later on the line, the index after the closing `"`. Replacing `[start, end)` with `formatMention(path)`
   * replaces the whole token.
   */
  end: number
  /** What was typed between the `@` (or `@"`) and the caret; may be empty. */
  query: string
  /** The caret is inside an `@"…` quote (the query may contain blanks). */
  quoted: boolean
}

/** A complete mention found by `parseMentions`. */
export interface ParsedMention {
  /** The mentioned path (unquoted). */
  path: string
  /** Index of the `@`. */
  start: number
  /** End (exclusive): after the path, or after the closing `"` of a quoted mention. */
  end: number
}

/** A matched range `[start, end)` of characters of a path (for highlighting). */
export type MatchRange = [start: number, end: number]

/** How well a query matches a path. */
export interface PathMatch {
  /**
   * Higher is better. The thousands digit is the tier: 4 basename prefix, 3 basename substring, 2 full-path substring,
   * 1 subsequence (0 for the empty query); the rest (0..999) ranks matches inside a tier.
   */
  score: number
  /** Matched ranges of `path`, sorted, non-overlapping and non-empty (empty for the empty query). */
  ranges: MatchRange[]
}

/** A candidate of the `@` menu (`ProjectFileEntry`): a project-relative POSIX path and its kind. */
export interface MentionPathEntry {
  path: string
  kind: ProjectFileKind
}

/** A ranked candidate with the ranges to highlight. */
export interface RankedPath {
  path: string
  kind: ProjectFileKind
  ranges: MatchRange[]
}

/** Result of `rankPaths`. */
export interface RankedPaths {
  /** The best matches first, at most `limit`. */
  items: RankedPath[]
  /** More entries matched than `limit`. */
  truncated: boolean
}

// ---------------------------------------------------------------------------------------------------------------------
// Characters

const WHITESPACE = /\s/

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && WHITESPACE.test(char)
}

function isLineBreak(char: string | undefined): boolean {
  return char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'
}

/** True when a mention may start at `index`: an `@` at the start of the text or right after whitespace. */
function mentionStartsAt(text: string, index: number): boolean {
  return text[index] === '@' && (index === 0 || isWhitespace(text[index - 1]))
}

/** Index of the closing `"` of the quote opened by `@"` at `at`, or -1 when no `"` follows on the same line. */
function closingQuote(text: string, at: number): number {
  for (let index = at + 2; index < text.length; index++) {
    const char = text[index]
    if (char === '"')
      return index
    if (isLineBreak(char))
      return -1
  }
  return -1
}

/** The first whitespace index at or after `from` (or the text length). */
function runEnd(text: string, from: number): number {
  let index = from
  while (index < text.length && !isWhitespace(text[index]))
    index++
  return index
}

/** The start of the whitespace-free run that ends at `at`. */
function runStart(text: string, at: number): number {
  let index = at
  while (index > 0 && !isWhitespace(text[index - 1]))
    index--
  return index
}

/** The start of the line that holds `at`. */
function lineStart(text: string, at: number): number {
  let index = at
  while (index > 0 && !isLineBreak(text[index - 1]))
    index--
  return index
}

// ---------------------------------------------------------------------------------------------------------------------
// Tokens and mentions

/** True when `path` can be written as a mention: a non-empty string without `"` and without line breaks. */
export function isMentionablePath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0)
    return false
  for (let index = 0; index < path.length; index++) {
    const char = path[index]
    if (char === '"' || isLineBreak(char))
      return false
  }
  return true
}

function hasWhitespace(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    if (isWhitespace(value[index]))
      return true
  }
  return false
}

/**
 * The mention text of a path: `@path`, or `@"path"` when the path contains whitespace. `null` when the path is not
 * mentionable (empty, or holds `"` or a line break; such paths cannot be written as a mention). Never throws.
 */
export function formatMention(path: string): string | null {
  if (!isMentionablePath(path))
    return null
  return hasWhitespace(path) ? `@"${path}"` : `@${path}`
}

/**
 * Every complete mention of `text`, in order (see the grammar at the top of this file). An unclosed `@"` is not a
 * mention (the scan goes on after its `@`); an unquoted run holding `"` is not a mention. Never throws.
 */
export function parseMentions(text: string): ParsedMention[] {
  const mentions: ParsedMention[] = []
  if (typeof text !== 'string')
    return mentions
  let index = 0
  while (index < text.length) {
    if (!mentionStartsAt(text, index)) {
      index++
      continue
    }
    if (text[index + 1] === '"') {
      const close = closingQuote(text, index)
      if (close > index + 2) {
        mentions.push({ path: text.slice(index + 2, close), start: index, end: close + 1 })
        index = close + 1
      }
      else {
        index++
      }
      continue
    }
    const end = runEnd(text, index + 1)
    const path = text.slice(index + 1, end)
    if (path.length > 0 && !path.includes('"'))
      mentions.push({ path, start: index, end })
    index = Math.max(end, index + 1)
  }
  return mentions
}

function plainToken(text: string, start: number, caret: number): MentionToken | null {
  const query = text.slice(start + 1, caret)
  if (query.length > MENTION_QUERY_MAX_CHARS)
    return null
  return { start, end: runEnd(text, caret), query, quoted: false }
}

/**
 * The `@` token the caret is in, or `null`. The caret (clamped to the text) must be after the `@` and inside the token:
 * - unquoted: an `@` at the start of the text or after whitespace with no whitespace between it and the caret
 *   (`a@b` and e-mail addresses never match; a caret right after a complete mention's trailing blank does not either);
 * - quoted: inside an `@"…` quote that is still open at the caret (blanks allowed, no line break); a caret after the
 *   closing `"` is outside the token. When the quote is never closed on the line, an unquoted `@` run at the caret that
 *   starts after the quote wins (`@"abandoned quote @next|`).
 * The query (`text` between the `@` or `@"` and the caret) is at most `MENTION_QUERY_MAX_CHARS` long, else `null`. The
 * scan follows `parseMentions` from the start of the caret's line, so a token is never found inside a complete
 * mention that ends before the caret. Never throws.
 */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  if (typeof text !== 'string' || typeof caret !== 'number' || Number.isNaN(caret))
    return null
  const at = Math.min(Math.max(Math.trunc(caret), 0), text.length)
  let index = lineStart(text, at)
  while (index < at) {
    if (!mentionStartsAt(text, index)) {
      index++
      continue
    }
    if (text[index + 1] !== '"') {
      const end = runEnd(text, index + 1)
      if (at <= end)
        return plainToken(text, index, at)
      index = end
      continue
    }
    const close = closingQuote(text, index)
    if (close !== -1 && close < at) {
      // A complete quoted mention before the caret.
      index = close + 1
      continue
    }
    const end = close === -1 ? runEnd(text, at) : close + 1
    if (at === index + 1)
      return { start: index, end, query: '', quoted: false }
    if (close === -1) {
      const later = runStart(text, at)
      if (later > index && later < at && text[later] === '@')
        return plainToken(text, later, at)
    }
    const query = text.slice(index + 2, at)
    if (query.length > MENTION_QUERY_MAX_CHARS)
      return null
    return { start: index, end, query, quoted: true }
  }
  return null
}

// ---------------------------------------------------------------------------------------------------------------------
// Fuzzy path matching

const TIER = 1000
const QUALITY_MAX = TIER - 1

/**
 * Case folding that keeps every UTF-16 code unit at its index (a character whose lower case has another length, such
 * as U+0130, is kept as is), so match indexes are indexes of the original path.
 */
function fold(value: string): string {
  let ascii = true
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7F) {
      ascii = false
      break
    }
  }
  if (ascii)
    return value.toLowerCase()
  let folded = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!
    const lower = char.toLowerCase()
    folded += lower.length === 1 ? lower : char
  }
  return folded
}

const WORD_SEPARATORS = new Set(['/', '\\', '.', '-', '_', ' '])

function isUpper(char: string | undefined): boolean {
  return char !== undefined && char !== char.toLowerCase() && char === char.toUpperCase()
}

function isLower(char: string | undefined): boolean {
  return char !== undefined && char !== char.toUpperCase() && char === char.toLowerCase()
}

/** A word starts at `index` of the original path: the path start, after a separator, or a camelCase hump. */
function isWordStart(path: string, index: number): boolean {
  if (index === 0)
    return true
  const previous = path[index - 1]!
  return WORD_SEPARATORS.has(previous) || (isLower(previous) && isUpper(path[index]))
}

/** A word ends right before `index` of the original path: the path end, a separator or a camelCase hump. */
function isWordEnd(path: string, index: number): boolean {
  return index >= path.length || WORD_SEPARATORS.has(path[index]!) || isWordStart(path, index)
}

function clampQuality(value: number): number {
  return Math.max(0, Math.min(QUALITY_MAX, Math.round(value)))
}

/** Every start index of `query` in `folded` within `[from, last]`. */
function occurrences(folded: string, query: string, from: number, last: number): number[] {
  const found: number[] = []
  let index = folded.indexOf(query, from)
  while (index !== -1 && index <= last) {
    found.push(index)
    index = folded.indexOf(query, index + 1)
  }
  return found
}

function toRanges(positions: readonly number[]): MatchRange[] {
  const ranges: MatchRange[] = []
  for (const position of positions) {
    const last = ranges.at(-1)
    if (last !== undefined && last[1] === position)
      last[1] = position + 1
    else
      ranges.push([position, position + 1])
  }
  return ranges
}

/** `scorePath` with an already folded, non-empty query. */
function scoreFolded(query: string, path: string): PathMatch | null {
  const length = query.length
  if (length > path.length)
    return null
  const folded = fold(path)
  // The basename ignores trailing slashes (a folder may be written `src/`).
  let baseEnd = folded.length
  while (baseEnd > 0 && folded[baseEnd - 1] === '/')
    baseEnd--
  const baseStart = baseEnd === 0 ? 0 : folded.lastIndexOf('/', baseEnd - 1) + 1
  const baseLength = baseEnd - baseStart

  // Tier 4: basename prefix (an exact basename, then a stem before an extension, then a word end rank higher).
  if (baseLength >= length && folded.startsWith(query, baseStart)) {
    let quality = 500
    if (baseLength === length)
      quality += 300
    else if (folded[baseStart + length] === '.')
      quality += 200
    else if (isWordEnd(path, baseStart + length))
      quality += 100
    return { score: 4 * TIER + clampQuality(quality), ranges: [[baseStart, baseStart + length]] }
  }

  // Tier 3: inside the basename (a word start ranks higher, then an earlier position).
  const inBase = occurrences(folded, query, baseStart + 1, baseEnd - length)
  if (inBase.length > 0) {
    let best = -1
    let bestQuality = -1
    for (const index of inBase) {
      const quality = clampQuality(500 + (isWordStart(path, index) ? 300 : 0) - Math.min(index - baseStart, 200))
      if (quality > bestQuality) {
        best = index
        bestQuality = quality
      }
    }
    return { score: 3 * TIER + bestQuality, ranges: [[best, best + length]] }
  }

  // Tier 2: anywhere in the path (a segment start, a word start and a match that reaches the basename rank higher).
  const inPath = occurrences(folded, query, 0, folded.length - length)
  if (inPath.length > 0) {
    let best = -1
    let bestQuality = -1
    for (const index of inPath) {
      const segmentStart = index === 0 || folded[index - 1] === '/'
      const quality = clampQuality(300
        + (segmentStart ? 300 : isWordStart(path, index) ? 150 : 0)
        + (index + length > baseStart ? 200 : 0)
        - Math.min(index, 100))
      if (quality > bestQuality) {
        best = index
        bestQuality = quality
      }
    }
    return { score: 2 * TIER + bestQuality, ranges: [[best, best + length]] }
  }

  // Tier 1: a subsequence. The alignment that starts as late as possible (it favors the basename), compacted forward.
  const positions = Array.from<number>({ length }).fill(0)
  let next = length - 1
  for (let index = folded.length - 1; index >= 0 && next >= 0; index--) {
    if (folded[index] === query[next]) {
      positions[next] = index
      next--
    }
  }
  if (next >= 0)
    return null
  let cursor = positions[0]! + 1
  for (let item = 1; item < length; item++) {
    while (cursor < folded.length && folded[cursor] !== query[item])
      cursor++
    positions[item] = cursor
    cursor++
  }
  let inBasename = 0
  let consecutive = 0
  let wordStarts = 0
  for (let item = 0; item < length; item++) {
    const position = positions[item]!
    if (position >= baseStart && position < baseEnd)
      inBasename++
    if (item > 0 && position === positions[item - 1]! + 1)
      consecutive++
    if (isWordStart(path, position))
      wordStarts++
  }
  const span = positions[length - 1]! - positions[0]! + 1
  const quality = 300 * inBasename / length
    + 250 * consecutive / Math.max(1, length - 1)
    + 250 * wordStarts / length
    + (positions[0] === baseStart ? 100 : 0)
    - Math.min(span - length, 99)
  return { score: TIER + clampQuality(quality), ranges: toRanges(positions) }
}

/**
 * How well `query` matches `path`, case-insensitively, or `null` when it does not match. Tiers, best first: basename
 * prefix, basename substring, full-path substring, subsequence (every query character in order). The empty query
 * matches every path with score 0 and no ranges. Never throws.
 */
export function scorePath(query: string, path: string): PathMatch | null {
  if (typeof query !== 'string' || typeof path !== 'string')
    return null
  if (query.length === 0)
    return { score: 0, ranges: [] }
  return scoreFolded(fold(query), path)
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function depthOf(path: string): number {
  let end = path.length
  while (end > 0 && path[end - 1] === '/')
    end--
  let depth = 0
  for (let index = 0; index < end; index++) {
    if (path[index] === '/')
      depth++
  }
  return depth
}

interface Candidate {
  entry: MentionPathEntry
  index: number
  score: number
  ranges: MatchRange[]
}

/**
 * The best `limit` entries for `query`: score descending, then the shorter path, then the path (UTF-16 order, the same
 * in every runtime), then the input order. The empty query keeps every entry: shallower paths first, then the path.
 * Entries that do not match are left out; `truncated` tells that more entries matched than `limit` (a non-finite or
 * negative limit counts as 0, `Infinity` as no limit). Deterministic; never throws.
 */
export function rankPaths(query: string, entries: readonly MentionPathEntry[], limit: number): RankedPaths {
  const max = limit === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0
  const folded = typeof query === 'string' ? fold(query) : ''
  const candidates: Candidate[] = []
  if (!Array.isArray(entries))
    return { items: [], truncated: false }
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (typeof entry !== 'object' || entry === null || typeof entry.path !== 'string')
      continue
    if (folded.length === 0) {
      candidates.push({ entry, index, score: -depthOf(entry.path), ranges: [] })
      continue
    }
    const match = scoreFolded(folded, entry.path)
    if (match !== null)
      candidates.push({ entry, index, score: match.score, ranges: match.ranges })
  }
  candidates.sort((left, right) => {
    if (left.score !== right.score)
      return right.score - left.score
    if (folded.length > 0 && left.entry.path.length !== right.entry.path.length)
      return left.entry.path.length - right.entry.path.length
    return comparePaths(left.entry.path, right.entry.path) || left.index - right.index
  })
  const kept = candidates.length > max ? candidates.slice(0, max) : candidates
  return {
    items: kept.map(candidate => ({ path: candidate.entry.path, kind: candidate.entry.kind, ranges: candidate.ranges })),
    truncated: candidates.length > max,
  }
}
