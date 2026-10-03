// Frozen interface of projects (Phase 7, ADR-031, ARCHITECTURE.md 6.13, API.md `projects.ts`). Implementation:
// `createProjectService(deps)` in `services/projects/index.ts` (C14 stub; W7.1 implements it). Consumers: the projects
// routes (W7.1), the chat pipeline (`openWorkspace` on every chat-model run of a chat with a project, W7.4) and the
// chats service (`ensure` / `update` check that a project exists, W7.5). Test double: `createFakeProjectService`
// (`testing/fake-projects.ts`).
//
// A project is a named folder on the server host, inside one of the allowed roots (`env.workspaceRoots`, from
// `HF_WORKSPACE_ROOTS`, default `<dataDir>/workspaces`); a chat optionally belongs to one (`chats.project_id`, no
// foreign key). The service owns the two cross-table queries on `chats.project_id`: the detach in `remove` and the
// `chatCount` of the summaries. Projects are configuration: not in backups or chat exports, kept by delete-all.
import type { ProjectBrowse, ProjectCreate, ProjectInstructionsFile, ProjectSummary, ProjectUpdate } from '@harness-forge/shared'
import type { SensitiveOperationOptions } from '../../types.ts'

/** The project file found in the project root and added to the run instructions. */
export interface ProjectFile {
  /** `AGENTS.md`, else `CLAUDE.md` (`PROJECT_INSTRUCTIONS_FILES`). */
  readonly name: ProjectInstructionsFile
  /**
   * The text, with every line made only of `@relative.md` expanded one level (inside the root, through the path guard),
   * at most `LIMITS.projectFileBytes` in total; a cut text ends with a truncation marker.
   */
  readonly content: string
  /** The text was cut at `LIMITS.projectFileBytes`. */
  readonly truncated: boolean
}

/** The project folder of a run, verified by `openWorkspace` (read again on every run). */
export interface OpenWorkspace {
  /** `prj_` + 16 characters. */
  readonly projectId: string
  /** Project name. */
  readonly name: string
  /**
   * Canonical realpath of the project folder: equal to its stored path and to its realpath when the run started, a
   * directory, inside a current root, not overlapping the data dir. Tools resolve every path against it
   * (`resolveWorkspacePath`), which re-checks it on every call.
   */
  readonly root: string
  /** The project's own instructions (null = none). */
  readonly instructions: string | null
  /** `AGENTS.md`, else `CLAUDE.md`, from the root; null when neither is a readable text file. */
  readonly projectFile: ProjectFile | null
}

/**
 * Result of `openWorkspace`. `ok: false`: the run continues without workspace tools and with the notice
 * `workspace-unavailable` carrying `message` ("The project folder … is not available: …"; safe to show). `name` is the
 * project name, or null when the project no longer exists.
 */
export type OpenWorkspaceResult
  = | { readonly ok: true, readonly workspace: OpenWorkspace }
    | { readonly ok: false, readonly name: string | null, readonly message: string }

/**
 * Projects and the allowed roots. Every write emits `project.changed` (`{ id, project }`, `project: null` after
 * `remove`). Errors are `HarnessError`s (API.md 2): `not_found` for an unknown id (and a missing folder in `create`),
 * `validation_error` with the issue path `['path']` for a folder outside the roots or overlapping the data dir,
 * `conflict` (`exists`, `run-active`).
 */
export interface ProjectService {
  /**
   * First step of `startDeps()`. Creates the default root `<dataDir>/workspaces` with mode 0700 when it is one of the
   * roots, then resolves every root with `realpath` and checks it: it must exist and be a directory (a missing explicit
   * root fails the boot), and it may not be the data dir or lie inside it outside `<dataDir>/workspaces`; a root that
   * contains the data dir is allowed. A refused root throws `EnvError` (exit 1 with the reason).
   */
  readonly start: () => Promise<void>
  /** The checked roots (canonical realpaths, `env.workspaceRoots` order). */
  readonly roots: () => Promise<readonly string[]>
  /** `GET /projects`: every project, sorted by name (`available`, `issue`, `instructionsFile`, `chatCount` computed now). */
  readonly list: () => Promise<ProjectSummary[]>
  /** One project (as listed); `not_found`. */
  readonly get: (id: string) => Promise<ProjectSummary>
  /**
   * `POST /projects` (fresh auth: the route table flag, and `sensitive.requireFreshAuth()` before anything is written
   * when given): `realpath(path)` (`not_found` when missing) must be a directory inside a root; with `newFolder`, `path`
   * is the parent and the folder is created without `recursive` (an existing one: `conflict` `exists`), then resolved
   * again; a folder that equals, contains or sits inside the data dir is refused (the default root's subtree excepted);
   * at most `LIMITS.projectsMax` projects; a path already used by a project is `conflict` (`exists`), and a folder this
   * call created is removed again. Emits `project.changed`.
   */
  readonly create: (input: ProjectCreate, sensitive?: SensitiveOperationOptions) => Promise<ProjectSummary>
  /** `PATCH /projects/:id`: name and instructions (`null` or `''` removes them); the path never changes. Emits `project.changed`. */
  readonly update: (id: string, patch: ProjectUpdate) => Promise<ProjectSummary>
  /**
   * `DELETE /projects/:id`: `conflict` (`run-active`) while a chat of the project holds a run (`deps.runs.hasRun`); one
   * transaction sets `chats.project_id = NULL` for its chats and deletes the row; the folder is never touched. Emits one
   * `project.changed` with `project: null` (no `chat.updated` per detached chat). `not_found`.
   */
  readonly remove: (id: string) => Promise<void>
  /**
   * `GET /projects/browse?path`: without `path` the roots only (`path: null`, `parent: null`, `entries: []`); with a
   * path inside a root (else `validation_error` on `['path']`): its subfolders (directories only, links not listed;
   * dot folders, `node_modules` and the data dir hidden), sorted by name, at most `LIMITS.browseEntriesMax`
   * (`truncated`), each with the `projectId` that uses it; `parent` is null at a root.
   */
  readonly browse: (path?: string) => Promise<ProjectBrowse>
  /**
   * Called by the chat pipeline on every chat-model run of a chat with a project: the stored path must still equal its
   * realpath, be a directory, lie inside a current root and not overlap the data dir; the project file is read through
   * the path guard. Never throws for an unavailable folder or an unknown project (`ok: false`); other failures
   * (database) reject.
   */
  readonly openWorkspace: (id: string) => Promise<OpenWorkspaceResult>
}
