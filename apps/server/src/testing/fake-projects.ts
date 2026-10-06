// Test double of `ProjectService` (Phase 7, C14-T6), so the chat pipeline (W7.4) and the chats service (W7.5) can test
// with projects while W7.1 implements the real service:
//
//   const t = await createTestApp({ factories: { projects: createFakeProjectService } })
//   const projects = t.deps.projects as FakeProjectService
//   const project = await projects.add({ name: 'Demo', files: { 'AGENTS.md': 'Be careful.' } })
//   const opened = await t.deps.projects.openWorkspace(project.id)   // { ok: true, workspace: { root, ... } }
//
// Projects live in the `projects` table of the test database (an in-memory SQLite by default), so the chats service's
// `UPDATE … WHERE EXISTS (SELECT 1 FROM projects …)` move and the detach of `remove` see them; `chatCount` comes from
// `chats.project_id`. Project folders are real folders: `add()` creates one below the first allowed root, which is
// `<dataDir>/workspaces` unless the test sets `HF_WORKSPACE_ROOTS` (`createTestApp({ workspaceRoots })`); with the
// default temp data dir of `createTestApp()` that is a `realpath(mkdtemp())` folder removed by `close()`.
//
// Follows the contract where callers can see it: `not_found` for unknown ids and missing folders, `validation_error`
// on `['path']` outside the roots, `conflict` `exists` for a used path or an existing new folder, `conflict` `run-active`
// in `remove` while a chat of the project holds a run, `project.changed` after every write (`project: null` after
// `remove`), `requireFreshAuth()` before `create` writes, browse without `path` = the roots. `openWorkspace` checks that
// the folder still is its own realpath and a directory and reads `AGENTS.md`, else `CLAUDE.md`, through the path guard
// (cut at `LIMITS.projectFileBytes`). Simplifications: no data-dir overlap checks, no `@file` expansion in the project
// file, `start()` only creates the default root.
import type { ProjectBrowse, ProjectCreate, ProjectSummary, ProjectUpdate } from '@harness-forge/shared'
import type { OpenWorkspace, OpenWorkspaceResult, ProjectFile, ProjectService } from '../services/projects/types.ts'
import type { AppDeps, SensitiveOperationOptions } from '../types.ts'
import { Buffer } from 'node:buffer'
import { mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  createProjectId,
  HarnessError,
  LIMITS,
  PROJECT_INSTRUCTIONS_FILES,
  projectCreateSchema,
  projectUpdateSchema,
  validationError,
} from '@harness-forge/shared'
import { asc, count, eq, inArray } from 'drizzle-orm'
import { chats, projects } from '../db/schema.ts'
import { isWithin } from '../plugins/scaffold/paths.ts'
import { DEFAULT_ROOT_MODE } from '../services/projects/index.ts'
import { openWorkspaceFile } from '../workspace/paths.ts'

/** Marker appended to a project file cut at `LIMITS.projectFileBytes`. */
export const FAKE_PROJECT_FILE_TRUNCATED = '\n[truncated]'

export interface FakeProjectAddInput {
  /** Default `Project <n>`. */
  name?: string
  /** An existing folder (used as is after `realpath`); default: a new folder below the first root. */
  path?: string
  instructions?: string | null
  /** Files written into the new folder (relative path -> text), e.g. `{ 'AGENTS.md': '...' }`. */
  files?: Record<string, string>
}

export interface FakeProjectServiceOptions {
  /** Clock of `createdAt` / `updatedAt` (default `Date.now`). */
  now?: () => number
}

export interface FakeProjectService extends ProjectService {
  /** Adds a project without fresh auth or root checks; creates its folder (and `files`) unless `path` is given. */
  readonly add: (input?: FakeProjectAddInput) => Promise<ProjectSummary>
  /** Project ids passed to `openWorkspace`, in call order. */
  readonly opened: string[]
}

function notFound(message: string): HarnessError {
  return new HarnessError({ code: 'not_found', message })
}

function pathIssue(message: string): HarnessError {
  return validationError([{ path: ['path'], message, code: 'custom' }], message)
}

function conflict(message: string, reason: 'exists' | 'run-active', extra: Record<string, unknown> = {}): HarnessError {
  return new HarnessError({ code: 'conflict', message, details: { reason, ...extra } })
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String((error as { code: unknown }).code) : undefined
}

/** A folder name from a project name: lowercase letters, digits and dashes. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
}

type ProjectRow = typeof projects.$inferSelect

/** Why `path` cannot be used as a project folder right now, or null (the checks of `openWorkspace`). */
async function folderIssue(path: string): Promise<string | null> {
  try {
    if (await realpath(path) !== path)
      return 'The folder moved or was replaced by a link.'
    if (!(await stat(path)).isDirectory())
      return 'The path is not a folder.'
    return null
  }
  catch {
    return 'The folder no longer exists.'
  }
}

/** `AGENTS.md`, else `CLAUDE.md`, from the folder root through the path guard; null when neither is a readable file. */
async function readProjectFile(root: string): Promise<ProjectFile | null> {
  for (const name of PROJECT_INSTRUCTIONS_FILES) {
    let opened: Awaited<ReturnType<typeof openWorkspaceFile>>
    try {
      opened = await openWorkspaceFile(root, name)
    }
    catch {
      continue
    }
    try {
      const max = LIMITS.projectFileBytes
      const buffer = Buffer.alloc(max)
      const { bytesRead } = await opened.handle.read(buffer, 0, max, 0)
      const truncated = opened.stats.size > max
      const text = new TextDecoder('utf-8').decode(buffer.subarray(0, bytesRead))
      return { name, content: truncated ? `${text}${FAKE_PROJECT_FILE_TRUNCATED}` : text, truncated }
    }
    finally {
      await opened.handle.close()
    }
  }
  return null
}

/** The fake `ProjectService` (see the module comment). Use as a factory: `factories: { projects: createFakeProjectService }`. */
export function createFakeProjectService(deps: AppDeps, options: FakeProjectServiceOptions = {}): FakeProjectService {
  const { db, env } = deps
  const now = options.now ?? Date.now
  const opened: string[] = []
  let added = 0

  async function roots(): Promise<readonly string[]> {
    const resolved: string[] = []
    for (const root of env.workspaceRoots) {
      try {
        resolved.push(await realpath(root))
      }
      catch {
        resolved.push(root)
      }
    }
    return resolved
  }

  async function ensureDefaultRoot(): Promise<void> {
    if (env.workspaceRoots.includes(env.paths.workspaces))
      await mkdir(env.paths.workspaces, { recursive: true, mode: DEFAULT_ROOT_MODE })
  }

  async function chatCounts(ids: readonly string[]): Promise<Map<string, number>> {
    if (ids.length === 0)
      return new Map()
    const rows = await db.select({ projectId: chats.projectId, n: count() }).from(chats).where(inArray(chats.projectId, [...ids])).groupBy(chats.projectId)
    return new Map(rows.flatMap(row => (row.projectId === null ? [] : [[row.projectId, row.n] as const])))
  }

  async function summarize(row: ProjectRow, chatCount: number): Promise<ProjectSummary> {
    const issue = await folderIssue(row.path)
    const file = issue === null ? await readProjectFile(row.path) : null
    return {
      id: row.id,
      name: row.name,
      path: row.path,
      instructions: row.instructions,
      available: issue === null,
      issue,
      instructionsFile: file?.name ?? null,
      chatCount,
      outputStyle: null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }
  }

  async function findRow(id: string): Promise<ProjectRow | undefined> {
    const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
    return row
  }

  async function requireRow(id: string): Promise<ProjectRow> {
    const row = await findRow(id)
    if (row === undefined)
      throw notFound(`Project ${id} not found.`)
    return row
  }

  async function summaryOf(row: ProjectRow): Promise<ProjectSummary> {
    return summarize(row, (await chatCounts([row.id])).get(row.id) ?? 0)
  }

  async function insert(name: string, path: string, instructions: string | null): Promise<ProjectSummary> {
    const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(projects)
    if (n >= LIMITS.projectsMax)
      throw pathIssue(`A server can have up to ${LIMITS.projectsMax} projects.`)
    const [used] = await db.select({ id: projects.id }).from(projects).where(eq(projects.path, path)).limit(1)
    if (used !== undefined)
      throw conflict(`The folder ${path} is already a project.`, 'exists')
    const at = now()
    const [row] = await db.insert(projects).values({ id: createProjectId(), name, path, instructions, createdAt: at, updatedAt: at }).returning()
    const summary = await summarize(row!, 0)
    deps.events.emit('project.changed', { id: summary.id, project: summary })
    return summary
  }

  /** `realpath(path)`: `not_found` when missing, `validation_error` when it is not a folder or outside every root. */
  async function checkedFolder(path: string): Promise<string> {
    let real: string
    try {
      real = await realpath(path)
    }
    catch (error) {
      if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR')
        throw notFound(`The folder ${path} does not exist.`)
      throw error
    }
    if (!(await stat(real)).isDirectory())
      throw pathIssue(`${path} is not a folder.`)
    if (!(await roots()).some(root => isWithin(root, real)))
      throw pathIssue('The folder is outside the allowed workspace roots (HF_WORKSPACE_ROOTS).')
    return real
  }

  async function create(input: ProjectCreate, sensitive?: SensitiveOperationOptions): Promise<ProjectSummary> {
    const parsed = projectCreateSchema.safeParse(input)
    if (!parsed.success)
      throw validationError(parsed.error)
    sensitive?.requireFreshAuth()
    const { name, newFolder } = parsed.data
    let path = await checkedFolder(parsed.data.path)
    let created: string | null = null
    if (newFolder !== undefined) {
      const target = join(path, newFolder)
      try {
        await mkdir(target)
      }
      catch (error) {
        if (errorCode(error) === 'EEXIST')
          throw conflict(`The folder ${target} already exists.`, 'exists')
        throw error
      }
      created = target
      path = await realpath(target)
    }
    try {
      return await insert(name, path, null)
    }
    catch (error) {
      if (created !== null)
        await rm(created, { recursive: true, force: true })
      throw error
    }
  }

  async function update(id: string, patch: ProjectUpdate): Promise<ProjectSummary> {
    const parsed = projectUpdateSchema.safeParse(patch)
    if (!parsed.success)
      throw validationError(parsed.error)
    await requireRow(id)
    const set: Partial<ProjectRow> = { updatedAt: now() }
    if (parsed.data.name !== undefined)
      set.name = parsed.data.name
    if (parsed.data.instructions !== undefined)
      set.instructions = parsed.data.instructions === '' ? null : parsed.data.instructions
    const [row] = await db.update(projects).set(set).where(eq(projects.id, id)).returning()
    const summary = await summaryOf(row!)
    deps.events.emit('project.changed', { id, project: summary })
    return summary
  }

  async function remove(id: string): Promise<void> {
    await requireRow(id)
    const members = await db.select({ id: chats.id }).from(chats).where(eq(chats.projectId, id))
    const running = members.find(chat => deps.runs.hasRun(chat.id))
    if (running !== undefined)
      throw conflict('A chat of this project is running. Stop it first.', 'run-active', { chatId: running.id })
    await db.batch([
      db.update(chats).set({ projectId: null }).where(eq(chats.projectId, id)),
      db.delete(projects).where(eq(projects.id, id)),
    ])
    deps.events.emit('project.changed', { id, project: null })
  }

  async function browse(path?: string): Promise<ProjectBrowse> {
    const allowed = await roots()
    const rootEntries = await Promise.all(allowed.map(async root => ({ path: root, available: await folderIssue(root) === null })))
    if (path === undefined)
      return { path: null, parent: null, roots: rootEntries, entries: [], truncated: false }
    const folder = await checkedFolder(path)
    const used = new Map((await db.select({ id: projects.id, path: projects.path }).from(projects)).map(row => [row.path, row.id]))
    const names = (await readdir(folder, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b))
    const entries = names.slice(0, LIMITS.browseEntriesMax).map((name) => {
      const entryPath = join(folder, name)
      return { name, path: entryPath, projectId: used.get(entryPath) ?? null }
    })
    const parent = allowed.includes(folder) ? null : dirname(folder)
    return { path: folder, parent, roots: rootEntries, entries, truncated: names.length > entries.length }
  }

  async function openWorkspace(id: string): Promise<OpenWorkspaceResult> {
    opened.push(id)
    const row = await findRow(id)
    if (row === undefined)
      return { ok: false, name: null, message: 'The project of this chat no longer exists.' }
    const issue = await folderIssue(row.path)
    if (issue !== null)
      return { ok: false, name: row.name, message: `The project folder ${row.path} is not available: ${issue}` }
    const workspace: OpenWorkspace = {
      projectId: row.id,
      name: row.name,
      root: row.path,
      instructions: row.instructions,
      projectFile: await readProjectFile(row.path),
    }
    return { ok: true, workspace }
  }

  async function add(input: FakeProjectAddInput = {}): Promise<ProjectSummary> {
    added += 1
    const name = input.name ?? `Project ${added}`
    let path: string
    if (input.path === undefined) {
      await ensureDefaultRoot()
      const base = (await roots())[0]
      if (base === undefined)
        throw new Error('fake projects: no workspace root.')
      path = join(base, `${slug(name)}-${added}`)
      await mkdir(path, { recursive: true })
      for (const [file, text] of Object.entries(input.files ?? {})) {
        await mkdir(dirname(join(path, file)), { recursive: true })
        await writeFile(join(path, file), text)
      }
      path = await realpath(path)
    }
    else {
      path = await realpath(input.path)
    }
    if (basename(path) === '')
      throw new Error('fake projects: a filesystem root cannot be a project.')
    return insert(name, path, input.instructions ?? null)
  }

  return {
    opened,
    add,
    start: ensureDefaultRoot,
    roots,
    list: async () => {
      const rows = await db.select().from(projects).orderBy(asc(projects.name), asc(projects.id))
      const counts = await chatCounts(rows.map(row => row.id))
      return Promise.all(rows.map(row => summarize(row, counts.get(row.id) ?? 0)))
    },
    get: async id => summaryOf(await requireRow(id)),
    create,
    update,
    remove,
    browse,
    openWorkspace,
  }
}
