// Workspace folders and projects for the Phase 7 specs (docs/UI.md 7.19, 7.20, 9.10; ADR-031). A project folder must lie
// inside one of the server's allowed roots (`HF_WORKSPACE_ROOTS`, default `<dataDir>/workspaces`), so the folder of a
// spec is created below the root the server under test reports (`GET /api/projects/browse`), or below
// `E2E_WORKSPACE_ROOT` when that is set (it must be one of the server's roots). Never a hard-coded `.tmp/e2e`: the
// coordinator's server (:8899, `.tmp/e2e`) and an agent's slot server have different data directories. The specs run on
// the host of the server (the folder is written with Node's `fs`).
//
// Every folder gets a unique name (`demo-<id>`), so specs never collide on a shared server, and `seedProject` registers
// the undo of everything it made through the `cleanup` fixture (the project first, then the folder: deleting a project
// never touches its folder).
import type { ProjectSummary } from '../../packages/shared/src/index.ts'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { uniqueId } from './data.ts'

/** The file `mock:workspace` writes, edits and prints (docs/PROVIDERS.md 8). */
export const MOCK_WORKSPACE_FILE = 'mock-workspace.txt'
/** What `mock:workspace` writes first ... */
export const MOCK_WORKSPACE_CONTENT = 'Hello from the mock agent.\n'
/** ... and what the file holds after its edit (`mock agent` -> `workspace agent`). */
export const MOCK_WORKSPACE_EDITED = 'Hello from the workspace agent.\n'
/** The command of its shell step. */
export const MOCK_WORKSPACE_COMMAND = `cat ${MOCK_WORKSPACE_FILE}`
/** Its last answer after a full run (write, edit, shell). */
export const MOCK_WORKSPACE_DONE = 'Workspace done: Hello from the workspace agent.'

/**
 * The workspace root the specs create their folders in: `E2E_WORKSPACE_ROOT`, else the first available root the server
 * reports (`GET /api/projects/browse` without a path lists only the roots, as realpaths).
 */
export async function workspaceRoot(api: HarnessApi): Promise<string> {
  const { roots } = await api.client.projects.browse({ query: {} })
  const fromEnv = process.env.E2E_WORKSPACE_ROOT
  if (fromEnv) {
    const wanted = await realpath(fromEnv)
    if (!roots.some(root => root.path === wanted))
      throw new Error(`E2E_WORKSPACE_ROOT ${wanted} is not a workspace root of the server (${roots.map(root => root.path).join(', ')}).`)
    return wanted
  }
  const root = roots.find(item => item.available)
  if (!root)
    throw new Error('The server has no available workspace root (HF_WORKSPACE_ROOTS).')
  return root.path
}

export interface WorkspaceFolder {
  /** The workspace root it was created in. */
  root: string
  /** Its folder name (unique: `<prefix>-<id>`). */
  name: string
  /** Its absolute path (`<root>/<name>`, a realpath because the root is one). */
  path: string
  /** Removes the folder and everything in it. */
  remove: () => Promise<void>
}

export interface SeedFolderOptions {
  /** Prefix of the folder name (default `demo`). */
  prefix?: string
  /** Files to create, by path relative to the folder (subfolders are created), e.g. `{ 'src/a.ts': '...' }`. */
  files?: Readonly<Record<string, string>>
}

/** Creates a uniquely named folder below the workspace root (see `workspaceRoot`). */
export async function seedWorkspaceFolder(api: HarnessApi, options: SeedFolderOptions = {}): Promise<WorkspaceFolder> {
  const root = await workspaceRoot(api)
  const name = uniqueId(options.prefix ?? 'demo')
  const path = join(root, name)
  await mkdir(path)
  for (const [relative, content] of Object.entries(options.files ?? {})) {
    const file = join(path, relative)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, content)
  }
  return { root, name, path, remove: () => rm(path, { recursive: true, force: true }) }
}

/** Creates a project for an existing folder through the API (no password on the server, or a fresh session). */
export function createProject(api: HarnessApi, input: { name: string, path: string }): Promise<ProjectSummary> {
  return api.client.projects.create({ body: input })
}

/** Every project of the server. */
export async function listProjects(api: HarnessApi): Promise<ProjectSummary[]> {
  return (await api.client.projects.list()).items
}

/** The project whose folder is `path`, if any. */
export async function projectByPath(api: HarnessApi, path: string): Promise<ProjectSummary | undefined> {
  return (await listProjects(api)).find(project => project.path === path)
}

/** Deletes a project (its chats move to No project; the folder stays); a project that is already gone is fine. */
export async function removeProject(api: HarnessApi, id: string): Promise<void> {
  try {
    await api.client.projects.remove({ params: { id } })
  }
  catch (error) {
    if ((error as { code?: unknown }).code !== 'not_found')
      throw error
  }
}

/** Deletes the project of a folder, if one was made for it (for projects a spec creates through the UI). */
export async function removeProjectAt(api: HarnessApi, path: string): Promise<void> {
  const project = await projectByPath(api, path)
  if (project)
    await removeProject(api, project.id)
}

export interface SeededProject {
  project: ProjectSummary
  folder: WorkspaceFolder
}

/**
 * A folder below the workspace root and a project for it (name: `options.name`, default the folder name), with the undo
 * of both registered through `cleanup` (the project is deleted first, then the folder).
 */
export async function seedProject(
  api: HarnessApi,
  cleanup: (task: CleanupTask) => void,
  options: SeedFolderOptions & { name?: string } = {},
): Promise<SeededProject> {
  const folder = await seedWorkspaceFolder(api, options)
  cleanup(() => folder.remove())
  const project = await createProject(api, { name: options.name ?? folder.name, path: folder.path })
  cleanup(api => removeProject(api, project.id))
  return { project, folder }
}
