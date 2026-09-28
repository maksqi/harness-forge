// What read-aloud says (docs/UI.md 7.18; ADR-029): the markdown of a reply's text parts turned into plain sentences,
// then split into the chunks of `POST /api/audio/speech`. Pure functions, no Vue.
// - speechText(): a code fence becomes "{Language} code omitted." ("Code omitted." without a language, "Diagram
//   omitted." for mermaid), a table "Table omitted.", a `$$` (or `\[`) block "Formula omitted." and inline math
//   "formula"; links read their label, bare URLs and autolinks "link", images their alt text; every other piece of
//   markdown and HTML is stripped. Each block (paragraph, heading, list item) ends with sentence punctuation, one block
//   per line, so the voice pauses between them.
// - speechChunks(): splits at sentence ends: the first chunk at most 300 characters (a fast start), then at most 1,500,
//   never more than 4,096 (LIMITS.speechFirstChunkChars / speechChunkChars / speechTextMaxChars). A sentence longer
//   than a chunk breaks at a clause break or a space.
import { LIMITS } from '@harness-forge/shared'

/** Readable names of common code fence languages ("TypeScript code omitted."); others are capitalized as written. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  'bash': 'Shell',
  'sh': 'Shell',
  'shell': 'Shell',
  'zsh': 'Shell',
  'console': 'Shell',
  'shellsession': 'Shell',
  'powershell': 'PowerShell',
  'ps1': 'PowerShell',
  'bat': 'Batch',
  'cmd': 'Batch',
  'c': 'C',
  'h': 'C',
  'cpp': 'C++',
  'c++': 'C++',
  'cc': 'C++',
  'hpp': 'C++',
  'cs': 'C#',
  'csharp': 'C#',
  'c#': 'C#',
  'css': 'CSS',
  'scss': 'SCSS',
  'sass': 'Sass',
  'less': 'Less',
  'csv': 'CSV',
  'dart': 'Dart',
  'diff': 'Diff',
  'patch': 'Diff',
  'docker': 'Dockerfile',
  'dockerfile': 'Dockerfile',
  'elixir': 'Elixir',
  'ex': 'Elixir',
  'go': 'Go',
  'golang': 'Go',
  'graphql': 'GraphQL',
  'gql': 'GraphQL',
  'haskell': 'Haskell',
  'hs': 'Haskell',
  'hcl': 'HCL',
  'html': 'HTML',
  'http': 'HTTP',
  'ini': 'INI',
  'java': 'Java',
  'javascript': 'JavaScript',
  'js': 'JavaScript',
  'mjs': 'JavaScript',
  'cjs': 'JavaScript',
  'jsx': 'JSX',
  'json': 'JSON',
  'jsonc': 'JSON',
  'json5': 'JSON',
  'kotlin': 'Kotlin',
  'kt': 'Kotlin',
  'latex': 'LaTeX',
  'tex': 'LaTeX',
  'lua': 'Lua',
  'make': 'Makefile',
  'makefile': 'Makefile',
  'markdown': 'Markdown',
  'md': 'Markdown',
  'nginx': 'Nginx',
  'nix': 'Nix',
  'objc': 'Objective-C',
  'objective-c': 'Objective-C',
  'perl': 'Perl',
  'pl': 'Perl',
  'php': 'PHP',
  'prisma': 'Prisma',
  'proto': 'Protobuf',
  'protobuf': 'Protobuf',
  'py': 'Python',
  'python': 'Python',
  'r': 'R',
  'rb': 'Ruby',
  'ruby': 'Ruby',
  'regex': 'Regex',
  'rs': 'Rust',
  'rust': 'Rust',
  'scala': 'Scala',
  'sol': 'Solidity',
  'solidity': 'Solidity',
  'sql': 'SQL',
  'svelte': 'Svelte',
  'svg': 'SVG',
  'swift': 'Swift',
  'terraform': 'Terraform',
  'tf': 'Terraform',
  'toml': 'TOML',
  'ts': 'TypeScript',
  'typescript': 'TypeScript',
  'tsx': 'TSX',
  'vue': 'Vue',
  'xml': 'XML',
  'yaml': 'YAML',
  'yml': 'YAML',
  'zig': 'Zig',
}

/** Fence "languages" that name no language: "Code omitted.". */
const PLAIN_LANGUAGES = new Set(['text', 'txt', 'plain', 'plaintext', 'output', 'log', 'none', 'nohighlight'])

/** Fence languages that are diagrams: "Diagram omitted.". */
const DIAGRAM_LANGUAGES = new Set(['mermaid'])

export const CODE_OMITTED = 'Code omitted.'
export const DIAGRAM_OMITTED = 'Diagram omitted.'
export const TABLE_OMITTED = 'Table omitted.'
export const FORMULA_OMITTED = 'Formula omitted.'
/** What an inline formula reads inside a sentence. */
export const INLINE_FORMULA = 'formula'
/** What a URL reads inside a sentence. */
export const LINK_WORD = 'link'

/** "TypeScript code omitted." for the info string of a fence ("ts", "ts title=a.ts", "{.python}"). */
export function codeOmittedText(info: string): string {
  const language = info.match(/^[{.\s]*([\w+#.-]{1,32})/)?.[1]?.toLowerCase().replace(/^\.+|\.+$/g, '')
  if (!language || PLAIN_LANGUAGES.has(language))
    return CODE_OMITTED
  if (DIAGRAM_LANGUAGES.has(language))
    return DIAGRAM_OMITTED
  const name = LANGUAGE_NAMES[language] ?? `${language.charAt(0).toUpperCase()}${language.slice(1)}`
  return `${name} code omitted.`
}

// ---------- blocks ----------

const THEMATIC_BREAK = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/
const SETEXT_UNDERLINE = /^\s{0,3}(?:=+|-+)\s*$/
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s(.*)$/
const TASK_MARKER = /^\[[ x]\]\s+/i
const REFERENCE_DEFINITION = /^\s{0,3}\[(?!\^)[^\]]+\]:\s*\S/
const FOOTNOTE_DEFINITION = /^\s{0,3}\[\^[^\]]+\]:\s*/
const TABLE_CELL_DELIMITER = /^:?-+:?$/
const BLOCKQUOTE_MARKERS = /^\s{0,3}(?:>\s?)+/
const BLANK = /^\s*$/

/** The opening line of a code fence: its marker (three or more backticks or tildes) and info string, or null. */
function fenceOpen(line: string): { marker: string, info: string } | null {
  const trimmed = line.trimStart()
  const char = trimmed.charAt(0)
  if (char !== '`' && char !== '~')
    return null
  let length = 0
  while (trimmed.charAt(length) === char)
    length++
  const info = trimmed.slice(length)
  // A backtick fence's info string never holds a backtick (that line is inline code).
  if (length < 3 || (char === '`' && info.includes('`')))
    return null
  return { marker: char.repeat(length), info }
}

/** The text of an ATX heading line (`## Setup ##` -> "Setup"), or null for any other line. */
function atxHeading(line: string): string | null {
  const open = line.match(/^ {0,3}#{1,6}(?:[ \t]|$)/)
  if (!open)
    return null
  return line.slice(open[0].length).trim().replace(/(?:^|[ \t])#+$/, '').trim()
}

/** A GFM table delimiter row: pipe-separated cells of dashes with optional colons (`| --- | :-: |`, `--|--`). */
function isTableDelimiter(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|'))
    return false
  const inner = trimmed.slice(trimmed.startsWith('|') ? 1 : 0, trimmed.endsWith('|') ? -1 : undefined)
  return inner.split('|').every(cell => TABLE_CELL_DELIMITER.test(cell.trim()))
}

function fenceCloses(line: string, marker: string): boolean {
  const trimmed = line.trim()
  if (trimmed.length < marker.length || !trimmed.startsWith(marker))
    return false
  const char = marker.charAt(0)
  return [...trimmed].every(item => item === char)
}

/** Index of the last line of a display formula starting at `start` (`$$ … $$` or `\[ … \]`), or -1. */
function formulaEnd(lines: readonly string[], start: number): number {
  const first = lines[start]!.trim()
  const [open, close] = first.startsWith('$$') ? ['$$', '$$'] : first.startsWith('\\[') ? ['\\[', '\\]'] : ['', '']
  if (!open)
    return -1
  if (first.includes(close, open.length))
    return start
  for (let index = start + 1; index < lines.length; index++) {
    if (lines[index]!.includes(close))
      return index
  }
  return lines.length - 1
}

/** A GFM table starts here: a row with a pipe followed by a delimiter row (`| --- | :-: |`). */
function isTableStart(lines: readonly string[], index: number): boolean {
  const next = lines[index + 1]
  return lines[index]!.includes('|') && next !== undefined && isTableDelimiter(next)
}

/** Sentence punctuation at the end of a block, so the voice pauses before the next one. */
function endSentence(text: string): string {
  if (/[.!?…:;]["'”’)\]]*$/.test(text))
    return text
  return `${text.replace(/,+$/, '')}.`
}

/**
 * The words read aloud for the markdown of a reply: one block per line (paragraphs, headings, list items, and the
 * "… omitted." notes of code, diagrams, tables and formulas), every block ending with sentence punctuation.
 */
export function speechText(markdown: string): string {
  const source = markdown
    .replace(/\r\n?/g, '\n')
    .replace(/[\uE000\uE001]/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
  const lines = source.split('\n').map(line => line.replace(BLOCKQUOTE_MARKERS, ''))
  const blocks: string[] = []
  let paragraph: string[] = []

  const push = (text: string) => {
    if (text)
      blocks.push(endSentence(text))
  }
  const flush = () => {
    if (paragraph.length > 0)
      push(inlineText(paragraph.join(' ')))
    paragraph = []
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = fenceOpen(line)
    if (fence) {
      flush()
      let end = index + 1
      while (end < lines.length && !fenceCloses(lines[end]!, fence.marker))
        end++
      blocks.push(codeOmittedText(fence.info))
      index = end
      continue
    }
    const formula = /^\s*(?:\$\$|\\\[)/.test(line) ? formulaEnd(lines, index) : -1
    if (formula >= 0) {
      flush()
      blocks.push(FORMULA_OMITTED)
      index = formula
      continue
    }
    if (isTableStart(lines, index)) {
      flush()
      let end = index + 2
      while (end < lines.length && !BLANK.test(lines[end]!) && lines[end]!.includes('|'))
        end++
      blocks.push(TABLE_OMITTED)
      index = end - 1
      continue
    }
    if (BLANK.test(line) || THEMATIC_BREAK.test(line) || SETEXT_UNDERLINE.test(line)) {
      flush()
      continue
    }
    const heading = atxHeading(line)
    if (heading !== null) {
      flush()
      push(inlineText(heading))
      continue
    }
    if (REFERENCE_DEFINITION.test(line))
      continue
    const item = line.match(LIST_ITEM)
    if (item) {
      flush()
      paragraph.push(item[1]!.trim().replace(TASK_MARKER, ''))
      continue
    }
    paragraph.push(line.replace(FOOTNOTE_DEFINITION, '').replace(/\\$/, '').trim())
  }
  flush()
  return blocks.join('\n')
}

// ---------- inline ----------

/** Pieces set aside while the rest of a block is stripped (code spans, math, escapes): U+E000 index U+E001. */
const PLACEHOLDER = /\uE000(\d+)\uE001/g
/** A link or image target with one level of balanced parentheses and an optional title: `(url "title")`. */
const LINK_TARGET = String.raw`\((?:[^()\n]|\([^()\n]*\))*\)`
const IMAGE = new RegExp(String.raw`!\[([^\]\n]*)\](?:${LINK_TARGET}|\[[^\]\n]*\])`, 'g')
const LINK = new RegExp(String.raw`\[([^\]\n]+)\](?:${LINK_TARGET}|\[[^\]\n]*\])`, 'g')
const AUTOLINK_URL = /<(?:https?|ftp):\/\/[^\s>]*>/gi
const AUTOLINK_EMAIL = /<(?:mailto:)?([^\s<>@]+@[^\s<>]+)>/gi
const BARE_URL = /\b(?:https?:\/\/|www\.)[^\s<>]+/gi
const HTML_BREAK = /<br\s*\/?>/gi
const HTML_TAG = /<\/?[a-z][\w:-]*(?:\s[^<>]*)?\/?>/gi
const ENTITIES: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }

/** A bare URL reads "link"; trailing punctuation (and an unbalanced closing parenthesis) stays in the sentence. */
function replaceUrl(url: string): string {
  let end = url.length
  while (end > 0) {
    const char = url.charAt(end - 1)
    if ('.,:;!?*_~\'"'.includes(char)) {
      end--
      continue
    }
    if (char === ')') {
      const body = url.slice(0, end)
      if ((body.match(/\(/g)?.length ?? 0) < (body.match(/\)/g)?.length ?? 0)) {
        end--
        continue
      }
    }
    break
  }
  return `${LINK_WORD}${url.slice(end)}`
}

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (entity, body: string) => {
    const lower = body.toLowerCase()
    if (lower.startsWith('#')) {
      const code = lower.startsWith('#x') ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10)
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : entity
    }
    return ENTITIES[lower] ?? entity
  })
}

function stripEmphasis(text: string): string {
  return text
    .replace(/(\*{3}|_{3})(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
    .replace(/\*(?=[^\s*])([^*]*?[^\s*])\*/g, '$1')
    .replace(/(^|[^\p{L}\p{N}_])_(?=[^\s_])([^_]*?[^\s_])_(?![\p{L}\p{N}_])/gu, '$1$2')
}

/** One block of markdown as plain words: code spans keep their text, links their label, math reads "formula". */
function inlineText(markdown: string): string {
  const saved: string[] = []
  const save = (text: string) => `\uE000${saved.push(text) - 1}\uE001`
  let text = markdown
    // Code spans first: nothing inside them is markdown.
    .replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_match, _ticks: string, code: string) => save(code.trim().replace(BARE_URL, replaceUrl)))
    // Inline math: display math written inline, \( \), and $…$ that cannot be an amount of money.
    .replace(/\$\$(?=\S)[\s\S]*?\$\$/g, () => save(INLINE_FORMULA))
    .replace(/\\\([\s\S]*?\\\)/g, () => save(INLINE_FORMULA))
    .replace(/(?<![\\$\w])\$(?=[^\s$])[^$\n]*?[^\s$\\]\$(?![\d$])/g, () => save(INLINE_FORMULA))
    // Backslash escapes: the character itself, never markdown.
    .replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, (_match, char: string) => save(char))
  text = text
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(AUTOLINK_URL, LINK_WORD)
    .replace(AUTOLINK_EMAIL, '$1')
    .replace(BARE_URL, replaceUrl)
    .replace(HTML_BREAK, ' ')
    .replace(HTML_TAG, '')
    .replace(/\[\^[^\]\s]+\]/g, '')
  text = stripEmphasis(decodeEntities(text))
  // Restore the saved pieces (a code span may hold a saved escape: a second pass settles it).
  for (let pass = 0; pass < 2 && text.includes('\uE000'); pass++)
    text = text.replace(PLACEHOLDER, (_match, index: string) => saved[Number(index)] ?? '')
  return text.replace(/\s+/g, ' ').trim()
}

// ---------- chunks ----------

export interface SpeechChunkLimits {
  /** Characters of the first chunk (a fast start); default LIMITS.speechFirstChunkChars (300). */
  first?: number
  /** Characters of every later chunk; default LIMITS.speechChunkChars (1,500). */
  rest?: number
  /** Hard cap of any chunk; default and maximum LIMITS.speechTextMaxChars (4,096). */
  max?: number
}

/** A sentence ends at `.`, `!`, `?` or `…` (plus closing quotes or brackets) followed by a space, and at a line break. */
const SENTENCE_END = /[.!?…]+["'”’)\]]*(?:\s+|$)|\n+/g
/** A clause break inside a long sentence: after `,`, `;`, `:` or a dash between spaces. */
const CLAUSE_BREAK = /[,;:]\s+|\s[–—-]\s+/g

function sentenceSegments(text: string): string[] {
  const segments: string[] = []
  let start = 0
  for (const match of text.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    if (end > start) {
      segments.push(text.slice(start, end))
      start = end
    }
  }
  if (start < text.length)
    segments.push(text.slice(start))
  return segments
}

/**
 * Where a piece longer than `limit` breaks: after the last clause break of the second half, else at the last space,
 * else at `limit` (never inside a surrogate pair). The part before the break, trimmed, is at most `limit` characters.
 */
function breakIndex(text: string, limit: number): number {
  const window = text.slice(0, limit + 1)
  let clause = -1
  for (const match of window.matchAll(CLAUSE_BREAK)) {
    if (match.index >= limit / 2)
      clause = match.index + match[0].length
  }
  if (clause > 0)
    return clause
  for (let index = window.length - 1; index > 0; index--) {
    if (/\s/.test(window.charAt(index)))
      return index
  }
  const code = text.charCodeAt(limit - 1)
  return limit > 1 && code >= 0xD800 && code <= 0xDBFF ? limit - 1 : limit
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(Math.floor(value), max))
}

/**
 * Splits plain text into the chunks of `POST /api/audio/speech`, at sentence ends: the first at most `first`
 * characters, the others at most `rest`, none over `max`. Chunks are trimmed and never empty.
 */
export function speechChunks(text: string, limits: SpeechChunkLimits = {}): string[] {
  const max = clampLimit(limits.max ?? LIMITS.speechTextMaxChars, LIMITS.speechTextMaxChars)
  const first = clampLimit(limits.first ?? LIMITS.speechFirstChunkChars, max)
  const rest = clampLimit(limits.rest ?? LIMITS.speechChunkChars, max)
  const chunks: string[] = []
  const limit = () => (chunks.length === 0 ? first : rest)
  let current = ''
  const pushCurrent = () => {
    const chunk = current.trim()
    if (chunk)
      chunks.push(chunk)
    current = ''
  }
  for (const segment of sentenceSegments(text)) {
    if ((current + segment).trim().length <= limit()) {
      current += segment
      continue
    }
    pushCurrent()
    let piece = segment.replace(/^\s+/, '')
    while (piece.trim().length > limit()) {
      const cut = breakIndex(piece, limit())
      const head = piece.slice(0, cut).trim()
      if (head)
        chunks.push(head)
      piece = piece.slice(cut).replace(/^\s+/, '')
    }
    current = piece
  }
  pushCurrent()
  return chunks
}

/** The chunks read aloud for the markdown of a reply (`speechChunks(speechText(markdown))`). */
export function readAloudChunks(markdown: string): string[] {
  return speechChunks(speechText(markdown))
}
