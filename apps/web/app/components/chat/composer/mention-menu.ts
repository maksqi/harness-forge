// Web-only helpers of the `@` file menu (docs/UI.md 7.26; ADR-042; phase-9 open point 13). They neither parse nor rank:
// the token comes from `mentionTokenAt`, the mention text from `formatMention` and the matched ranges from `scorePath`
// (`@harness-forge/shared` `util/mentions.ts`, the only implementation of those rules). Here: replacing the token with
// a picked entry, the highlight runs of a row (rendered as `<mark>`, no raw HTML rendering), the row labels, and the copy of
// search and attach errors.
import type { HarnessError, MatchRange, ProjectFileEntry } from '@harness-forge/shared'
import { formatMention, LIMITS, scorePath } from '@harness-forge/shared'

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
