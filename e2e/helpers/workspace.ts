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
//
// Phase 8 (W8.12): `seedGitProject` makes the folder a git repository with one commit, through `execFile('git', [...])`
// with argument arrays only, run inside that folder with a HOME and a global config of its own (a temporary folder) and
// `GIT_CEILING_DIRECTORIES` at the workspace root, so git never reads the user's configuration and never reaches a
// repository above the folder (the coordinator's and the agents' roots lie inside the harness-forge checkout). Specs
// skip their git tests when `gitAvailable()` is false.
import type { ProjectSummary } from '../../packages/shared/src/index.ts'
import type { HarnessApi } from './api.ts'
import type { CleanupTask } from './fixtures.ts'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

/** The file `mock:checkpoint` writes on every turn (docs/PROVIDERS.md 8, Phase 8) ... */
export const MOCK_CHECKPOINT_FILE = 'checkpoint.txt'
/** ... with the text `Turn <n>\n` (n = the number of user messages in the prompt). */
export function mockCheckpointContent(turn: number): string {
  return `Turn ${turn}\n`
}
/** The folder its first shell call makes and changes into (the sticky working folder of the next call). */
export const MOCK_CHECKPOINT_DIR = 'mock-dir'
/** Its first shell call. */
export const MOCK_CHECKPOINT_MKDIR = `mkdir -p ${MOCK_CHECKPOINT_DIR} && cd ${MOCK_CHECKPOINT_DIR}`
/** Its second shell call (runs in the folder the first one ended in). */
export const MOCK_CHECKPOINT_LS = 'ls'
/** Its answer after a full run. */
export const MOCK_CHECKPOINT_DONE = 'Checkpoint done.'

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

// ---------- git (Phase 8) ----------

/** The author of every commit these helpers make (set per command with `-c`, never in a config file). */
const GIT_AUTHOR = ['-c', 'user.name=Harness E2E', '-c', 'user.email=e2e@example.invalid']
/** Settings that keep the repository predictable whatever the host has: branch `main`, no signing, no line-end rewrite. */
const GIT_DEFAULTS = ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']

let gitCheck: Promise<boolean> | undefined

/** Whether `git` runs on this host (checked once with `git --version`). Specs skip their git tests otherwise. */
export function gitAvailable(): Promise<boolean> {
  gitCheck ??= new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true }, error => resolve(error === null))
  })
  return gitCheck
}

/** Runs `git <args>` in `cwd` with exactly `env` (no variable of the test process leaks in) and returns its stdout. */
function execGit(cwd: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...GIT_AUTHOR, ...GIT_DEFAULTS, ...args], { cwd, env, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error)
        reject(new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr.trim() || error.message}`))
      else
        resolve(stdout)
    })
  })
}

export interface GitRepository {
  /**
   * Runs `git <args>` (an argument array, never a shell string) inside the repository folder with the helper's own
   * HOME, global config and ceiling, e.g. `git('status', '--porcelain')`; resolves to its stdout.
   */
  git: (...args: string[]) => Promise<string>
  /** Removes the temporary HOME (the repository stays; remove its folder separately). */
  dispose: () => Promise<void>
}

export interface InitGitOptions {
  /** `GIT_CEILING_DIRECTORIES`: git never looks for a repository above this folder (the workspace root). */
  ceiling: string
  /** Commit every file of the folder (default true); false leaves an empty repository with every file untracked. */
  commit?: boolean
}

/**
 * Makes an existing folder (a realpath) a git repository on branch `main`: `git init`, then (unless `commit: false`)
 * `git add --all` and one commit "Initial commit". Git runs through `execFile` with argument arrays inside the folder,
 * with HOME and `GIT_CONFIG_GLOBAL` in a temporary folder (no system config) and `GIT_CEILING_DIRECTORIES` at
 * `ceiling`; before the first write the helper checks that the repository's top level is the folder itself, so it never
 * writes to another repository. Call it only when `gitAvailable()` is true; `dispose()` removes the temporary HOME.
 */
export async function initGitRepository(path: string, options: InitGitOptions): Promise<GitRepository> {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'hf-e2e-git-')))
  const dispose = () => rm(home, { recursive: true, force: true })
  try {
    const globalConfig = join(home, 'gitconfig')
    await writeFile(globalConfig, '')
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: home,
      GIT_CONFIG_GLOBAL: globalConfig,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: options.ceiling,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    }
    const git = (...args: string[]) => execGit(path, args, env)
    await git('init', '--quiet')
    // Never write to another repository: the folder itself must be the top level.
    const top = await realpath((await git('rev-parse', '--show-toplevel')).trim())
    if (top !== path)
      throw new Error(`git init in ${path} resolved to the repository at ${top}.`)
    if (options.commit !== false) {
      await git('add', '--all')
      await git('commit', '--quiet', '--allow-empty', '-m', 'Initial commit')
    }
    return { git, dispose }
  }
  catch (error) {
    await dispose()
    throw error
  }
}

export interface SeededGitProject extends SeededProject {
  /** `git <args>` inside the project folder (see `GitRepository.git`). */
  git: (...args: string[]) => Promise<string>
}

export interface SeedGitProjectOptions extends SeedFolderOptions {
  /** The project name (default: the folder name). */
  name?: string
  /** Commit the seeded files (default true); false leaves an empty repository with every file untracked. */
  commit?: boolean
}

/**
 * `seedProject` whose folder is a git repository on branch `main` (`initGitRepository`: the seeded files in one commit
 * "Initial commit" unless `commit: false`), everything undone through `cleanup` (the project, the folder with its
 * `.git`, the temporary HOME). Call it only when `gitAvailable()` is true.
 */
export async function seedGitProject(
  api: HarnessApi,
  cleanup: (task: CleanupTask) => void,
  options: SeedGitProjectOptions = {},
): Promise<SeededGitProject> {
  const seeded = await seedProject(api, cleanup, options)
  const repository = await initGitRepository(seeded.folder.path, { ceiling: seeded.folder.root, commit: options.commit })
  cleanup(() => repository.dispose())
  return { ...seeded, git: repository.git }
}
