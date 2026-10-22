// Web-only helpers of the `@` file menu (docs/UI.md 7.26; ADR-042; phase-9 open point 13). They neither parse nor rank:
// the token comes from `mentionTokenAt`, the mention text from `formatMention` and the matched ranges from `scorePath`
// (`@harness-forge/shared` `util/mentions.ts`, the only implementation of those rules). Here: replacing the token with
// a picked entry, the highlight runs of a row (rendered as `<mark>`, no raw HTML rendering), the row labels, and the copy of
// search and attach errors.
// Phase 14 (ADR-061; docs/UI.md 7.35; W14.8): the MCP resource rows of the same menu: replacing the token with a picked
// resource (`formatResourceMention`), a row's title, icon kind and accessible name, the resource count, the "Not listed"
// line and the copy of attach errors. Resource texts are untrusted: they are rendered as plain text.
import type { HarnessError, MatchRange, McpResourceEntry, ProjectFileEntry } from '@harness-forge/shared'
import { formatMention, formatResourceMention, LIMITS, scorePath } from '@harness-forge/shared'

/** The token the entry replaces: `[start, end)` of the text (`mentionTokenAt`). */
export interface MentionTokenRange {
  start: number
  end: number
}

/** The text after picking an entry, the caret, and whether the menu stays open (a folder was picked). */
export interface MentionReplacement {
  text: string
  caret: number
  keepOpen: boolean
}

const WHITESPACE = /\s/

/**
 * Replaces the `@` token with a picked entry. A file becomes its mention (`formatMention(path)`, which already starts
 * with `@`) and one blank (an existing blank after the token is reused); the caret goes after the blank. A folder
 * becomes `@folder/` (`@"my folder/"` when quoted, with the caret before the closing quote) and the menu stays open on
 * it. A path that cannot be written as a mention (it holds `"` or a line break) just removes the token.
 */
export function replaceMentionToken(text: string, token: MentionTokenRange, entry: ProjectFileEntry): MentionReplacement {
  const before = text.slice(0, token.start)
  const after = text.slice(token.end)
  if (entry.kind === 'dir') {
    const folder = entry.path.endsWith('/') ? entry.path : `${entry.path}/`
    const mention = formatMention(folder)
    if (mention) {
      const caret = before.length + (mention.endsWith('"') ? mention.length - 1 : mention.length)
      return { text: `${before}${mention}${after}`, caret, keepOpen: true }
    }
    return { text: `${before}${after}`, caret: before.length, keepOpen: false }
  }
  const mention = formatMention(entry.path)
  if (!mention)
    return { text: `${before}${after}`, caret: before.length, keepOpen: false }
  const blank = WHITESPACE.test(after.charAt(0)) ? '' : ' '
  const value = `${before}${mention}${blank}${after}`
  return { text: value, caret: before.length + mention.length + 1, keepOpen: false }
}

/** One run of a row label: matched characters are highlighted. */
export interface HighlightRun {
  text: string
  match: boolean
}

/** The label of a row: the base name (folders end with `/`) and the folder it is in (`src/`; '' at the root). */
export interface MentionRowLabel {
  name: HighlightRun[]
  folder: HighlightRun[]
}

/** Index where the base name of a project-relative path starts. */
function baseNameStart(path: string): number {
  let end = path.length
  while (end > 0 && path[end - 1] === '/')
    end--
  return end === 0 ? 0 : path.lastIndexOf('/', end - 1) + 1
}

/** The base name of a project-relative path (`src/parser.ts` -> `parser.ts`). */
export function pathBaseName(path: string): string {
  const start = baseNameStart(path)
  return path.slice(start).replace(/\/+$/, '') || path
}

/** The runs of `path.slice(from, to)`, highlighted where `ranges` cover them. */
function runsOf(path: string, from: number, to: number, ranges: readonly MatchRange[]): HighlightRun[] {
  const runs: HighlightRun[] = []
  let index = from
  for (const [start, end] of ranges) {
    const left = Math.max(start, from)
    const right = Math.min(end, to)
    if (right <= left)
      continue
    if (left > index)
      runs.push({ text: path.slice(index, left), match: false })
    runs.push({ text: path.slice(left, right), match: true })
    index = right
  }
  if (index < to)
    runs.push({ text: path.slice(index, to), match: false })
  return runs
}

/** The label of a menu row with the characters `scorePath(query, path)` matched (no ranges for the empty query). */
export function mentionRowLabel(entry: ProjectFileEntry, query: string): MentionRowLabel {
  const path = entry.path.replace(/\/+$/, '')
  const ranges = scorePath(query, path)?.ranges ?? []
  const start = baseNameStart(path)
  const name = runsOf(path, start, path.length, ranges)
  if (entry.kind === 'dir')
    name.push({ text: '/', match: false })
  return { name, folder: runsOf(path, 0, start, ranges) }
}

/** The polite count of the menu: "{n} files" / "1 file" / "No matching files". */
export function mentionCountLabel(count: number): string {
  if (count === 0)
    return 'No matching files'
  return count === 1 ? '1 file' : `${count} files`
}

/** The error line of the menu: a folder that cannot be opened (400) has its own text. */
export function mentionErrorMessage(error: HarnessError | null | undefined): string {
  return error?.code === 'validation_error' ? 'The project folder is unavailable.' : 'Couldn\'t search files.'
}

const MENTION_LIMIT_MB = Math.round(LIMITS.mentionFileMaxBytes / (1024 * 1024))

function issuePaths(error: HarnessError): string[] {
  const details = error.details as { issues?: unknown } | undefined
  if (!details || !Array.isArray(details.issues))
    return []
  return details.issues.flatMap((issue: unknown) => {
    const path = (issue as { path?: unknown } | null)?.path
    return Array.isArray(path) ? [path.join('.')] : []
  })
}

/**
 * The description of the toast "{path} can't be attached": 413 -> the 5 MB cap, 404 -> the file is gone, a type the
 * upload refuses (its issue is on `file`) -> the accepted types, any other 400 -> the server's message.
 */
export function projectAttachErrorText(error: HarnessError): string {
  if (error.code === 'payload_too_large')
    return `Files can be up to ${MENTION_LIMIT_MB} MB.`
  if (error.code === 'not_found')
    return 'The file no longer exists.'
  if (error.code === 'validation_error' && issuePaths(error).includes('file'))
    return 'Attach images, PDFs or text files.'
  return error.message
}

// ---------- MCP resources (Phase 14, ADR-061) ----------

/**
 * Replaces the `@` token with a picked MCP resource: its mention (`formatResourceMention(serverId, uri)`, display text
 * only: the resource travels as an attached file) and one blank (an existing blank after the token is reused); the caret
 * goes after the blank. A resource whose id or URI cannot be written as a mention just removes the token.
 */
export function replaceResourceToken(text: string, token: MentionTokenRange, entry: Pick<McpResourceEntry, 'serverId' | 'uri'>): MentionReplacement {
  const before = text.slice(0, token.start)
  const after = text.slice(token.end)
  const mention = formatResourceMention(entry.serverId, entry.uri)
  if (!mention)
    return { text: `${before}${after}`, caret: before.length, keepOpen: false }
  const blank = WHITESPACE.test(after.charAt(0)) ? '' : ' '
  return { text: `${before}${mention}${blank}${after}`, caret: before.length + mention.length + 1, keepOpen: false }
}

/** The title of a resource row and its chip: the resource's title, else its name, else its URI. */
export function resourceTitle(entry: Pick<McpResourceEntry, 'title' | 'name' | 'uri'>): string {
  return entry.title?.trim() || entry.name.trim() || entry.uri
}

/** The icon of a resource row from its MIME type (`FileText`, `Image`, `FileType` for PDF, else `File`). */
export type ResourceIconKind = 'text' | 'image' | 'pdf' | 'file'

export function resourceIconKind(mimeType: string | undefined): ResourceIconKind {
  const mime = mimeType?.trim().toLowerCase() ?? ''
  if (mime.startsWith('image/'))
    return 'image'
  if (mime === 'application/pdf')
    return 'pdf'
  if (mime.startsWith('text/') || mime === 'application/json' || mime.endsWith('+json') || mime.endsWith('+xml') || mime === 'application/xml')
    return 'text'
  return 'file'
}

/** The accessible name of a resource row: "{title}, {server}, {mime type}" (the MIME type when the server gave one). */
export function resourceOptionLabel(entry: Pick<McpResourceEntry, 'title' | 'name' | 'uri' | 'serverName' | 'serverId' | 'mimeType'>): string {
  const parts = [resourceTitle(entry), entry.serverName.trim() || entry.serverId]
  if (entry.mimeType?.trim())
    parts.push(entry.mimeType.trim())
  return parts.join(', ')
}

/** The polite count of the resource section: "{n} resources" / "1 resource" / "No matching resources". */
export function resourceCountLabel(count: number): string {
  if (count === 0)
    return 'No matching resources'
  return count === 1 ? '1 resource' : `${count} resources`
}

/** The line under the resource rows naming the servers whose resources are missing: "Not listed: {names} (not connected)." */
export function resourcesUnavailableText(names: readonly string[]): string | null {
  const shown = names.map(name => name.trim()).filter(name => name !== '')
  if (shown.length === 0)
    return null
  return `Not listed: ${shown.join(', ')} (not connected).`
}

const RESOURCE_LIMIT_MB = Math.round(LIMITS.mcpResourceReadBytes / (1024 * 1024))

/**
 * The toast of a resource that could not be attached (docs/UI.md 7.35): 413 -> "This resource is larger than 5 MB.",
 * 409 `needs-auth` -> "Sign in to {server} first.", anything else -> "Couldn't attach {name}.".
 */
export function resourceAttachErrorText(error: Pick<HarnessError, 'code' | 'details'> | null | undefined, name: string, server: string): string {
  if (error?.code === 'payload_too_large')
    return `This resource is larger than ${RESOURCE_LIMIT_MB} MB.`
  const reason = (error?.details as { reason?: unknown } | undefined)?.reason
  if (error?.code === 'conflict' && reason === 'needs-auth')
    return `Sign in to ${server} first.`
  return `Couldn't attach ${name}.`
}
