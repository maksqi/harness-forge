// The paths of the project definition editor (Phase 12, ADR-056, ARCHITECTURE.md 6.36 "Paths"). Owner: W12.4.
//
// Editable paths are exactly the ones of `projectDefinitionPathKind` (`@harness-forge/shared`): the definition markdown of
// `.claude/` and `.harness/` (`agents/<name>.md`, `commands/[<folder>/…]<name>.md` with at most 3 subfolders,
// `skills/<name>/SKILL.md`, `output-styles/<name>.md`), the four settings files and `.mcp.json` at the project root.
// Anything else is a `400`. On top of the shape:
//
// - a `.git` segment (any case) and a secret-looking segment (`isSecretLookingName`: `.env`, `secrets.*`, `*.key`, …)
//   are refused, so nothing is ever read or written there;
// - the path must resolve to itself: `resolveWorkspacePath(root, path, { allowMissing: true })` must give `rel ===
//   path`, so no segment of it is a symbolic link (a linked `.claude` folder, a linked file, a link loop and a link out
//   of the project are all refused) — the precedent is the Remember append (`services/customizations/memory.ts`);
// - writers check it again inside the file lock (`resolveDefinitionPathAgain`), so a link placed between the check and
//   the write is refused there.
//
// Errors are `validation_error`s with the issue path `['path']` (`workspacePathError`); messages name the path, never
// file contents.
import type { ProjectDefinitionFileKind } from '@harness-forge/shared'
import type { ResolvedWorkspacePath } from '../../workspace/paths.ts'
import { isMarkdownDefinitionKind, projectDefinitionPathKind } from '@harness-forge/shared'
import { hasGitSegment, resolveWorkspacePath, workspacePathError } from '../../workspace/paths.ts'
import { isSecretLookingName } from '../../workspace/sensitive.ts'

/** The kinds that hold markdown (the definition parser reads them; only they can be deleted). */
export type MarkdownDefinitionKind = Extract<ProjectDefinitionFileKind, 'agent' | 'command' | 'skill' | 'style'>

/** An editable project path with its kind. */
export interface ProjectDefinitionTarget {
  /** The project-relative POSIX path, exactly as requested. */
  readonly path: string
  readonly kind: ProjectDefinitionFileKind
}

export const NOT_EDITABLE_MESSAGE = 'Use a definition file under .claude/ or .harness/ (agents, commands, skills/<name>/SKILL.md, output-styles), a settings file or .mcp.json.'

/** `"<path>"` for messages: control characters cannot occur (the shape check refuses them), long paths are cut. */
function shown(path: string): string {
  return path.length > 200 ? `${path.slice(0, 200)}…` : path
}

/** The refusal of a path that goes through a symbolic link. */
export function linkedPathError(path: string): ReturnType<typeof workspacePathError> {
  return workspacePathError(`"${shown(path)}" is a symbolic link or goes through one; it cannot be edited here.`)
}

/**
 * The kind of an editable path (no file system access): the shape of `projectDefinitionPathKind`, no `.git` segment and
 * no secret-looking segment. Throws `validation_error` on `['path']`.
 */
export function definitionTarget(path: string): ProjectDefinitionTarget {
  const kind = typeof path === 'string' ? projectDefinitionPathKind(path) : null
  if (kind === null)
    throw workspacePathError(NOT_EDITABLE_MESSAGE)
  if (hasGitSegment(path))
    throw workspacePathError(`"${shown(path)}" is inside a .git folder; it cannot be edited here.`)
  if (path.split('/').some(segment => isSecretLookingName(segment)))
    throw workspacePathError(`"${shown(path)}" has a secret-looking name; it cannot be edited here.`)
  return { path, kind }
}

/** `definitionTarget` for the delete route: only markdown definitions (settings files and `.mcp.json` are a `400`). */
export function markdownDefinitionTarget(path: string): ProjectDefinitionTarget & { readonly kind: MarkdownDefinitionKind } {
  const target = definitionTarget(path)
  if (!isMarkdownDefinitionKind(target.kind))
    throw workspacePathError('Only agent, command, skill and output style files can be deleted.')
  return target as ProjectDefinitionTarget & { readonly kind: MarkdownDefinitionKind }
}

/**
 * Resolves an editable path inside the project folder `root` (a canonical realpath) with `allowMissing`: the result's
 * `rel` must equal `path` (no link anywhere on it), and the resolved path must not be inside `.git`. Throws the guard's
 * `validation_error` (outside the folder, a dangling link, a loop, a file where a folder is expected) or the link refusal.
 */
export async function resolveDefinitionPath(root: string, path: string): Promise<ResolvedWorkspacePath> {
  const resolved = await resolveWorkspacePath(root, path, { allowMissing: true })
  if (resolved.rel !== path || hasGitSegment(resolved.rel))
    throw linkedPathError(path)
  return resolved
}

/**
 * The check inside the file lock: the path resolves again to the same place (`rel === path`, the same absolute path as
 * the lock was taken on). Answers the fresh resolution (its `exists` may differ from the first one: the file was created
 * or removed meanwhile).
 */
export async function resolveDefinitionPathAgain(root: string, path: string, first: ResolvedWorkspacePath): Promise<ResolvedWorkspacePath> {
  const again = await resolveDefinitionPath(root, path)
  if (again.absolute !== first.absolute)
    throw linkedPathError(path)
  return again
}

/** The parse options of a markdown definition: the file name (agents, commands, styles) or the skill folder name. */
export function definitionParseOptions(target: ProjectDefinitionTarget): { fileName: string } | { folderName: string } {
  const segments = target.path.split('/')
  if (target.kind === 'skill')
    return { folderName: segments.at(-2) ?? '' }
  return { fileName: segments.at(-1) ?? '' }
}

/** The skill folder of a `…/skills/<name>/SKILL.md` path (removed after a delete when it is empty), else null. */
export function skillFolderOf(target: ProjectDefinitionTarget): string | null {
  if (target.kind !== 'skill')
    return null
  return target.path.split('/').slice(0, -1).join('/')
}
