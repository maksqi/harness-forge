// Folder path helpers of the Add project dialog (docs/UI.md 9.10; ADR-031). Paths are canonical realpaths of the server
// host, so they may use `/` (POSIX) or `\` (Windows); every helper accepts both. Pure: no store, no DOM.
import { folderNameSchema } from '@harness-forge/shared'

/** One breadcrumb segment: the root first, then each folder down to the open one. */
export interface FolderCrumb {
  label: string
  path: string
}

const SEPARATORS = /[\\/]/

function trimTrailingSeparators(path: string): string {
  let end = path.length
  while (end > 1 && SEPARATORS.test(path[end - 1]!))
    end--
  return path.slice(0, end)
}

/** The separator a path uses: `\` for a Windows path without `/`, else `/`. */
export function pathSeparator(path: string): '/' | '\\' {
  return path.includes('\\') && !path.includes('/') ? '\\' : '/'
}

/** The last segment of `path` (the path itself when it has no separator, e.g. `/`). */
export function baseName(path: string): string {
  const trimmed = trimTrailingSeparators(path)
  const parts = trimmed.split(SEPARATORS)
  return parts.at(-1) || trimmed
}

/** `name` inside the folder `parent`, with the parent's separator. */
export function joinPath(parent: string, name: string): string {
  const trimmed = trimTrailingSeparators(parent)
  const separator = pathSeparator(trimmed)
  return trimmed.endsWith(separator) ? `${trimmed}${name}` : `${trimmed}${separator}${name}`
}

/** The two paths name the same folder (trailing separators ignored). */
export function samePath(a: string, b: string): boolean {
  return trimTrailingSeparators(a) === trimTrailingSeparators(b)
}

/** `path` equals `root` or lies inside it. */
export function isWithinRoot(root: string, path: string): boolean {
  const base = trimTrailingSeparators(root)
  const target = trimTrailingSeparators(path)
  if (target === base)
    return true
  if (!target.startsWith(base))
    return false
  return SEPARATORS.test(base.at(-1) ?? '') || SEPARATORS.test(target[base.length] ?? '')
}

/** The root that holds `path` (the deepest one when roots nest), or null. */
export function rootOf(path: string, roots: readonly string[]): string | null {
  let best: string | null = null
  for (const root of roots) {
    if (isWithinRoot(root, path) && (best === null || root.length > best.length))
      best = root
  }
  return best
}

/**
 * The breadcrumb of the open folder `path`: its root (labelled with the root's name), then every folder below it, the
 * last one being `path` itself. A path outside every root gets one crumb.
 */
export function folderCrumbs(path: string, roots: readonly string[]): FolderCrumb[] {
  const target = trimTrailingSeparators(path)
  const root = rootOf(target, roots)
  if (root === null)
    return [{ label: baseName(target), path: target }]
  const base = trimTrailingSeparators(root)
  const crumbs: FolderCrumb[] = [{ label: baseName(base), path: base }]
  const rest = target.slice(base.length).split(SEPARATORS).filter(Boolean)
  let current = base
  for (const segment of rest) {
    current = joinPath(current, segment)
    crumbs.push({ label: segment, path: current })
  }
  return crumbs
}

/**
 * Why `name` (already trimmed) cannot be a new folder, as the dialog says it (docs/UI.md 9.10), or null. Checked like
 * `folderNameSchema`: no `/` or `\`, not `.` / `..`, no leading dot, at most 255 characters.
 */
export function folderNameError(name: string): string | null {
  if (name.includes('/') || name.includes('\\'))
    return 'Use a name without slashes.'
  if (name.startsWith('.'))
    return 'Folder names can\'t start with a dot.'
  if (name.length > 255)
    return 'Use at most 255 characters.'
  const parsed = folderNameSchema.safeParse(name)
  return parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Use a different name.')
}
