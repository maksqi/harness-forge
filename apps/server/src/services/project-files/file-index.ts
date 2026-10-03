// The file index of one project for `@` mentions (Phase 9, ADR-042, ARCHITECTURE.md 6.21 "Index"). Owner: W9.6.
//
// `buildProjectFileIndex(root)` walks the project folder with the workspace walker (`workspace/walk.ts`: `.gitignore`,
// `node_modules`, `.git`, the temp files of atomic writes, folder links never entered, its entry / depth / 10 s limits;
// no pattern code of its own) and keeps the project-relative POSIX paths of the files, minus:
//
// - secret-looking paths (`workspace/sensitive.ts`) and any path with a `.git` segment;
// - file links whose target is secret-looking or inside `.git` (the walker keeps a file link when its target is a
//   regular file inside the root and reports it under the link's own name, so `notes.txt -> .env` is checked here).
//
// At most `maxFiles` files are kept (`LIMITS.mentionIndexFilesMax`); a cut index, or a walk ended by its own limits, is
// `truncated`. The folders are derived from the kept file paths (`projectFileEntries`): a folder without a listed file
// is never a candidate. Nothing here logs; the caller logs counts only (never a path).
import type { ProjectFileEntry } from '@harness-forge/shared'
import type { WalkOptions, WalkResult } from '../../workspace/walk.ts'
import { realpath } from 'node:fs/promises'
import { performance } from 'node:perf_hooks'
import { isWithin } from '../../plugins/scaffold/paths.ts'
import { hasGitSegment, toWorkspaceRel } from '../../workspace/paths.ts'
import { isSecretLookingPath } from '../../workspace/sensitive.ts'

/** The walker (`walkWorkspace`); tests pass a wrapper that counts or delays walks. */
export type ProjectWalk = (options: WalkOptions) => Promise<WalkResult>

/** The index of one project. */
export interface ProjectFileIndex {
  /** The files (walk order) followed by the folders derived from them (sorted); no trailing `/`. */
  readonly entries: readonly ProjectFileEntry[]
  /** Number of `kind: 'file'` entries. */
  readonly files: number
  /** The index was cut at `maxFiles`, or the walk stopped at one of its limits: a match may be missing. */
  readonly truncated: boolean
  /** When the build started (epoch ms): a file written before it is in the index. */
  readonly indexedAt: number
  /** How long the build took (ms, for the debug log). */
  readonly durationMs: number
}

export interface BuildProjectFileIndexOptions {
  /** Files kept at most (`LIMITS.mentionIndexFilesMax`). */
  maxFiles: number
  /** The walker (default: `walkWorkspace`, passed by the service). */
  walk: ProjectWalk
  /** Aborts the walk (shutdown). */
  signal?: AbortSignal
  /** Clock of `indexedAt` (default `Date.now`). */
  now?: () => number
}

/** True for a project-relative path that is never listed nor attached: a `.git` segment or a secret-looking name. */
export function isUnmentionablePath(rel: string): boolean {
  return hasGitSegment(rel) || isSecretLookingPath(rel)
}

/**
 * The file entries of `paths` (in order) plus every folder above them, sorted, without a trailing `/` (a path that is
 * also listed as a file is not repeated as a folder).
 */
export function projectFileEntries(paths: readonly string[]): ProjectFileEntry[] {
  const entries: ProjectFileEntry[] = paths.map(path => ({ path, kind: 'file' }))
  const files = new Set(paths)
  const dirs = new Set<string>()
  for (const path of paths) {
    let end = path.lastIndexOf('/')
    while (end > 0) {
      const dir = path.slice(0, end)
      if (dirs.has(dir))
        break
      if (!files.has(dir))
        dirs.add(dir)
      end = dir.lastIndexOf('/')
    }
  }
  return [...entries, ...[...dirs].sort().map(path => ({ path, kind: 'dir' as const }))]
}

/** The target of a file link kept by the walker is listable: inside the root, no `.git` segment, not secret-looking. */
async function isListableLink(root: string, absolute: string): Promise<boolean> {
  try {
    const target = await realpath(absolute)
    return isWithin(root, target) && !isUnmentionablePath(toWorkspaceRel(root, target))
  }
  catch {
    return false
  }
}

/** Walks the project folder `root` (a canonical realpath, `OpenWorkspace.root`) and builds its index. */
export async function buildProjectFileIndex(root: string, options: BuildProjectFileIndexOptions): Promise<ProjectFileIndex> {
  const now = options.now ?? (() => Date.now())
  const indexedAt = now()
  const startedAt = performance.now()
  const walked = await options.walk({ root, start: root, signal: options.signal })
  const paths: string[] = []
  let truncated = walked.truncated
  for (const file of walked.files) {
    if (isUnmentionablePath(file.rel))
      continue
    if (file.link && !await isListableLink(root, file.absolute))
      continue
    if (paths.length >= options.maxFiles) {
      truncated = true
      break
    }
    paths.push(file.rel)
  }
  options.signal?.throwIfAborted()
  return {
    entries: projectFileEntries(paths),
    files: paths.length,
    truncated,
    indexedAt,
    durationMs: Math.round(performance.now() - startedAt),
  }
}
