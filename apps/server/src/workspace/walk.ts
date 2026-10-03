// The folder walker of `find_files` and `search_files` (Phase 7, ADR-032, ARCHITECTURE.md 6.13 "Walking"). An async
// depth-first walk below a start folder inside the project root (both canonical realpaths; the start folder comes from
// `resolveWorkspacePath`):
//
// - `.git` (a folder or a worktree file) is always skipped; so are the temp files of atomic writes (`.hf-write-*`);
// - unless `includeIgnored`: `node_modules` folders and gitignored paths are skipped. Every folder's `.gitignore` gets
//   its own `ignore` instance (read through the frozen `readWorkspaceFile`); the deepest instance with a verdict on a
//   path wins (a negation in a nested file re-includes), and an ignored folder is never entered, as in git. The
//   `.gitignore` files of the folders between the root and the start folder apply too, unless they ignore the start
//   folder itself: the caller named it, so it is walked with only the rules inside it. Patterns that could backtrack badly (more than
//   `GITIGNORE_MAX_WILDCARDS` runs of `*`, or longer than `GITIGNORE_LINE_MAX_CHARS`) are dropped: the rules run on the
//   main thread and come from the repository, so a hostile `.gitignore` must not stall the server;
// - folder links are never entered; a file link is kept only when its realpath is a regular file inside the root
//   (reported under the link's own path); FIFOs, sockets and devices are skipped;
// - every folder is re-checked (`realpath(folder) === folder`) before it is read, so a folder swapped for a link during
//   the walk is skipped;
// - caps: `maxEntries` directory entries seen (100,000), folders `maxDepth` levels below the start (64), `timeoutMs`
//   (10 s); hitting one ends the walk early with `truncated: true`. The abort signal throws its reason.
//
// Files come back in walk order (the files of a folder in name order, then its subfolders in name order).
import type { Ignore } from 'ignore'
import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import ignore from 'ignore'
import { isWithin } from '../plugins/scaffold/paths.ts'
import { readWorkspaceFile, toWorkspaceRel, WORKSPACE_TEMP_PREFIX } from './paths.ts'

/** Directory entries a walk looks at before it stops. */
export const WALK_MAX_ENTRIES = 100_000
/** Folder levels below the start folder a walk enters. */
export const WALK_MAX_DEPTH = 64
/** A walk stops after this long. */
export const WALK_TIMEOUT_MS = 10_000
/** Bytes read of one `.gitignore` file (a longer one is skipped). */
export const GITIGNORE_MAX_BYTES = 262_144
/** A `.gitignore` line longer than this is dropped. */
export const GITIGNORE_LINE_MAX_CHARS = 512
/** A `.gitignore` line with more runs of `*` than this is dropped. */
export const GITIGNORE_MAX_WILDCARDS = 3

export interface WalkOptions {
  /** The project root (canonical realpath). */
  root: string
  /** The start folder: a canonical realpath inside `root` (`ResolvedWorkspacePath.absolute` of an existing folder). */
  start: string
  /** Also walk `node_modules` and gitignored paths; default false. */
  includeIgnored?: boolean
  signal?: AbortSignal
  /** Default `WALK_MAX_ENTRIES`. */
  maxEntries?: number
  /** Default `WALK_MAX_DEPTH`. */
  maxDepth?: number
  /** Default `WALK_TIMEOUT_MS`. */
  timeoutMs?: number
  /** Clock (tests). */
  now?: () => number
}

/** A file found by the walk. */
export interface WalkFile {
  /** Project-relative POSIX path (the link's own path for a file link). */
  readonly rel: string
  /** Path relative to the start folder, POSIX (what globs are matched against). */
  readonly fromStart: string
  /** Absolute path (the link's own path for a file link). */
  readonly absolute: string
  /** The entry is a symbolic link to a file inside the root. */
  readonly link: boolean
}

export interface WalkResult {
  files: WalkFile[]
  /** A cap (entries, depth, time) ended the walk early or kept it out of a folder. */
  truncated: boolean
  /** Directory entries looked at. */
  entries: number
}

/** The `.gitignore` rules of one folder. */
interface IgnoreLevel {
  /** Project-relative POSIX folder ('' for the root). */
  readonly dir: string
  readonly rules: Ignore
}

interface PendingFolder {
  readonly absolute: string
  /** Project-relative POSIX path ('' for the root). */
  readonly rel: string
  /** Relative to the start folder ('' for the start). */
  readonly fromStart: string
  readonly depth: number
  readonly levels: readonly IgnoreLevel[]
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

function joinRel(base: string, name: string): string {
  return base === '' ? name : `${base}/${name}`
}

/** Number of runs of `*` in a pattern (`**` counts once). */
function wildcardRuns(line: string): number {
  return line.match(/\*+/g)?.length ?? 0
}

/** The usable lines of a `.gitignore` file (comments and blank lines are handled by `ignore`). */
export function safeGitignoreLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter(line => line.length <= GITIGNORE_LINE_MAX_CHARS && wildcardRuns(line) <= GITIGNORE_MAX_WILDCARDS)
}

/** The rules of the `.gitignore` file in `dirRel` (project-relative, '' for the root), or null without a usable one. */
async function loadIgnoreLevel(root: string, dirRel: string): Promise<IgnoreLevel | null> {
  let text: string
  try {
    const { bytes } = await readWorkspaceFile(root, joinRel(dirRel, '.gitignore'), { maxBytes: GITIGNORE_MAX_BYTES })
    text = bytes.toString('utf8')
  }
  catch {
    return null
  }
  const lines = safeGitignoreLines(text)
  if (lines.every(line => line.trim() === '' || line.startsWith('#')))
    return null
  try {
    return { dir: dirRel, rules: ignore().add(lines) }
  }
  catch {
    return null
  }
}

/** True when the deepest rule set with a verdict ignores `rel` (folders end with `/`). */
function isIgnored(rel: string, levels: readonly IgnoreLevel[]): boolean {
  for (let index = levels.length - 1; index >= 0; index--) {
    const level = levels[index]!
    const sub = level.dir === '' ? rel : rel.slice(level.dir.length + 1)
    if (sub === '' || sub === '/')
      continue
    let verdict: { ignored: boolean, unignored: boolean }
    try {
      verdict = level.rules.test(sub)
    }
    catch {
      continue
    }
    if (verdict.unignored)
      return false
    if (verdict.ignored)
      return true
  }
  return false
}

/**
 * The rule sets of the folders from the root down to the parent of `startRel` (the start folder adds its own). Empty
 * when they ignore the start folder itself: the caller named it, so only the rules inside it apply.
 */
async function ancestorLevels(root: string, startRel: string): Promise<IgnoreLevel[]> {
  const levels: IgnoreLevel[] = []
  if (startRel === '')
    return levels
  const segments = startRel.split('/')
  for (let depth = 0; depth < segments.length; depth++) {
    const dir = segments.slice(0, depth).join('/')
    const level = await loadIgnoreLevel(root, dir)
    if (level !== null)
      levels.push(level)
  }
  return isIgnored(`${startRel}/`, levels) ? [] : levels
}

/** A file link kept by the walk: its realpath must be a regular file inside the root. */
async function isFileLinkInside(root: string, absolute: string): Promise<boolean> {
  try {
    const target = await realpath(absolute)
    if (!isWithin(root, target))
      return false
    return (await stat(target)).isFile()
  }
  catch {
    return false
  }
}

function compareNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Walks the files below `options.start` (see the module comment). */
export async function walkWorkspace(options: WalkOptions): Promise<WalkResult> {
  const { root, start, signal } = options
  const includeIgnored = options.includeIgnored === true
  const maxEntries = options.maxEntries ?? WALK_MAX_ENTRIES
  const maxDepth = options.maxDepth ?? WALK_MAX_DEPTH
  const timeoutMs = options.timeoutMs ?? WALK_TIMEOUT_MS
  const now = options.now ?? (() => performance.now())
  const startedAt = now()

  const startRel = toWorkspaceRel(root, start)
  const startRelPath = startRel === '.' ? '' : startRel
  const result: WalkResult = { files: [], truncated: false, entries: 0 }
  const stack: PendingFolder[] = [{
    absolute: start,
    rel: startRelPath,
    fromStart: '',
    depth: 0,
    levels: includeIgnored ? [] : await ancestorLevels(root, startRelPath),
  }]

  while (stack.length > 0) {
    signal?.throwIfAborted()
    if (now() - startedAt > timeoutMs) {
      result.truncated = true
      break
    }
    const folder = stack.pop()!

    // A folder swapped for a link (or moved) since it was listed is skipped.
    try {
      if (await realpath(folder.absolute) !== folder.absolute)
        continue
    }
    catch {
      continue
    }
    let entries
    try {
      entries = await readdir(folder.absolute, { withFileTypes: true })
    }
    catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR' || errorCode(error) === 'EACCES' || errorCode(error) === 'EPERM')
        continue
      throw error
    }
    entries.sort((a, b) => compareNames(a.name, b.name))

    let levels = folder.levels
    if (!includeIgnored && entries.some(entry => entry.name === '.gitignore')) {
      const level = await loadIgnoreLevel(root, folder.rel)
      if (level !== null)
        levels = [...levels, level]
    }

    const subfolders: PendingFolder[] = []
    let stop = false
    for (const entry of entries) {
      result.entries++
      if (result.entries > maxEntries) {
        result.entries = maxEntries
        result.truncated = true
        stop = true
        break
      }
      const name = entry.name
      if (name.toLowerCase() === '.git' || name.startsWith(WORKSPACE_TEMP_PREFIX))
        continue
      const rel = joinRel(folder.rel, name)
      const fromStart = joinRel(folder.fromStart, name)
      const absolute = join(folder.absolute, name)
      if (entry.isDirectory()) {
        if (!includeIgnored && (name === 'node_modules' || isIgnored(`${rel}/`, levels)))
          continue
        if (folder.depth + 1 > maxDepth) {
          result.truncated = true
          continue
        }
        subfolders.push({ absolute, rel, fromStart, depth: folder.depth + 1, levels })
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink())
        continue
      if (!includeIgnored && isIgnored(rel, levels))
        continue
      if (entry.isSymbolicLink()) {
        if (await isFileLinkInside(root, absolute))
          result.files.push({ rel, fromStart, absolute, link: true })
        continue
      }
      result.files.push({ rel, fromStart, absolute, link: false })
    }
    if (stop)
      break
    for (let index = subfolders.length - 1; index >= 0; index--)
      stack.push(subfolders[index]!)
  }
  return result
}
