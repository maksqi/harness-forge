// Projects (Phase 7, ADR-031, ARCHITECTURE.md 6.13, API.md 5.22): `createProjectService(deps)` implements
// `ProjectService` (./types.ts). Owner: W7.1.
//
// - Roots (`./roots.ts`): `start()` creates the default root (0700), resolves and checks every root (`EnvError` for a
//   refused one) and keeps the result; `roots()` answers it.
// - A project is a row of `projects` (id `prj_` + 16, name, canonical realpath, instructions). Its folder must be a
//   directory inside a root that does not equal, contain or sit inside the data dir (the default root's subtree
//   excepted); `create` checks that once, `openWorkspace` and the summaries check it again on every call.
// - The service owns the two cross-table queries on `chats.project_id` (no foreign key): the grouped `chatCount` and the
//   detach of `remove` (one batch with the delete). The folder of a project is never touched after `create`.
// - Every write emits `project.changed` (`{ id, project }`, `project: null` after `remove`).
import type { ProjectBrowse, ProjectBrowseEntry, ProjectCreate, ProjectSummary, ProjectUpdate } from '@harness-forge/shared'
import type { Dirent } from 'node:fs'
import type { AppDeps, SensitiveOperationOptions } from '../../types.ts'
import type { RootContext } from './roots.ts'
import type { OpenWorkspace, OpenWorkspaceResult, ProjectService } from './types.ts'
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import {
  createProjectId,
  HarnessError,
  LIMITS,
  projectCreateSchema,
  projectUpdateSchema,
  validationError,
  workspacePathSchema,
} from '@harness-forge/shared'
import { count, eq, isNotNull } from 'drizzle-orm'
import { chats, projects } from '../../db/schema.ts'
import { databaseError, guardDb, isConstraintError } from '../chats/db-errors.ts'
import { probeProjectFile, readProjectFile } from './project-file.ts'
import {
  checkRoots,
  errorCode,
  folderIssue,
  insideDataDir,
  insideRoots,
  isDirectory,
  overlapsDataDir,
  uncheckedRootContext,
} from './roots.ts'

export { DEFAULT_ROOT_MODE } from './roots.ts'

// ---------- messages (user-facing, API.md 5.22) ----------

export const OUTSIDE_ROOTS_MESSAGE = 'Choose a folder inside the workspace folders.'
export const CONTAINS_DATA_DIR_MESSAGE = 'This folder contains the harness-forge data directory.'
export const INSIDE_DATA_DIR_MESSAGE = 'This folder is inside the harness-forge data directory.'
export const PROJECT_EXISTS_MESSAGE = 'A project for this folder already exists.'
export const FOLDER_EXISTS_MESSAGE = 'A folder with this name already exists.'
export const PROJECTS_MAX_MESSAGE = `A server can have up to ${LIMITS.projectsMax} projects.`
export const PROJECT_RUNNING_MESSAGE = 'A chat of this project is running. Stop it first, then try again.'
export const PROJECT_GONE_MESSAGE = 'The project of this chat no longer exists.'

/** The `workspace-unavailable` notice text of `openWorkspace` ("The project folder … is not available: …"). */
export function folderUnavailableMessage(path: string, issue: string): string {
  return `The project folder ${path} is not available: ${issue}`
}

function pathIssue(message: string): HarnessError {
  return validationError([{ path: ['path'], message, code: 'custom' }], message)
}

function projectNotFound(id: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `Project ${id} not found.` })
}

function folderNotFound(path: string): HarnessError {
  return new HarnessError({ code: 'not_found', message: `The folder ${path} does not exist.` })
}

function conflict(message: string, reason: 'exists' | 'run-active', extra: { chatId?: string } = {}): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason, ...extra } })
}

/** The data-dir rule of a project folder (create): 400 on `['path']` when it overlaps. */
function checkDataDir(folder: string, context: RootContext): void {
  if (!overlapsDataDir(folder, context))
    return
  throw pathIssue(insideDataDir(folder, context) && folder !== context.dataDir ? INSIDE_DATA_DIR_MESSAGE : CONTAINS_DATA_DIR_MESSAGE)
}

/**
 * `realpath(path)` of a folder sent by the client (create, browse): `not_found` when it does not exist (also a dangling
 * link), 400 on `['path']` when it is relative, cannot be accessed, is not a directory or lies outside every root.
 */
async function resolveFolder(path: string, context: RootContext): Promise<string> {
  if (!isAbsolute(path))
    throw pathIssue('Use an absolute folder path.')
  let real: string
  try {
    real = await realpath(path)
  }
  catch (error) {
    const code = errorCode(error)
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw folderNotFound(path)
    if (code === 'EACCES' || code === 'EPERM')
      throw pathIssue('This folder cannot be accessed (permission denied).')
    if (code === 'ELOOP')
      throw pathIssue('This path goes through a symbolic link loop.')
    if (code === 'ENAMETOOLONG')
      throw pathIssue('This path is too long.')
    throw error
  }
  if (!(await isDirectory(real)))
    throw pathIssue('This path is not a folder.')
  if (!insideRoots(real, context))
    throw pathIssue(OUTSIDE_ROOTS_MESSAGE)
  return real
}

/** Locale-aware, case-insensitive name order with natural numbers (`app2` before `app10`). */
const byName = new Intl.Collator('en', { sensitivity: 'base', numeric: true })

type ProjectRow = typeof projects.$inferSelect

export function createProjectService(deps: AppDeps): ProjectService {
  const { db, env } = deps
  let checked: RootContext | null = null

  /** The checked roots after `start()`; before it, the unchecked realpaths (a service used without the boot). */
  async function context(): Promise<RootContext> {
    return checked ?? uncheckedRootContext(env)
  }

  async function findRow(id: string): Promise<ProjectRow | undefined> {
    const [row] = await guardDb(async () => db.select().from(projects).where(eq(projects.id, id)).limit(1))
    return row
  }

  async function requireRow(id: string): Promise<ProjectRow> {
    const row = await findRow(id)
    if (row === undefined)
      throw projectNotFound(id)
    return row
  }

  /** Chats per project (archived ones included): one grouped query over `chats_project_idx`. */
  async function chatCounts(): Promise<Map<string, number>> {
    const rows = await guardDb(async () => db
      .select({ projectId: chats.projectId, n: count() })
      .from(chats)
      .where(isNotNull(chats.projectId))
      .groupBy(chats.projectId))
    return new Map(rows.flatMap(row => (row.projectId === null ? [] : [[row.projectId, row.n] as const])))
  }

  async function chatCountOf(id: string): Promise<number> {
    const [row] = await guardDb(async () => db.select({ n: count() }).from(chats).where(eq(chats.projectId, id)))
    return row?.n ?? 0
  }

  async function summarize(row: ProjectRow, chatCount: number, ctx: RootContext): Promise<ProjectSummary> {
    const issue = await folderIssue(row.path, ctx)
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      instructions: row.instructions,
      available: issue === null,
      issue,
      instructionsFile: issue === null ? await probeProjectFile(row.path) : null,
      chatCount,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async function summaryOf(row: ProjectRow): Promise<ProjectSummary> {
    return summarize(row, await chatCountOf(row.id), await context())
  }

  function changed(id: string, project: ProjectSummary | null): void {
    deps.events.emit('project.changed', { id, project })
  }

  // ---------- create ----------

  async function insert(name: string, path: string): Promise<ProjectRow> {
    const [used] = await guardDb(async () => db.select({ id: projects.id }).from(projects).where(eq(projects.path, path)).limit(1))
    if (used !== undefined)
      throw conflict(PROJECT_EXISTS_MESSAGE, 'exists')
    const at = Date.now()
    try {
      const [row] = await db.insert(projects).values({ id: createProjectId(), name, path, instructions: null, createdAt: at, updatedAt: at }).returning()
      return row!
    }
    catch (error) {
      // Two requests for the same folder: the unique index on `path` decides.
      if (isConstraintError(error))
        throw conflict(PROJECT_EXISTS_MESSAGE, 'exists')
      throw databaseError(error)
    }
  }

  /** `mkdir` without `recursive` inside the checked parent: 409 `exists` for an existing entry. */
  async function makeFolder(parent: string, folderName: string): Promise<string> {
    const target = join(parent, folderName)
    try {
      await mkdir(target)
    }
    catch (error) {
      const code = errorCode(error)
      if (code === 'EEXIST')
        throw conflict(FOLDER_EXISTS_MESSAGE, 'exists')
      if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS')
        throw pathIssue('The folder cannot be created here (permission denied).')
      if (code === 'ENAMETOOLONG')
        throw pathIssue('The folder name is too long.')
      throw error
    }
    return target
  }

  async function create(input: ProjectCreate, sensitive?: SensitiveOperationOptions): Promise<ProjectSummary> {
    const parsed = projectCreateSchema.safeParse(input)
    if (!parsed.success)
      throw validationError(parsed.error)
    sensitive?.requireFreshAuth()
    const { name, newFolder } = parsed.data
    const ctx = await context()
    const folder = await resolveFolder(parsed.data.path, ctx)
    // The new folder's parent may contain the data dir (a root that holds it), never be or sit inside it.
    if (newFolder === undefined || insideDataDir(folder, ctx))
      checkDataDir(folder, ctx)
    const [{ n } = { n: 0 }] = await guardDb(async () => db.select({ n: count() }).from(projects))
    if (n >= LIMITS.projectsMax)
      throw pathIssue(PROJECTS_MAX_MESSAGE)

    let created: string | null = null
    try {
      let path = folder
      if (newFolder !== undefined) {
        created = await makeFolder(folder, newFolder)
        path = await realpath(created)
        if (!insideRoots(path, ctx))
          throw pathIssue(OUTSIDE_ROOTS_MESSAGE)
        checkDataDir(path, ctx)
      }
      const row = await insert(name, path)
      created = null
      const summary = await summarize(row, 0, ctx)
      deps.logger.info('project created', { projectId: row.id, newFolder: newFolder !== undefined })
      changed(row.id, summary)
      return summary
    }
    finally {
      // A folder this call created is removed again when the project was not stored (only while still empty).
      if (created !== null)
        await rmdir(created).catch(() => {})
    }
  }

  // ---------- update / remove ----------

  async function update(id: string, patch: ProjectUpdate): Promise<ProjectSummary> {
    const parsed = projectUpdateSchema.safeParse(patch)
    if (!parsed.success)
      throw validationError(parsed.error)
    const set: Partial<ProjectRow> = { updatedAt: Date.now() }
    if (parsed.data.name !== undefined)
      set.name = parsed.data.name
    if (parsed.data.instructions !== undefined)
      set.instructions = parsed.data.instructions === '' ? null : parsed.data.instructions
    const [row] = await guardDb(async () => db.update(projects).set(set).where(eq(projects.id, id)).returning())
    if (row === undefined)
      throw projectNotFound(id)
    const summary = await summaryOf(row)
    changed(id, summary)
    return summary
  }

  async function remove(id: string): Promise<void> {
    await requireRow(id)
    const members = await guardDb(async () => db.select({ id: chats.id }).from(chats).where(eq(chats.projectId, id)))
    const running = members.find(chat => deps.runs.hasRun(chat.id))
    if (running !== undefined)
      throw conflict(PROJECT_RUNNING_MESSAGE, 'run-active', { chatId: running.id })
    // One transaction: the chats leave the project and the row goes; the folder is never touched.
    const [, deleted] = await guardDb(async () => db.batch([
      db.update(chats).set({ projectId: null }).where(eq(chats.projectId, id)),
      db.delete(projects).where(eq(projects.id, id)).returning({ id: projects.id }),
    ]))
    if (deleted.length === 0)
      throw projectNotFound(id)
    deps.logger.info('project deleted', { projectId: id, detachedChats: members.length })
    changed(id, null)
  }

  // ---------- browse ----------

  async function browse(path?: string): Promise<ProjectBrowse> {
    const ctx = await context()
    const roots = await Promise.all(ctx.roots.map(async root => ({ path: root, available: await isDirectory(root) })))
    if (path === undefined)
      return { path: null, parent: null, roots, entries: [], truncated: false }
    const folder = await resolveFolder(path, ctx)
    // A folder that contains the data dir may be browsed (the data dir is hidden); one inside it may not.
    if (insideDataDir(folder, ctx))
      checkDataDir(folder, ctx)
    let dirents: Dirent[]
    try {
      dirents = await readdir(folder, { withFileTypes: true })
    }
    catch (error) {
      const code = errorCode(error)
      if (code === 'EACCES' || code === 'EPERM')
        throw pathIssue('This folder cannot be accessed (permission denied).')
      if (code === 'ENOENT' || code === 'ENOTDIR')
        throw folderNotFound(path)
      throw error
    }
    const names = dirents
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .filter((name) => {
        const entryPath = join(folder, name)
        // The data dir is never listed; names a path cannot carry (control characters, too long) are skipped.
        return entryPath !== ctx.dataDir && workspacePathSchema.safeParse(entryPath).success
      })
      .sort((a, b) => byName.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0))
    const used = new Map((await guardDb(async () => db.select({ id: projects.id, path: projects.path }).from(projects))).map(row => [row.path, row.id]))
    const entries: ProjectBrowseEntry[] = names.slice(0, LIMITS.browseEntriesMax).map((name) => {
      const entryPath = join(folder, name)
      return { name, path: entryPath, projectId: used.get(entryPath) ?? null }
    })
    const parent = ctx.roots.includes(folder) ? null : dirname(folder)
    return { path: folder, parent, roots, entries, truncated: names.length > entries.length }
  }

  // ---------- openWorkspace ----------

  async function openWorkspace(id: string): Promise<OpenWorkspaceResult> {
    const row = await findRow(id)
    if (row === undefined)
      return { ok: false, name: null, message: PROJECT_GONE_MESSAGE }
    const issue = await folderIssue(row.path, await context())
    if (issue !== null)
      return { ok: false, name: row.name, message: folderUnavailableMessage(row.path, issue) }
    const workspace: OpenWorkspace = Object.freeze({
      projectId: row.id,
      name: row.name,
      root: row.path,
      instructions: row.instructions,
      projectFile: await readProjectFile(row.path),
    })
    return { ok: true, workspace }
  }

  return {
    start: async () => {
      checked = await checkRoots(env)
    },
    roots: async () => (await context()).roots,
    list: async () => {
      const [rows, counts, ctx] = await Promise.all([guardDb(async () => db.select().from(projects)), chatCounts(), context()])
      const summaries = await Promise.all(rows.map(row => summarize(row, counts.get(row.id) ?? 0, ctx)))
      return summaries.sort((a, b) => byName.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
    get: async id => summaryOf(await requireRow(id)),
    create,
    update,
    remove,
    browse,
    openWorkspace,
  }
}
