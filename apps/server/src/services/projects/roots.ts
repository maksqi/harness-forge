// Allowed workspace roots and the folder checks of projects (Phase 7, ADR-031, ARCHITECTURE.md 6.13 "Allowed roots").
// Owner: W7.1.
//
// - `checkRoots(env)` is the filesystem half of `HF_WORKSPACE_ROOTS` (`loadEnv` checks only the syntax): the default
//   root `<dataDir>/workspaces` is created with mode 0700 when it is one of the roots; every root is resolved with
//   `realpath` and must exist and be a directory; a root equal to the data dir, or inside it but outside
//   `<dataDir>/workspaces`, is refused (`EnvError`, exit 1 with the reason); a root that contains the data dir is allowed
//   (normal in development, where the repository holds `data/`).
// - `folderIssue(path, context)` answers why a stored project folder cannot be used now (the checks of
//   `openWorkspace` and of `ProjectSummary.available`): it must still be its own realpath, a directory, inside a current
//   root and not overlap the data dir.
// - `overlapsDataDir` / `insideDataDir`: a project folder may not equal, contain or sit inside the data dir; the
//   subtree of the default root is the exception.
import type { Env } from '../../env.ts'
import { mkdir, realpath, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { EnvError } from '../../env.ts'
import { isWithin } from '../../plugins/scaffold/paths.ts'

/** Mode of the default root (and of the data dir): only the server user may enter it. */
export const DEFAULT_ROOT_MODE = 0o700

/** The checked roots and the data dir, as canonical realpaths. */
export interface RootContext {
  /** Allowed roots (realpaths, `env.workspaceRoots` order, deduplicated). */
  readonly roots: readonly string[]
  /** Realpath of the data dir. */
  readonly dataDir: string
  /** `<dataDir>/workspaces` (realpath of the data dir + `workspaces`): its subtree may hold project folders. */
  readonly defaultRoot: string
}

export function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/** The realpath of `path`, or `path` itself when it cannot be resolved. */
export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  }
  catch {
    return path
  }
}

function isFilesystemRoot(path: string): boolean {
  return dirname(path) === path
}

/** True when `folder` equals, contains or sits inside the data dir (the default root's subtree excepted). */
export function overlapsDataDir(folder: string, context: RootContext): boolean {
  if (isWithin(context.defaultRoot, folder))
    return false
  return isWithin(context.dataDir, folder) || isWithin(folder, context.dataDir)
}

/** True when `folder` equals or sits inside the data dir (the default root's subtree excepted); browsing refuses it. */
export function insideDataDir(folder: string, context: RootContext): boolean {
  return !isWithin(context.defaultRoot, folder) && isWithin(context.dataDir, folder)
}

/** True when `folder` is one of the roots or inside one. */
export function insideRoots(folder: string, context: RootContext): boolean {
  return context.roots.some(root => isWithin(root, folder))
}

/** The data dir and default root without checking the roots (a service used before `start()`, e.g. in tests). */
export async function uncheckedRootContext(env: Pick<Env, 'dataDir' | 'workspaceRoots'>): Promise<RootContext> {
  const dataDir = await realpathOrSelf(env.dataDir)
  const roots = [...new Set(await Promise.all(env.workspaceRoots.map(realpathOrSelf)))]
  return Object.freeze({ roots: Object.freeze(roots), dataDir, defaultRoot: join(dataDir, 'workspaces') })
}

/** Why `root` (an entry of `HF_WORKSPACE_ROOTS`, or the default root) is refused at boot. */
function rootError(root: string, reason: string): EnvError {
  return new EnvError(`HF_WORKSPACE_ROOTS: ${root} ${reason}`)
}

/**
 * The boot checks of the roots (see the module comment). Creates the default root (mode 0700) when it is one of the
 * roots; throws `EnvError` for a refused root.
 */
export async function checkRoots(env: Pick<Env, 'dataDir' | 'paths' | 'workspaceRoots'>): Promise<RootContext> {
  if (env.workspaceRoots.includes(env.paths.workspaces))
    await mkdir(env.paths.workspaces, { recursive: true, mode: DEFAULT_ROOT_MODE })
  const dataDir = await realpathOrSelf(env.dataDir)
  const defaultRoot = join(dataDir, 'workspaces')
  const roots: string[] = []
  for (const root of env.workspaceRoots) {
    let real: string
    try {
      real = await realpath(root)
    }
    catch (error) {
      const code = errorCode(error)
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw rootError(root, 'does not exist. Create the folder or remove it from the list.')
      if (code === 'EACCES' || code === 'EPERM')
        throw rootError(root, 'cannot be accessed (permission denied).')
      throw rootError(root, `cannot be resolved (${code ?? 'unknown error'}).`)
    }
    if (!(await stat(real)).isDirectory())
      throw rootError(root, 'is not a folder.')
    if (isFilesystemRoot(real))
      throw rootError(root, 'resolves to a filesystem root. Name a folder that holds your projects.')
    if (real === dataDir)
      throw rootError(root, 'is the data directory (HF_DATA_DIR). Use a folder outside it, or <data dir>/workspaces.')
    if (isWithin(dataDir, real) && !isWithin(defaultRoot, real))
      throw rootError(root, 'is inside the data directory (HF_DATA_DIR). Only <data dir>/workspaces may hold project folders there.')
    if (!roots.includes(real))
      roots.push(real)
  }
  return Object.freeze({ roots: Object.freeze(roots), dataDir, defaultRoot })
}

// ---------- folder issues (ProjectSummary.issue, openWorkspace) ----------

export const FOLDER_MISSING_ISSUE = 'The folder does not exist.'
export const FOLDER_REPLACED_ISSUE = 'The folder was moved or replaced by a symbolic link.'
export const FOLDER_NOT_DIRECTORY_ISSUE = 'The path is not a folder.'
export const FOLDER_DENIED_ISSUE = 'The folder cannot be accessed (permission denied).'
export const FOLDER_OUTSIDE_ROOTS_ISSUE = 'The folder is outside the workspace folders (HF_WORKSPACE_ROOTS).'
export const FOLDER_DATA_DIR_ISSUE = 'The folder overlaps the harness-forge data directory.'

function statIssue(error: unknown): string {
  const code = errorCode(error)
  if (code === 'ENOENT' || code === 'ENOTDIR')
    return FOLDER_MISSING_ISSUE
  if (code === 'EACCES' || code === 'EPERM')
    return FOLDER_DENIED_ISSUE
  if (code === 'ELOOP')
    return FOLDER_REPLACED_ISSUE
  return `The folder cannot be opened (${code ?? 'unknown error'}).`
}

/**
 * Why the stored project folder `path` cannot be used now, or null: it must still equal its realpath, be a directory,
 * lie inside a current root and not overlap the data dir. Never throws.
 */
export async function folderIssue(path: string, context: RootContext): Promise<string | null> {
  try {
    if (await realpath(path) !== path)
      return FOLDER_REPLACED_ISSUE
    if (!(await stat(path)).isDirectory())
      return FOLDER_NOT_DIRECTORY_ISSUE
  }
  catch (error) {
    return statIssue(error)
  }
  if (!insideRoots(path, context))
    return FOLDER_OUTSIDE_ROOTS_ISSUE
  if (overlapsDataDir(path, context))
    return FOLDER_DATA_DIR_ISSUE
  return null
}

/** True when `path` exists and is a directory (the `available` flag of a browse root). Never throws. */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  }
  catch {
    return false
  }
}
