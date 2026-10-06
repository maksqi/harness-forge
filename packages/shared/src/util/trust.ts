/**
 * Project trust (Phase 11, ADR-049): the canonical text whose sha256 pins an executable item of a project folder (a
 * hook of its settings files, a server of its `.mcp.json`, a command file with `` !`cmd` `` spans), and the script
 * files a command names (their sha256 is part of the item's hash, so editing `.claude/hooks/check.sh` makes the hook
 * pending again). The server hashes `trustHashInput(item)` with sha256 (`node:crypto`); this module only canonicalizes.
 * Pure and isomorphic; never throws. Contract skeleton written by the coordinator in P11-0a (K1); implemented by C35.
 *
 * Import note: this module imports `util/shell-command.ts`, which imports `limits.ts`; `limits.ts` must therefore never
 * import this module (an import cycle that fails at load time).
 */
import { parseShellCommand } from './shell-command.ts'

export const TRUST_ITEM_KINDS = ['hook', 'mcp', 'command'] as const
export type TrustItemKind = (typeof TRUST_ITEM_KINDS)[number]

/** Mirrored by the Phase 11 group of `LIMITS`. */
export const TRUST_LIMITS = {
  /** Referenced script files hashed per item. */
  refFilesMax: 8,
  /** A referenced file larger than this is hashed as missing (`sha256: null`, warning `referenced-file-missing`). */
  refFileBytes: 1_048_576,
} as const

/** A project-relative file a command names, with its content hash (null = missing, unreadable or too large). */
export interface TrustRef {
  readonly path: string
  readonly sha256: string | null
}

export type TrustHashItem
  = | {
    readonly kind: 'hook'
    readonly event: string
    readonly matcher: string | null
    readonly command: string
    readonly timeoutSec: number | null
    readonly refs: readonly TrustRef[]
  }
  | {
    readonly kind: 'mcp'
    readonly name: string
    /** The raw (unexpanded) server object of `.mcp.json`. */
    readonly server: unknown
    readonly refs: readonly TrustRef[]
  }
  | {
    readonly kind: 'command'
    readonly name: string
    /** The `!` span commands of the file, in order. */
    readonly spans: readonly string[]
    readonly refs: readonly TrustRef[]
  }

/** Version of the canonical layout (the second element of every `trustHashInput` array). */
const TRUST_HASH_VERSION = 1

// ---------------------------------------------------------------------------------------------------------------------
// Canonical JSON

type Frame
  = | { readonly kind: 'value', readonly value: unknown, readonly inArray: boolean }
    | { readonly kind: 'text', readonly text: string }
    | { readonly kind: 'leave', readonly value: object }

/** True for values JSON leaves out of objects (and writes as `null` in arrays). */
function isSkipped(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol'
}

function primitiveJson(value: unknown): string | null {
  if (value === null)
    return 'null'
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value)
    case 'number':
      return Number.isFinite(value) ? JSON.stringify(value) : 'null'
    case 'boolean':
      return value ? 'true' : 'false'
    case 'bigint':
      return JSON.stringify(value.toString())
    case 'undefined':
    case 'function':
    case 'symbol':
      return 'null'
    default:
      return null
  }
}

/** Iterative (no recursion, so any nesting depth works); a value that refers to itself is written as `null`. */
function canonicalize(root: unknown): string {
  const out: string[] = []
  const active = new Set<object>()
  const stack: Frame[] = [{ kind: 'value', value: root, inArray: false }]
  while (stack.length > 0) {
    const frame = stack.pop() as Frame
    if (frame.kind === 'text') {
      out.push(frame.text)
      continue
    }
    if (frame.kind === 'leave') {
      active.delete(frame.value)
      continue
    }
    const value = frame.value
    const primitive = primitiveJson(value)
    if (primitive !== null) {
      out.push(primitive)
      continue
    }
    const object = value as object
    if (active.has(object)) {
      out.push('null')
      continue
    }
    active.add(object)
    if (Array.isArray(object)) {
      const items = object as readonly unknown[]
      const frames: Frame[] = [{ kind: 'text', text: '[' }]
      for (let index = 0; index < items.length; index++) {
        if (index > 0)
          frames.push({ kind: 'text', text: ',' })
        frames.push({ kind: 'value', value: items[index], inArray: true })
      }
      frames.push({ kind: 'text', text: ']' }, { kind: 'leave', value: object })
      for (let index = frames.length - 1; index >= 0; index--)
        stack.push(frames[index] as Frame)
      continue
    }
    const record = object as Record<string, unknown>
    const keys = Object.keys(record).filter(key => !isSkipped(record[key])).sort()
    const frames: Frame[] = [{ kind: 'text', text: '{' }]
    keys.forEach((key, index) => {
      frames.push({ kind: 'text', text: `${index > 0 ? ',' : ''}${JSON.stringify(key)}:` }, { kind: 'value', value: record[key], inArray: false })
    })
    frames.push({ kind: 'text', text: '}' }, { kind: 'leave', value: object })
    for (let index = frames.length - 1; index >= 0; index--)
      stack.push(frames[index] as Frame)
  }
  return out.join('')
}

/**
 * JSON with object keys sorted recursively (UTF-16 code unit order) and no whitespace; stable under key order and
 * formatting. Plain JSON semantics otherwise: `undefined`, functions and symbols are left out of objects and written as
 * `null` in arrays, non-finite numbers are `null`, a bigint is its decimal string, a cycle is `null`.
 */
export function canonicalJson(value: unknown): string {
  try {
    return canonicalize(value)
  }
  catch {
    // A throwing getter or proxy.
    return 'null'
  }
}

function canonicalRefs(refs: unknown): { path: string, sha256: string | null }[] {
  if (!Array.isArray(refs))
    return []
  const seen = new Set<string>()
  const result: { path: string, sha256: string | null }[] = []
  for (const ref of refs as readonly unknown[]) {
    if (typeof ref !== 'object' || ref === null)
      continue
    const { path, sha256 } = ref as { path?: unknown, sha256?: unknown }
    if (typeof path !== 'string')
      continue
    const hash = typeof sha256 === 'string' ? sha256 : null
    const key = `${path}\u0000${hash ?? ''}`
    if (seen.has(key))
      continue
    seen.add(key)
    result.push({ path, sha256: hash })
  }
  return result.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : (a.sha256 ?? '') < (b.sha256 ?? '') ? -1 : (a.sha256 ?? '') > (b.sha256 ?? '') ? 1 : 0)
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/**
 * The canonical text of an item: a JSON array `[kind, 1, …fields, refs]` (refs `{ path, sha256 }` sorted by path,
 * duplicates removed):
 * - hook: `['hook', 1, event, matcher, command, timeoutSec, refs]`;
 * - mcp: `['mcp', 1, name, server, refs]` (the raw server object, keys sorted);
 * - command: `['command', 1, name, spans, refs]`.
 */
export function trustHashInput(item: TrustHashItem): string {
  if (typeof item !== 'object' || item === null)
    return canonicalJson(null)
  const refs = canonicalRefs((item as { refs?: unknown }).refs)
  switch (item.kind) {
    case 'hook': {
      const timeout = typeof item.timeoutSec === 'number' && Number.isFinite(item.timeoutSec) ? item.timeoutSec : null
      return canonicalJson(['hook', TRUST_HASH_VERSION, textOrNull(item.event), textOrNull(item.matcher), textOrNull(item.command), timeout, refs])
    }
    case 'mcp':
      return canonicalJson(['mcp', TRUST_HASH_VERSION, textOrNull(item.name), item.server ?? null, refs])
    case 'command': {
      const spans = Array.isArray(item.spans) ? (item.spans as readonly unknown[]).map(textOrNull) : []
      return canonicalJson(['command', TRUST_HASH_VERSION, textOrNull(item.name), spans, refs])
    }
    default:
      return canonicalJson([null, TRUST_HASH_VERSION, refs])
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Referenced files

/** Commands longer than this are scanned up to here (hook commands are ≤ 4096 characters). */
const COMMAND_SCAN_MAX_CHARS = 65_536
/** File extensions of scripts a relative path (`scripts/check.sh`) or a bare file name (`count.sh`) is recognized by. */
const SCRIPT_EXTENSIONS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'ksh',
  'py',
  'rb',
  'pl',
  'php',
  'lua',
  'js',
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'r',
  'ps1',
])
/** `$CLAUDE_PROJECT_DIR` / `${HARNESS_PROJECT_DIR}` prefixes, optionally inside double quotes (`"$VAR"/x`, `"$VAR/x"`). */
const PROJECT_DIR_PREFIX = /^("?)\$(?:\{(?:CLAUDE|HARNESS)_PROJECT_DIR\}|(?:CLAUDE|HARNESS)_PROJECT_DIR)("?)\//
/** Characters a referenced path may not hold (shell syntax, globs, quotes, escapes; control characters separately). */
const UNSAFE_PATH_CHARACTER = /["$&'()*;<>?[\\\]`{|}~!]/

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7F)
      return true
  }
  return false
}

/** `word` without the shell punctuation that may trail a word of the whitespace fallback (`x.sh;`, `x.sh)`). */
function withoutTrailingPunctuation(word: string): string {
  let end = word.length
  while (end > 0 && ';&|)'.includes(word[end - 1] as string))
    end--
  return word.slice(0, end)
}

/** The project-relative normal form of `path`: `./` and `.` segments removed, slashes collapsed; null when unusable. */
function normalizeRef(path: string): string | null {
  if (path === '' || path.startsWith('/') || UNSAFE_PATH_CHARACTER.test(path) || hasControlCharacter(path) || path.endsWith('/'))
    return null
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.')
      continue
    if (segment === '..')
      return null
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join('/')
}

function hasScriptExtension(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 && SCRIPT_EXTENSIONS.has(base.slice(dot + 1).toLowerCase())
}

/**
 * A word the extension rule never reads as a file: an option or an option value (`-x`, `--config=x.sh`), an assignment
 * (`HOOK=x.sh`), a URL or a remote path (`https://host/x.sh`, `host:x.sh`).
 */
function isOptionOrUrl(token: string): boolean {
  return token.startsWith('-') || token.includes('=') || token.includes(':')
}

/**
 * How a word was obtained: `parsed` (unquoted by `parseShellCommand`, which refuses `$`), `split` (the whitespace
 * fallback: quotes and trailing shell punctuation still present) or `argv` (one literal argument).
 */
type WordMode = 'parsed' | 'split' | 'argv'

/** The path after a `$CLAUDE_PROJECT_DIR` / `${HARNESS_PROJECT_DIR}` prefix (quotes handled per mode), else undefined. */
function projectDirRest(token: string, mode: WordMode): string | null | undefined {
  const prefix = token.match(PROJECT_DIR_PREFIX)
  if (prefix === null)
    return undefined
  const opening = prefix[1] ?? ''
  const closing = prefix[2] ?? ''
  const rest = token.slice(prefix[0].length)
  if (opening === '' && closing === '')
    return rest
  if (mode !== 'split')
    return null
  if (opening === '"' && closing === '"')
    return rest
  if (opening === '"' && closing === '' && rest.endsWith('"'))
    return rest.slice(0, -1)
  return null
}

/** The referenced path of one word, or null. */
function refOfWord(word: string, mode: WordMode): string | null {
  let token = mode === 'split' ? withoutTrailingPunctuation(word) : word
  if (mode !== 'parsed') {
    const rest = projectDirRest(token, mode)
    if (rest !== undefined)
      return rest === null ? null : normalizeRef(rest)
  }
  if (mode === 'split') {
    const quote = token[0]
    if ((quote === '"' || quote === '\'') && token.length >= 2 && token.endsWith(quote))
      token = token.slice(1, -1)
  }
  if (token.startsWith('./') || token.startsWith('.claude/') || token.startsWith('.harness/'))
    return normalizeRef(token)
  // A relative path with `/` (`scripts/check.sh`) or a bare file name (`count.sh`: `sh count.sh`, `node hook.mjs`
  // run in the project folder) with a script extension.
  if (!isOptionOrUrl(token) && hasScriptExtension(token))
    return normalizeRef(token)
  return null
}

function collectRefs(words: Iterable<unknown>, mode: WordMode): string[] {
  const refs: string[] = []
  for (const word of words) {
    if (typeof word !== 'string')
      continue
    const ref = refOfWord(word.slice(0, COMMAND_SCAN_MAX_CHARS), mode)
    if (ref !== null && !refs.includes(ref)) {
      refs.push(ref)
      if (refs.length >= TRUST_LIMITS.refFilesMax)
        break
    }
  }
  return refs
}

/**
 * The project-relative script files a command names (≤ `TRUST_LIMITS.refFilesMax`): tokens of `parseShellCommand`
 * (else a whitespace split) of the form `$CLAUDE_PROJECT_DIR/…`, `${CLAUDE_PROJECT_DIR}/…`, `"$HARNESS_PROJECT_DIR"/…`,
 * `./…`, `.claude/…`, `.harness/…`, or a relative path with a script extension, with or without `/` (`scripts/x.py`,
 * `count.sh`; Gate P11-A: a bare script name is a reference too, so editing the script of `sh count.sh` makes the item
 * pending again; a name that is no file, `echo foo.sh`, is hashed as missing); normalized, never with `..`. Paths with
 * shell syntax, globs, quotes inside, absolute paths and folders (`…/`) are never references, nor are options, option
 * values, assignments and URLs for the extension rule (`--config=x.sh`, `A=x.sh`, `https://host/x.sh`); the result
 * keeps the first-seen order without duplicates.
 */
export function extractCommandFileRefs(command: string): string[] {
  if (typeof command !== 'string' || command === '')
    return []
  try {
    const text = command.slice(0, COMMAND_SCAN_MAX_CHARS)
    const parsed = parseShellCommand(text)
    if (parsed.ok)
      return collectRefs(parsed.segments.flatMap(segment => segment.words), 'parsed')
    return collectRefs(text.split(/\s+/), 'split')
  }
  catch {
    return []
  }
}

/**
 * The project-relative script files an argument list names (a stdio `.mcp.json` server: its `command`, then its
 * `args`): the word rules of `extractCommandFileRefs`, each element one literal word (no shell parsing, no quotes).
 */
export function extractArgsFileRefs(args: readonly string[]): string[] {
  if (!Array.isArray(args))
    return []
  try {
    return collectRefs(args as readonly unknown[], 'argv')
  }
  catch {
    return []
  }
}
