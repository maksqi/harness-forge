// Plan files (Phase 10, ADR-047; ARCHITECTURE.md 6.27, API.md 4.25). Signature FROZEN after P10-0b (C31 stub); W10.5
// implements it.
//
// `savePlan(context, plan, c)` is what the run binds as `AgentRunScope.savePlan` (`pipeline.ts`), for `core-agent`'s
// `exit_plan_mode` on the approved continuation: only with the setting `planFiles` on, a workspace on the call context
// (`c.workspace`, a project chat) and the run scope of that project bound to `c` (a chat run: a plan file is never
// written outside one). The path is `<planDirectory>/<YYYY-MM-DD>-<slug>.md` (UTC date from `context.now`, the slug from
// the plan's first heading, else its first non-empty line: `[a-z0-9-]`, at most 48, fallback `plan`; `-2`, `-3` …
// when the name is taken, at most `PLAN_FILE_MAX_SUFFIX`), written with `journaledWrite(c, c.workspace.root, { tool:
// 'exit_plan_mode', path }, produce)` under the run scope bound to `c` (the changes panel lists it, rewind removes it,
// undo restores it); missing folders are created by the frozen guarded write.
//
// Guards: `planDirectory` is checked again (`isSafePlanDirectory`: relative, no `..`, no `.git`), so a tampered setting
// never leaves the project; the folder must resolve to exactly its own spelling through `resolveWorkspacePath` (a
// symbolic link anywhere on it is refused, even one into the project); `produce` runs under the file lock and refuses
// a target that exists or resolves elsewhere, so a file is never overwritten.
//
// Never rejects: `{ planPath }` (project-relative) when written, `{ planError }` (one sentence safe to show, at most
// `PLAN_ERROR_MAX_CHARS`, logged as a warning) when the write failed, `{}` when no file is due. Plan texts are never
// logged.
import type { ToolCallContext } from '@harness-forge/plugin-sdk'
import type { Settings } from '@harness-forge/shared'
import type { Logger } from '../logger.ts'
import type { AppDeps } from '../types.ts'
import type { ResolvedWorkspacePath } from '../workspace/paths.ts'
import type { SavedPlan } from './agent-scope.ts'
import { lstat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { HarnessError, isHarnessError, isSafePlanDirectory } from '@harness-forge/shared'
import { journaledWrite } from '../workspace/journal.ts'
import { hasGitSegment, resolveWorkspacePath, toWorkspaceRel } from '../workspace/paths.ts'
import { runScopeOf } from '../workspace/run-scope.ts'
import { isAbortError } from './errors.ts'

/** What `savePlan` reads (bound once per run by the pipeline). */
export interface PlanFileContext {
  /** The services. */
  readonly deps: AppDeps
  /** The settings of the run (`planFiles`, `planDirectory`). */
  readonly settings: Settings
  readonly logger: Logger
  /** The clock (the date of the file name). */
  readonly now: () => number
}

/** The tool name of the journal row of a plan file. */
export const PLAN_FILE_TOOL = 'exit_plan_mode'
/** Characters of the slug of a plan file name. */
export const PLAN_SLUG_MAX_CHARS = 48
/** The slug of a plan without a usable heading or line. */
export const PLAN_SLUG_FALLBACK = 'plan'
/** The highest suffix tried for a taken name (`-2` … `-99`). */
export const PLAN_FILE_MAX_SUFFIX = 99
/** Characters of `planError` (`exitPlanModeOutputSchema`). */
export const PLAN_ERROR_MAX_CHARS = 500

export const PLAN_DIRECTORY_UNSAFE_ERROR = 'The plan folder setting is not a folder inside the project.'
export const PLAN_FILE_STOPPED_ERROR = 'The reply was stopped before the plan file was written.'
export const PLAN_FILE_FAILED_ERROR = 'The plan file could not be written.'

/** A Markdown ATX heading line: up to 3 spaces, 1 - 6 `#`, a space or tab, the text (linear: no nested quantifiers). */
const HEADING = /^ {0,3}#{1,6}[ \t](.*)$/

/** The chosen name exists (or appeared under the lock): try the next suffix. */
class PlanFileTaken extends Error {}

function errnoOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : ''
}

/** One error for the model and the UI: a `HarnessError`'s message (safe by contract) or a fixed sentence. */
function planErrorOf(error: unknown): string {
  if (isAbortError(error))
    return PLAN_FILE_STOPPED_ERROR
  if (isHarnessError(error) && error.message.trim() !== '')
    return error.message.trim()
  const code = errnoOf(error)
  return /^E[A-Z0-9]{1,20}$/.test(code) ? `${PLAN_FILE_FAILED_ERROR.slice(0, -1)} (${code}).` : PLAN_FILE_FAILED_ERROR
}

/** `message` on one line, at most `PLAN_ERROR_MAX_CHARS`. */
export function capPlanError(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim()
  return flat.length > PLAN_ERROR_MAX_CHARS ? `${flat.slice(0, PLAN_ERROR_MAX_CHARS - 1)}…` : flat
}

/** The text of an ATX heading line without its optional closing `#`s, or '' (not a heading, or an empty one). */
function headingText(line: string): string {
  const text = (line.match(HEADING)?.[1] ?? '').trim()
  let end = text.length
  while (end > 0 && text[end - 1] === '#')
    end -= 1
  // A closing sequence counts only after a space or tab (`# C#` keeps its `#`).
  if (end < text.length && (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t'))
    return text.slice(0, end).trim()
  return text
}

/** The text of a plan's first Markdown heading, else its first non-empty line ('' without one). */
function titleLine(plan: string): string {
  const lines = plan.split(/\r?\n/)
  for (const line of lines) {
    const text = headingText(line)
    if (text !== '')
      return text
  }
  return lines.find(line => line.trim() !== '') ?? ''
}

/**
 * The slug of a plan file name: the first heading (else the first non-empty line) lowercased, accents dropped, every run
 * of other characters turned into one `-`, trimmed, at most `PLAN_SLUG_MAX_CHARS`; `plan` when nothing is left.
 */
export function planSlug(plan: string): string {
  const slug = titleLine(plan)
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, PLAN_SLUG_MAX_CHARS)
    .replace(/-+$/, '')
  return slug === '' ? PLAN_SLUG_FALLBACK : slug
}

/** The UTC date of `ms` as `YYYY-MM-DD`. */
export function planDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** The file name of attempt `n` (1 = no suffix). */
export function planFileName(date: string, slug: string, n: number): string {
  return n <= 1 ? `${date}-${slug}.md` : `${date}-${slug}-${n}.md`
}

/** The setting as a POSIX relative folder (separators unified, trailing ones dropped), or null when it is unsafe. */
export function planDirectoryOf(setting: string): string | null {
  const value = setting.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  return isSafePlanDirectory(value) ? value : null
}

function linkError(rel: string): HarnessError {
  return new HarnessError({ code: 'validation_error', message: `The plan folder "${rel}" is or goes through a symbolic link.` })
}

/** True when anything (a file, a folder, a link) exists at `absolute` (a path below a guarded folder). */
async function occupied(absolute: string): Promise<boolean> {
  try {
    await lstat(absolute)
    return true
  }
  catch (error) {
    const code = errnoOf(error)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      return false
    throw error
  }
}

/** Resolves the plan folder through the guard and refuses a link on it (see the module comment). */
async function checkedFolder(root: string, dir: string): Promise<{ rel: string, folder: ResolvedWorkspacePath }> {
  const rel = toWorkspaceRel(root, resolve(root, dir))
  if (rel === '.' || rel === '..' || rel.startsWith('../') || hasGitSegment(rel))
    throw new HarnessError({ code: 'validation_error', message: PLAN_DIRECTORY_UNSAFE_ERROR })
  const folder = await resolveWorkspacePath(root, rel, { allowMissing: true })
  if (folder.rel !== rel)
    throw linkError(rel)
  if (folder.exists && !(await lstat(folder.absolute)).isDirectory())
    throw new HarnessError({ code: 'validation_error', message: `"${rel}" is not a folder.` })
  return { rel, folder }
}

/** Writes the plan under the first free name; throws when no file was written. */
async function writePlanFile(c: ToolCallContext, root: string, dir: string, date: string, slug: string, content: string): Promise<string> {
  const { rel, folder } = await checkedFolder(root, dir)
  for (let n = 1; n <= PLAN_FILE_MAX_SUFFIX; n += 1) {
    c.signal.throwIfAborted()
    const name = planFileName(date, slug, n)
    const path = `${rel}/${name}`
    if (folder.exists && await occupied(join(folder.absolute, name)))
      continue
    try {
      const result = await journaledWrite(c, root, { tool: PLAN_FILE_TOOL, path }, async (before, resolved) => {
        if (resolved.rel !== path)
          throw linkError(rel)
        // Under the file lock: a file created since the name was picked is never overwritten.
        if (before.state !== 'missing' || resolved.exists || await occupied(resolved.absolute))
          throw new PlanFileTaken()
        return content
      })
      return result.written.rel
    }
    catch (error) {
      if (error instanceof PlanFileTaken)
        continue
      throw error
    }
  }
  throw new HarnessError({ code: 'conflict', message: `Too many plan files named "${planFileName(date, slug, 1)}" in "${rel}".` })
}

/** Writes an approved plan into the project (see the module comment). */
export async function savePlan(context: PlanFileContext, plan: string, c: ToolCallContext): Promise<SavedPlan> {
  const { settings, logger } = context
  const workspace = c.workspace
  if (settings.planFiles !== true || workspace === undefined)
    return {}
  const scope = runScopeOf(c)
  if (scope === null || scope.projectId !== workspace.projectId)
    return {}
  try {
    const dir = planDirectoryOf(typeof settings.planDirectory === 'string' ? settings.planDirectory : '')
    if (dir === null)
      throw new HarnessError({ code: 'validation_error', message: PLAN_DIRECTORY_UNSAFE_ERROR })
    const content = plan.endsWith('\n') ? plan : `${plan}\n`
    const planPath = await writePlanFile(c, workspace.root, dir, planDate(context.now()), planSlug(plan), content)
    logger.debug('plan file saved', { projectId: workspace.projectId, path: planPath })
    return { planPath }
  }
  catch (error) {
    const planError = capPlanError(planErrorOf(error))
    logger.warn('cannot save the plan file', { projectId: workspace.projectId, reason: planError, ...(isHarnessError(error) ? {} : { err: error }) })
    return { planError }
  }
}
