// Sticky working folder of the `shell` tool (Phase 8, ADR-038, ARCHITECTURE.md 6.13 "Sticky working folder"). The folder
// a shell call ends in is stored in its output (`endCwd`); the next call of the chat starts there. Derived from the
// stored history, so it follows the shown branch and survives a restart; inside a run `scope.shellCwd.current`
// (`run-scope.ts`) follows the finished calls.
//
// - `initialShellCwd(history)`: where the first call of a run starts (the pipeline seeds the run scope with it, W8.5).
// - `checkShellFolder(root, input)`: a folder inside the project through the frozen path guard (the remembered folder
//   is re-checked at each call start; a folder that is gone means the call runs in the project folder, with a note).
// - `clampEndCwd(root, reported)`: the reported end folder (`pwd -P`, absolute) as a project-relative folder, or `.`
//   with the note `SHELL_CWD_OUTSIDE_NOTE` when it is outside the project or not a folder.
// - `cdTargetsInside(root, start, targets)`: the `cd` check of the shell rules (`shellPolicy`).
import type { HarnessUIMessage } from '@harness-forge/shared'
import type { ResolvedWorkspacePath } from './paths.ts'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { HarnessError, workspaceToolPathSchema } from '@harness-forge/shared'
import { resolveWorkspacePath } from './paths.ts'

/** The name of the core shell tool (`core-workspace`; `tool-shell` UI parts). */
const SHELL_TOOL = 'shell'

/** The `cwdNote` when the reported end folder is outside the project or not a folder (ARCHITECTURE.md 6.13). */
export const SHELL_CWD_OUTSIDE_NOTE = 'The command ended outside the project folder; the next call starts in the project folder.'

/** Characters of a folder quoted in a note (the note stays under the schema's 500 characters). */
const NOTE_FOLDER_MAX_CHARS = 200

function noteFolder(folder: string): string {
  return folder.length > NOTE_FOLDER_MAX_CHARS ? `${folder.slice(0, NOTE_FOLDER_MAX_CHARS)}...` : folder
}

/** The `cwdNote` when the remembered folder cannot be used at the start of a call: the call runs in the project folder. */
export function shellCwdGoneNote(folder: string, reason: 'missing' | 'unusable'): string {
  const what = reason === 'missing' ? 'no longer exists' : 'can no longer be used'
  return `The working folder ${noteFolder(folder)} ${what}, so the command ran in the project folder.`
}

/** The folder as the model text names it: `.` is "the project folder". */
export function shellFolderLabel(folder: string): string {
  return folder === '.' ? 'the project folder' : folder
}

// ---------- initial folder ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** A part of the core `shell` tool (`tool-shell`, or a dynamic tool part named `shell`). */
function isShellPart(part: Record<string, unknown>): boolean {
  return part.type === `tool-${SHELL_TOOL}` || (part.type === 'dynamic-tool' && part.toolName === SHELL_TOOL)
}

/** The stored `endCwd` of a finished shell part, or null (no output, not reported, an output saved before v1.4). */
function partEndCwd(part: Record<string, unknown>): string | null {
  if (!isShellPart(part) || part.state !== 'output-available' || !isRecord(part.output))
    return null
  const parsed = workspaceToolPathSchema.safeParse(part.output.endCwd)
  return parsed.success ? parsed.data : null
}

/**
 * The project-relative POSIX folder (`.` = the project root) where the first `shell` call of a run starts: the `endCwd`
 * of the last finished `shell` tool part on the run's active path (`history`, oldest first), `.` when there is none or
 * the output predates Phase 8. The caller re-checks it at the start of each call (a missing folder falls back to `.`).
 *
 * A finished output without `endCwd` (the end folder was not reported: `exec`, a kill, the command's own EXIT trap)
 * left the folder as it was, so the search goes on before it; outputs saved before v1.4 lack the field too and all come
 * before the first v1.4 output on a path, so they count as `.`. (For parallel calls of one step the last part wins
 * here, while inside the run the call that finished last did.)
 */
export function initialShellCwd(history: readonly HarnessUIMessage[]): string {
  for (let index = history.length - 1; index >= 0; index--) {
    const message = history[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.parts))
      continue
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
      const part: unknown = message.parts[partIndex]
      if (!isRecord(part))
        continue
      const endCwd = partEndCwd(part)
      if (endCwd !== null)
        return endCwd
    }
  }
  return '.'
}

// ---------- folder checks ----------

/** Why a folder cannot be used: it is gone, or it is outside the project, a link out of it, a file, unreadable. */
export type ShellFolderProblem = 'missing' | 'unusable'

export type ShellFolderCheck
  = | { ok: true, folder: ResolvedWorkspacePath }
    | { ok: false, problem: ShellFolderProblem }

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/**
 * `input` (project-relative or absolute) as an existing folder inside the project, through the frozen path guard
 * (`resolveWorkspacePath`: realpath containment) and `stat`. Never throws for a refused folder; a project folder that
 * is gone or moved is `unusable` too (the caller's own root check reports it).
 */
export async function checkShellFolder(root: string, input: string): Promise<ShellFolderCheck> {
  let folder: ResolvedWorkspacePath
  try {
    folder = await resolveWorkspacePath(root, input)
  }
  catch (error) {
    if (error instanceof HarnessError && error.code === 'not_found')
      return { ok: false, problem: 'missing' }
    return { ok: false, problem: 'unusable' }
  }
  try {
    const info = await stat(folder.absolute)
    return info.isDirectory() ? { ok: true, folder } : { ok: false, problem: 'unusable' }
  }
  catch (error) {
    const code = errorCode(error)
    return { ok: false, problem: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unusable' }
  }
}

/** The end folder of a call, as stored in its output. */
export interface ClampedEndCwd {
  /** Project-relative POSIX folder (`.` = the project folder). */
  endCwd: string
  /** Set when the reported folder was refused (`SHELL_CWD_OUTSIDE_NOTE`). */
  note: string | null
}

/**
 * The reported end folder (`ShellRunResult.endCwd`, an absolute physical path) clamped to the project: its
 * project-relative path when it resolves inside the root and is a folder, else `.` with `SHELL_CWD_OUTSIDE_NOTE`.
 */
export async function clampEndCwd(root: string, reported: string): Promise<ClampedEndCwd> {
  const check = await checkShellFolder(root, reported)
  if (check.ok && workspaceToolPathSchema.safeParse(check.folder.rel).success)
    return { endCwd: check.folder.rel, note: null }
  return { endCwd: '.', note: SHELL_CWD_OUTSIDE_NOTE }
}

/**
 * True when every `cd` target (`matchShellRules(...).cdTargets`, in order) enters a folder inside the project: each is
 * resolved relative to the previous one, starting at `start` (the call's absolute start folder), the way `cd` does it
 * (lexically: `link/..` is the folder holding `link`), then checked through the path guard (realpath containment), as
 * an existing folder the shell may enter. The environment never sets `CDPATH`, so `cd sub` enters `<current>/sub`.
 */
export async function cdTargetsInside(root: string, start: string, targets: readonly string[]): Promise<boolean> {
  let current = start
  for (const target of targets) {
    const next = resolve(current, target)
    const check = await checkShellFolder(root, next)
    if (!check.ok)
      return false
    try {
      await access(check.folder.absolute, constants.X_OK)
    }
    catch {
      return false
    }
    current = next
  }
  return true
}
